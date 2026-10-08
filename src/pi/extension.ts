import { Type } from "@earendil-works/pi-ai"
import type { Context } from "@earendil-works/chord"
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable"
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable"
import type { SystemMessage } from "@earendil-works/pi-ai"
import { SYSTEM } from "../optchat/prompts.ts"
import { rewriteRequest } from "./rewrite.ts"

/** What the OptChat extension needs from the memory, in Promise form (see bridge.ts). */
export interface OptChatBridge {
  /** The conversation's active transcript entries (from its newest reset on). */
  readonly entries: (conversationId: ConversationId, context: Context) => Promise<ReadonlyArray<EntryRecord>>
  /** Log every transcript entry not yet logged, in order. */
  readonly project: (entries: ReadonlyArray<EntryRecord>) => Promise<void>
  /** The Memory View frozen for the Run whose first input is `entryId`: settles and renders it once. */
  readonly runView: (entryId: EntryId, signal: AbortSignal | undefined) => Promise<ReadonlyArray<string>>
  /** The system message (prompt, Standing Instructions and tools) a turn just sent: compactions reuse it. */
  readonly prefix: (system: SystemMessage) => Promise<void>
  readonly zoom: (id: number, n: number) => Promise<string>
  readonly date: (id: number) => Promise<string>
}

/** A Run ends with an assistant entry that asks for no more tools. */
const endsRun = (entry: EntryRecord): boolean => {
  if (entry.kind !== "pi.assistant") return false
  const message = entry.model?.[0]
  return message?.role === "assistant" && message.stopReason !== "toolUse"
}

/** The first user entry of the current Run, if the Run has started. */
export const runInput = (entries: ReadonlyArray<EntryRecord>): EntryRecord | undefined => {
  let from = 0
  for (let k = entries.length - 1; k >= 0; k--) {
    if (endsRun(entries[k]!)) {
      from = k + 1
      break
    }
  }
  return entries.slice(from).find((e) => e.kind === "pi.user")
}

export const makeOptChatExtension = (bridge: OptChatBridge) => {
  const zoom = defineTool({
    name: "zoom",
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    execute: async (args) => ({ content: [{ type: "text", text: await bridge.zoom(args.id, args.n) }] })
  })

  const date = defineTool({
    name: "date",
    description: "The date and time of message id.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    replay: "safe",
    execute: async (args) => ({ content: [{ type: "text", text: await bridge.date(args.id) }] })
  })

  return defineExtension({
    name: "optchat",
    tools: [zoom, date],
    // One prompt for turns and compactions (UniiChat spec §5); Standing Instructions follow it.
    sections: [section("prompt", () => SYSTEM, { tag: false })],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          const entries = await bridge.entries(api.conversationId, context)
          await bridge.project(entries)
          const input = runInput(entries)
          if (input === undefined) return undefined
          const pieces = await bridge.runView(input.id, context.abortSignal)
          const messages = rewriteRequest(request.messages, pieces)
          if (messages[0]?.role === "system") await bridge.prefix(messages[0])
          return { messages }
        }
      })
    ]
  })
}
