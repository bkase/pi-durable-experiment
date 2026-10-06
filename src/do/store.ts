import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite"
import { Effect, Layer } from "effect"
import type { LogMessage } from "../optchat/log.ts"
import { type LogDraft, makeMessage, OptChatStore } from "../optchat/store.ts"
import type { Node } from "../optchat/tree.ts"

/** OptChat's own tables, next to pi-durable's in the same Durable Object SQLite database. */
export const OPTCHAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS oc_log (
  i INTEGER PRIMARY KEY,
  entry_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  size INTEGER NOT NULL,
  date TEXT NOT NULL,
  UNIQUE (entry_id, part)
);
CREATE TABLE IF NOT EXISTS oc_node (
  l INTEGER NOT NULL,
  i INTEGER NOT NULL,
  text TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (l, i)
);
CREATE TABLE IF NOT EXISTS oc_run_view (
  entry_id TEXT PRIMARY KEY,
  pieces TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oc_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oc_inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  submission_id TEXT,
  entry_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
);
`

type Row = Record<string, unknown>

const toMessage = (row: Row): LogMessage => ({
  i: Number(row.i),
  kind: row.kind as LogMessage["kind"],
  text: String(row.text),
  size: Number(row.size),
  date: String(row.date)
})

/**
 * OptChatStore over the DO's SQLite, through the same queued executor pi-durable uses, so OptChat's
 * writes never interleave with a pi-durable transaction. The Log is also cached in memory: it is
 * append-only and the Memory service reads every message at load.
 */
export const doOptChatStore = (db: SqliteDatabase) =>
  Layer.effect(
    OptChatStore,
    Effect.gen(function*() {
      const q = <A>(f: () => Promise<A>) => Effect.promise(f)
      yield* q(() => db.exec(OPTCHAT_SCHEMA))
      const rows = yield* q(() => db.all<Row>("SELECT i, kind, text, size, date FROM oc_log ORDER BY i"))
      const messages = rows.map(toMessage)
      const seen = new Set(
        (yield* q(() => db.all<Row>("SELECT entry_id, part FROM oc_log"))).map((r) => `${r.entry_id}#${r.part}`)
      )
      const firsts = new Map<string, number>()
      for (const r of yield* q(() => db.all<Row>("SELECT entry_id, MIN(i) AS i FROM oc_log GROUP BY entry_id"))) {
        firsts.set(String(r.entry_id), Number(r.i))
      }

      return OptChatStore.of({
        append: (drafts: ReadonlyArray<LogDraft>) =>
          Effect.gen(function*() {
            const fresh = drafts.filter((d) => !seen.has(`${d.entryId}#${d.part}`))
            if (fresh.length === 0) return []
            const added = fresh.map((d, k) => makeMessage(messages.length + k, d))
            yield* q(() =>
              db.transaction(async (tx) => {
                for (let k = 0; k < added.length; k++) {
                  const m = added[k]!
                  const d = fresh[k]!
                  await tx.run(
                    "INSERT INTO oc_log (i, entry_id, part, kind, text, size, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    m.i,
                    d.entryId,
                    d.part,
                    m.kind,
                    m.text,
                    m.size,
                    m.date
                  )
                }
              })
            )
            for (let k = 0; k < added.length; k++) {
              const d = fresh[k]!
              messages.push(added[k]!)
              seen.add(`${d.entryId}#${d.part}`)
              if (!firsts.has(d.entryId)) firsts.set(d.entryId, added[k]!.i)
            }
            return added
          }),
        count: Effect.sync(() => messages.length),
        message: (i) => Effect.sync(() => messages[i]),
        firstOf: (entryId) => Effect.sync(() => firsts.get(entryId)),
        projectedEntries: Effect.sync(() => new Set(firsts.keys())),
        putNode: (node: Node) =>
          q(() =>
            db.run("INSERT OR REPLACE INTO oc_node (l, i, text, size) VALUES (?, ?, ?, ?)", node.l, node.i, node.text, node.size)
          ),
        nodes: q(() => db.all<Row>("SELECT l, i, text, size FROM oc_node")).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({ l: Number(r.l), i: Number(r.i), text: String(r.text), size: Number(r.size) }))
          )
        ),
        runView: (entryId) =>
          q(() => db.get<Row>("SELECT pieces FROM oc_run_view WHERE entry_id = ?", entryId)).pipe(
            Effect.map((row) => (row === undefined ? undefined : (JSON.parse(String(row.pieces)) as string[])))
          ),
        putRunView: (entryId, pieces) =>
          q(() => db.run("INSERT OR IGNORE INTO oc_run_view (entry_id, pieces) VALUES (?, ?)", entryId, JSON.stringify(pieces)))
      })
    })
  )
