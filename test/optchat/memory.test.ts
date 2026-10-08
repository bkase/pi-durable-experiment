import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { RULER } from "../../src/optchat/prompts.ts"
import { type CompactionRequest, CompactorModel, Memory, ModelError } from "../../src/optchat/memory.ts"
import { OptChatStore, type LogDraft } from "../../src/optchat/store.ts"

const date = "2026-10-06T00:00:00.000Z"
const draft = (entryId: string, text: string, kind: LogDraft["kind"] = "user"): LogDraft => ({
  entryId,
  part: 0,
  kind,
  text,
  date
})

type Call = CompactionRequest

/** A Compactor that answers with a fixed line, recording every call. */
const recordingCompactor = (calls: Call[], reply: (call: Call) => string = () => "summary") =>
  Layer.succeed(CompactorModel)({
    complete: (request) =>
      Effect.sync(() => {
        calls.push({ view: [...request.view], turns: request.turns.map((t) => ({ ...t, content: [...t.content] })) })
        return reply(request)
      })
  })

const memoryWith = (compactor: Layer.Layer<CompactorModel>) =>
  Memory.layer.pipe(Layer.provide(Layer.mergeAll(OptChatStore.memory, compactor)))

describe("Memory", () => {
  it.effect("short messages are their own nodes, with no model call", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "hi"), draft("b", "there", "talk")])
      yield* memory.settle(2)
      yield* memory.idle
      assert.strictEqual(calls.length, 0)
      assert.strictEqual(yield* memory.zoom(0, 2), "0+1|user: hi\n1+1|talk: there")
      assert.strictEqual(yield* memory.zoom(0, 1), "0+0|user: hi")
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls))))
  })

  it.effect("long messages are compressed with the compaction view as context and the ruler task", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "short one"), draft("b", "x".repeat(2000))])
      yield* memory.settle(2)
      assert.strictEqual(calls.length, 1)
      assert.deepStrictEqual(calls[0]!.view, ["<chat>\n0+1|user: short one\n</chat>"])
      const task = calls[0]!.turns[0]!.content[0]!
      assert.isTrue(task.startsWith("Compaction: compress message 1 into one line of at most 512 bytes"))
      assert.include(task, RULER)
      assert.include(task, `<input>\nuser: ${"x".repeat(2000)}\n</input>`)
      assert.include((yield* memory.render(2)).join(""), "1+1|summary")
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls))))
  })

  it.effect("asks again in the same conversation when a line is too long, keeping the shortest", () => {
    const calls: Call[] = []
    const replies = ["y".repeat(700), "y".repeat(600), "y".repeat(520), "y".repeat(530), "y".repeat(515)]
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "z".repeat(3000))])
      yield* memory.settle(1)
      assert.strictEqual(calls.length, 5)
      const last = calls[4]!.turns
      assert.strictEqual(last.length, 9)
      assert.include(last[2]!.content[0]!, "Too long: your line is 700 bytes, over the 512-byte limit.")
      assert.include(last[2]!.content[0]!, "| ← LIMIT")
      assert.include((yield* memory.render(1)).join(""), `0+1|${"y".repeat(515)}`)
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls, () => replies[calls.length - 1]!))))
  })

  it.effect("merges see lines up to their last message and name the lines they merge", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "p".repeat(600)), draft("b", "q".repeat(600))])
      yield* memory.settle(2)
      yield* memory.idle
      const merge = calls.find((c) => c.turns[0]!.content[0]!.startsWith("Compaction: merge"))!
      assert.include(merge.turns[0]!.content[0]!, "Compaction: merge lines 0+1 and 1+1, adjacent")
      assert.include(merge.turns[0]!.content[0]!, "<chat> may hold their messages, 0 to 1, in more detail")
      const L = "L".repeat(300)
      assert.deepStrictEqual(merge.view, [`<chat>\n0+1|${L}\n1+1|${L}\n</chat>`])
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls, () => "L".repeat(300)))))
  })

  it.effect("merges into parents in batches and keeps the view under its high mark", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      let peak = 0
      for (let k = 0; k < 1200; k++) {
        yield* memory.append([draft(`e${k}`, `message ${k} `.padEnd(400, "."))])
        yield* memory.idle
        peak = Math.max(peak, (yield* memory.status).viewBytes)
      }
      const status = yield* memory.status
      assert.strictEqual(status.T, 1200)
      assert.strictEqual(status.first, 1200)
      assert.isTrue(status.batches > 0)
      assert.isTrue(peak <= 128_000 + 600, `peak ${peak}`)
      assert.isTrue(status.compactionViewBytes <= 32_000 + 600, `compaction view ${status.compactionViewBytes}`)
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls, () => "m".repeat(300)))))
  })

  it.effect("ignores drafts already logged (projection is idempotent)", () =>
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "one")])
      const again = yield* memory.append([draft("a", "one"), draft("b", "two")])
      assert.strictEqual(again.length, 1)
      assert.strictEqual(yield* memory.count, 2)
    }).pipe(Effect.provide(memoryWith(recordingCompactor([])))))

  it.effect("retries a failed node when the next message arrives", () => {
    let failures = 2
    const flaky = Layer.succeed(CompactorModel)({
      complete: () => (failures-- > 0 ? Effect.fail(new ModelError({ message: "rate limited" })) : Effect.succeed("ok"))
    })
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "q".repeat(1000))])
      yield* memory.idle
      assert.strictEqual((yield* memory.status).failing, 1)
      yield* memory.append([draft("b", "next")])
      yield* memory.idle
      yield* memory.append([draft("c", "and next")])
      yield* memory.settle(1)
      assert.include((yield* memory.render(1)).join(""), "0+1|ok")
    }).pipe(Effect.provide(memoryWith(flaky)))
  })

  it.effect("rejects bad zooms", () =>
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "one")])
      assert.strictEqual(yield* memory.zoom(1, 1), "No line 1+1.")
      assert.strictEqual(yield* memory.zoom(0, 3), "No line 0+3.")
    }).pipe(Effect.provide(memoryWith(recordingCompactor([])))))
})
