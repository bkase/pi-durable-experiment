import type { Message } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { Layer } from "effect"
import { describe, expect, it } from "vitest"
import { openApp } from "../../src/do/app.ts"
import { ChatGPT } from "../../src/models/chatgpt.ts"
import { MASTER_MODEL, MasterModels, mockCompactor, mockMaster, PROVIDER } from "../../src/models/models.ts"
import { SYSTEM } from "../../src/optchat/prompts.ts"
import { nodeDoStorage } from "../support/node-do-storage.ts"

/** Mock models that record every request the Master receives. */
const recording = (requests: Message[][]) =>
  Layer.sync(MasterModels, () => {
    const models = createModels()
    const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MASTER_MODEL, reasoning: true }] })
    const respond = (context: { messages: ReadonlyArray<Message> }) => {
      requests.push([...context.messages])
      faux.appendResponses([respond])
      return mockMaster(context.messages)
    }
    faux.setResponses([respond])
    models.setProvider(faux.provider)
    return MasterModels.of({ models, master: { provider: PROVIDER, modelId: MASTER_MODEL } })
  })

describe("what the Master receives", () => {
  it("every Run: one system message with the prompt and tools, then the Memory View and the new input only", async () => {
    const requests: Message[][] = []
    const app = await openApp({
      storage: nodeDoStorage(),
      workspace: {} as never,
      exec: false,
      models: (kv) => Layer.mergeAll(recording(requests), mockCompactor, ChatGPT.layer(kv)),
      onError: (e) => console.error(e)
    })
    await app.setInstructions("Call me Brandon.")
    for (const text of ["one", "two", "three"]) {
      await app.input(text)
      await app.settle(10_000)
    }
    expect(requests.length).toBe(3)
    for (const request of requests) {
      const [system, ...rest] = request
      expect(system!.role).toBe("system")
      if (system!.role !== "system") throw new Error()
      const sections = Object.values(system!.sections ?? {}).join("\n")
      expect(sections).toContain(SYSTEM)
      expect(sections).toContain("Call me Brandon.")
      expect((system!.toolsAdded ?? []).map((t) => t.name).sort()).toEqual(expect.arrayContaining(["date", "zoom"]))
      expect(rest.length).toBe(1)
      expect(rest.filter((m) => m.role === "system")).toEqual([])
    }
    // The prompt and tools are byte-identical across Runs: they head every cached prefix.
    expect(JSON.stringify({ ...requests[1]![0], timestamp: 0 })).toBe(JSON.stringify({ ...requests[2]![0], timestamp: 0 }))
    const third = requests[2]![1]!
    if (third.role !== "user" || typeof third.content === "string") throw new Error("expected blocks")
    const blocks = third.content.map((b) => (b.type === "text" ? b.text : ""))
    expect(blocks[blocks.length - 1]).toBe("three")
    expect(blocks.slice(0, -1).join("")).toBe(
      "<chat>\n0+1|user: one\n1+1|talk: (mock) heard: one — the view I was given has 0 lines.\n2+1|user: two\n3+1|talk: (mock) heard: two — the view I was given has 2 lines.\n</chat>"
    )
  }, 30_000)

  it("within a Run, later Turns append to the same request (the frozen view stays put)", async () => {
    const requests: Message[][] = []
    const app = await openApp({
      storage: nodeDoStorage(),
      workspace: {} as never,
      exec: false,
      models: (kv) => Layer.mergeAll(recording(requests), mockCompactor, ChatGPT.layer(kv)),
      onError: (e) => console.error(e)
    })
    await app.input("first")
    await app.settle(10_000)
    await app.input("/mock zoom 0 1")
    await app.settle(10_000)
    const [turn1, turn2] = requests.slice(1)
    expect(turn1!.map((m) => m.role)).toEqual(["system", "user"])
    expect(turn2!.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"])
    expect(JSON.stringify(turn2!.slice(0, 2))).toBe(JSON.stringify(turn1))
  }, 30_000)
})
