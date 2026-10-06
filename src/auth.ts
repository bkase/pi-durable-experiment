/** Constant-time string comparison (both sides hashed first, so lengths don't leak). */
export const safeEqual = async (a: string, b: string): Promise<boolean> => {
  const encoder = new TextEncoder()
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ])
  const x = new Uint8Array(ha)
  const y = new Uint8Array(hb)
  let diff = 0
  for (let k = 0; k < x.length; k++) diff |= x[k]! ^ y[k]!
  return diff === 0
}

/** The token a request presents: `Authorization: Bearer`, or a `bearer.<token>` WebSocket subprotocol. */
export const presentedToken = (headers: Headers): string | undefined => {
  const auth = headers.get("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim()
  const protocols = headers.get("sec-websocket-protocol")
  const bearer = protocols?.split(",").map((p) => p.trim()).find((p) => p.startsWith("bearer."))
  return bearer?.slice(7)
}

/** `/hook/<token>/<source>` for webhook senders that can't set headers. */
export const parseHookPath = (pathname: string): { token?: string; source: string } | undefined => {
  const parts = pathname.split("/").filter((p) => p.length > 0)
  if (parts[0] !== "hook") return undefined
  if (parts.length === 3) return { token: decodeURIComponent(parts[1]!), source: decodeURIComponent(parts[2]!) }
  if (parts.length === 2) return { source: decodeURIComponent(parts[1]!) }
  return undefined
}

/** A stable id for a webhook delivery, from the common sender headers, so retries don't run twice. */
export const deliveryId = (headers: Headers): string | undefined =>
  headers.get("x-github-delivery") ??
    headers.get("x-request-id") ??
    headers.get("idempotency-key") ??
    headers.get("x-delivery-id") ??
    headers.get("webhook-id") ??
    undefined
