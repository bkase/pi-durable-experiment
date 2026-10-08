# Memory simulation (mock Compactor)

`bun scripts/simulate.ts 6000` replays synthetic Runs (user → talk → tool/echo ×3 → talk; echoes ~2.5 KB) through the real `Memory` service with the deterministic mock Compactor, rendering the Memory View at the start of each Run as the Run would see it, and measures how much of the previous Run's view is a byte-identical prefix of the next one's: the part a prompt cache can serve.

## After the UniiChat cache fixes (2026-10-08)

| T (messages) | view | lines | batches so far | view reused from the previous Run |
|---:|---:|---:|---:|---:|
| 1,000 | 71.0 KB | 176 | 3 | 92.7% |
| 2,000 | 77.8 KB | 197 | 7 | 94.7% |
| 3,000 | 84.1 KB | 219 | 11 | 94.7% |
| 4,000 | 90.5 KB | 242 | 15 | 94.8% |
| 5,000 | 96.9 KB | 266 | 19 | 94.8% |
| 6,000 | 103.2 KB | 289 | 23 | 94.7% |

The view is a sawtooth between 64 and 128 KB (snapshots land at different phases). Between batches each Run's view is a strict prefix of the next; the ~5% not reused is the batch every ~250 messages, which rewrites the view once.

## Before (original OptChat spec, 2026-10-06)

| T (messages) | view | lines | view reused from the previous Run |
|---:|---:|---:|---:|
| 1,000 | 127.9 KB | 316 | 14% (18.6k of 129.6k chars) |
| 3,000 | 127.6 KB | 292 | 29% (37.7k of 130.1k) |
| 6,000 | 127.7 KB | 286 | 38% (49.8k of 130.1k) |

Two causes: the merge order measured a pair's age from its *first* message, which keeps rewriting old lines, and merges ran at every message, so every Run's view differed from the last one near its middle.

Compactor calls stay at ~1.37 per message (short messages and short merges are free nodes); runs are 8 messages apart here, so this is more pessimistic than a per-message replay.
