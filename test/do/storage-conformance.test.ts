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

describe("DoSqliteDatabase after the object's storage is lost", () => {
  it("reports the fatal error once per failing call and still rejects", async () => {
    const base = nodeDoStorage()
    let lost = false
    const storage = {
      ...base,
      sql: {
        exec(query: string, ...bindings: unknown[]) {
          if (lost) throw new Error("Network connection lost.")
          return base.sql.exec(query, ...bindings)
        }
      }
    }
    const fatal: string[] = []
    const db = new DoSqliteDatabase(storage, (e) => fatal.push(e.message))
    await db.exec("CREATE TABLE t (v INTEGER)")
    lost = true
    await expect(db.get("SELECT * FROM t")).rejects.toThrow("Network connection lost")
    await expect(db.transaction((tx) => tx.run("INSERT INTO t (v) VALUES (1)"))).rejects.toThrow("Network connection lost")
    expect(fatal).toEqual(["Network connection lost.", "Network connection lost."])
  })

  it("does not treat ordinary SQL errors as fatal", async () => {
    const fatal: string[] = []
    const db = new DoSqliteDatabase(nodeDoStorage(), (e) => fatal.push(e.message))
    await expect(db.get("SELECT * FROM missing")).rejects.toThrow()
    expect(fatal).toEqual([])
  })
})
