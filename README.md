# OptChat on pi-durable, in a Cloudflare Durable Object

An experiment: **one endless chat with an agent that remembers everything**, running as a single always-on Cloudflare Durable Object.

- **[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)** (pi 1.0) is the agent harness: Runs, tool calls and their checkpoints are committed before anything is shown, so a crashed or evicted object picks its work back up. Here it runs on the Durable Object's own SQLite.
- **[OptChat / UniiChat](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)** (Victor Taelin's design, following its 2026-10-08 revision) is the memory: every message is kept verbatim, a cheap model compresses the history into a binary tree of one-line summaries, and every Run starts **fresh** from a fixed-size *Memory View* of the whole chat — recent messages one per line, older ones coarser. The agent `zoom`s into any line, down to the original message. No context rot, no compaction, constant cost.
- **[Effect v4](https://effect.website)** for the OptChat core, **[Alchemy v2](https://alchemy.run)** for infrastructure.
- **[`@cloudflare/computer`](https://www.npmjs.com/package/@cloudflare/computer)** gives the agent a Workspace: a SQLite-backed filesystem in the same object and a bash-compatible shell ([just-bash](https://github.com/vercel-labs/just-bash)) running in a Dynamic Worker.

The design was worked out interview-style first; the vocabulary is in [`CONTEXT.md`](CONTEXT.md) and each non-obvious decision has an ADR in [`docs/adr/`](docs/adr).

## What it does

- **Chat** from a terminal client over a WebSocket; typing while the agent works steers the running Run.
- **Remember** everything, forever, at a constant prompt size: the Memory View stays between 64 and 128 KB however long the chat gets, and only grows at its end between rare batch rewrites, so nearly all of it is read from the prompt cache.
- **React to the outside world**: webhooks (GitHub, Stripe, your deploys…) arrive as `event` messages — logged and answered, but never treated as the user's instructions.
- **Work** in its Workspace: read, write, edit, find, grep files, and run shell pipelines with `curl` and `jq`.
- **Survive** crashes, evictions and deploys mid-Run: an alarm heartbeat wakes the object and pi-durable resumes; a tool that may have half-run is reported to the model as interrupted, never silently re-run.

## How a Run works

```
input ──► Chat Durable Object ──► reset() + submit ──► pi-durable generation
                                                          │ beforeRequest (OptChat extension)
                                                          ▼
              [system: the one OptChat prompt + Standing Instructions + tools]     ← byte-identical every Run
              [user:   <chat> Memory View, frozen for this Run </chat> + the input]
              [this Run's own Turns: tool calls and results, append-only]

every committed entry ──► Projector ──► Log ──► Compactor ──► Summary Tree ──► Memory View
compaction call: [same system prompt + tools as a turn] [<chat> Compaction View </chat>] [task with a 512-byte ruler]
```

- The pi-durable transcript **is** the Log ([ADR 0001](docs/adr/0001-transcript-is-the-log.md)); the Projector turns entries into Log Messages (`user`, `talk`, `tool`, `echo`, `event`) and never logs model thinking.
- Each Run starts with a pi-durable `reset()`, so per-request work is one Run, not the whole history ([ADR 0005](docs/adr/0005-plain-durable-object-in-an-async-worker.md)).
- Models: Master `gpt-6.1-sol`, Compactor `gpt-6-luna`, via "Sign in with ChatGPT" run inside the Durable Object, which alone holds and refreshes the credential ([ADR 0003](docs/adr/0003-sign-in-with-chatgpt-owned-by-the-do.md)). Scripted mock models (Effect layers) run everything without an account.

## Layout

| Path | What |
|---|---|
| `src/optchat/` | The OptChat core in Effect: Log, Summary Tree, Memory View fold, Compactor pump, the spec's prompts (verbatim, plus the `event` kind) |
| `src/pi/` | The seam to pi-durable: request rewrite, the OptChat extension (`zoom`, `date`, the request hook), Workspace tools, the Durable Object SQLite adapter |
| `src/do/` | What the Durable Object runs: Runs, steering, the Event inbox, catch-up projection, OptChat's tables |
| `src/models/` | Model access as Effect layers: `MockModels` and `LiveModels` (ChatGPT sign-in, priority tier) |
| `src/worker.ts` | The Worker (auth, routing) and the `Chat` Durable Object (WebSocket, webhooks, alarm) |
| `alchemy.run.ts` | The stack: Worker, `Chat` namespace, Worker Loader, shared token |
| `cli/optchat.ts` | Terminal client |

## Quick start

Requires Node 24+ and [Bun](https://bun.sh) (for the CLI). The releases used here were days old when this was written; `.npmrc` / `bunfig.toml` exempt exactly these packages from a 7-day release-age gate — drop them if you don't use one.

```sh
npm install
npm test                                   # unit, pi-durable's storage conformance suite, end-to-end with mock models
```

### Run locally, in workerd (the real Workers runtime)

```sh
PORT=8797 scripts/local.sh                 # macOS arm64 workerd binary; token "dev-token"; mock models
OPTCHAT_URL=http://127.0.0.1:8797 OPTCHAT_TOKEN=dev-token bun cli/optchat.ts
```

With mock models, `/mock <tool> …` makes the scripted agent call a tool: `/mock zoom 0 4`, `/mock exec ls -la /`, `/mock write /notes/a.md hi`.

### Deploy to Cloudflare

```sh
echo "OPTCHAT_TOKEN=$(openssl rand -hex 32)" > .env   # the shared token (git-ignored)
npx alchemy deploy --profile <your-alchemy-profile>   # prints the Worker URL
```

Worker Loader (Dynamic Workers) needs a paid Workers plan.

### Talk to it

```sh
OPTCHAT_URL=https://<your-worker>.workers.dev OPTCHAT_TOKEN=<token> bun cli/optchat.ts
```

Plain lines are input. Commands: `/status`, `/view`, `/zoom <id> <n>`, `/abort`, `/instructions`, `/instructions set <text>`, `/login`, `/login <redirect-url>`, `/quit`. One-shot: `bun cli/optchat.ts send "text"`.

Webhooks: `curl -X POST -H "X-GitHub-Delivery: <id>" -d @payload.json https://<worker>/hook/<token>/github` — the delivery id (or a hash of the body) deduplicates retries.

### Use real models

1. In the CLI, `/login` and open the URL to sign in with ChatGPT. The browser then fails to load `127.0.0.1:1455/…` — that's expected; send that URL back with `/login <url>`.
2. Add `MODEL_MODE=live` to `.env` and redeploy. (`CACHE_MARKS=on` also sends the OptChat spec's explicit cache breakpoints; their Responses API field names are unverified.)

## Status and findings

Verified on Cloudflare (with mock models): pi-durable on Durable Object SQLite; Runs over the Memory View; `zoom`; Workspace writes and just-bash `exec` through Dynamic Workers (no `experimental` flag needed); steering mid-Run; webhook Events with dedupe and auth; a deploy in the middle of a long `exec` — the Run resumes and the object stays reachable.

Things learned the hard way:

- **A Dynamic Worker outlives the Durable Object that started it.** After a deploy, a still-running shell command called back into a reset instance whose storage threw on every call; background work spun until the CPU limit and the object was unreachable for minutes. The adapter now treats lost storage as fatal and the object calls `ctx.abort()` ([ADR 0006](docs/adr/0006-discard-instances-whose-storage-is-gone.md)).
- **pi-durable hooks can't read the transcript**, and pi-durable rebuilds the whole active context on every request — hence a `reset()` per Run.
- **The original spec's merge order thrashed the cache.** Measuring a pair's age from its first message and merging at every message meant consecutive Runs shared only 14–38% of the view. With the revised spec (age from the last message, sawtooth batches, a saved view, compactions sharing the turns' prefix) they share 94.7% in simulation, and the merge order matches Taelin's rollback push exactly ([results](docs/experiments/memory-simulation.md), [ADR 0007](docs/adr/0007-uniichat-cache-fixes.md)).

Not yet verified: behaviour with real models, prompt-cache hit rates, and whether ChatGPT tokens get the priority tier.

## Limits

One chat, one user, one shared token. The shell is an emulator — no real binaries, `npm`, or `git` (a Container backend would add them). No browser tool yet. pi-durable and `@cloudflare/computer` are both marked experimental.
