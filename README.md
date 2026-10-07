# OptChat on pi-durable, in a Durable Object

An experiment: one endless chat with an agent that remembers everything, built from

- **[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.0** — the durable agent harness (crash-safe Runs, tasks, tool calls), running inside a **Cloudflare Durable Object** on the object's own SQLite;
- **[OptChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)** memory — every message kept verbatim, compressed into a binary Summary Tree, and each Run starts fresh from a fixed-size Memory View of the whole chat;
- **Effect v4** for the OptChat core and **Alchemy v2** for infrastructure;
- **`@cloudflare/computer`** for the agent's Workspace: a SQLite-backed filesystem plus a bash-compatible shell (just-bash in a Dynamic Worker).

The vocabulary is in [`CONTEXT.md`](CONTEXT.md); the decisions and their reasons are in [`docs/adr/`](docs/adr).

## How a Run works

```
input ──► Chat DO ──► reset() + submit ──► pi-durable generation
                                              │ beforeRequest (OptChat extension)
                                              ▼
              [system: OptChat prompt + view doc + Standing Instructions + tools]
              [user:   <chat> Memory View (frozen for this Run) </chat> + input]
              [this Run's own Turns: tool calls, results …]
every committed entry ──► Projector ──► Log ──► Compactor (gpt-6-luna) ──► Summary Tree ──► Memory View
```

- The pi-durable transcript **is** the Log (ADR 0001); the Projector turns entries into Log Messages (`user`, `talk`, `tool`, `echo`, `event`) and never logs thinking.
- Webhook deliveries are `event`s, not the user's words, and wait their turn (ADR 0004).
- An evicted object is a crashed one: an alarm heartbeat wakes it while work is pending and `resume()` finishes the Run (ADR 0005, verified locally with `kill -9` mid-tool).

## Layout

| Path | What |
|---|---|
| `src/optchat/` | The OptChat core in Effect: Log, Summary Tree, Memory View fold, Compactor pump, prompts (verbatim from the spec, plus the `event` kind) |
| `src/pi/` | The seam to pi-durable: request rewrite, the OptChat extension (`zoom`, `date`, hook), Workspace tools, the DO SQLite adapter |
| `src/do/` | The app the Durable Object runs: Runs, steering, the Event inbox, catch-up projection; OptChat's SQL tables |
| `src/models/` | Model access as Effect layers: `MockModels` (scripted) and `LiveModels` (ChatGPT sign-in, priority tier) |
| `src/worker.ts` | The Worker (auth, routing) and the `Chat` Durable Object (WebSocket, webhooks, alarm) |
| `alchemy.run.ts` | The stack: Worker, `Chat` namespace, Worker Loader, shared token |
| `cli/optchat.ts` | Terminal client |

## Run it locally (real workerd)

```sh
npm install
PORT=8797 scripts/local.sh                       # token: dev-token, mock models
OPTCHAT_URL=http://127.0.0.1:8797 OPTCHAT_TOKEN=dev-token bun cli/optchat.ts
```

With mock models, `/mock <tool> …` makes the scripted Master call a tool: `/mock zoom 0 4`, `/mock exec ls -la /`, `/mock write /notes/a.md hi`, `/mock read /notes/a.md`.

## Deploy

```sh
npx alchemy profile refresh --profile personal   # once, if it needs re-auth
npx alchemy deploy --profile personal            # reads OPTCHAT_TOKEN from .env
```

`.env` (git-ignored) holds the shared token: the CLI sends it as `Authorization: Bearer`, webhooks use the header or `POST /hook/<token>/<source>`.

## Talk to it

```sh
OPTCHAT_URL=https://<worker>.workers.dev OPTCHAT_TOKEN=$(grep OPTCHAT_TOKEN .env | cut -d= -f2) bun cli/optchat.ts
```

Plain lines are input (a steer while a Run is going). Commands: `/status`, `/view`, `/zoom <id> <n>`, `/abort`, `/instructions`, `/instructions set <text>`, `/login`, `/login <redirect-url>`, `/quit`. One-shot: `bun cli/optchat.ts send "text"`.

Webhooks: `curl -X POST -H "X-GitHub-Delivery: <id>" -d @payload.json https://…/hook/<token>/github`. The delivery id (or a hash of the body) deduplicates retries.

## Real models

1. In the CLI: `/login`, open the URL, sign in with ChatGPT; the browser then fails to load `127.0.0.1:1455/…` — copy that URL and send `/login <url>`. The credential stays in the Durable Object.
2. Add `MODEL_MODE=live` to `.env` and `npm run deploy` (Master `gpt-6.1-sol`, Compactor `gpt-6-luna`, `service_tier: priority`). `CACHE_MARKS=on` also sends the spec's explicit cache breakpoints, whose Responses API field names are unverified.

## Tests

```sh
npx vitest run        # unit + pi-durable storage conformance + end-to-end app tests (mock models)
npx tsc -p .
```

## Status

Deployed with the `personal` profile (brandernan@) at `https://pi-durable-experiment-optchat-x6c7eonasboqurixmxb24m2c.brandernan.workers.dev` (stage `live_bkase`, mock models). Verified in production: pi-durable on Durable Object SQLite, Runs over the Memory View, `zoom`, Workspace write and just-bash `exec` through Dynamic Workers (no `experimental` flag), steering mid-Run, webhook Events with dedupe and auth, Standing Instructions, and a deploy in the middle of a long `exec`: the Run resumes, the tool is reported as interrupted, and the object stays reachable (ADR 0006). Not yet verified: real models (needs `/login`, then `MODEL_MODE=live`), cache hit rates, and whether ChatGPT tokens get the priority tier.
