// Replay N synthetic messages through the real Memory service (mock Compactor) and measure what the
// OptChat spec measured: view size, line count, and how much of consecutive views is shared (the
// cacheable prefix). Run: node scripts/simulate.ts [messages]
import { Effect, Layer } from "effect"
import { mockCompactor } from "../src/models/models.ts"
import { CompactorModel, Memory } from "../src/optchat/memory.ts"
import { type LogDraft, OptChatStore } from "../src/optchat/store.ts"

const N = Number(process.argv[2] ?? 3000)
const kinds = ["user", "talk", "tool", "echo", "echo", "tool", "echo", "talk"] as const
const sizes = { user: 300, talk: 700, tool: 150, echo: 2500 }

let compactorCalls = 0
const counting = Layer.effect(
  CompactorModel,
  Effect.gen(function*() {
    const inner = yield* CompactorModel
    return CompactorModel.of({
      complete: (request) =>
        Effect.suspend(() => {
          compactorCalls++
          return inner.complete(request)
        })
    })
  })
).pipe(Layer.provide(mockCompactor))

const program = Effect.gen(function*() {
  const memory = yield* Memory
  let previous = ""
  const shared: number[] = []
  const reads: number[] = []
  for (let k = 0; k < N; k++) {
    const kind = kinds[k % kinds.length]!
    const draft: LogDraft = {
      entryId: `e${k}`,
      part: 0,
      kind,
      text: `${kind} #${k}: ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(sizes[kind] / 27))}`.slice(0, sizes[kind]),
      date: new Date(1_790_000_000_000 + k * 60_000).toISOString()
    }
    yield* memory.append([draft])
    if (kind === "user") {
      yield* memory.settle(k + 1)
      const pieces = yield* memory.render(k)
      const view = pieces.join("")
      let p = 0
      while (p < previous.length && p < view.length && previous[p] === view[p]) p++
      if (previous.length > 0) {
        shared.push(p)
        reads.push(p / view.length)
      }
      previous = view
    }
    if ((k + 1) % 1000 === 0 || k + 1 === N) {
      yield* memory.settle(k + 1)
      const s = yield* memory.status
      const recent = shared.slice(-125)
      const avg = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length)
      const recentReads = reads.slice(-125)
      const hit = recentReads.reduce((a, b) => a + b, 0) / Math.max(1, recentReads.length)
      console.log(
        `T=${String(s.T).padStart(6)}  view=${(s.viewBytes / 1000).toFixed(1).padStart(6)} KB  lines=${
          String(s.viewLines).padStart(4)
        }  compactor calls/msg=${(compactorCalls / s.T).toFixed(2)}  batches=${String(s.batches).padStart(3)}  view reused from the previous Run (last 125 Runs)=${
          (100 * hit).toFixed(1)
        }% (${(avg / 1000).toFixed(1)}k chars)`
      )
    }
  }
})

await Effect.runPromise(
  program.pipe(Effect.provide(Memory.layer.pipe(Layer.provide(Layer.mergeAll(OptChatStore.memory, counting)))))
)
