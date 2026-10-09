# The Workspace is @cloudflare/computer with the worker-shell backend, not a container

The agent needs files and a shell, but a Durable Object has neither. We use `@cloudflare/computer`'s `Workspace` on the same DO's SQLite storage, with the worker-shell backend (just-bash in a Dynamic Worker via Worker Loader), and wrap its pi-ai tools as pi-durable tools so each call is a durable task: reads are `replay: "safe"`, writes and `exec` are not.

## Considered Options

- **just-bash directly in the DO** with our own SQLite filesystem adapter: no Worker Loader, but shell work blocks the agent's isolate and we own the persistence code. Kept as the fallback if Worker Loader can't be deployed.
- **Cloudflare Container from day one**: real Linux, but slow cold starts and a second store to sync.
- **A pi-durable `ExecutionEnv` over the Workspace** (so the stock `CodingTools` work): the env conformance suite (watch, binary readers, …) costs far more than wrapping a handful of tools.

## Consequences

- The shell is an emulator: no real binaries, no `npm install`. The container backend can be added behind the same `exec` when that hurts.
- Both `@cloudflare/computer` and pi-durable are pre-1.0/experimental; expect API churn.
- The worker-shell has no network by default. Its `curl` goes through `EgressGateway`, an entrypoint in our own Worker that lets through only hosts on `EGRESS_ALLOW` (default GitHub's API and raw content), so a prompt-injected command can't send Workspace files elsewhere.
