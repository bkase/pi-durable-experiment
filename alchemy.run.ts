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
  // The dashboard (public/ui/index.html at /ui/): static, served before the Worker; its data comes
  // from the token-protected /api/* routes.
  assets: "./public",
  // nodejs_compat and ctx.exports are on by default at this date.
  compatibility: { date: "2026-09-25" },
  // Per event. Normal events use well under a second; this caps any runaway loop quickly.
  limits: { cpuMs: 30_000 },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    Chat: Cloudflare.DurableObject<Chat>("Chat"),
    LOADER: Cloudflare.WorkerLoader(),
    OPTCHAT_TOKEN: Config.Redacted("OPTCHAT_TOKEN"),
    // "mock" (scripted models) until you've signed in with /login; then set MODEL_MODE=live in .env.
    MODEL_MODE: Config.String("MODEL_MODE").pipe(Config.withDefault("mock")),
    CACHE_MARKS: Config.String("CACHE_MARKS").pipe(Config.withDefault("off")),
    // Hosts the agent's shell may reach with curl (subdomains included); everything else is blocked.
    EGRESS_ALLOW: Config.String("EGRESS_ALLOW").pipe(Config.withDefault("api.github.com,raw.githubusercontent.com"))
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
