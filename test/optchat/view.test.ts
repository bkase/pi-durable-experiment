import { describe, expect, it } from "vitest"
import { bytes } from "../../src/optchat/constants.ts"
import { RULER } from "../../src/optchat/prompts.ts"
import { makeNode, name, NodeIndex, parseName, span } from "../../src/optchat/tree.ts"
import { MemoryView, renderPieces } from "../../src/optchat/view.ts"

/** Every node over T messages built, with fixed-size text, as an always-caught-up Compactor would. */
const fullTree = (T: number, size = 200) => {
  const tree = new NodeIndex()
  for (let l = 0; span(l) <= T; l++) {
    for (let i = 0; (i + 1) * span(l) <= T; i++) tree.put(makeNode(l, i, `${l}:${i} `.padEnd(size, "x").slice(0, size)))
  }
  return tree
}

type Push = { keep: 0 | 1; state: number; older: Push | null } | null

/** Taelin's rollback push (rollback_state_list.js, 2022), with `life` fixed at 0. */
const push = (state: number, states: Push): Push =>
  states === null
    ? { keep: 0, state, older: null }
    : states.keep === 0
    ? { ...states, keep: 1 }
    : { keep: 0, state, older: push(states.state, states.older) }

/** Push's list read as a view: each state starts a line running to the next newer state. */
const pushLines = (states: Push, T: number): string[] => {
  const starts: number[] = []
  for (let s = states; s !== null; s = s.older) starts.push(s.state)
  starts.reverse()
  return starts.map((s, k) => `${s}+${(starts[k + 1] ?? T) - s}`)
}

describe("tree addressing", () => {
  it("names nodes by first message and count", () => {
    expect(name(3, 5)).toBe("40+8")
    expect(parseName(40, 8)).toEqual({ l: 3, i: 5 })
    expect(parseName(41, 8)).toBeUndefined()
    expect(parseName(0, 3)).toBeUndefined()
  })

  it("the ruler is exactly 512 bytes", () => {
    expect(bytes(RULER)).toBe(512)
  })
})

describe("MemoryView merge order", () => {
  it("picks exactly the merges Taelin's push makes, with push's length as the budget", () => {
    const N = 3000
    const tree = fullTree(N, 1)
    const view = new MemoryView(tree, Infinity, Infinity)
    let states: Push = null
    for (let t = 0; t < N; t++) {
      states = push(t, states)
      view.append(t)
      const expected = pushLines(states, t + 1)
      view.mergeDownTo(expected.length)
      const actual = view.lines.map((p) => name(p.l, p.i))
      if (actual.join() !== expected.join()) throw new Error(`t=${t}: view ${actual} vs push ${expected}`)
    }
  })

  it("merges the pair that ended longest ago, not the one that started longest ago (the cache bug)", () => {
    const tree = fullTree(10, 1)
    const view = new MemoryView(tree, Infinity, Infinity)
    for (let t = 0; t < 10; t++) view.append(t)
    view.mergeDownTo(4)
    expect(view.lines.map((p) => name(p.l, p.i))).toEqual(["0+4", "4+4", "8+1", "9+1"])
    view.mergeDownTo(3)
    expect(view.lines.map((p) => name(p.l, p.i))).toEqual(["0+4", "4+4", "8+2"])
  })
})

describe("MemoryView sawtooth", () => {
  it("only grows at its end between batches, and each batch drops it to the low mark", () => {
    const T = 4000
    const tree = fullTree(T)
    const view = new MemoryView(tree, 20_000, 10_000)
    let before = ""
    let batches = 0
    let maxSize = 0
    for (let i = 0; i < T; i++) {
      const merged = view.append(i)
      const now = view.renderLines().join("\n")
      if (merged > 0) {
        batches++
        expect(view.size).toBeLessThanOrEqual(10_000)
      } else if (before.length > 0) {
        expect(now.startsWith(before)).toBe(true)
      }
      maxSize = Math.max(maxSize, view.size)
      before = now
    }
    expect(batches).toBeGreaterThan(5)
    expect(maxSize).toBeLessThanOrEqual(20_000 + 200)
  })

  it("tiles [0, T) and is coarser for older messages", () => {
    const T = 3000
    const view = MemoryView.fold(fullTree(T), T, 20_000, 10_000)
    let next = 0
    for (const part of view.lines) {
      expect(part.i * span(part.l)).toBe(next)
      next += span(part.l)
    }
    expect(next).toBe(T)
    expect(view.lines[0]!.l).toBeGreaterThan(view.lines[view.lines.length - 1]!.l)
  })

  it("never splits a merged line", () => {
    const tree = fullTree(2000)
    const view = new MemoryView(tree, 10_000, 5_000)
    const seen = new Set<string>()
    const lineAt = (message: number) => {
      let lo = 0
      let hi = view.lines.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        const p = view.lines[mid]!
        if (p.i * span(p.l) <= message) lo = mid
        else hi = mid - 1
      }
      return view.lines[lo]!
    }
    let split = 0
    for (let i = 0; i < 2000; i++) {
      view.append(i)
      if (i % 50 !== 49) continue
      for (const k of seen) {
        const [l, i0] = k.split(":").map(Number) as [number, number]
        if (lineAt(i0 * span(l)).l < l) split++
      }
      for (const p of view.lines) seen.add(`${p.l}:${p.i}`)
    }
    expect(split).toBe(0)
  })

  it("keeps merging at each message until it reaches the low mark when parents weren't built", () => {
    const tree = new NodeIndex()
    for (let i = 0; i < 100; i++) tree.put(makeNode(0, i, "y".repeat(300)))
    const view = new MemoryView(tree, 10_000, 5_000)
    for (let i = 0; i < 100; i++) view.append(i)
    expect(view.size).toBeGreaterThan(10_000)
    for (let i = 0; i < 100; i += 2) tree.put(makeNode(1, i / 2, "z".repeat(100)))
    tree.put(makeNode(0, 100, "y"))
    view.built()
    view.append(100)
    // Every pair whose parent is built merged; the rest waits for its parents.
    expect(view.lines.length).toBe(51)
    expect(view.size).toBe(50 * 100 + 1)
  })

  it("restores exactly what it saved", () => {
    const tree = fullTree(500)
    const view = new MemoryView(tree, 20_000, 10_000)
    for (let i = 0; i < 400; i++) view.append(i)
    const restored = MemoryView.restore(tree, JSON.parse(JSON.stringify(view.save())), 20_000, 10_000)
    expect(restored.renderLines()).toEqual(view.renderLines())
    for (let i = 400; i < 500; i++) {
      view.append(i)
      restored.append(i)
    }
    expect(restored.renderLines()).toEqual(view.renderLines())
  })

  it("reports the first unsummarized line and unbuilt lines before a message", () => {
    const tree = new NodeIndex()
    tree.put(makeNode(0, 0, "a"))
    const view = new MemoryView(tree)
    for (let i = 0; i < 3; i++) view.append(i)
    expect(view.first()).toBe(1)
    expect(view.settledBefore(1)).toBe(true)
    expect(view.settledBefore(2)).toBe(false)
    expect(view.unbuiltBefore(3)).toBe(2)
    expect(view.renderLines()[1]).toBe("1+1|(not summarized yet: zoom it)")
    expect(view.contextLines(3)).toEqual(["0+1|a"])
  })
})

describe("renderPieces", () => {
  it("cuts the view into whole blocks of 4 lines, then the rest with the closing tag", () => {
    const lines = Array.from({ length: 10 }, (_, k) => `${k}+1|line ${k}`)
    const pieces = renderPieces(lines)
    expect(pieces.length).toBe(3)
    expect(pieces[0]).toBe("<chat>\n0+1|line 0\n1+1|line 1\n2+1|line 2\n3+1|line 3\n")
    expect(pieces[2]).toBe("8+1|line 8\n9+1|line 9\n</chat>")
    expect(pieces.join("")).toBe(`<chat>\n${lines.join("\n")}\n</chat>`)
  })

  it("keeps whole blocks byte-identical as the view grows (the cached prefix)", () => {
    const lines = Array.from({ length: 13 }, (_, k) => `${k}+1|x`)
    const a = renderPieces(lines.slice(0, 10))
    const b = renderPieces(lines)
    expect(b.slice(0, 2)).toEqual(a.slice(0, 2))
  })

  it("handles an empty view", () => {
    expect(renderPieces([])).toEqual(["<chat>\n</chat>"])
  })
})
