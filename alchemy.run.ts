import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import type { Chat } from "./src/worker.ts"

/**
 * One Worker hosting one Durable Object (`Chat`, SQLite-backed) that runs pi-durable with the
 * OptChat memory. The Worker Loader binding powers the Workspace's worker-shell (just-bash).
 */
export const Worker = Cloudflare.Worker("OptChat", {
  main: "./src/worker.ts",
  // nodejs_compat and ctx.exports are on by default at this date.
  compatibility: { date: "2026-09-25" },
  limits: { cpuMs: 300_000 },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    Chat: Cloudflare.DurableObject<Chat>("Chat"),
    LOADER: Cloudflare.WorkerLoader(),
    OPTCHAT_TOKEN: Config.Redacted("OPTCHAT_TOKEN")
  }
})

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>

export default Alchemy.Stack(
  "pi-durable-experiment",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const worker = yield* Worker
    return { url: worker.url }
  })
)
