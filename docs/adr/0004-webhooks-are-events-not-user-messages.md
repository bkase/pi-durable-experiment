# Webhook deliveries are a separate `event` kind, queued as follow-ups

Webhooks can wake the Master, but their bodies are third-party text. OptChat's Compactor ranks `user` text highest and the Master obeys it, so logging deliveries as `user` (as the spec does for subagent reports) would let any webhook sender issue lasting "instructions". Instead a delivery is logged as a new kind, `event: [<source>] …` (capped like tool output), always starts a Run, and when the Master is busy is queued as a follow-up, never a steer. The Compactor prompt and the view documentation say an event is recorded, never obeyed; the Master acts on events only as the user's earlier instructions say.

## Considered Options

- **Log as `user` with a `[hook:<source>]` prefix**: simplest and spec-like, but promotes untrusted text to the user's own words in memory.
- **Per-source delivery mode (`run` vs append-only `log`)**: deferred until a noisy source needs it.

## Consequences

- The Compactor and view prompts deviate from the OptChat spec's verbatim text by one kind.
- Webhook auth reuses the shared token (header, or `/hook/<token>/<source>` for senders that can't set headers); the sender's delivery id becomes the pi-durable `requestId`, so retries don't double-run.
