# The pi-durable transcript is the OptChat Log; requests are rewritten per Run

OptChat needs every Run to start fresh (Memory View + new input) while keeping the whole history verbatim. pi-durable instead keeps a continuous transcript and shrinks it with compaction. We keep pi-durable's transcript as the single source of truth for the Log, project its entries into Log Messages, and use the generation `beforeRequest` hook to replace each request's messages with `[Memory View rendered at Run start] [new input] [this Run's own Turns]`. pi-durable compaction is disabled.

## Considered Options

- **Separate OptChat Log table**, with the transcript as per-Run scratch (`reset()` each Run): matches the OptChat spec literally, but stores everything twice and the two can disagree after a crash.

## Consequences

- The model never sees pi-durable's accumulated transcript, even though storage holds all of it.
- Prompt-cache breakpoints inside the Memory View can't be expressed through pi-ai `Message`s; they need a provider wrapper using pi-ai's `onPayload`.
