import type { Workspace } from "@cloudflare/computer"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type {
  AgentEvent,
  AgentEventStream,
  Conversation,
  EntryId,
  EntryRecord,
  Harness as PiHarness,
  SubmissionId
} from "@earendil-works/pi-durable"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { Effect, Layer, ManagedRuntime } from "effect"
import { MasterModels } from "../models/models.ts"
import { type CompactorModel, Memory, type MemoryStatus } from "../optchat/memory.ts"
import { LOGGED_KINDS, projectEntry } from "../optchat/projector.ts"
import { OptChatStore } from "../optchat/store.ts"
import { makeOptChatExtension, type OptChatBridge } from "../pi/extension.ts"
import { DoSqliteDatabase, type DoStorage } from "../pi/do-sqlite.ts"
import { makeWorkspaceExtension } from "../pi/workspace-tools.ts"
import { doOptChatStore } from "./store.ts"

const ctx = BACKGROUND_CONTEXT
const EVENT_CAP = 30_000

export interface AppStatus {
  readonly running: boolean
  readonly queuedEvents: number
  readonly memory: MemoryStatus
  readonly usage: unknown
}

/** Everything the Chat Durable Object does, independent of how requests reach it. */
export interface App {
  readonly harness: PiHarness
  readonly root: Conversation
  /** The user's words: start a Run, or steer the running one. */
  readonly input: (text: string, requestId?: string) => Promise<void>
  /** A webhook delivery: logged as an Event and answered in its own Run, after any running one. */
  readonly event: (source: string, deliveryId: string, text: string) => Promise<"queued" | "duplicate">
  readonly abort: () => Promise<void>
  readonly status: () => Promise<AppStatus>
  readonly view: () => Promise<string>
  readonly zoom: (id: number, n: number) => Promise<string>
  readonly instructions: () => Promise<string>
  readonly setInstructions: (text: string) => Promise<void>
  /** Pending work exists (a Run, queued Events, or unbuilt Nodes). */
  readonly busy: () => Promise<boolean>
  /** Resolves when nothing is pending, or after `ms`. */
  readonly settle: (ms: number) => Promise<void>
  readonly subscribe: (listener: (events: ReadonlyArray<AgentEvent>) => void) => () => void
  readonly snapshot: () => AgentEventStream["snapshot"]
}

export interface AppOptions {
  readonly storage: DoStorage
  readonly workspace: Workspace
  readonly exec: boolean
  /** Model access: `MockModels` or the live ChatGPT-backed layer. */
  readonly models: Layer.Layer<MasterModels | CompactorModel>
  readonly onError: (error: unknown) => void
}

type Row = Record<string, unknown>

export const openApp = async (options: AppOptions): Promise<App> => {
  const db = new DoSqliteDatabase(options.storage)
  const storage = await SqliteStorage.open(db)

  const layer = Memory.layer.pipe(
    Layer.provideMerge(doOptChatStore(db)),
    Layer.provideMerge(options.models)
  )
  const runtime = ManagedRuntime.make(layer)
  const run = <A>(effect: Effect.Effect<A, never, Memory | OptChatStore | MasterModels | CompactorModel>) =>
    runtime.runPromise(effect)
  const memory = await run(Effect.gen(function*() {
    return yield* Memory
  }))
  const store = await run(Effect.gen(function*() {
    return yield* OptChatStore
  }))
  const { models, master } = await run(Effect.gen(function*() {
    return yield* MasterModels
  }))

  let harness!: PiHarness
  /** An Event submission whose submission id is not yet recorded; projection of user entries waits for it. */
  let submitting: Promise<void> = Promise.resolve()

  /** Which pi.user entries were placed by a webhook Event, and from which source. */
  const eventSource = async (entryId: EntryId): Promise<string | undefined> => {
    await submitting
    const known = await db.get<Row>("SELECT source FROM oc_inbox WHERE entry_id = ?", String(entryId))
    if (known !== undefined) return String(known.source)
    const pending = await db.all<Row>(
      "SELECT seq, source, submission_id FROM oc_inbox WHERE state = 'submitted' AND entry_id IS NULL"
    )
    for (const row of pending) {
      const submission = await harness.submission(Number(row.submission_id) as SubmissionId, ctx)
      const record = submission === undefined ? undefined : await submission.status(ctx)
      if (record !== undefined && "entry" in record && record.entry === entryId) {
        await db.run("UPDATE oc_inbox SET entry_id = ?, state = 'placed' WHERE seq = ?", String(entryId), row.seq as number)
        return String(row.source)
      }
    }
    return undefined
  }

  const project = async (entries: ReadonlyArray<EntryRecord>) => {
    const drafts = []
    for (const entry of entries) {
      if (!LOGGED_KINDS.has(entry.kind)) continue
      const source = entry.kind === "pi.user" ? await eventSource(entry.id) : undefined
      drafts.push(...projectEntry(entry as never, source))
    }
    if (drafts.length > 0) await run(memory.append(drafts))
  }

  const bridge: OptChatBridge = {
    entries: async (conversationId, context) => {
      const conversation = await harness.conversation(conversationId, context)
      return conversation === undefined ? [] : (await conversation.context(context)).entries
    },
    project,
    runView: async (entryId, signal) => {
      const key = String(entryId)
      const frozen = await run(store.runView(key))
      if (frozen !== undefined) return frozen
      const end = await run(store.firstOf(key))
      if (end === undefined) throw new Error(`run input ${key} is not in the Log`)
      await runtime.runPromise(memory.settle(end), signal === undefined ? {} : { signal })
      const pieces = await run(memory.render(end))
      await run(store.putRunView(key, pieces))
      return pieces
    },
    zoom: (id, n) => run(memory.zoom(id, n)),
    date: (id) => run(memory.date(id))
  }

  const registry = createRegistry()
  registry.install(makeOptChatExtension(bridge))
  registry.install(makeWorkspaceExtension(options.workspace, { exec: options.exec }))

  harness = await Harness.open(storage, {
    models,
    registry,
    settings: {
      compaction: { enabled: false, backgroundTokens: 0 },
      progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
      steeringMode: "all",
      toolExecution: "parallel"
    },
    onReport: options.onError
  }, ctx)
  const root = await harness.root(ctx, { agent: { model: master, thinkingLevel: "high" } })

  // Catch up: log anything committed but not yet logged (newest first, until a logged entry).
  {
    const projected = await run(store.projectedEntries)
    const missing: EntryRecord[] = []
    let cursor: Parameters<Conversation["entries"]>[2] = undefined
    scan: while (true) {
      const page = await root.entries({}, 200, cursor, ctx)
      for (const entry of page.items) {
        if (projected.has(String(entry.id))) break scan
        missing.push(entry)
      }
      if (page.next === undefined) break
      cursor = page.next
    }
    await project(missing.reverse())
  }

  /** Log whatever the current Run committed that the event stream has not delivered yet. */
  const syncLog = async () => project((await root.context(ctx)).entries)

  const listeners = new Set<(events: ReadonlyArray<AgentEvent>) => void>()
  let running = true
  let draining = false

  const drain = async (): Promise<void> => {
    if (running || draining) return
    draining = true
    try {
      const next = await db.get<Row>("SELECT seq, source, request_id, text FROM oc_inbox WHERE state = 'queued' ORDER BY seq LIMIT 1")
      if (next === undefined) return
      await syncLog()
      let recorded!: () => void
      submitting = new Promise((resolve) => (recorded = resolve))
      try {
        const submission = await startRun(String(next.text), String(next.request_id), false)
        await db.run("UPDATE oc_inbox SET state = 'submitted', submission_id = ? WHERE seq = ?", String(submission), next.seq as number)
      } finally {
        recorded()
      }
    } finally {
      draining = false
    }
  }

  /** A Run starts from nothing: the model sees the Memory View, not the transcript (ADR 0001). */
  const startRun = async (text: string, requestId?: string, preflight = true): Promise<SubmissionId> => {
    running = true
    if (preflight) await syncLog()
    await root.reset(undefined, ctx)
    const submission = await root.submit(
      { type: "input", content: text, ...(requestId === undefined ? {} : { requestId }) },
      ctx
    )
    void root.waitForIdle(ctx).then(() => {
      running = false
      return drain()
    }).catch(options.onError)
    return submission.id
  }

  const events = await watchEventsSafe(harness, root, options.onError)
  events.start(async (batch) => {
    const appended = batch.flatMap((e) => (e.type === "entry_appended" ? [e.entry] : []))
    if (appended.length > 0) await project(appended).catch(options.onError)
    for (const listener of listeners) listener(batch)
  })

  harness.resume()
  void root.waitForIdle(ctx).then(() => {
    running = false
    return drain()
  }).catch(options.onError)

  const busy = async () => {
    if (running) return true
    const queued = await db.get<Row>("SELECT COUNT(*) AS n FROM oc_inbox WHERE state = 'queued'")
    if (Number(queued?.n ?? 0) > 0) return true
    const status = await run(memory.status)
    return status.busy > 0
  }

  return {
    harness,
    root,
    input: async (text, requestId) => {
      if (running) {
        await root.submit({ type: "input", content: text, whenBusy: "steer", ...(requestId ? { requestId } : {}) }, ctx)
      } else {
        await startRun(text, requestId)
      }
    },
    event: async (source, deliveryId, text) => {
      const requestId = `event:${source}:${deliveryId}`
      const existing = await db.get<Row>("SELECT seq FROM oc_inbox WHERE request_id = ?", requestId)
      if (existing !== undefined) return "duplicate"
      const capped = text.length > EVENT_CAP ? `${text.slice(0, EVENT_CAP)}\n[... cut ...]` : text
      await db.run("INSERT INTO oc_inbox (source, request_id, text) VALUES (?, ?, ?)", source, requestId, capped)
      await drain()
      return "queued"
    },
    abort: () => root.abort(ctx),
    status: async () => {
      const queued = await db.get<Row>("SELECT COUNT(*) AS n FROM oc_inbox WHERE state = 'queued'")
      return {
        running,
        queuedEvents: Number(queued?.n ?? 0),
        memory: await run(memory.status),
        usage: await harness.usage(ctx)
      }
    },
    view: async () => (await run(memory.render(await run(memory.count)))).join(""),
    zoom: (id, n) => run(memory.zoom(id, n)),
    instructions: async () => (await root.agent(ctx)).instructions ?? "",
    setInstructions: (text) => root.configure({ instructions: text.trim().length === 0 ? null : text }, ctx),
    busy,
    settle: async (ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline && (await busy())) {
        await Promise.race([
          root.waitForIdle(ctx),
          run(memory.idle),
          new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deadline - Date.now())))
        ])
        await syncLog()
        await drain()
      }
      await syncLog()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => events.snapshot
  }
}

const watchEventsSafe = async (harness: PiHarness, root: Conversation, onError: (e: unknown) => void) => {
  const { watchEvents } = await import("@earendil-works/pi-durable")
  const stream = await watchEvents(harness, root.id, ctx)
  void stream.closed.then((end) => onError(new Error(`event stream closed: ${JSON.stringify(end)}`)))
  return stream
}
