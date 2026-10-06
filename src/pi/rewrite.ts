import type { Message, SystemMessage, TextContent, Tool, UserMessage } from "@earendil-works/pi-ai"

/** A Run ends with an assistant message that asks for no more tools. */
const endsRun = (message: Message): boolean => message.role === "assistant" && message.stopReason !== "toolUse"

/**
 * Fold every positional system message (base prompt, section replacements, tool additions and
 * removals) into one leading system message, so the request has one stable head.
 */
export const foldSystem = (messages: ReadonlyArray<Message>): SystemMessage | undefined => {
  let lead: SystemMessage | undefined
  const sections = new Map<string, string>()
  const tools = new Map<string, Tool>()
  for (const message of messages) {
    if (message.role !== "system") continue
    if (lead === undefined) lead = message
    else if (hasText(message.content)) lead = { ...lead, content: joinContent(lead.content, message.content) }
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else sections.set(name, value)
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  if (lead === undefined) return undefined
  const folded: SystemMessage = {
    role: "system",
    content: lead.content,
    timestamp: lead.timestamp
  }
  if (sections.size > 0) folded.sections = Object.fromEntries(sections)
  if (tools.size > 0) folded.toolsAdded = [...tools.values()]
  return folded
}

const hasText = (content: SystemMessage["content"]): boolean =>
  typeof content === "string" ? content.length > 0 : content.some((block) => block.text.length > 0)

const joinContent = (a: SystemMessage["content"], b: SystemMessage["content"]): SystemMessage["content"] => {
  const blocks = (c: SystemMessage["content"]): TextContent[] => (typeof c === "string" ? [{ type: "text", text: c }] : c)
  return [...blocks(a), ...blocks(b)]
}

/** Index (among non-system messages) where the current Run starts. */
export const runStart = (conversation: ReadonlyArray<Message>): number => {
  for (let k = conversation.length - 1; k >= 0; k--) {
    if (endsRun(conversation[k]!)) return k + 1
  }
  return 0
}

/**
 * The request a Run sends: one folded system message, then the Memory View pieces as the first
 * blocks of the Run's first user message, then the rest of the Run verbatim. Nothing from earlier
 * Runs is sent: the Memory View stands in for it.
 */
export const rewriteRequest = (
  messages: ReadonlyArray<Message>,
  viewPieces: ReadonlyArray<string>
): Message[] => {
  const system = foldSystem(messages)
  const conversation = messages.filter((m) => m.role !== "system")
  const run = conversation.slice(runStart(conversation))
  const firstUser = run.findIndex((m) => m.role === "user")
  if (firstUser < 0) return [...(system ? [system] : []), ...run]
  const input = run[firstUser] as UserMessage
  const inputBlocks = typeof input.content === "string" ? [{ type: "text" as const, text: input.content }] : input.content
  const opened: UserMessage = {
    ...input,
    content: [...viewPieces.map((text) => ({ type: "text" as const, text })), ...inputBlocks]
  }
  return [...(system ? [system] : []), ...run.slice(0, firstUser), opened, ...run.slice(firstUser + 1)]
}
