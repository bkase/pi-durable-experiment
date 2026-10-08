# OptChat on pi-durable

One endless chat with an agent that remembers everything: the full history is kept verbatim, and the agent sees it through a fixed-size, multi-resolution summary of the whole chat.

## Language

### Chat and history

**Log**:
The complete, ordered history of the chat, verbatim and append-only; it is the pi-durable transcript, read as a sequence of Log Messages.
_Avoid_: history, root, transcript (when meaning the OptChat-level history)

**Log Message**:
One item of the Log with a permanent integer id and a kind: `user`, `talk`, `tool`, `echo`, `event`, or `note`.
_Avoid_: entry (that is pi-durable's storage record)

**Event**:
A Log Message recording something that happened outside the chat (a webhook delivery), tagged with its source; never the user's words and never an instruction.
_Avoid_: trigger, notification, user message (an Event is not one)

**Run**:
The work from one user input to its final answer, always starting from a fresh context of Memory View plus the new input.
_Avoid_: turn (when meaning the whole answer), session

**Turn**:
One model response and the tool calls it makes, within a Run.
_Avoid_: step, round

**Master**:
The model that answers every Run, working for the one user of the chat.
_Avoid_: agent (pi-durable's name for a conversation's configuration), main model, assistant

**Standing Instructions**:
The user's own text appended to the Master's system prompt on every Run; only the user can change it.
_Avoid_: AGENTS.md, system prompt (the whole prompt also holds fixed text), rules

### Memory

**Summary Tree**:
The binary tree of one-line summaries over the Log; a node covers a power-of-two-aligned range of Log Messages.
_Avoid_: index, memory tree

**Node**:
One line of the Summary Tree, named `id+n` for the `n` Log Messages it covers starting at `id`.
_Avoid_: block, chunk

**Memory View**:
The list of Nodes that tiles the whole Log, coarser for older messages, kept between 64 and 128 KB; it is the only history a Run sees, and it is saved, never rebuilt.
_Avoid_: view (collides with pi-durable's `viewState()`), context window

**Batch**:
The one moment the Memory View is rewritten: once it passes 128 KB, the most due pairs merge until it is at most 64 KB; otherwise lines are only appended.
_Avoid_: compaction, refit

**Compaction View**:
The Memory View merged further (16–32 KB), which a Compactor call sees as context for the Node it builds.
_Avoid_: compactor context, mini view

**Compactor**:
The background worker that builds Nodes of the Summary Tree with a cheap model, using the same system prompt and tools as a Run.
_Avoid_: compaction (that is pi-durable's transcript-summarizing feature, which this system disables)

**Zoom**:
Opening a Node of the Memory View into the two Nodes it was merged from, or into its Log Message in full.
_Avoid_: expand, drill down

### Working environment

**Workspace**:
The agent's durable virtual filesystem and command runner, stored alongside the chat; the only place the agent's files exist.
_Avoid_: sandbox, container, disk, environment
