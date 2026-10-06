import { describe, expect, it } from "vitest"
import { bytes, NODE } from "../../src/optchat/constants.ts"
import { SCALE } from "../../src/optchat/prompts.ts"
import { makeNode, NodeIndex, parseName, span } from "../../src/optchat/tree.ts"
import { MemoryView, renderPieces } from "../../src/optchat/view.ts"

/** Build every node over T messages with fixed-size text, as an always-caught-up Compactor would. */
const fullTree = (T: number, size = 200) => {
  const tree = new NodeIndex()
  for (let l = 0; span(l) <= T; l++) {
    for (let i = 0; (i + 1) * span(l) <= T; i++) tree.put(makeNode(l, i, `${l}:${i} `.padEnd(size, "x")))
  }
  return tree
}

describe("tree addressing", () => {
  it("names nodes by first message and count", () => {
    expect(parseName(2184, 8)).toEqual({ l: 3, i: 273 })
    expect(parseName(2185, 8)).toBeUndefined()
    expect(parseName(0, 3)).toBeUndefined()
  })

  it("SCALE is exactly NODE bytes", () => {
    expect(bytes(SCALE)).toBe(NODE)
  })
})

describe("MemoryView", () => {
  it("keeps every message as its own line while under budget", () => {
    const tree = fullTree(10)
    const view = MemoryView.fold(tree, 10)
    expect(view.lines.length).toBe(10)
    expect(view.renderLines()[3]).toMatch(/^3\+1\|0:3 /)
  })

  it("stays under budget, tiles [0, T), and is coarser for older messages", () => {
    const T = 3000
    const tree = fullTree(T)
    const view = MemoryView.fold(tree, T, 20_000)
    expect(view.size).toBeLessThanOrEqual(20_000)
    let next = 0
    for (const part of view.lines) {
      expect(part.i * span(part.l)).toBe(next)
      next += span(part.l)
    }
    expect(next).toBe(T)
    const levels = view.lines.map((p) => p.l)
    expect(levels[0]).toBeGreaterThan(levels[levels.length - 1]!)
  })

  it("changes only near its end from one message to the next (cacheable)", () => {
    const T = 4000
    const tree = fullTree(T + 1)
    const before = MemoryView.fold(tree, T, 20_000).renderLines().join("\n")
    const after = MemoryView.fold(tree, T + 1, 20_000).renderLines().join("\n")
    let shared = 0
    while (shared < before.length && before[shared] === after[shared]) shared++
    expect(shared / before.length).toBeGreaterThan(0.5)
  })

  it("never splits a merged line", () => {
    const tree = fullTree(2000)
    const view = new MemoryView(tree, 10_000)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      view.append(i)
      const now = new Set(view.lines.map((p) => `${p.l}:${p.i}`))
      for (const k of seen) {
        const [l, i0] = k.split(":").map(Number) as [number, number]
        const covered = [...now].some((n) => {
          const [l2, i2] = n.split(":").map(Number) as [number, number]
          return l2 >= l && Math.floor((i0 * span(l)) / span(l2)) === i2
        })
        expect(covered).toBe(true)
      }
      for (const k of now) seen.add(k)
    }
  })

  it("waits instead of merging when parents are not built", () => {
    const tree = new NodeIndex()
    for (let i = 0; i < 100; i++) tree.put(makeNode(0, i, "y".repeat(300)))
    const view = MemoryView.fold(tree, 100, 10_000)
    expect(view.lines.length).toBe(100)
    expect(view.size).toBeGreaterThan(10_000)
  })

  it("reports the first unsummarized line", () => {
    const tree = new NodeIndex()
    tree.put(makeNode(0, 0, "a"))
    const view = MemoryView.fold(tree, 3)
    expect(view.first()).toBe(1)
    expect(view.settledBefore(1)).toBe(true)
    expect(view.settledBefore(2)).toBe(false)
    expect(view.renderLines()[1]).toBe("1+1|(not summarized yet: zoom it)")
  })
})

describe("renderPieces", () => {
  it("cuts at line ends before each mark and joins back to the whole", () => {
    const lines = Array.from({ length: 600 }, (_, k) => `${k}+1|${"z".repeat(250)}`)
    const pieces = renderPieces(lines)
    expect(pieces.length).toBe(4)
    expect(pieces.join("")).toBe(`<chat>\n${lines.join("\n")}\n</chat>`)
    expect(pieces[0]!.length).toBeLessThanOrEqual(50_000)
    for (const p of pieces.slice(0, -1)) expect(p.endsWith("\n")).toBe(true)
  })

  it("skips marks past the end", () => {
    expect(renderPieces(["0+1|a"])).toEqual(["<chat>\n0+1|a\n</chat>"])
  })
})
