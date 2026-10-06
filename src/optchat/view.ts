import { bytes, MARKS, PLACEHOLDER, VIEW } from "./constants.ts"
import { name, start, type TreeReader } from "./tree.ts"

/** One line of the Memory View: tree node (l, i). */
export interface Part {
  readonly l: number
  readonly i: number
}

const PLACEHOLDER_SIZE = bytes(PLACEHOLDER)

/**
 * The Memory View: tree nodes tiling the whole Log [0, T), oldest first, kept under a byte budget.
 * It only ever appends at the end and merges the most due adjacent pair; it never splits.
 */
export class MemoryView {
  private parts: Part[] = []
  private total = 0
  private count = 0

  constructor(
    private readonly tree: TreeReader,
    private readonly budget: number = VIEW
  ) {}

  /** Number of Log Messages the view covers. */
  get T(): number {
    return this.count
  }

  get size(): number {
    return this.total
  }

  get lines(): ReadonlyArray<Part> {
    return this.parts
  }

  private partSize(part: Part): number {
    return this.tree.get(part.l, part.i)?.size ?? PLACEHOLDER_SIZE
  }

  /** Message `i` entered the Log. Messages must arrive in order. */
  append(i: number): void {
    if (i !== this.count) throw new Error(`MemoryView.append: expected message ${this.count}, got ${i}`)
    const part = { l: 0, i }
    this.parts.push(part)
    this.count += 1
    this.total += this.partSize(part)
    this.fit()
  }

  /** A node was built: its size may have changed, and a merge may now be possible. */
  built(): void {
    this.total = this.parts.reduce((sum, part) => sum + this.partSize(part), 0)
    this.fit()
  }

  private fit(): void {
    const T = this.count
    while (this.total > this.budget) {
      let best = -1
      let bestDue = -Infinity
      for (let k = 0; k + 1 < this.parts.length; k++) {
        const a = this.parts[k]!
        const b = this.parts[k + 1]!
        if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue
        if (this.tree.get(a.l + 1, a.i / 2) === undefined) continue
        const due = (T - start(a.l, a.i)) / 2 ** (a.l + 2)
        if (due > bestDue) {
          bestDue = due
          best = k
        }
      }
      if (best < 0) break
      const a = this.parts[best]!
      const b = this.parts[best + 1]!
      const parent = { l: a.l + 1, i: a.i / 2 }
      this.total += this.partSize(parent) - this.partSize(a) - this.partSize(b)
      this.parts.splice(best, 2, parent)
    }
  }

  /** First message whose view line is not yet a summary; T when every line is built. */
  first(): number {
    for (const part of this.parts) {
      if (this.tree.get(part.l, part.i) === undefined) return start(part.l, part.i)
    }
    return this.count
  }

  /** Every line covering messages before `end` is a summary. */
  settledBefore(end: number): boolean {
    for (const part of this.parts) {
      if (start(part.l, part.i) >= end) return true
      if (this.tree.get(part.l, part.i) === undefined) return false
    }
    return true
  }

  /** The `id+n|text` lines covering messages before `end` (default: all). */
  renderLines(end: number = this.count): string[] {
    const out: string[] = []
    for (const part of this.parts) {
      if (start(part.l, part.i) >= end) break
      const text = this.tree.get(part.l, part.i)?.text ?? PLACEHOLDER
      out.push(`${name(part.l, part.i)}|${text.replace(/\n/g, " ")}`)
    }
    return out
  }

  /** Rebuild from message 0, as at load. */
  static fold(tree: TreeReader, T: number, budget: number = VIEW): MemoryView {
    const view = new MemoryView(tree, budget)
    for (let i = 0; i < T; i++) view.append(i)
    return view
  }
}

/**
 * The rendered `<chat>` block, cut into cacheable pieces at the last line end before each mark.
 * Joining the pieces gives the whole block.
 */
export const renderPieces = (lines: ReadonlyArray<string>, marks: ReadonlyArray<number> = MARKS): string[] => {
  const whole = `<chat>\n${lines.map((l) => `${l}\n`).join("")}</chat>`
  const pieces: string[] = []
  let from = 0
  for (const mark of marks) {
    if (mark >= whole.length) break
    const cut = whole.lastIndexOf("\n", mark - 1)
    if (cut < from) continue
    pieces.push(whole.slice(from, cut + 1))
    from = cut + 1
  }
  pieces.push(whole.slice(from))
  return pieces
}

