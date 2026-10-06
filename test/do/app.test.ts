import { describe, expect, it } from "vitest"
import { type App, openApp } from "../../src/do/app.ts"
import { MockModels } from "../../src/models/models.ts"
import { nodeDoStorage } from "../support/node-do-storage.ts"

/** The Log, one line per message, via zoom(i, 1). */
const log = async (app: App) => {
  const { memory } = await app.status()
  const lines: string[] = []
  for (let i = 0; i < memory.T; i++) lines.push((await app.zoom(i, 1)).replace(/^\d+\+0\|/, ""))
  return lines
}

const open = (storage = nodeDoStorage()) =>
  openApp({
    storage,
    workspace: {} as never,
    exec: false,
    models: MockModels,
    onError: (e) => console.error(e)
  })

describe("Chat app (mock models)", () => {
  it("runs each message as a fresh Run over the Memory View and logs everything", async () => {
    const app = await open()
    await app.input("hello there")
    await app.settle(10_000)
    expect(await log(app)).toEqual([
      "user: hello there",
      "talk: (mock) heard: hello there — the view I was given has 0 lines."
    ])

    await app.input("and again")
    await app.settle(10_000)
    const lines = await log(app)
    expect(lines[3]).toBe("talk: (mock) heard: and again — the view I was given has 2 lines.")
  }, 30_000)

  it("gives the Master zoom and date as tools", async () => {
    const app = await open()
    await app.input("remember the number 42")
    await app.settle(10_000)
    await app.input("/mock zoom 0 1")
    await app.settle(10_000)
    const lines = await log(app)
    expect(lines).toContain(`tool: zoom {"id":0,"n":1}`)
    expect(lines.find((l) => l.startsWith("echo: zoom:"))).toContain("user: remember the number 42")
    expect(lines[lines.length - 1]).toMatch(/^talk: \(mock\) zoom returned: 0\+0\|user: remember the number 42/)
  }, 30_000)

  it("logs webhook deliveries as Events, once per delivery id", async () => {
    const app = await open()
    expect(await app.event("github", "d-1", "CI failed on main")).toBe("queued")
    expect(await app.event("github", "d-1", "CI failed on main")).toBe("duplicate")
    await app.settle(10_000)
    const lines = await log(app)
    expect(lines[0]).toBe("event: [github] CI failed on main")
    expect(lines[1]).toMatch(/^talk: \(mock\) heard: CI failed on main/)
  }, 30_000)

  it("keeps the Log and the tree across a restart without logging anything twice", async () => {
    const storage = nodeDoStorage()
    const first = await open(storage)
    await first.input("before restart")
    await first.settle(10_000)
    const before = await log(first)

    const second = await open(storage)
    expect(await log(second)).toEqual(before)
    await second.input("after restart")
    await second.settle(10_000)
    const after = await log(second)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after[after.length - 1]).toBe("talk: (mock) heard: after restart — the view I was given has 2 lines.")
  }, 30_000)

  it("stores and applies the user's Standing Instructions", async () => {
    const app = await open()
    await app.setInstructions("Always answer in haiku.")
    expect(await app.instructions()).toBe("Always answer in haiku.")
    await app.setInstructions("")
    expect(await app.instructions()).toBe("")
  }, 30_000)
})
