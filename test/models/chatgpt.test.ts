import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { ChatGPT, type KeyValue } from "../../src/models/chatgpt.ts"
import { shapePayload } from "../../src/models/models.ts"

const memoryKv = (): KeyValue & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k)
  }
}

const tokenResponse = (n: number, expiresIn = 3600) =>
  new Response(
    JSON.stringify({
      access_token: `access-${n}`,
      refresh_token: `refresh-${n}`,
      id_token: "id",
      scope: "openid offline_access chatgpt.tokens.use.direct",
      expires_in: expiresIn
    }),
    { headers: { "content-type": "application/json" } }
  )

describe("Sign in with ChatGPT (in the Durable Object)", () => {
  it.effect("signs in by paste-back, keeps a stable installation id, and refreshes rotated tokens", () => {
    const kv = memoryKv()
    const bodies: URLSearchParams[] = []
    let n = 0
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(new URLSearchParams(String(init.body)))
      n += 1
      // The first grant expires at once (inside the safety margin), so the next token() refreshes.
      return tokenResponse(n, n === 1 ? 60 : 3600)
    }) as unknown as typeof fetch

    return Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      assert.deepStrictEqual(yield* chatgpt.status, { signedIn: false })

      const url = new URL(yield* chatgpt.start)
      assert.strictEqual(url.origin, "https://auth.openai.com")
      assert.strictEqual(url.searchParams.get("client_id"), "dynamic_agent_client")
      assert.strictEqual(url.searchParams.get("code_challenge_method"), "S256")
      const host = url.searchParams.get("ext_agent_host_id")!
      assert.match(host, /^urn:uuid:[0-9a-f-]{36}$/)
      const again = new URL(yield* chatgpt.start)
      assert.strictEqual(again.searchParams.get("ext_agent_host_id"), host)

      const state = again.searchParams.get("state")!
      const bad = yield* Effect.flip(chatgpt.finish(`http://127.0.0.1:1455/auth/callback?code=c&state=wrong&client_id=x`))
      assert.strictEqual(bad.message, "OAuth state mismatch")

      yield* chatgpt.finish(`http://127.0.0.1:1455/auth/callback?code=the-code&state=${state}&client_id=client-1`)
      assert.strictEqual(bodies[0]!.get("grant_type"), "authorization_code")
      assert.strictEqual(bodies[0]!.get("client_id"), "client-1")
      assert.strictEqual(bodies[0]!.get("code"), "the-code")
      assert.isTrue((yield* chatgpt.status).signedIn)

      assert.strictEqual(yield* chatgpt.token, "access-2")
      assert.strictEqual(bodies[1]!.get("grant_type"), "refresh_token")
      assert.strictEqual(bodies[1]!.get("refresh_token"), "refresh-1")
      assert.strictEqual(JSON.parse(kv.data.get("chatgpt.credential")!).refresh, "refresh-2")
      assert.strictEqual(yield* chatgpt.token, "access-2")
      assert.strictEqual(bodies.length, 2)
    }).pipe(Effect.provide(ChatGPT.layer(kv, fakeFetch)))
  })

  it.effect("refuses a token without the direct-use scope", () => {
    const kv = memoryKv()
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "a", refresh_token: "r", scope: "openid", expires_in: 3600 }))) as unknown as typeof fetch
    return Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      const state = new URL(yield* chatgpt.start).searchParams.get("state")!
      const error = yield* Effect.flip(chatgpt.finish(`http://127.0.0.1:1455/auth/callback?code=c&state=${state}&client_id=x`))
      assert.include(error.message, "chatgpt.tokens.use.direct")
    }).pipe(Effect.provide(ChatGPT.layer(kv, fakeFetch)))
  })
})

describe("shapePayload", () => {
  const payload = () => ({
    model: "gpt-6.1-sol",
    input: [
      { role: "user", content: [{ type: "input_text", text: "<chat>\n0+1|a\n" }, { type: "input_text", text: "1+1|b\n</chat>" }, { type: "input_text", text: "hi" }] }
    ]
  })

  it("always asks for the priority tier", () => {
    const out = shapePayload({ serviceTier: "priority", explicitCacheMarks: false })(payload()) as Record<string, unknown>
    assert.strictEqual(out.service_tier, "priority")
    assert.isUndefined(out.reasoning)
  })

  it("marks only the last whole block of the Memory View when explicit marks are on", () => {
    const out = shapePayload({ serviceTier: "priority", explicitCacheMarks: true })(payload()) as any
    const parts = out.input[0].content
    assert.deepStrictEqual(parts.map((p: any) => p.prompt_cache_breakpoint === true), [true, false, false])
    assert.strictEqual(out.reasoning.context, "all_turns")
  })
})
