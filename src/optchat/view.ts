import { bytes, PLACEHOLDER, VIEW_HIGH, VIEW_LOW } from "./constants.ts"
import { name, span, start, type TreeReader } from "./tree.ts"

/** One line of a view: tree node (l, i). */
export interface Part {
  readonly l: number
  readonly i: number
}

/** A view as it is persisted: its lines, how many messages it covers, and whether a batch is underway. */
export interface ViewState {
  readonly parts: ReadonlyArray<readonly [number, number]>
  readonly T: number
  readonly merging: boolean
}

const PLACEHOLDER_SIZE = bytes(PLACEHOLDER)

/**
 * A view: tree nodes tiling messages [0, T), oldest first (UniiChat spec §3).
 *
 * - Each new message appends its line; nothing else changes. So between batches, the last call's
 *   whole view is a prefix of the next call's, and the prompt cache holds.
 * - Once the view passes `high` bytes, one batch merges the most due sibling pairs (parents built)
 *   until it is at most `low` bytes. If parents aren't built yet, it keeps merging what it can at
 *   each new message until it gets there.
 * - Most due = `(T − last) / 2^l`, `last` being the pair's last message: how long ago the pair
 *   ended, in its own line size. Ties go to the oldest pair. This is Taelin's rollback push order.
 * - A merged line never splits.
 */
export class MemoryView {
  private parts: Part[] = []
  private total = 0
  private count = 0
  private merging = false

  constructor(
    private readonly tree: TreeReader,
    readonly high: number = VIEW_HIGH,
    readonly low: number = VIEW_LOW
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

  /**
   * Message `i` entered the Log. Messages must arrive in order. Returns how many merges ran (a batch
   * rewrites the view from its first merged line on).
   */
  append(i: number): number {
    if (i !== this.count) throw new Error(`MemoryView.append: expected message ${this.count}, got ${i}`)
    const part = { l: 0, i }
    this.parts.push(part)
    this.count += 1
    this.total += this.partSize(part)
    if (this.total > this.high) this.merging = true
    return this.merging ? this.batch() : 0
  }

  /** A node was built: its line's size may have changed (placeholder → summary). */
  built(): void {
    this.total = this.parts.reduce((sum, part) => sum + this.partSize(part), 0)
  }

  /** Merge the most due pairs until the view is at most `low` bytes, or no parent is built. */
  private batch(): number {
    const merged = this.mergeDownTo(this.low)
    if (this.total <= this.low) this.merging = false
    return merged
  }

  /** Merge the most due pairs (parents built) until the view is at most `limit` bytes. */
  mergeDownTo(limit: number): number {
    let merged = 0
    while (this.total > limit) {
      const k = this.mostDue()
      if (k < 0) break
      this.mergeAt(k)
      merged++
    }
    return merged
  }

  private mostDue(): number {
    const T = this.count
    let best = -1
    let bestDue = -Infinity
    for (let k = 0; k + 1 < this.parts.length; k++) {
      const a = this.parts[k]!
      const b = this.parts[k + 1]!
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue
      if (this.tree.get(a.l + 1, a.i / 2) === undefined) continue
      const last = start(a.l, a.i) + 2 * span(a.l) - 1
      const due = (T - last) / span(a.l)
      if (due > bestDue) {
        bestDue = due
        best = k
      }
    }
    return best
  }

  private mergeAt(k: number) {
    const a = this.parts[k]!
    const b = this.parts[k + 1]!
    const parent = { l: a.l + 1, i: a.i / 2 }
    this.total += this.partSize(parent) - this.partSize(a) - this.partSize(b)
    this.parts.splice(k, 2, parent)
  }

  /** Start a fresh batch from `source`'s lines (the compaction view, re-derived from the chat view). */
  resetFrom(source: MemoryView): number {
    this.parts = source.parts.map((p) => ({ ...p }))
    this.count = source.count
    this.total = this.parts.reduce((sum, part) => sum + this.partSize(part), 0)
    this.merging = this.total > this.low
    return this.merging ? this.batch() : 0
  }

  /** First message whose line is not yet a summary; T when every line is built. */
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

  /** Unbuilt lines that start before message `end`. */
  unbuiltBefore(end: number): number {
    let n = 0
    for (const part of this.parts) {
      if (start(part.l, part.i) >= end) break
      if (this.tree.get(part.l, part.i) === undefined) n++
    }
    return n
  }

  /** The `id+n|text` lines covering messages before `end` (default: all). */
  renderLines(end: number = this.count): string[] {
    const out: string[] = []
    for (const part of this.parts) {
      if (start(part.l, part.i) >= end) break
      out.push(lineOf(part, this.tree))
    }
    return out
  }

  /**
   * The lines a compaction of a node ending at `end` sees: lines starting before `end`, stopping at
   * the first unbuilt one, so no call ever sees a placeholder.
   */
  contextLines(end: number): string[] {
    const out: string[] = []
    for (const part of this.parts) {
      if (start(part.l, part.i) >= end) break
      if (this.tree.get(part.l, part.i) === undefined) break
      out.push(lineOf(part, this.tree))
    }
    return out
  }

  save(): ViewState {
    return { parts: this.parts.map((p) => [p.l, p.i] as const), T: this.count, merging: this.merging }
  }

  static restore(tree: TreeReader, state: ViewState, high = VIEW_HIGH, low = VIEW_LOW): MemoryView {
    const view = new MemoryView(tree, high, low)
    view.parts = state.parts.map(([l, i]) => ({ l, i }))
    view.count = state.T
    view.merging = state.merging
    view.total = view.parts.reduce((sum, part) => sum + view.partSize(part), 0)
    return view
  }

  /** Build from message 0 by replaying appends: only for a Log that never had a saved view. */
  static fold(tree: TreeReader, T: number, high = VIEW_HIGH, low = VIEW_LOW): MemoryView {
    const view = new MemoryView(tree, high, low)
    for (let i = 0; i < T; i++) view.append(i)
    return view
  }
}

const lineOf = (part: Part, tree: TreeReader) =>
  `${name(part.l, part.i)}|${(tree.get(part.l, part.i)?.text ?? PLACEHOLDER).replace(/\n/g, " ")}`

/**
 * The `<chat>` block in cacheable pieces: whole blocks of `BLOCK` lines, then the rest with the
 * closing tag. A cache mark goes on the last whole block; joining the pieces gives the whole block.
 */
export const BLOCK = 4

export const renderPieces = (lines: ReadonlyArray<string>, block: number = BLOCK): string[] => {
  const pieces: string[] = []
  const whole = Math.floor(lines.length / block)
  for (let b = 0; b < whole; b++) {
    const text = lines.slice(b * block, (b + 1) * block).map((l) => `${l}\n`).join("")
    pieces.push(b === 0 ? `<chat>\n${text}` : text)
  }
  const rest = lines.slice(whole * block).map((l) => `${l}\n`).join("")
  pieces.push(whole === 0 ? `<chat>\n${rest}</chat>` : `${rest}</chat>`)
  return pieces
}
