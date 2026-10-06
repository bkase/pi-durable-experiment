# Memory simulation (mock Compactor)

`bun scripts/simulate.ts 6000` replays synthetic Runs (user → talk → tool/echo ×3 → talk; echoes ~2.5 KB) through the real `Memory` service with the deterministic mock Compactor, rendering the Memory View at the start of each Run, as a Run would see it.

| T (messages) | view | lines | nodes | Compactor calls / message | prefix shared by consecutive Runs |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 127.9 KB | 316 | 1,994 | 1.37 | 18.6k of 129.6k chars |
| 2,000 | 127.6 KB | 299 | 3,994 | 1.37 | 27.7k of 130.0k |
| 3,000 | 127.6 KB | 292 | 5,993 | 1.37 | 37.7k of 130.1k |
| 4,000 | 127.6 KB | 289 | 7,994 | 1.37 | 42.8k of 130.0k |
| 5,000 | 127.7 KB | 287 | 9,995 | 1.37 | 46.3k of 130.1k |
| 6,000 | 127.7 KB | 286 | 11,993 | 1.37 | 49.8k of 130.1k |

- The view hovers at the 128 KB budget; it never grows with history.
- The shared prefix grows with history, as the spec reports (73k at 20k messages, 92k at 400k). Runs here are 8 messages apart, so this is more pessimistic than the spec's per-message replay.
- Fewer than the spec's ~2 Compactor calls per message, because short messages and short merges are free nodes.
- Lines average ~440 bytes because the mock Compactor fills lines; a real Compactor's ~250-byte lines would give ~500 lines.
- 6,000 messages take ~7 s of CPU in total for the fold, pump and renders.
