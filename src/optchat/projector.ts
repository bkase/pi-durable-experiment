import { cap, type Kind } from "./log.ts"
import type { LogDraft } from "./store.ts"

/** The parts of a pi-durable transcript entry the Projector reads (structurally typed). */
export interface ProjectableEntry {
  readonly id: string
  readonly kind: string
  readonly model?: ReadonlyArray<ProjectableMessage>
}

type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image" }
  | { readonly type: "thinking" }
  | { readonly type: "toolCall"; readonly name: string; readonly arguments: unknown }

export type ProjectableMessage =
  | { readonly role: "user"; readonly content: string | ReadonlyArray<Block>; readonly timestamp: number }
  | {
    readonly role: "assistant"
    readonly content: ReadonlyArray<Block>
    readonly stopReason: string
    readonly errorMessage?: string
    readonly timestamp: number
  }
  | {
    readonly role: "toolResult"
    readonly toolName: string
    readonly content: ReadonlyArray<Block>
    readonly isError: boolean
    readonly timestamp: number
  }
  | { readonly role: "system"; readonly timestamp: number }

const textOf = (content: string | ReadonlyArray<Block>): string =>
  typeof content === "string"
    ? content
    : content
      .map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
      .filter((s) => s.length > 0)
      .join("\n")

/**
 * Turn one transcript entry into Log Messages, in order. Thinking is never logged.
 * `eventSource` marks a user entry that was placed by a webhook Event.
 */
export const projectEntry = (entry: ProjectableEntry, eventSource?: string): LogDraft[] => {
  const out: Array<{ kind: Kind; text: string; timestamp: number }> = []
  for (const message of entry.model ?? []) {
    switch (message.role) {
      case "user": {
        const text = textOf(message.content)
        if (eventSource !== undefined) out.push({ kind: "event", text: `[${eventSource}] ${cap(text)}`, timestamp: message.timestamp })
        else out.push({ kind: "user", text, timestamp: message.timestamp })
        break
      }
      case "assistant": {
        let talk: string[] = []
        const flushTalk = () => {
          const text = talk.join("\n").trim()
          if (text.length > 0) out.push({ kind: "talk", text, timestamp: message.timestamp })
          talk = []
        }
        for (const block of message.content) {
          if (block.type === "text") talk.push(block.text)
          else if (block.type === "toolCall") {
            flushTalk()
            out.push({
              kind: "tool",
              text: `${block.name} ${JSON.stringify(block.arguments)}`,
              timestamp: message.timestamp
            })
          }
        }
        flushTalk()
        if (message.stopReason === "error" && message.errorMessage !== undefined) {
          out.push({ kind: "talk", text: `(model request failed: ${message.errorMessage})`, timestamp: message.timestamp })
        }
        break
      }
      case "toolResult": {
        const text = textOf(message.content)
        out.push({
          kind: "echo",
          text: cap(`${message.toolName}${message.isError ? " (error)" : ""}: ${text}`),
          timestamp: message.timestamp
        })
        break
      }
      case "system":
        break
    }
  }
  return out.map((m, part) => ({
    entryId: entry.id,
    part,
    kind: m.kind,
    text: m.text,
    date: new Date(m.timestamp).toISOString()
  }))
}

/** Entry kinds that carry chat content into the Log. */
export const LOGGED_KINDS: ReadonlySet<string> = new Set(["pi.user", "pi.assistant", "pi.tool-result"])
