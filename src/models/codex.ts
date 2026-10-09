import { Context, Duration, Effect, Fiber, Layer, Schema, Semaphore } from "effect"

/**
 * ChatGPT subscription sign-in through the Codex device-code flow (ADR 0008), run by the Durable
 * Object: `/login` returns a short code, the user enters it at auth.openai.com, and the object polls,
 * exchanges the code and from then on holds and refreshes the credential. This is pi-ai's
 * `openai-codex` flow rebuilt on fetch, so it runs in a Worker and survives evictions (the pending
 * login is stored; polling resumes on wake).
 */
const AUTH = "https://auth.openai.com"
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const TOKEN_URL = `${AUTH}/oauth/token`
const USER_CODE_URL = `${AUTH}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH}/api/accounts/deviceauth/token`
export const VERIFICATION_URI = `${AUTH}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH}/deviceauth/callback`
const JWT_CLAIM = "https://api.openai.com/auth"
const DEVICE_TTL_MS = 15 * 60 * 1000
const EXPIRY_MARGIN_MS = 3 * 60 * 1000

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", { message: Schema.String }) {}

export interface Credential {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId: string
}

interface Pending {
  readonly deviceAuthId: string
  readonly userCode: string
  readonly intervalSeconds: number
  readonly expiresAt: number
}

/** Key-value persistence for the credential and the pending login (the DO's `oc_kv` table). */
export interface KeyValue {
  readonly get: (key: string) => Promise<string | undefined>
  readonly set: (key: string, value: string) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

export interface LoginStatus {
  readonly signedIn: boolean
  readonly expires?: number
  /** A sign-in waiting for the user to enter its code. */
  readonly pending?: { readonly userCode: string; readonly verificationUri: string; readonly expiresAt: number }
  readonly error?: string
}

export class ChatGPT extends Context.Service<ChatGPT, {
  /** Begin a sign-in: the code to enter at the verification page. Polling runs in the background. */
  readonly start: Effect.Effect<{ readonly userCode: string; readonly verificationUri: string }, AuthError>
  /** A valid access token, refreshed (and the rotated refresh token stored) when near expiry. */
  readonly token: Effect.Effect<string, AuthError>
  readonly status: Effect.Effect<LoginStatus>
  /** Resolves when the pending sign-in (if any) completes, fails or expires. */
  readonly settled: Effect.Effect<void>
}>()("optchat/ChatGPT") {
  static layer(kv: KeyValue, options: { fetch?: typeof fetch; now?: () => number; onSignedIn?: () => void } = {}) {
    return Layer.effect(ChatGPT, make(kv, options.fetch ?? fetch, options.now ?? Date.now, options.onSignedIn ?? (() => {})))
  }
}

/** The ChatGPT account id the Codex endpoint needs, from the access token's claims. */
export const accountIdOf = (accessToken: string): string | undefined => {
  try {
    const part = accessToken.split(".")[1]!
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")))
    const id = json?.[JWT_CLAIM]?.chatgpt_account_id
    return typeof id === "string" && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

const make = (kv: KeyValue, fetchImpl: typeof fetch, now: () => number, onSignedIn: () => void) =>
  Effect.gen(function*() {
    const refreshing = yield* Semaphore.make(1)
    const scope = yield* Effect.scope
    let poller: Fiber.Fiber<void> | undefined
    let lastError: string | undefined

    const io = <A>(f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: (e) => new AuthError({ message: e instanceof Error ? e.message : String(e) }) })
    const read = <A>(key: string) =>
      Effect.promise(async () => {
        const raw = await kv.get(key)
        return raw === undefined ? undefined : (JSON.parse(raw) as A)
      })
    const write = (key: string, value: unknown) => Effect.promise(() => kv.set(key, JSON.stringify(value)))

    const tokenRequest = (body: URLSearchParams) =>
      io(async () => {
        const response = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body
        })
        if (!response.ok) throw new Error(`token request failed (${response.status}): ${await response.text().catch(() => "")}`)
        return (await response.json()) as Record<string, unknown>
      })

    const toCredential = (json: Record<string, unknown>) =>
      Effect.gen(function*() {
        const { access_token, refresh_token, expires_in } = json
        if (typeof access_token !== "string" || typeof refresh_token !== "string" || typeof expires_in !== "number") {
          return yield* new AuthError({ message: "token response is missing fields" })
        }
        const accountId = accountIdOf(access_token)
        if (accountId === undefined) return yield* new AuthError({ message: "token has no ChatGPT account id" })
        return { access: access_token, refresh: refresh_token, expires: now() + expires_in * 1000 - EXPIRY_MARGIN_MS, accountId }
      })

    /** One poll of a pending sign-in: undefined while the user hasn't entered the code yet. */
    const pollOnce = (pending: Pending) =>
      Effect.gen(function*() {
        const response = yield* io(() =>
          fetchImpl(DEVICE_TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode })
          })
        )
        if (response.status === 403 || response.status === 404) return undefined
        const json = (yield* io(() => response.json())) as Record<string, unknown>
        if (!response.ok) {
          const code = typeof json.error === "object" ? (json.error as { code?: string })?.code : json.error
          if (code === "deviceauth_authorization_pending" || code === "slow_down") return undefined
          return yield* new AuthError({ message: `device sign-in failed (${response.status}): ${JSON.stringify(json)}` })
        }
        const { authorization_code, code_verifier } = json
        if (typeof authorization_code !== "string" || typeof code_verifier !== "string") {
          return yield* new AuthError({ message: "device sign-in response is missing fields" })
        }
        return yield* toCredential(
          yield* tokenRequest(
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: CLIENT_ID,
              code: authorization_code,
              code_verifier,
              redirect_uri: DEVICE_REDIRECT_URI
            })
          )
        )
      })

    const poll = (pending: Pending): Effect.Effect<void> =>
      Effect.gen(function*() {
        while (now() < pending.expiresAt) {
          yield* Effect.sleep(Duration.seconds(Math.max(1, pending.intervalSeconds)))
          const credential = yield* pollOnce(pending)
          if (credential !== undefined) {
            yield* write("codex.credential", credential)
            yield* Effect.promise(() => kv.delete("codex.pending"))
            lastError = undefined
            onSignedIn()
            return
          }
        }
        lastError = "the sign-in code expired; run /login again"
        yield* Effect.promise(() => kv.delete("codex.pending"))
      }).pipe(
        Effect.catch((error: AuthError) =>
          Effect.gen(function*() {
            lastError = error.message
            yield* Effect.promise(() => kv.delete("codex.pending"))
          })
        )
      )

    const startPolling = (pending: Pending) =>
      Effect.gen(function*() {
        if (poller !== undefined) yield* Fiber.interrupt(poller)
        poller = yield* Effect.forkIn(poll(pending), scope)
      })

    // A sign-in that was pending when the object was evicted keeps polling.
    const resumed = yield* read<Pending>("codex.pending")
    if (resumed !== undefined) yield* startPolling(resumed)

    const start = Effect.gen(function*() {
      const response = yield* io(() =>
        fetchImpl(USER_CODE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_id: CLIENT_ID })
        })
      )
      if (!response.ok) {
        return yield* new AuthError({
          message: `device code request failed (${response.status}): ${(yield* io(() => response.text())).slice(0, 200)}`
        })
      }
      const json = (yield* io(() => response.json())) as Record<string, unknown>
      const interval = Number(typeof json.interval === "string" ? json.interval.trim() : json.interval)
      if (typeof json.device_auth_id !== "string" || typeof json.user_code !== "string" || !Number.isFinite(interval)) {
        return yield* new AuthError({ message: "invalid device code response" })
      }
      const pending: Pending = {
        deviceAuthId: json.device_auth_id,
        userCode: json.user_code,
        intervalSeconds: interval,
        expiresAt: now() + DEVICE_TTL_MS
      }
      yield* write("codex.pending", pending)
      lastError = undefined
      yield* startPolling(pending)
      return { userCode: pending.userCode, verificationUri: VERIFICATION_URI }
    })

    const token = Effect.gen(function*() {
      const current = yield* read<Credential>("codex.credential")
      if (current === undefined) return yield* new AuthError({ message: "not signed in to ChatGPT; use /login" })
      if (now() < current.expires) return current.access
      const fresh = yield* toCredential(
        yield* tokenRequest(
          new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: CLIENT_ID })
        )
      )
      yield* write("codex.credential", fresh)
      return fresh.access
    }).pipe(Semaphore.withPermits(refreshing, 1))

    return ChatGPT.of({
      start,
      token,
      status: Effect.gen(function*() {
        const credential = yield* read<Credential>("codex.credential")
        const pending = yield* read<Pending>("codex.pending")
        return {
          signedIn: credential !== undefined,
          ...(credential ? { expires: credential.expires } : {}),
          ...(pending
            ? { pending: { userCode: pending.userCode, verificationUri: VERIFICATION_URI, expiresAt: pending.expiresAt } }
            : {}),
          ...(lastError ? { error: lastError } : {})
        }
      }),
      settled: Effect.suspend(() => (poller === undefined ? Effect.void : Fiber.await(poller).pipe(Effect.asVoid)))
    })
  })
