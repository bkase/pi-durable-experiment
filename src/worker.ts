import { Workspace, WorkspaceServiceProxy } from "@cloudflare/computer"
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell"
import curl from "@cloudflare/computer/shell/curl"
import jq from "@cloudflare/computer/shell/jq"
import { DurableObject } from "cloudflare:workers"
import { deliveryId, parseHookPath, presentedToken, safeEqual } from "./auth.ts"
import { type App, openApp } from "./do/app.ts"
import { ChatGPT } from "./models/chatgpt.ts"
import { LiveModels, MockModels } from "./models/models.ts"
import { Layer } from "effect"
import { decodeClientMessage, type ServerMessage } from "./protocol.ts"
import { SHELL_BACKEND } from "./pi/workspace-tools.ts"

// The worker-shell's Dynamic Worker reaches the Workspace back through this entrypoint.
export { WorkspaceServiceProxy }

export interface Env {
  readonly Chat: DurableObjectNamespace<Chat>
  readonly LOADER?: unknown
  readonly OPTCHAT_TOKEN: string
  /** "mock" (default) runs scripted models; "live" uses the ChatGPT credential. */
  readonly MODEL_MODE?: string
  /** "on" sends the spec's explicit cache marks (unverified Responses API fields). */
  readonly CACHE_MARKS?: string
}

const CHAT = "main"
const HEARTBEAT_MS = 30_000
/** An alarm may run 15 minutes; leave room to reschedule. */
const ALARM_WORK_MS = 13 * 60_000

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization",
  "access-control-allow-methods": "GET, OPTIONS"
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const chat = env.Chat.get(env.Chat.idFromName(CHAT))
    const hook = parseHookPath(url.pathname)
    const token = hook?.token ?? presentedToken(request.headers)
    const authorized = token !== undefined && (await safeEqual(token, env.OPTCHAT_TOKEN))

    if (url.pathname === "/health") return json({ ok: true })
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null, { status: 204, headers: CORS })
    if (url.pathname === "/" || url.pathname === "/ui") return Response.redirect(new URL("/ui/", url).toString(), 302)
    if (!authorized) return json({ error: "unauthorized" }, 401)
    if (url.pathname === "/chat" || url.pathname === "/status" || url.pathname.startsWith("/api/") || hook !== undefined) {
      return chat.fetch(request)
    }
    return json({ error: "not found" }, 404)
  }
} satisfies ExportedHandler<Env>

/** The one chat: pi-durable harness, OptChat memory and Workspace, all in this Durable Object's SQLite. */
export class Chat extends DurableObject<Env> {
  private readonly workspace: Workspace
  private app: Promise<App> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const exec = env.LOADER !== undefined
    this.workspace = new Workspace({
      storage: ctx.storage as never,
      backends: exec
        ? [
          new WorkerShellBackend({
            id: SHELL_BACKEND,
            loader: env.LOADER as never,
            workspace: { binding: "Chat", id: ctx.id.toString() },
            ctx,
            commands: [curl, jq]
          })
        ]
        : []
    })
    ctx.blockConcurrencyWhile(async () => {
      await this.open()
    })
  }

  /** Lets the worker-shell's Dynamic Worker reach this Workspace (see `WorkspaceServiceProxy`). */
  async __getWorkspaceStub() {
    await this.workspace.ready()
    return this.workspace.stub()
  }

  private open(): Promise<App> {
    this.app ??= openApp({
      storage: this.ctx.storage as never,
      workspace: this.workspace,
      exec: this.env.LOADER !== undefined,
      models: (kv) =>
        this.env.MODEL_MODE === "live"
          ? LiveModels({ serviceTier: "priority", explicitCacheMarks: this.env.CACHE_MARKS === "on" }).pipe(
            Layer.provideMerge(ChatGPT.layer(kv))
          )
          : Layer.merge(MockModels, ChatGPT.layer(kv)),
      onFatal: (error) => {
        // Background work (pi-durable's scheduler, the Compactor) would otherwise keep failing on the
        // dead storage until the CPU limit; a fresh instance resumes everything from storage.
        console.error(`optchat: storage lost, discarding this instance: ${error.message}`)
        this.ctx.abort(`storage lost: ${error.message}`)
      },
      onError: (error) => console.error(`optchat: ${describe(error)}`)
    }).then((app) => {
      app.subscribe((events) => this.broadcast({ type: "events", events }))
      return app
    }, (error) => {
      console.error(`optchat: open failed: ${describe(error)}`)
      this.app = undefined
      throw error
    })
    return this.app
  }

  private broadcast(message: ServerMessage) {
    const text = JSON.stringify(message)
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(text)
      } catch {
        // a closing socket; its close handler cleans up
      }
    }
  }

  /** Keep the object awake (and wake it after an eviction) while work is pending. */
  private async heartbeat() {
    const app = await this.open()
    if (await app.busy()) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
  }

  override async fetch(request: Request): Promise<Response> {
    const app = await this.open()
    const url = new URL(request.url)
    const hook = parseHookPath(url.pathname)

    if (hook !== undefined) {
      if (request.method !== "POST") return json({ error: "POST only" }, 405)
      const body = await request.text()
      const id = deliveryId(request.headers) ?? (await digest(body))
      const result = await app.event(hook.source, id, body)
      await this.heartbeat()
      return json({ result }, 202)
    }
    if (url.pathname === "/status") return json(await app.status())
    if (url.pathname.startsWith("/api/")) {
      try {
        return json(await app.api(url.pathname.slice(5), url.searchParams))
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
    if (url.pathname === "/chat") {
      if (request.headers.get("upgrade") !== "websocket") return json({ error: "expected websocket" }, 426)
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      pair[1].send(JSON.stringify({ type: "hello", status: await app.status() } satisfies ServerMessage))
      pair[1].send(JSON.stringify({ type: "snapshot", snapshot: app.snapshot() } satisfies ServerMessage))
      const protocol = request.headers.get("sec-websocket-protocol")?.includes("optchat") ? "optchat" : undefined
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        ...(protocol ? { headers: { "sec-websocket-protocol": protocol } } : {})
      })
    }
    return json({ error: "not found" }, 404)
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const app = await this.open()
    let id = ""
    const reply = (message: ServerMessage) => socket.send(JSON.stringify(message))
    try {
      const message = decodeClientMessage(typeof data === "string" ? data : new TextDecoder().decode(data))
      id = message.id
      const ok = (data: unknown) => reply({ type: "result", id, ok: true, data })
      switch (message.type) {
        case "input":
          await app.input(message.text)
          await this.heartbeat()
          return ok("accepted")
        case "abort":
          await app.abort()
          return ok("aborted")
        case "status":
          return ok(await app.status())
        case "view":
          return ok(await app.view())
        case "zoom":
          return ok(await app.zoom(message.at, message.n))
        case "instructions.get":
          return ok(await app.instructions())
        case "instructions.set":
          await app.setInstructions(message.text)
          return ok("saved")
        case "login.start":
          return ok(
            `Open this URL, sign in, then paste the URL the browser lands on (it will fail to load; that is expected) with /login <url>:\n${await app
              .login.start()}`
          )
        case "login.finish":
          await app.login.finish(message.url)
          return ok(`Signed in to ChatGPT.${this.env.MODEL_MODE === "live" ? "" : " Deploy with MODEL_MODE=live to use it."}`)
      }
    } catch (error) {
      reply({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string) {
    // 1005/1006 are reported, never sent.
    socket.close(code === 1005 || code === 1006 ? 1000 : code, reason)
  }

  override async alarm() {
    const started = Date.now()
    try {
      const app = await this.open()
      const opened = Date.now()
      await app.settle(ALARM_WORK_MS)
      await this.heartbeat()
      console.log(`optchat: alarm done (open ${opened - started} ms, settle ${Date.now() - opened} ms)`)
    } catch (error) {
      console.error(`optchat: alarm failed after ${Date.now() - started} ms: ${describe(error)}`)
      throw error
    }
  }
}

const digest = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

const describe = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : JSON.stringify(error)
