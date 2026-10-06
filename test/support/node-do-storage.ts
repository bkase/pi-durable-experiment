import { DatabaseSync } from "node:sqlite"
import type { DoStorage } from "../../src/pi/do-sqlite.ts"

/**
 * A stand-in for a Durable Object's SQLite storage on node:sqlite: synchronous `sql.exec`, and a
 * `transaction()` that commits the closure's writes together or rolls them all back.
 */
export const nodeDoStorage = (path = ":memory:"): DoStorage & { readonly db: DatabaseSync } => {
  const db = new DatabaseSync(path)
  let depth = 0
  return {
    db,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const statements = query.split(";").map((s) => s.trim()).filter((s) => s.length > 0)
        if (bindings.length === 0 && statements.length > 1) {
          db.exec(query)
          return { toArray: () => [] }
        }
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[]
        return { toArray: () => rows }
      }
    },
    async transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T> {
      const name = `sp${depth++}`
      db.exec(`SAVEPOINT ${name}`)
      try {
        const result = await closure({})
        db.exec(`RELEASE ${name}`)
        return result
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
        throw error
      } finally {
        depth--
      }
    }
  }
}
