import { Type } from "@earendil-works/pi-ai"
import type { EntryRecord } from "@earendil-works/pi-durable"
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable"
import { MASTER, VIEW_DOC } from "../optchat/prompts.ts"
import { rewriteRequest } from "./rewrite.ts"

/** What the OptChat extension needs from the memory, in Promise form (see bridge.ts). */
export interface OptChatBridge {
  /** Log every transcript entry not yet logged, in order. */
  readonly project: (entries: ReadonlyArray<EntryRecord>) => Promise<void>
  /** The Memory View frozen for the Run whose first input is `entryId`: settles and renders it once. */
  readonly runView: (entryId: string, signal: AbortSignal | undefined) => Promise<ReadonlyArray<string>>
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
    sections: [
      section("master", () => MASTER, { tag: false }),
      section("view", () => VIEW_DOC, { tag: false })
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          const view = await api.context(api.conversationId, context)
          await bridge.project(view.entries)
          const input = runInput(view.entries)
          if (input === undefined) return undefined
          const pieces = await bridge.runView(input.id, context.abortSignal)
          return { messages: rewriteRequest(request.messages, pieces) }
        }
      })
    ]
  })
}
