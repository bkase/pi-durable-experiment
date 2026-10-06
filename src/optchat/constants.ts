/** Target size of one summary line, in UTF-8 bytes. */
export const NODE = 512
/** Byte budget of the Memory View (≈ 62-64k tokens). */
export const VIEW = 128_000
/** Compactor calls running at once. */
export const JOBS = 8
/** Attempts per Node to get under NODE. */
export const TRIES = 5
/** Wait before retrying a failed Node, in milliseconds. */
export const RETRY_MS = 10_000
/** Max size of one tool result in the Log, in characters (head + tail kept). */
export const CAP = 30_000
/** Cache breakpoints inside the rendered Memory View, in characters. */
export const MARKS = [50_000, 80_000, 100_000] as const

export const PLACEHOLDER = "(not summarized yet: zoom it)"

const encoder = new TextEncoder()

/** UTF-8 byte length. All OptChat sizes are bytes, never tokens. */
export const bytes = (text: string): number => encoder.encode(text).length
