import { bytes, CAP } from "./constants.ts"

export type Kind = "user" | "talk" | "tool" | "echo" | "event" | "note"

/** One item of the Log, with its permanent id. */
export interface LogMessage {
  readonly i: number
  readonly kind: Kind
  readonly text: string
  /** Bytes of `kind + ": " + text`. */
  readonly size: number
  /** ISO time it entered the Log. */
  readonly date: string
}

/** A Log Message without its text: what stays in memory (text is read from storage on demand). */
export type LogMeta = Omit<LogMessage, "text">

export const line = (kind: Kind, text: string): string => `${kind}: ${text}`

export const sizeOf = (kind: Kind, text: string): number => bytes(line(kind, text))

/** Keep the head and tail of an over-long text, with a note of what was cut. */
export const cap = (text: string, limit: number = CAP): string => {
  if (text.length <= limit) return text
  const keep = limit - 200
  const head = text.slice(0, Math.ceil(keep / 2))
  const tail = text.slice(text.length - Math.floor(keep / 2))
  return `${head}\n[... ${text.length - head.length - tail.length} characters cut ...]\n${tail}`
}
