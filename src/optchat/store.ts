import { Context, Effect, Layer } from "effect"
import { type Kind, type LogMessage, type LogMeta, sizeOf } from "./log.ts"
import type { Node } from "./tree.ts"
import type { ViewState } from "./view.ts"

/** A Log Message before it has an id: where it came from in the pi-durable transcript. */
export interface LogDraft {
  readonly entryId: string
  /** Position of this message among those projected from the same entry. */
  readonly part: number
  readonly kind: Kind
  readonly text: string
  readonly date: string
}

/**
 * Durable storage for OptChat's derived state: the Log index (projected from the transcript)
 * and the Summary Tree. Writes are synchronous and atomic per call.
 */
export interface OptChatStoreShape {
  /** Append drafts in order; drafts whose (entryId, part) is already logged are skipped. */
  readonly append: (drafts: ReadonlyArray<LogDraft>) => Effect.Effect<ReadonlyArray<LogMessage>>
  readonly count: Effect.Effect<number>
  /** Every Log Message without its text, in order (loaded once at start). */
  readonly metas: Effect.Effect<ReadonlyArray<LogMeta>>
  /** One Log Message with its text, read from storage. */
  readonly message: (i: number) => Effect.Effect<LogMessage | undefined>
  /** Log id of the first message projected from `entryId`. */
  readonly firstOf: (entryId: string) => Effect.Effect<number | undefined>
  /** Entries already projected (for catching up after a restart). */
  readonly projectedEntries: Effect.Effect<ReadonlySet<string>>
  readonly putNode: (node: Node) => Effect.Effect<void>
  readonly nodes: Effect.Effect<ReadonlyArray<Node>>
  /** The Memory View text frozen for a Run, keyed by the Run's first input entry. */
  readonly runView: (entryId: string) => Effect.Effect<ReadonlyArray<string> | undefined>
  readonly putRunView: (entryId: string, pieces: ReadonlyArray<string>) => Effect.Effect<void>
  /** The saved views ("chat" and "compact"): kept across restarts, never rebuilt from the Log. */
  readonly loadView: (name: string) => Effect.Effect<ViewState | undefined>
  readonly saveView: (name: string, state: ViewState) => Effect.Effect<void>
}

export class OptChatStore extends Context.Service<OptChatStore, OptChatStoreShape>()("optchat/OptChatStore") {
  /** Everything in memory: for tests and local runs. */
  static readonly memory = Layer.sync(OptChatStore, () => {
    const messages: LogMessage[] = []
    const origin = new Map<string, number>()
    const firsts = new Map<string, number>()
    const nodes = new Map<string, Node>()
    const runViews = new Map<string, ReadonlyArray<string>>()
    const views = new Map<string, ViewState>()
    return OptChatStore.of({
      append: (drafts) =>
        Effect.sync(() => {
          const added: LogMessage[] = []
          for (const draft of drafts) {
            const k = `${draft.entryId}#${draft.part}`
            if (origin.has(k)) continue
            const message = makeMessage(messages.length, draft)
            messages.push(message)
            origin.set(k, message.i)
            if (!firsts.has(draft.entryId)) firsts.set(draft.entryId, message.i)
            added.push(message)
          }
          return added
        }),
      count: Effect.sync(() => messages.length),
      metas: Effect.sync(() => messages.map(({ text: _, ...meta }) => meta)),
      message: (i) => Effect.sync(() => messages[i]),
      firstOf: (entryId) => Effect.sync(() => firsts.get(entryId)),
      projectedEntries: Effect.sync(() => new Set(firsts.keys())),
      putNode: (node) => Effect.sync(() => void nodes.set(`${node.l}:${node.i}`, node)),
      nodes: Effect.sync(() => [...nodes.values()]),
      runView: (entryId) => Effect.sync(() => runViews.get(entryId)),
      putRunView: (entryId, pieces) => Effect.sync(() => void runViews.set(entryId, pieces)),
      loadView: (name) => Effect.sync(() => views.get(name)),
      saveView: (name, state) => Effect.sync(() => void views.set(name, state))
    })
  })
}


export const makeMessage = (i: number, draft: LogDraft): LogMessage => ({
  i,
  kind: draft.kind,
  text: draft.text,
  size: sizeOf(draft.kind, draft.text),
  date: draft.date
})
