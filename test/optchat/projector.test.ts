import { describe, expect, it } from "vitest"
import { CAP } from "../../src/optchat/constants.ts"
import { projectEntry } from "../../src/optchat/projector.ts"

const t = 1_790_000_000_000

describe("projectEntry", () => {
  it("logs user input word for word", () => {
    const drafts = projectEntry({ id: "e1", kind: "pi.user", model: [{ role: "user", content: "hello", timestamp: t }] })
    expect(drafts).toEqual([{ entryId: "e1", part: 0, kind: "user", text: "hello", date: new Date(t).toISOString() }])
  })

  it("marks Events with their source and never as the user's words", () => {
    const drafts = projectEntry(
      { id: "e2", kind: "pi.user", model: [{ role: "user", content: "deploy failed", timestamp: t }] },
      "github"
    )
    expect(drafts.map((d) => [d.kind, d.text])).toEqual([["event", "[github] deploy failed"]])
  })

  it("splits an assistant response into talk and tool messages, dropping thinking", () => {
    const drafts = projectEntry({
      id: "e3",
      kind: "pi.assistant",
      model: [{
        role: "assistant",
        stopReason: "toolUse",
        timestamp: t,
        content: [
          { type: "thinking" },
          { type: "text", text: "Let me look." },
          { type: "toolCall", name: "read", arguments: { path: "/a.md" } },
          { type: "toolCall", name: "zoom", arguments: { id: 0, n: 4 } }
        ]
      }]
    })
    expect(drafts.map((d) => [d.part, d.kind, d.text])).toEqual([
      [0, "talk", "Let me look."],
      [1, "tool", `read {"path":"/a.md"}`],
      [2, "tool", `zoom {"id":0,"n":4}`]
    ])
  })

  it("caps tool results, keeping head and tail", () => {
    const big = "a".repeat(CAP) + "b".repeat(CAP)
    const [draft] = projectEntry({
      id: "e4",
      kind: "pi.tool-result",
      model: [{ role: "toolResult", toolName: "exec", isError: false, timestamp: t, content: [{ type: "text", text: big }] }]
    })
    expect(draft!.kind).toBe("echo")
    expect(draft!.text.length).toBeLessThanOrEqual(CAP)
    expect(draft!.text.startsWith("exec: aaa")).toBe(true)
    expect(draft!.text.endsWith("bbb")).toBe(true)
    expect(draft!.text).toContain("characters cut")
  })

  it("logs nothing for system entries", () => {
    expect(projectEntry({ id: "e5", kind: "pi.system", model: [{ role: "system", timestamp: t }] })).toEqual([])
  })
})
