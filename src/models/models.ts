import type { AssistantMessage, Message, MutableModels } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { Context, Effect, Layer } from "effect"
import { bytes, NODE } from "../optchat/constants.ts"
import { CompactorModel, ModelError } from "../optchat/memory.ts"
import { ChatGPT } from "./chatgpt.ts"

export const PROVIDER = "openai"
export const MASTER_MODEL = "gpt-6.1-sol"
export const COMPACTOR_MODEL = "gpt-6-luna"

/** pi-ai model access for the Master, as pi-durable's generation uses it. */
export class MasterModels extends Context.Service<MasterModels, {
  readonly models: MutableModels
  readonly master: { readonly provider: string; readonly modelId: string }
}>()("optchat/MasterModels") {}

const textOf = (message: Message | undefined): string => {
  if (message === undefined) return ""
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  }
  if (message.role === "toolResult") return message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  return ""
}

/** The input of a Run's first user message: its last text block (the earlier blocks are the Memory View). */
const lastBlock = (message: Message | undefined): string => {
  if (message?.role !== "user") return ""
  if (typeof message.content === "string") return message.content
  const texts = message.content.filter((b) => b.type === "text")
  return texts.length === 0 ? "" : (texts[texts.length - 1] as { text: string }).text
}

/**
 * A scripted Master for running everything without a real model. Plain input gets an
 * acknowledgement naming how much of the Memory View it saw; `/mock <tool> …` makes one tool call:
 *
 *   /mock zoom <id> <n>      /mock date <id>      /mock exec <command>
 *   /mock write <path> <text>      /mock read <path>      /mock ls <path>
 */
export const mockMaster = (messages: ReadonlyArray<Message>): AssistantMessage => {
  const last = messages[messages.length - 1]
  if (last?.role === "toolResult") {
    const out = textOf(last)
    return fauxAssistantMessage(`(mock) ${last.toolName} returned: ${out.length > 600 ? `${out.slice(0, 600)}…` : out}`)
  }
  const input = lastBlock(last).trim()
  const viewBlocks = last?.role === "user" && typeof last.content !== "string"
    ? last.content.filter((b) => b.type === "text").slice(0, -1).map((b) => (b as { text: string }).text).join("")
    : ""
  const viewLines = viewBlocks.split("\n").filter((l) => /^\d+\+\d+\|/.test(l)).length
  const match = /^\/mock\s+(\w+)\s*([\s\S]*)$/.exec(input)
  if (match !== null) {
    const [, tool, rest = ""] = match
    const args = rest.trim()
    switch (tool) {
      case "zoom": {
        const [id = "0", n = "1"] = args.split(/\s+/)
        return fauxAssistantMessage([fauxText("Zooming."), fauxToolCall("zoom", { id: Number(id), n: Number(n) })], {
          stopReason: "toolUse"
        })
      }
      case "date":
        return fauxAssistantMessage([fauxToolCall("date", { id: Number(args || 0) })], { stopReason: "toolUse" })
      case "exec":
        return fauxAssistantMessage([fauxToolCall("exec", { command: args })], { stopReason: "toolUse" })
      case "read":
        return fauxAssistantMessage([fauxToolCall("read", { path: args })], { stopReason: "toolUse" })
      case "ls":
        return fauxAssistantMessage([fauxToolCall("ls", { path: args || "/" })], { stopReason: "toolUse" })
      case "write": {
        const space = args.indexOf(" ")
        const path = space < 0 ? args : args.slice(0, space)
        const content = space < 0 ? "" : args.slice(space + 1)
        return fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" })
      }
    }
  }
  return fauxAssistantMessage(`(mock) heard: ${input} — the view I was given has ${viewLines} lines.`)
}

const cutTo = (text: string, limit: number): string => {
  let out = text.replace(/\s+/g, " ").trim()
  while (bytes(out) > limit) out = out.slice(0, Math.max(0, out.length - Math.ceil((bytes(out) - limit) / 2) - 1))
  return out
}

/** A deterministic Compactor: compresses by cutting, merges by joining both halves cut to fit. */
export const mockCompactor = Layer.succeed(CompactorModel)({
  complete: (_system, turns) =>
    Effect.sync(() => {
      const step = turns[0]!.content[1] ?? ""
      const body = step.slice(step.indexOf(":\n", step.indexOf("bytes:\n") + 7) + 2)
      if (step.includes("Merge these two lines")) {
        const [a = "", b = ""] = body.split("\n")
        return `${cutTo(a, NODE / 2 - 2)}; ${cutTo(b, NODE / 2 - 2)}`
      }
      return cutTo(body, 300)
    })
})

/** Master and Compactor both scripted: the whole system runs without a model account. */
export const MockModels = Layer.mergeAll(
  Layer.sync(MasterModels, () => {
    const models = createModels()
    const faux = fauxProvider({
      provider: PROVIDER,
      models: [{ id: MASTER_MODEL, reasoning: true, contextWindow: 272_000 }, { id: COMPACTOR_MODEL }]
    })
    const respond = (context: { messages: ReadonlyArray<Message> }) => {
      faux.appendResponses([respond])
      return mockMaster(context.messages)
    }
    faux.setResponses([respond])
    models.setProvider(faux.provider)
    return MasterModels.of({ models, master: { provider: PROVIDER, modelId: MASTER_MODEL } })
  }),
  mockCompactor
)

export interface LiveOptions {
  /** OpenAI `service_tier`; the user chose priority ("high speed"). */
  readonly serviceTier: "priority" | "default"
  /**
   * Mark the Memory View pieces as cache breakpoints and keep reasoning across the Run, as the
   * OptChat spec measured. Off by default: the exact Responses API fields are unverified here.
   */
  readonly explicitCacheMarks: boolean
}

/** Rewrite an OpenAI Responses payload: priority tier, and optionally the spec's cache marks. */
export const shapePayload = (options: LiveOptions) => (payload: unknown): unknown => {
  const body = payload as Record<string, unknown>
  const out: Record<string, unknown> = { ...body, service_tier: options.serviceTier }
  if (!options.explicitCacheMarks) return out
  out.reasoning = { ...(body.reasoning as object | undefined), context: "all_turns" }
  const input = body.input as Array<Record<string, unknown>> | undefined
  const first = input?.find((item) => item.role === "user")
  const parts = first?.content as Array<Record<string, unknown>> | undefined
  if (parts !== undefined) {
    let inView = false
    for (const part of parts) {
      const text = typeof part.text === "string" ? part.text : ""
      if (text.startsWith("<chat>")) inView = true
      if (inView) part.prompt_cache_breakpoint = true
      if (text.endsWith("</chat>")) break
    }
  }
  return out
}

/** The real models, on the ChatGPT credential the Durable Object holds (ADR 0003). */
export const LiveModels = (options: LiveOptions) =>
  liveCompactor.pipe(Layer.provideMerge(liveMaster(options)))

const liveMaster = (options: LiveOptions) =>
  Layer.effect(
    MasterModels,
    Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      const services = yield* Effect.context<never>()
      const { openaiProvider } = yield* Effect.promise(() => import("@earendil-works/pi-ai/providers/openai"))
      const inner = openaiProvider()
      const shape = shapePayload(options)
      const provider = {
        ...inner,
        auth: {
          apiKey: {
            name: "Sign in with ChatGPT",
            resolve: async () => ({
              auth: { apiKey: await Effect.runPromiseWith(services)(chatgpt.token) },
              source: "Sign in with ChatGPT"
            })
          }
        },
        streamSimple: (model: never, context: never, opts?: Record<string, unknown>) =>
          inner.streamSimple(model, context, { ...opts, onPayload: (p: unknown) => shape(p) } as never)
      }
      const models = createModels()
      models.setProvider(provider as never)
      return MasterModels.of({ models, master: { provider: PROVIDER, modelId: MASTER_MODEL } })
    })
  )

/** The Compactor on `gpt-6-luna` at medium effort (the spec ran its compactor at medium). */
const liveCompactor = Layer.effect(
  CompactorModel,
  Effect.gen(function*() {
    const { models } = yield* MasterModels
    const model = models.getModel(PROVIDER, COMPACTOR_MODEL)
    if (model === undefined) return yield* Effect.die(new Error(`no model ${COMPACTOR_MODEL}`))
    return CompactorModel.of({
      complete: (system, turns) =>
        Effect.tryPromise({
          try: async () => {
            const now = Date.now()
            const messages: Message[] = turns.map((turn) =>
              turn.role === "user"
                ? { role: "user", content: turn.content.map((text) => ({ type: "text", text })), timestamp: now }
                : ({
                  role: "assistant",
                  content: [{ type: "text", text: turn.content.join("") }],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
                  },
                  stopReason: "stop",
                  timestamp: now
                } as AssistantMessage)
            )
            const reply = await models.completeSimple(model, { systemPrompt: system, messages } as never, {
              reasoning: "medium"
            })
            if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "compactor request failed")
            return reply.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          },
          catch: (e) => new ModelError({ message: e instanceof Error ? e.message : String(e) })
        })
    })
  })
)
