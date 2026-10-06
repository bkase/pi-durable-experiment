# The Chat Durable Object is a plain class in an async Worker; Effect runs inside it

Alchemy v2's idiomatic Durable Object is an Effect-defined class (`Cloudflare.DurableObject<…>()(…)`) whose methods are Effects. We use Alchemy's async-Worker form instead: `alchemy.run.ts` (Effect) declares the Worker, the `Chat` namespace, the Worker Loader and the token, and `src/worker.ts` exports a plain `class Chat extends DurableObject`. `@cloudflare/computer`'s worker-shell calls back into the Workspace through `WorkspaceServiceProxy` → `env.Chat.get(id).__getWorkspaceStub()`, an RPC method on the DO class itself, and pi-durable is Promise/Chord-based; a plain class hosts both without fighting the generated Effect class. The OptChat core (Memory, Compactor, store) is Effect v4, run through a `ManagedRuntime` behind one bridge.

## Consequences

- Effect v4 is used for the stack and the OptChat core, not for the Worker/DO request plumbing.
- Each Run starts with `reset()`: pi-durable rebuilds the whole active context on every request, so without it per-request work grows with the whole history. Queued Events wait in OptChat's own inbox (not pi-durable follow-ups) so each starts after a reset.
