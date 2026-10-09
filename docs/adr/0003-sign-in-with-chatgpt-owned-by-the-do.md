> Superseded in part by [ADR 0008](0008-codex-device-code-sign-in.md): the sign-in flow is now Codex's device code.

# Models run on a "Sign in with ChatGPT" credential that the Durable Object owns

The Master is `gpt-6.1-sol` and the Compactor is `gpt-6-luna`, both on the OpenAI Responses API with `service_tier: "priority"`, authenticated by pi-ai's "Sign in with ChatGPT" flow (`openai-chatgpt`: dynamic client, `chatgpt.tokens.use.direct`, tokens sent to `api.openai.com/v1`) instead of an API key. The DO runs the sign-in itself: it holds its own permanent installation UUID, issues the authorize URL, takes the pasted-back redirect URL (the `127.0.0.1:1455` callback is expected to fail to load), exchanges the code, and from then on is the only holder that refreshes and persists the rotating tokens. The credential never leaves the DO.

## Considered Options

- **Log in locally, push the credential to the DO**: simplest code, but the token transits the laptop, and any later refresh there kills the DO's copy.
- **Codex OAuth (`openai-codex`, device-code flow)**: nicer headless login, but a different endpoint (`chatgpt.com/backend-api`) than the one chosen.
- **Anthropic API key** (Opus 5.5 master, Sonnet 5 compactor): rejected in favour of the user's ChatGPT subscription.

## Consequences

- pi-ai's `openai-chatgpt` module imports `node:http`/`node:crypto`; the DO reimplements its login/refresh on WebCrypto.
- `service_tier`, `prompt_cache_breakpoint` on Memory View pieces and `reasoning.context: "all_turns"` aren't reachable through pi-durable's stream settings; one provider wrapper adds them via pi-ai `onPayload`.
- Whether ChatGPT-token requests honour `priority` is unverified; pi-ai records the tier OpenAI actually applied.
