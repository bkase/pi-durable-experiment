import { Context, Deferred, Effect, FiberSet, Layer, Schema, Semaphore } from "effect"
import { bytes, COMPACT_HIGH, COMPACT_LOW, JOBS, LEAF_LAG, NODE, TRIES } from "./constants.ts"
import { line, type LogMeta } from "./log.ts"
import { compressTask, mergeTask, tooLong } from "./prompts.ts"
import { type LogDraft, OptChatStore } from "./store.ts"
import { freeLeaf, freeMerge, key, makeNode, name, type Node, NodeIndex, parseName, span } from "./tree.ts"
import { MemoryView, renderPieces, type ViewState } from "./view.ts"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  message: Schema.String
}) {}

/** One message of a compaction conversation after its view; `content` is its text blocks. */
export interface CompactorTurn {
  readonly role: "user" | "assistant"
  readonly content: ReadonlyArray<string>
}

/**
 * One compaction call: `[tools] [system prompt] [<chat> compaction view </chat>] [task …]`. The
 * model layer supplies the turns' own tools and system prompt, so compactions read them from the
 * turns' cache entry (UniiChat spec §4).
 */
export interface CompactionRequest {
  readonly view: ReadonlyArray<string>
  readonly turns: ReadonlyArray<CompactorTurn>
}

/** The cheap model that writes Summary Tree nodes. It is given the turns' tools but must call none. */
export class CompactorModel extends Context.Service<CompactorModel, {
  readonly complete: (request: CompactionRequest) => Effect.Effect<string, ModelError>
}>()("optchat/CompactorModel") {}

export interface MemoryStatus {
  readonly T: number
  readonly viewBytes: number
  readonly viewLines: number
  readonly compactionViewBytes: number
  readonly nodes: number
  readonly busy: number
  readonly failing: number
  /** First message whose view line is not yet a summary (T when settled). */
  readonly first: number
  /** Batches the chat view has run since this instance started (each rewrites the view once). */
  readonly batches: number
}

/** The OptChat memory: the Log, the Summary Tree, the Memory View and the Compactor that builds it. */
export class Memory extends Context.Service<Memory, {
  /** Log new messages (idempotent per transcript entry part) and wake the Compactor. */
  readonly append: (drafts: ReadonlyArray<LogDraft>) => Effect.Effect<ReadonlyArray<LogMeta>>
  readonly count: Effect.Effect<number>
  /** Resolves once every view line covering messages before `end` is a summary. */
  readonly settle: (end: number) => Effect.Effect<void>
  /** The `<chat>` block covering messages before `end`, in cacheable pieces. */
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

  // The views are kept, never rebuilt: a rebuilt view differs from the live one and every cache
  // entry dies. Only a Log that never had a saved view (or lost its tail) is folded forward.
  const restore = (saved: ViewState | undefined, high?: number, low?: number) => {
    const view = saved === undefined ? new MemoryView(index, high, low) : MemoryView.restore(index, saved, high, low)
    for (let i = view.T; i < messages.length; i++) view.append(i)
    return view
  }
  const view = restore(yield* store.loadView("chat"))
  const savedCompact = yield* store.loadView("compact")
  const compact = savedCompact === undefined
    ? new MemoryView(index, COMPACT_HIGH, COMPACT_LOW)
    : restore(savedCompact, COMPACT_HIGH, COMPACT_LOW)
  if (savedCompact === undefined) compact.resetFrom(view)
  let batches = 0

  const saveViews = Effect.all([store.saveView("chat", view.save()), store.saveView("compact", compact.save())], {
    discard: true
  })

  // Work queues (spec §4: never scan the tree for work).
  const inflight = new Set<string>()
  const failed = new Map<string, readonly [number, number]>()
  const mergeQueue: Array<readonly [number, number]> = []
  const queued = new Set<string>()
  let nextLeaf = 0
  const advanceLeaf = () => {
    while (nextLeaf < messages.length && index.has(0, nextLeaf)) nextLeaf++
  }
  const enqueueParent = (l: number, i: number) => {
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    const pl = l + 1
    const pi = Math.floor(i / 2)
    if (!index.has(l, sibling) || index.has(pl, pi) || queued.has(key(pl, pi))) return
    queued.add(key(pl, pi))
    mergeQueue.push([pl, pi])
  }
  for (const node of [...index.all()]) enqueueParent(node.l, node.i)
  advanceLeaf()

  let settleWaiters: Array<{ end: number; done: Deferred.Deferred<void> }> = []
  let idleWaiters: Array<Deferred.Deferred<void>> = []
  const notify = Effect.sync(() => {
    const ready = settleWaiters.filter((w) => view.settledBefore(w.end))
    settleWaiters = settleWaiters.filter((w) => !view.settledBefore(w.end))
    const idle = inflight.size === 0 ? idleWaiters : []
    if (inflight.size === 0) idleWaiters = []
    return [...ready.map((w) => w.done), ...idle]
  }).pipe(Effect.flatMap((ds) => Effect.forEach(ds, (d) => Deferred.succeed(d, undefined), { discard: true })))

  const T = () => messages.length

  const ask = Effect.fnUntraced(function*(end: number, task: string) {
    const context = renderPieces(compact.contextLines(end))
    const turns: CompactorTurn[] = [{ role: "user", content: [task] }]
    const tries: string[] = []
    while (true) {
      const reply = (yield* model.complete({ view: context, turns })).trim().replace(/^\d+\+\d+\|/, "")
      if (reply.length === 0) return yield* new ModelError({ message: "empty compactor reply" })
      tries.push(reply)
      const size = bytes(reply)
      if (size <= NODE || tries.length >= TRIES) break
      turns.push({ role: "assistant", content: [reply] }, {
        role: "user",
        content: [tooLong(size, cutBytes(reply, NODE))]
      })
    }
    return tries.reduce((a, b) => (bytes(b) < bytes(a) ? b : a))
  })

  const build = Effect.fnUntraced(function*(l: number, i: number) {
    if (l === 0) {
      const message = (yield* store.message(i))!
      const free = freeLeaf(message)
      if (free !== undefined) return free
      return makeNode(0, i, yield* ask(i, compressTask(i, message.kind, message.text)))
    }
    const a = index.get(l - 1, 2 * i)!
    const b = index.get(l - 1, 2 * i + 1)!
    const free = freeMerge(l, i, a, b)
    if (free !== undefined) return free
    const first = i * span(l)
    const end = (i + 1) * span(l)
    return makeNode(
      l,
      i,
      yield* ask(
        end,
        mergeTask(`${name(l - 1, 2 * i)}|${flat(a.text)}`, `${name(l - 1, 2 * i + 1)}|${flat(b.text)}`, first, end - 1)
      )
    )
  })

  const job = (l: number, i: number): Effect.Effect<void> =>
    build(l, i).pipe(
      Effect.flatMap((node: Node) =>
        Effect.gen(function*() {
          yield* store.putNode(node)
          index.put(node)
          view.built()
          compact.built()
          enqueueParent(l, i)
          if (l === 0) advanceLeaf()
        })
      ),
      Effect.catch((error: ModelError) =>
        Effect.gen(function*() {
          // Tried again at the next message (spec §4), not on a timer.
          yield* Effect.logWarning(`compactor: node ${l}:${i} failed: ${error.message}`)
          failed.set(key(l, i), [l, i])
        })
      ),
      Effect.ensuring(Effect.sync(() => inflight.delete(key(l, i)))),
      Effect.andThen(notify),
      Effect.andThen(Effect.suspend(() => pump))
    )

  /** Start ready work up to JOBS: merges whose halves are built, then the next messages in order. */
  const pump: Effect.Effect<void> = Effect.suspend(() => {
    const starts: Array<readonly [number, number]> = []
    const take = (l: number, i: number) => {
      inflight.add(key(l, i))
      starts.push([l, i])
    }
    while (inflight.size < JOBS && mergeQueue.length > 0) {
      const [l, i] = mergeQueue.shift()!
      queued.delete(key(l, i))
      if (!index.has(l, i) && !inflight.has(key(l, i)) && !failed.has(key(l, i))) take(l, i)
    }
    while (inflight.size < JOBS && nextLeaf < T() && view.unbuiltBefore(nextLeaf) < LEAF_LAG) {
      const i = nextLeaf++
      if (!index.has(0, i) && !inflight.has(key(0, i)) && !failed.has(key(0, i))) take(0, i)
    }
    return Effect.forEach(starts, ([l, i]) => FiberSet.run(fibers, job(l, i)), { discard: true })
  })

  /** Failed nodes go back in line when the next message arrives. */
  const retryFailed = Effect.sync(() => {
    for (const [k, [l, i]] of failed) {
      failed.delete(k)
      if (l === 0) nextLeaf = Math.min(nextLeaf, i)
      else if (!queued.has(k)) {
        queued.add(k)
        mergeQueue.unshift([l, i])
      }
    }
  })

  const append = (drafts: ReadonlyArray<LogDraft>) =>
    Effect.gen(function*() {
      const added = yield* store.append(drafts)
      if (added.length === 0) return []
      yield* retryFailed
      const metas = added.map(({ text: _, ...meta }) => meta)
      for (const meta of metas) {
        messages.push(meta)
        if (view.append(meta.i) > 0) {
          // A chat batch: the compaction view is the chat view merged further, so it follows.
          batches++
          compact.resetFrom(view)
        } else compact.append(meta.i)
      }
      yield* saveViews
      yield* pump
      return metas
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

  const idle = Effect.gen(function*() {
    if (inflight.size === 0) return
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
    date: (id) => Effect.sync(() => messages[id]?.date ?? `No message ${id}.`),
    status: Effect.sync(() => ({
      T: T(),
      viewBytes: view.size,
      viewLines: view.lines.length,
      compactionViewBytes: compact.size,
      nodes: index.size,
      busy: inflight.size,
      failing: failed.size,
      first: view.first(),
      batches
    })),
    idle
  })
})
