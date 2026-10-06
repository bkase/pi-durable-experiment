import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { bytes, NODE } from "../../src/optchat/constants.ts"
import { CompactorModel, Memory, ModelError } from "../../src/optchat/memory.ts"
import { OptChatStore, type LogDraft } from "../../src/optchat/store.ts"

const date = "2026-10-06T00:00:00.000Z"
const draft = (entryId: string, text: string, kind: LogDraft["kind"] = "user"): LogDraft => ({
  entryId,
  part: 0,
  kind,
  text,
  date
})

interface Call {
  readonly system: string
  readonly turns: ReadonlyArray<{ role: string; content: ReadonlyArray<string> }>
}

/** A Compactor that answers with a short line naming what it saw, recording every call. */
const recordingCompactor = (calls: Call[], reply: (call: Call) => string = () => "summary") =>
  Layer.succeed(CompactorModel)({
    complete: (system, turns) =>
      Effect.sync(() => {
        const call = { system, turns }
        calls.push(call)
        return reply(call)
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

  it.effect("long messages are compressed with the view as context and no ids", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "short one"), draft("b", "x".repeat(2000))])
      yield* memory.settle(2)
      assert.strictEqual(calls.length, 1)
      const [context, step] = calls[0]!.turns[0]!.content
      assert.strictEqual(context, "<chat>\nuser: short one\n</chat>")
      assert.isTrue(step!.startsWith(`For scale, this line is exactly ${NODE} bytes:`))
      assert.include(step!, "Compress this message into one line")
      assert.notInclude(step!, "1+1|")
      const lines = (yield* memory.render(2)).join("")
      assert.include(lines, "1+1|summary")
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
      assert.include(last[2]!.content[0]!, "That line is 700 bytes; the limit is 512.")
      assert.include(last[2]!.content[0]!, "| ← LIMIT")
      const zoomed = yield* memory.render(1)
      assert.include(zoomed.join(""), `0+1|${"y".repeat(515)}`)
    }).pipe(Effect.provide(memoryWith(recordingCompactor(calls, () => replies[calls.length - 1]!))))
  })

  it.effect("merges into parents and keeps the view under budget", () => {
    const calls: Call[] = []
    return Effect.gen(function*() {
      const memory = yield* Memory
      const drafts = Array.from({ length: 600 }, (_, k) => draft(`e${k}`, `message ${k} `.padEnd(400, ".")))
      yield* memory.append(drafts)
      yield* memory.settle(600)
      yield* memory.idle
      const status = yield* memory.status
      assert.strictEqual(status.T, 600)
      assert.strictEqual(status.first, 600)
      assert.isTrue(status.viewBytes <= 128_000)
      for (const call of calls) assert.isTrue(bytes(call.turns[0]!.content[0]!) > 0)
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

  it.live("retries a failing node until it succeeds", () => {
    let failures = 2
    const flaky = Layer.succeed(CompactorModel)({
      complete: () =>
        failures-- > 0 ? Effect.fail(new ModelError({ message: "rate limited" })) : Effect.succeed("ok")
    })
    return Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "q".repeat(1000))])
      yield* memory.settle(1)
      assert.include((yield* memory.render(1)).join(""), "0+1|ok")
    }).pipe(Effect.provide(memoryWith(flaky)))
  }, { timeout: 40_000 })

  it.effect("rejects bad zooms", () =>
    Effect.gen(function*() {
      const memory = yield* Memory
      yield* memory.append([draft("a", "one")])
      assert.strictEqual(yield* memory.zoom(1, 1), "No line 1+1.")
      assert.strictEqual(yield* memory.zoom(0, 3), "No line 0+3.")
    }).pipe(Effect.provide(memoryWith(recordingCompactor([])))))
})
