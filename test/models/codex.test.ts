import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { accountIdOf, ChatGPT, type KeyValue, VERIFICATION_URI } from "../../src/models/codex.ts"
import { shapePayload } from "../../src/models/models.ts"

const memoryKv = (): KeyValue & { readonly data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) }
}

/** An unsigned JWT carrying a ChatGPT account id, as the Codex endpoint expects. */
const jwt = (accountId: string, n: number) =>
  `h.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, n })).replace(/=+$/, "")}.s`

/** A fake auth.openai.com: device code → pending until approved → authorization code → tokens. */
const fakeOpenAI = () => {
  const state = { approved: false, polls: 0, refreshes: 0, issued: 0 }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/deviceauth/usercode")) return json({ device_auth_id: "da_1", user_code: "ABCD-EFGH", interval: "5" })
    if (url.endsWith("/deviceauth/token")) {
      state.polls++
      return state.approved ? json({ authorization_code: "ac_1", code_verifier: "cv_1" }) : json({}, 403)
    }
    if (url.endsWith("/oauth/token")) {
      const body = new URLSearchParams(String(init.body))
      if (body.get("grant_type") === "refresh_token") state.refreshes++
      state.issued++
      return json({ access_token: jwt("acct_42", state.issued), refresh_token: `r${state.issued}`, expires_in: 3600 })
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  return { state, fetchImpl }
}

describe("Codex device-code sign-in (in the Durable Object)", () => {
  it.effect("returns a code, polls while pending, and stores the credential once approved", () => {
    const kv = memoryKv()
    const openai = fakeOpenAI()
    let notified = 0
    return Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      assert.deepStrictEqual(yield* chatgpt.status, { signedIn: false })
      assert.deepStrictEqual(yield* chatgpt.start, { userCode: "ABCD-EFGH", verificationUri: VERIFICATION_URI })
      assert.strictEqual((yield* chatgpt.status).pending?.userCode, "ABCD-EFGH")
      yield* TestClock.adjust("12 seconds")
      assert.strictEqual(openai.state.polls, 2)
      assert.isFalse((yield* chatgpt.status).signedIn)
      openai.state.approved = true
      yield* TestClock.adjust("5 seconds")
      yield* chatgpt.settled
      const status = yield* chatgpt.status
      assert.isTrue(status.signedIn)
      assert.isUndefined(status.pending)
      assert.strictEqual(notified, 1)
      assert.strictEqual(accountIdOf(yield* chatgpt.token), "acct_42")
    }).pipe(Effect.provide(ChatGPT.layer(kv, { fetch: openai.fetchImpl, onSignedIn: () => notified++ })))
  })

  it.effect("resumes a pending sign-in after a restart", () => {
    const kv = memoryKv()
    const openai = fakeOpenAI()
    return Effect.gen(function*() {
      yield* Effect.gen(function*() {
        yield* (yield* ChatGPT).start
      }).pipe(Effect.provide(ChatGPT.layer(kv, { fetch: openai.fetchImpl })))
      openai.state.approved = true
      yield* Effect.gen(function*() {
        const chatgpt = yield* ChatGPT
        yield* TestClock.adjust("5 seconds")
        yield* chatgpt.settled
        assert.isTrue((yield* chatgpt.status).signedIn)
      }).pipe(Effect.provide(ChatGPT.layer(kv, { fetch: openai.fetchImpl })))
    })
  })

  it.effect("refreshes an expiring token and stores the rotated one", () => {
    const kv = memoryKv()
    const openai = fakeOpenAI()
    let clock = 1_000_000
    kv.data.set("codex.credential", JSON.stringify({ access: jwt("acct_42", 0), refresh: "r0", expires: clock - 1, accountId: "acct_42" }))
    return Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      const token = yield* chatgpt.token
      assert.strictEqual(openai.state.refreshes, 1)
      assert.strictEqual(JSON.parse(kv.data.get("codex.credential")!).refresh, "r1")
      assert.strictEqual(yield* chatgpt.token, token)
      assert.strictEqual(openai.state.refreshes, 1)
    }).pipe(Effect.provide(ChatGPT.layer(kv, { fetch: openai.fetchImpl, now: () => clock })))
  })

  it.effect("gives up when the code expires", () => {
    const kv = memoryKv()
    const openai = fakeOpenAI()
    let clock = 0
    return Effect.gen(function*() {
      const chatgpt = yield* ChatGPT
      yield* chatgpt.start
      clock = 16 * 60 * 1000
      yield* TestClock.adjust("5 seconds")
      yield* chatgpt.settled
      const status = yield* chatgpt.status
      assert.isFalse(status.signedIn)
      assert.include(status.error ?? "", "expired")
    }).pipe(Effect.provide(ChatGPT.layer(kv, { fetch: openai.fetchImpl, now: () => clock })))
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
    assert.deepStrictEqual(out.input[0].content.map((p: any) => p.prompt_cache_breakpoint === true), [true, false, false])
    assert.strictEqual(out.reasoning.context, "all_turns")
  })
})

