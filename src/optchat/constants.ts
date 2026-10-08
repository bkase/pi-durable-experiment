/** Target size of one summary line, in UTF-8 bytes. */
export const NODE = 512
/** The Memory View is a sawtooth: it grows to VIEW_HIGH bytes, then one batch merges it to VIEW_LOW. */
export const VIEW_HIGH = 128_000
export const VIEW_LOW = 64_000
/** A compaction's view: the chat's view merged further, with the same sawtooth. */
export const COMPACT_HIGH = 32_000
export const COMPACT_LOW = 16_000
/** Compactor calls running at once. */
export const JOBS = 8
/** A message's node starts once fewer than this many lines before it are still unbuilt. */
export const LEAF_LAG = 8
/** Attempts per Node to get under NODE. */
export const TRIES = 5
/** Max size of one tool result in the Log, in characters (head + tail kept). Other long texts are split. */
export const CAP = 30_000

export const PLACEHOLDER = "(not summarized yet: zoom it)"

const encoder = new TextEncoder()

/** UTF-8 byte length. All OptChat sizes are bytes, never tokens. */
export const bytes = (text: string): number => encoder.encode(text).length
