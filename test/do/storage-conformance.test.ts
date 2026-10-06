import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { registerStorageConformance } from "@earendil-works/pi-durable/testing"
import { describe, expect, it } from "vitest"
import { DoSqliteDatabase } from "../../src/pi/do-sqlite.ts"
import { nodeDoStorage } from "../support/node-do-storage.ts"

registerStorageConformance({ describe, expect, it } as never, "DoSqliteDatabase", async (use: (s: SqliteStorage) => Promise<void>) => {
  const storage = await SqliteStorage.open(new DoSqliteDatabase(nodeDoStorage()))
  await use(storage)
})

describe("DoSqliteDatabase transactions", () => {
  it("rolls back every write when the callback throws", async () => {
    const db = new DoSqliteDatabase(nodeDoStorage())
    await db.exec("CREATE TABLE t (v TEXT)")
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t (v) VALUES (?)", "a")
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(await db.all("SELECT * FROM t")).toEqual([])
  })

  it("queues outside operations behind an open transaction", async () => {
    const db = new DoSqliteDatabase(nodeDoStorage())
    await db.exec("CREATE TABLE t (v INTEGER)")
    const order: string[] = []
    const tx = db.transaction(async (t) => {
      await t.run("INSERT INTO t (v) VALUES (1)")
      await new Promise((r) => setTimeout(r, 20))
      order.push("tx")
    })
    const read = db.all<{ v: number }>("SELECT v FROM t").then((rows) => {
      order.push(`read:${rows.length}`)
    })
    await Promise.all([tx, read])
    expect(order).toEqual(["tx", "read:1"])
  })

  it("rejects a transaction handle used after the callback settles", async () => {
    const db = new DoSqliteDatabase(nodeDoStorage())
    await db.exec("CREATE TABLE t (v INTEGER)")
    let leaked: { run: (sql: string) => Promise<void> } | undefined
    await db.transaction(async (t) => {
      leaked = t
    })
    await expect(leaked!.run("INSERT INTO t (v) VALUES (1)")).rejects.toThrow("no longer active")
  })
})
