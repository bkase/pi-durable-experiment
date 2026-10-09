# Sign in through the Codex device-code flow, not "Sign in with ChatGPT"

Supersedes ADR 0003's choice of flow (the rest stands: the Durable Object owns the credential, priority tier, `gpt-6.1-sol` Master and `gpt-6-luna` Compactor). "Sign in with ChatGPT" (`openai-chatgpt`, token sharing to `api.openai.com`) fails on OpenAI's side for this account: both our URL and pi-ai's own end in "Operation timed out". The Codex flow (`openai-codex`) also uses the ChatGPT subscription and works from a plain HTTP client: `/login` asks auth.openai.com for a device code, the user enters it at `auth.openai.com/codex/device`, and the Durable Object polls, exchanges the code and stores and refreshes the credential. Requests go to the Codex endpoint (`chatgpt.com/backend-api`) over SSE; the account id comes from the token.

## Consequences

- No paste-back step; a pending sign-in is stored, so polling resumes after an eviction, and the alarm heartbeat keeps the object awake while a code is outstanding.
- The live provider id is `openai-codex`; the chat's stored model follows the mode on every start.
- Unverified until the first live request: that chatgpt.com accepts requests from Cloudflare's network.
