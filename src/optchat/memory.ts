import { Context, Deferred, Duration, Effect, FiberSet, Layer, Schema, Semaphore } from "effect"
import { bytes, JOBS, NODE, RETRY_MS, TRIES } from "./constants.ts"
import { line, type LogMessage, type LogMeta } from "./log.ts"
import { COMPACT, SCALE } from "./prompts.ts"
import { type LogDraft, OptChatStore } from "./store.ts"
import { freeLeaf, freeMerge, key, makeNode, type Node, NodeIndex, parseName, span, start } from "./tree.ts"
import { MemoryView, renderPieces } from "./view.ts"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  message: Schema.String
}) {}

/** One message of a Compactor conversation; `content` is its text blocks. */
export interface CompactorTurn {
  readonly role: "user" | "assistant"
  readonly content: ReadonlyArray<string>
}

/** The cheap model that writes Summary Tree nodes. No tools; one conversation per node. */
export class CompactorModel extends Context.Service<CompactorModel, {
  readonly complete: (system: string, turns: ReadonlyArray<CompactorTurn>) => Effect.Effect<string, ModelError>
}>()("optchat/CompactorModel") {}

export interface MemoryStatus {
  readonly T: number
  readonly viewBytes: number
  readonly viewLines: number
  readonly nodes: number
  readonly busy: number
  readonly failing: number
  /** First message whose view line is not yet a summary (T when settled). */
  readonly first: number
}

/** The OptChat memory: the Log, the Summary Tree, the Memory View and the Compactor that builds it. */
export class Memory extends Context.Service<Memory, {
  /** Log new messages (idempotent per transcript entry part) and wake the Compactor. */
  readonly append: (drafts: ReadonlyArray<LogDraft>) => Effect.Effect<ReadonlyArray<LogMessage>>
  readonly count: Effect.Effect<number>
  /** Resolves once every view line covering messages before `end` is a summary. */
  readonly settle: (end: number) => Effect.Effect<void>
  /** The `<chat>` block covering messages before `end`, cut at the cache marks. */
  readonly render: (end: number) => Effect.Effect<ReadonlyArray<string>>
  readonly zoom: (id: number, n: number) => Effect.Effect<string>
  readonly date: (id: number) => Effect.Effect<string>
  readonly status: Effect.Effect<MemoryStatus>
  /** Resolves when the Compactor has nothing running. */
  readonly idle: Effect.Effect<void>
}>()("optchat/Memory") {
  static readonly layer = Layer.effect(Memory, Effect.suspend(() => make))
}

const flat = (text: string): string => text.replace(/\n/g, " ")

/** Cut to at most `limit` bytes without splitting a UTF-8 character. */
const cutBytes = (text: string, limit: number): string => {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= limit) return text
  return new TextDecoder().decode(encoded.slice(0, limit)).replace(/�$/, "")
}

const make = Effect.gen(function*() {
  const store = yield* OptChatStore
  const model = yield* CompactorModel
  const fibers = yield* FiberSet.make<void, never>()
  const appending = yield* Semaphore.make(1)

  const index = new NodeIndex()
  for (const node of yield* store.nodes) index.put(node)
  const messages: LogMeta[] = [...(yield* store.metas)]
  const view = MemoryView.fold(index, messages.length)

  const busy = new Set<string>()
  const failing = new Set<string>()
  let settleWaiters: Array<{ end: number; done: Deferred.Deferred<void> }> = []
  let idleWaiters: Array<Deferred.Deferred<void>> = []

  const notify = Effect.sync(() => {
    const ready = settleWaiters.filter((w) => view.settledBefore(w.end))
    settleWaiters = settleWaiters.filter((w) => !view.settledBefore(w.end))
    const idle = busy.size === 0 ? idleWaiters : []
    if (busy.size === 0) idleWaiters = []
    return [...ready.map((w) => w.done), ...idle]
  }).pipe(Effect.flatMap((ds) => Effect.forEach(ds, (d) => Deferred.succeed(d, undefined), { discard: true })))

  const T = () => messages.length

  /** View lines before `end`, bare: text only, no ids (the Compactor would copy them). */
  const contextBlock = (end: number): string => {
    const lines: string[] = []
    for (const part of view.lines) {
      if (start(part.l, part.i) >= end) break
      const node = index.get(part.l, part.i)
      if (node !== undefined) lines.push(flat(node.text))
    }
    return `<chat>\n${lines.map((l) => `${l}\n`).join("")}</chat>`
  }

  const ask = Effect.fnUntraced(function*(context: string, step: string) {
    const turns: CompactorTurn[] = [{ role: "user", content: [context, step] }]
    const tries: string[] = []
    while (true) {
      const reply = (yield* model.complete(COMPACT, turns)).trim()
      if (reply.length === 0) return yield* new ModelError({ message: "empty compactor reply" })
      tries.push(reply)
      const size = bytes(reply)
      if (size <= NODE || tries.length >= TRIES) break
      turns.push({ role: "assistant", content: [reply] })
      turns.push({
        role: "user",
        content: [
          `That line is ${size} bytes; the limit is ${NODE}. It must end where it is cut here:\n${
            cutBytes(reply, NODE)
          }| ← LIMIT`
        ]
      })
    }
    return tries.reduce((a, b) => (bytes(b) < bytes(a) ? b : a))
  })

  const scale = `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n`

  const build = Effect.fnUntraced(function*(l: number, i: number) {
    if (l === 0) {
      const message = (yield* store.message(i))!
      const free = freeLeaf(message)
      if (free !== undefined) return free
      const step = `${scale}Compress this message into one line, in at most ${NODE} bytes:\n${
        line(message.kind, message.text)
      }`
      return makeNode(0, i, yield* ask(contextBlock(i), step))
    }
    const a = index.get(l - 1, 2 * i)!
    const b = index.get(l - 1, 2 * i + 1)!
    const free = freeMerge(l, i, a, b)
    if (free !== undefined) return free
    const step = `${scale}Merge these two lines into one, in at most ${NODE} bytes:\n${flat(a.text)}\n${flat(b.text)}`
    return makeNode(l, i, yield* ask(contextBlock((i + 1) * span(l)), step))
  })

  const save = (node: Node) =>
    Effect.gen(function*() {
      yield* store.putNode(node)
      index.put(node)
      view.built()
    })

  const job = (l: number, i: number): Effect.Effect<void> =>
    build(l, i).pipe(
      Effect.flatMap(save),
      Effect.flatMap(() =>
        Effect.sync(() => {
          busy.delete(key(l, i))
          failing.delete(key(l, i))
        })
      ),
      Effect.catch((error: ModelError) =>
        Effect.gen(function*() {
          if (!failing.has(key(l, i))) {
            failing.add(key(l, i))
            yield* Effect.logWarning(`compactor: node ${l}:${i} failed: ${error.message}`)
          }
          yield* Effect.sleep(Duration.millis(RETRY_MS))
          busy.delete(key(l, i))
        })
      ),
      Effect.andThen(notify),
      Effect.andThen(Effect.suspend(() => pump))
    )

  /** Start every node that is unbuilt, idle, has its sources, and whose whole context is summarized. */
  const pump: Effect.Effect<void> = Effect.suspend(() => {
    const starts: Array<[number, number]> = []
    const total = T()
    const first = view.first()
    outer: for (let l = 0; span(l) <= total; l++) {
      for (let i = 0; (i + 1) * span(l) <= total; i++) {
        if (busy.size >= JOBS) break outer
        if (index.has(l, i) || busy.has(key(l, i))) continue
        if (l > 0 && (!index.has(l - 1, 2 * i) || !index.has(l - 1, 2 * i + 1))) continue
        const end = l === 0 ? i : (i + 1) * span(l)
        if (end > first) continue
        busy.add(key(l, i))
        starts.push([l, i])
      }
    }
    return Effect.forEach(starts, ([l, i]) => FiberSet.run(fibers, job(l, i)), { discard: true })
  })

  const append = (drafts: ReadonlyArray<LogDraft>) =>
    Effect.gen(function*() {
      const added = yield* store.append(drafts)
      for (const { text: _, ...meta } of added) {
        messages.push(meta)
        view.append(meta.i)
      }
      if (added.length > 0) yield* pump
      return added
    }).pipe(Semaphore.withPermits(appending, 1))

  const settle = (end: number) =>
    Effect.gen(function*() {
      if (view.settledBefore(end)) return
      const done = yield* Deferred.make<void>()
      settleWaiters.push({ end, done })
      yield* Deferred.await(done)
    })

  const zoom = (id: number, n: number) =>
    Effect.gen(function*() {
      const at = parseName(id, n)
      if (at === undefined || id + n > T()) return `No line ${id}+${n}.`
      if (n === 1) {
        const m = (yield* store.message(id))!
        return `${id}+0|${line(m.kind, m.text)}`
      }
      const a = index.get(at.l - 1, 2 * at.i)
      const b = index.get(at.l - 1, 2 * at.i + 1)
      if (a === undefined || b === undefined) return `No line ${id}+${n}.`
      const half = n / 2
      return `${id}+${half}|${flat(a.text)}\n${id + half}+${half}|${flat(b.text)}`
    })

  const date = (id: number) =>
    Effect.sync(() => {
      const m = messages[id]
      return m === undefined ? `No message ${id}.` : m.date
    })

  const idle = Effect.gen(function*() {
    if (busy.size === 0) return
    const done = yield* Deferred.make<void>()
    idleWaiters.push(done)
    yield* Deferred.await(done)
  })

  yield* pump

  return Memory.of({
    append,
    count: Effect.sync(T),
    settle,
    render: (end) => Effect.sync(() => renderPieces(view.renderLines(end))),
    zoom,
    date,
    status: Effect.sync(() => ({
      T: T(),
      viewBytes: view.size,
      viewLines: view.lines.length,
      nodes: index.size,
      busy: busy.size,
      failing: failing.size,
      first: view.first()
    })),
    idle
  })
})
