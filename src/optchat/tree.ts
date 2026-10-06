import { bytes, NODE } from "./constants.ts"
import { line, type LogMessage } from "./log.ts"

/** One line of the Summary Tree: covers messages [i·2^l, (i+1)·2^l). */
export interface Node {
  readonly l: number
  readonly i: number
  readonly text: string
  readonly size: number
}

export const key = (l: number, i: number): string => `${l}:${i}`

export const span = (l: number): number => 2 ** l

/** First message covered by node (l, i). */
export const start = (l: number, i: number): number => i * span(l)

/** The `id+n` name the Master sees. */
export const name = (l: number, i: number): string => `${start(l, i)}+${span(l)}`

/** Tree coordinates of the name `id+n`, if it names an aligned power-of-two range. */
export const parseName = (id: number, n: number): { l: number; i: number } | undefined => {
  if (!Number.isInteger(id) || !Number.isInteger(n) || id < 0 || n < 1) return undefined
  const l = Math.log2(n)
  if (!Number.isInteger(l) || id % n !== 0) return undefined
  return { l, i: id / n }
}

export const makeNode = (l: number, i: number, text: string): Node => ({ l, i, text, size: bytes(text) })

/** A short message is its own level-0 node, word for word. */
export const freeLeaf = (message: LogMessage): Node | undefined => {
  const text = line(message.kind, message.text)
  return message.size <= NODE ? makeNode(0, message.i, text) : undefined
}

/** Two children that fit together are their parent, with no model call. */
export const freeMerge = (l: number, i: number, a: Node, b: Node): Node | undefined => {
  const text = `${a.text}\n${b.text}`
  return bytes(text) <= NODE ? makeNode(l, i, text) : undefined
}

/** Read access to built nodes. */
export interface TreeReader {
  get(l: number, i: number): Node | undefined
}

/** In-memory index of built nodes. */
export class NodeIndex implements TreeReader {
  private readonly nodes = new Map<string, Node>()

  get(l: number, i: number): Node | undefined {
    return this.nodes.get(key(l, i))
  }

  has(l: number, i: number): boolean {
    return this.nodes.has(key(l, i))
  }

  put(node: Node): void {
    this.nodes.set(key(node.l, node.i), node)
  }

  get size(): number {
    return this.nodes.size
  }

  all(): IterableIterator<Node> {
    return this.nodes.values()
  }
}
