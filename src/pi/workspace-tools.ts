import type { Workspace } from "@cloudflare/computer"
import { createPiTools } from "@cloudflare/computer/tools/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { TSchema } from "typebox"

/** Tools that only read: safe to run again after a crash (ADR 0002). */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep"])

export const SHELL_BACKEND = "shell"

/**
 * The Workspace tools (read, ls, find, grep, write, edit, delete, exec) as pi-durable tools, so each
 * call is a durable task. Writes and exec are not replayed after a crash: the model gets an
 * `interrupted` result instead.
 */
export const makeWorkspaceExtension = (
  workspace: Workspace,
  options: { readonly exec: boolean; readonly allow: ReadonlyArray<string> }
) => {
  const { tools, execute } = createPiTools({
    workspace,
    ...(options.exec
      ? {
        shell: {
          defaultBackend: SHELL_BACKEND,
          backends: {
            [SHELL_BACKEND]: {
              description:
                `A bash-compatible shell (just-bash) over the workspace files: pipes, redirects, coreutils, grep, sed, awk, jq. ${
                  options.allow.length === 0
                    ? "It has no network access."
                    : `curl reaches only these hosts and their subdomains: ${options.allow.join(", ")}.`
                }`
            }
          }
        }
      }
      : {})
  })
  return defineExtension({
    name: "workspace",
    tools: tools.filter((tool) => tool.name !== "publish").map((tool) =>
      defineTool({
        name: tool.name,
        description: tool.description,
        // JSON Schema, not TypeBox: pi-ai validates plain JSON Schema too.
        parameters: tool.parameters as unknown as TSchema,
        ...(REPLAY_SAFE.has(tool.name) ? { replay: "safe" as const } : {}),
        execute: async (args, api, context) => {
          const result = await execute(
            { id: api.callId, name: tool.name, arguments: args },
            context.abortSignal === undefined ? {} : { abortSignal: context.abortSignal }
          )
          if (result.isError) {
            throw new Error(result.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n"))
          }
          return { content: result.content }
        }
      })
    )
  })
}
