import { Context, Effect, Layer, Schema, Semaphore } from "effect"

/**
 * "Sign in with ChatGPT" run by the Durable Object itself (ADR 0003): pi-ai's `openai-chatgpt`
 * flow (dynamic client, PKCE, `chatgpt.tokens.use.direct`), rebuilt on fetch + WebCrypto. The
 * browser's redirect to 127.0.0.1:1455 is expected to fail to load; the user pastes its URL back.
 * The credential never leaves this object's storage.
 */
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
const RESOURCE = "https://api.openai.com/v1"
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback"
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct"
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`
const EXPIRY_MARGIN_MS = 3 * 60 * 1000

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", { message: Schema.String }) {}

export interface Credential {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly clientId: string
}

/** Key-value persistence for the credential and the pending login (the DO's `oc_kv` table). */
export interface KeyValue {
  readonly get: (key: string) => Promise<string | undefined>
  readonly set: (key: string, value: string) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

export class ChatGPT extends Context.Service<ChatGPT, {
  /** Begin a login: the URL to open in a browser. */
  readonly start: Effect.Effect<string>
  /** Finish it with the redirect URL the browser ended on. */
  readonly finish: (redirectUrl: string) => Effect.Effect<void, AuthError>
  /** A valid access token, refreshed (and the rotated refresh token stored) when near expiry. */
  readonly token: Effect.Effect<string, AuthError>
  readonly status: Effect.Effect<{ readonly signedIn: boolean; readonly expires?: number }>
}>()("optchat/ChatGPT") {
  static layer(kv: KeyValue, fetchImpl: typeof fetch = fetch) {
    return Layer.effect(ChatGPT, make(kv, fetchImpl))
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const random = (n = 32) => base64url(crypto.getRandomValues(new Uint8Array(n)))

const make = (kv: KeyValue, fetchImpl: typeof fetch) =>
  Effect.gen(function*() {
    const refreshing = yield* Semaphore.make(1)
    const io = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: (e) => new AuthError({ message: e instanceof Error ? e.message : String(e) }) })

    const installId = Effect.promise(async () => {
      const existing = await kv.get("chatgpt.install_id")
      if (existing !== undefined) return existing
      const id = crypto.randomUUID()
      await kv.set("chatgpt.install_id", id)
      return id
    })

    const requestToken = (body: URLSearchParams) =>
      io(async () => {
        const response = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body
        })
        if (!response.ok) throw new Error(`token request failed (${response.status}): ${await response.text().catch(() => "")}`)
        return (await response.json()) as Record<string, unknown>
      })

    const toCredential = (token: Record<string, unknown>, clientId: string) =>
      Effect.gen(function*() {
        const { access_token, refresh_token, scope, expires_in } = token
        if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof scope !== "string") {
          return yield* new AuthError({ message: "token response is missing fields" })
        }
        if (typeof expires_in !== "number" || expires_in <= 0) return yield* new AuthError({ message: "bad expires_in" })
        if (!scope.split(/\s+/).includes(DIRECT_TOKEN_SCOPE)) {
          return yield* new AuthError({ message: `grant did not include ${DIRECT_TOKEN_SCOPE}` })
        }
        return { access: access_token, refresh: refresh_token, expires: Date.now() + expires_in * 1000 - EXPIRY_MARGIN_MS, clientId }
      })

    const save = (credential: Credential) => io(() => kv.set("chatgpt.credential", JSON.stringify(credential)))
    const load = Effect.promise(async () => {
      const raw = await kv.get("chatgpt.credential")
      return raw === undefined ? undefined : (JSON.parse(raw) as Credential)
    })

    const start = Effect.gen(function*() {
      const verifier = random()
      const challenge = base64url(new Uint8Array(yield* digest(verifier)))
      const state = random()
      const host = yield* installId
      yield* Effect.promise(() => kv.set("chatgpt.pending", JSON.stringify({ verifier, state })))
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        agent_name_hint: "OptChat",
        ext_agent_host_id: `urn:uuid:${host}`,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        nonce: random()
      }).toString()
      return url.toString()
    })

    const finish = (redirectUrl: string) =>
      Effect.gen(function*() {
        const raw = yield* Effect.promise(() => kv.get("chatgpt.pending"))
        if (raw === undefined) return yield* new AuthError({ message: "no login in progress; start one first" })
        const pending = JSON.parse(raw) as { verifier: string; state: string }
        const url = yield* Effect.try({
          try: () => new URL(redirectUrl.trim()),
          catch: () => new AuthError({ message: "paste the full redirect URL from the browser" })
        })
        if (`${url.origin}${url.pathname}` !== REDIRECT_URI) {
          return yield* new AuthError({ message: `the redirect URL must start with ${REDIRECT_URI}` })
        }
        const error = url.searchParams.get("error")
        if (error) return yield* new AuthError({ message: `authorization failed: ${error}` })
        const code = url.searchParams.get("code")
        const clientId = url.searchParams.get("client_id")
        if (url.searchParams.get("state") !== pending.state) return yield* new AuthError({ message: "OAuth state mismatch" })
        if (!code || !clientId) return yield* new AuthError({ message: "redirect URL has no code or client_id" })
        const token = yield* requestToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: pending.verifier,
            redirect_uri: REDIRECT_URI,
            resource: RESOURCE
          })
        )
        yield* save(yield* toCredential(token, clientId))
        yield* Effect.promise(() => kv.delete("chatgpt.pending"))
      })

    const token = Effect.gen(function*() {
      const credential = yield* load
      if (credential === undefined) return yield* new AuthError({ message: "not signed in to ChatGPT; use /login" })
      if (Date.now() < credential.expires) return credential.access
      const current = (yield* load)!
      if (Date.now() < current.expires) return current.access
      const fresh = yield* toCredential(
        yield* requestToken(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: current.clientId,
            refresh_token: current.refresh,
            resource: RESOURCE
          })
        ),
        current.clientId
      )
      yield* save(fresh)
      return fresh.access
    }).pipe(Semaphore.withPermits(refreshing, 1))

    return ChatGPT.of({
      start,
      finish,
      token,
      status: load.pipe(
        Effect.map((c) => (c === undefined ? { signedIn: false } : { signedIn: true, expires: c.expires }))
      )
    })
  })

const digest = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
