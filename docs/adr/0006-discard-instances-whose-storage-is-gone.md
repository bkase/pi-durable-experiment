# Discard a Chat instance as soon as its storage is gone

Found in production: a deploy resets the Durable Object, but a worker-shell Dynamic Worker still running a command (e.g. `sleep 90`) outlives it, and when it finishes it calls back into the Workspace. That callback lands on the reset instance, whose storage now throws `Network connection lost` / `Durable Object reset because its code was updated` on every call; pi-durable's scheduler and OptChat's background work kept failing in a loop until the 300 s CPU limit, and the object answered nothing for ~5 minutes. `DoSqliteDatabase` now treats those errors as fatal and the DO calls `ctx.abort()`, so the dead instance goes away in milliseconds and the next request gets a fresh instance that resumes from storage. The Worker's CPU limit is 30 s per event to cap any other runaway loop.

## Consequences

- An `exec` interrupted by a deploy is reported to the Master as interrupted (ADR 0002); the zombie's late callback is dropped, not applied.
- The alarm's `settle` must only await what is pending: racing an already-resolved promise turned it into a busy loop (≈5 s CPU per long tool call before the fix, ≈50 ms after).
