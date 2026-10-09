import type { AssistantMessage, Message, MutableModels, SystemMessage } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"
import { Context, Effect, Layer } from "effect"
import { bytes, NODE } from "../optchat/constants.ts"
import { CompactorModel, ModelError } from "../optchat/memory.ts"
import { SYSTEM } from "../optchat/prompts.ts"
import { ChatGPT, type KeyValue } from "./codex.ts"

/** The mock models stand in under this provider id; the live ones are the Codex provider's. */
export const PROVIDER = "openai"
export const LIVE_PROVIDER = "openai-codex"
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

/** The `<input>` of a compaction task. */
const inputOf = (task: string) => {
  const from = task.indexOf("<input>\n") + "<input>\n".length
  return task.slice(from, task.lastIndexOf("\n</input>"))
}

/** A deterministic Compactor: compresses by cutting, merges by joining both halves cut to fit. */
export const mockCompactor = Layer.succeed(CompactorModel)({
  complete: ({ turns }) =>
    Effect.sync(() => {
      const task = turns[0]!.content[0] ?? ""
      const input = inputOf(task)
      if (task.startsWith("Compaction: merge")) {
        const [a = "", b = ""] = input.split("\n")
        return { text: `${cutTo(a, NODE / 2 - 2)}; ${cutTo(b, NODE / 2 - 2)}` }
      }
      return { text: cutTo(input, 300) }
    })
})

/**
 * The system message (prompt, Standing Instructions, tools) the last turn sent. Compactions send the
 * same one so they read it from the turns' cache entry (UniiChat spec §4). Persisted, so compactions
 * after a restart keep the same prefix.
 */
export class TurnPrefix extends Context.Service<TurnPrefix, {
  readonly get: Effect.Effect<SystemMessage>
  readonly set: (system: SystemMessage) => Effect.Effect<void>
}>()("optchat/TurnPrefix") {
  static layer(kv: KeyValue) {
    return Layer.effect(
      TurnPrefix,
      Effect.gen(function*() {
        const saved = yield* Effect.promise(() => kv.get("turn.prefix"))
        // Before any turn: the prompt alone (no tools yet), until the first turn sends the real prefix.
        let current: SystemMessage = saved === undefined
          ? { role: "system", content: "", sections: { prompt: SYSTEM }, timestamp: 0 }
          : JSON.parse(saved)
        let raw = saved
        return TurnPrefix.of({
          get: Effect.sync(() => current),
          set: (system) =>
            Effect.gen(function*() {
              const next = JSON.stringify({ ...system, timestamp: 0 })
              if (next === raw) return
              raw = next
              current = JSON.parse(next)
              yield* Effect.promise(() => kv.set("turn.prefix", next))
            })
        })
      })
    )
  }
}

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
  // The cache mark goes on the last whole block of the view (UniiChat spec §3.3): the next call
  // finds it and pays only for the lines after it.
  const input = body.input as Array<Record<string, unknown>> | undefined
  const first = input?.find((item) => item.role === "user")
  const parts = (first?.content as Array<Record<string, unknown>> | undefined) ?? []
  const texts = parts.map((part) => (typeof part.text === "string" ? part.text : ""))
  const open = texts.findIndex((t) => t.startsWith("<chat>"))
  const close = texts.findIndex((t) => t.endsWith("</chat>"))
  if (open >= 0 && close > open) parts[close - 1]!.prompt_cache_breakpoint = true
  return out
}

/** The real models: the Codex endpoint, on the ChatGPT credential the Durable Object holds (ADR 0008). */
export const LiveModels = (options: LiveOptions) =>
  liveCompactor.pipe(Layer.provideMerge(liveMaster(options)))

const liveMaster = (options: LiveOptions) =>
  Layer.effect(
    MasterModels,
    Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      const services = yield* Effect.context<never>()
      const { openaiCodexProvider } = yield* Effect.promise(() => import("@earendil-works/pi-ai/providers/openai-codex"))
      const inner = openaiCodexProvider()
      const shape = shapePayload(options)
      const provider = {
        ...inner,
        auth: {
          apiKey: {
            name: "ChatGPT (Codex sign-in)",
            resolve: async () => ({
              auth: { apiKey: await Effect.runPromiseWith(services)(chatgpt.token) },
              source: "ChatGPT (Codex sign-in)"
            })
          }
        },
        // SSE, not WebSockets: the Codex WebSocket transport needs custom headers Workers can't set.
        streamSimple: (model: never, context: never, opts?: Record<string, unknown>) =>
          inner.streamSimple(model, context, { ...opts, transport: "sse", onPayload: (p: unknown) => shape(p) } as never)
      }
      const models = createModels()
      models.setProvider(provider as never)
      return MasterModels.of({ models, master: { provider: LIVE_PROVIDER, modelId: MASTER_MODEL } })
    })
  )

/**
 * The Compactor on `gpt-6-luna` at xhigh effort (the spec runs its cheap compactor at xhigh):
 * `[the turns' system message and tools] [user: compaction view pieces + task] [retries …]`.
 */
const liveCompactor = Layer.effect(
  CompactorModel,
  Effect.gen(function*() {
    const { models } = yield* MasterModels
    const prefix = yield* TurnPrefix
    const model = models.getModel(LIVE_PROVIDER, COMPACTOR_MODEL)
    if (model === undefined) return yield* Effect.die(new Error(`no model ${COMPACTOR_MODEL}`))
    return CompactorModel.of({
      complete: ({ view, turns }) =>
        Effect.gen(function*() {
          const system = yield* prefix.get
          return yield* Effect.tryPromise({
            try: async () => {
              const now = Date.now()
              const messages: Message[] = [system]
              turns.forEach((turn, k) => {
                const content = k === 0 ? [...view, ...turn.content] : [...turn.content]
                messages.push(
                  turn.role === "user"
                    ? { role: "user", content: content.map((text) => ({ type: "text", text })), timestamp: now }
                    : ({
                      role: "assistant",
                      content: [{ type: "text", text: content.join("") }],
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
              })
              const reply = await models.completeSimple(model, { messages } as never, { reasoning: "xhigh", transport: "sse" } as never)
              if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "compactor request failed")
              const { input, output, cacheRead, cacheWrite } = reply.usage
              return {
                text: reply.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
                usage: { input, output, cacheRead, cacheWrite }
              }
            },
            catch: (e) => new ModelError({ message: e instanceof Error ? e.message : String(e) })
          })
        })
    })
  })
)
