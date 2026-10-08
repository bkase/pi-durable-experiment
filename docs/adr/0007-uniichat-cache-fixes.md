# Follow the UniiChat revision of the spec for the view, compactions and prompt

The OptChat gist was rewritten as "UniiChat" (2026-10-08) after its author found that the original thrashed the prompt cache. We adopt its design: the merge order measures a pair's age from its last message (`(T − last)/2^l`, which reproduces Taelin's rollback push exactly); the view is a sawtooth (append only, one batch from 128 KB down to 64 KB) and is saved, never rebuilt; compactions send the turns' own system prompt and tools, then a 16–32 KB compaction view, then the task; one prompt serves turns and compactions; the view goes in 4-line blocks with the cache mark on the last whole block. In simulation consecutive Runs reuse 94.7% of the view, up from 14–38%.

## Deviations

- Replies keep the kind `talk` (the spec names them after the agent) so existing Logs stay valid; `event` stays as a kind (ADR 0004); no subagents (`work`, `zoom("Name")`) or device tools.
- The turns' prefix is captured from the request pi-durable builds and persisted, because compactions are made outside pi-durable with pi-ai. Master and Compactor are different models, so compactions share the prefix with each other rather than with the turns.
- Explicit cache marks map to OpenAI's `prompt_cache_breakpoint` and stay behind `CACHE_MARKS=on` (field unverified); the prefix stability that the marks exploit is what matters for automatic prefix caching too.
