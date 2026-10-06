#!/usr/bin/env bun
/**
 * OptChat terminal client. Prints plainly (no redraws) so the terminal's scrollback works.
 *
 *   OPTCHAT_URL=https://…workers.dev OPTCHAT_TOKEN=… bun cli/optchat.ts          attach and chat
 *   bun cli/optchat.ts send "text"                                                 one message, print the answer
 *
 * In the chat: plain lines are input (a steer if the agent is busy). Commands:
 *   /abort  /status  /view  /zoom <id> <n>  /instructions  /instructions set <text>  /login  /login <redirect-url>  /quit
 */
import * as readline from "node:readline"

const url = process.env.OPTCHAT_URL
const token = process.env.OPTCHAT_TOKEN
if (!url || !token) {
  console.error("Set OPTCHAT_URL and OPTCHAT_TOKEN.")
  process.exit(2)
}

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }
const pending = new Map<string, Pending>()
let seq = 0

const wsUrl = `${url.replace(/^http/, "ws").replace(/\/$/, "")}/chat`
const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } } as never)

const request = (message: Record<string, unknown>): Promise<unknown> => {
  const id = `c${++seq}`
  socket.send(JSON.stringify({ ...message, id }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

let atLineStart = true
const write = (s: string) => {
  if (s.length === 0) return
  process.stdout.write(s)
  atLineStart = s.endsWith("\n")
}
const newline = () => {
  if (!atLineStart) write("\n")
}

let onRunEnd: (() => void) | undefined
/** Whether the current message's text already streamed (else print it whole at its end). */
let streamed = false

/** Render pi-durable agent events (watchEvents) as plain lines. */
const render = (event: Record<string, any>) => {
  switch (event.type) {
    case "message_start":
      streamed = false
      break
    case "message_update":
      for (const change of event.changes ?? []) {
        if (change.type === "text_delta") {
          streamed = true
          write(change.delta)
        } else if (change.type === "thinking_delta") write(dim(change.delta))
      }
      break
    case "message_end": {
      const message = event.entry?.model?.[0]
      if (!streamed && message?.role === "assistant") {
        for (const block of message.content ?? []) if (block.type === "text") write(block.text)
      }
      if (message?.role === "user" && mode === "chat") {
        const text = typeof message.content === "string" ? message.content : message.content.map((b: any) => b.text ?? "").join("")
        write(bold(`› ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`))
      }
      streamed = false
      newline()
      break
    }
    case "tool_execution_start":
      newline()
      write(dim(`→ ${event.toolName} ${JSON.stringify(event.args ?? {})}\n`))
      break
    case "tool_execution_end": {
      const result = event.entry?.model?.[0]
      const text = (result?.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
      const short = text.length > 400 ? `${text.slice(0, 400)}…` : text
      write(dim(`← ${event.toolName}${result?.isError ? " (error)" : ""}: ${short.replace(/\n/g, "\n  ")}\n`))
      break
    }
    case "auto_retry_start":
      newline()
      write(dim(`(retrying: ${event.errorMessage})\n`))
      break
    case "task_failed":
      newline()
      write(dim(`(failed: ${event.message})\n`))
      break
    case "run_end":
      newline()
      onRunEnd?.()
      break
  }
}

socket.addEventListener("message", (frame) => {
  const message = JSON.parse(String(frame.data))
  switch (message.type) {
    case "hello":
      if (mode === "chat") console.log(dim(`connected · ${JSON.stringify(message.status)}`))
      break
    case "result": {
      const p = pending.get(message.id)
      pending.delete(message.id)
      if (message.ok) p?.resolve(message.data)
      else p?.reject(new Error(message.error))
      break
    }
    case "events":
      for (const event of message.events) render(event)
      break
  }
})
socket.addEventListener("close", (e) => {
  newline()
  console.error(dim(`disconnected (${e.code}${e.reason ? `: ${e.reason}` : ""})`))
  process.exit(e.code === 1000 ? 0 : 1)
})
socket.addEventListener("error", () => {
  console.error("connection failed")
  process.exit(1)
})

const mode = process.argv[2] === "send" ? "send" : "chat"
await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()))

if (mode === "send") {
  const text = process.argv.slice(3).join(" ")
  const done = new Promise<void>((resolve) => (onRunEnd = resolve))
  await request({ type: "input", text })
  await done
  socket.close(1000)
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  for await (const raw of rl) {
    const text = raw.trim()
    if (text.length === 0) continue
    try {
      if (text === "/quit") break
      else if (text === "/abort") await request({ type: "abort" })
      else if (text === "/status") console.log(JSON.stringify(await request({ type: "status" }), null, 2))
      else if (text === "/view") console.log(String(await request({ type: "view" })))
      else if (text.startsWith("/zoom ")) {
        const [, at, n] = text.split(/\s+/)
        console.log(String(await request({ type: "zoom", at: Number(at), n: Number(n) })))
      } else if (text === "/instructions") console.log(String(await request({ type: "instructions.get" })))
      else if (text.startsWith("/instructions set ")) {
        await request({ type: "instructions.set", text: text.slice("/instructions set ".length) })
        console.log(dim("instructions saved"))
      } else if (text === "/login") console.log(bold(String(await request({ type: "login.start" }))))
      else if (text.startsWith("/login ")) console.log(String(await request({ type: "login.finish", url: text.slice(7) })))
      else await request({ type: "input", text: raw })
    } catch (error) {
      console.error(`error: ${(error as Error).message}`)
    }
  }
  socket.close(1000)
}
