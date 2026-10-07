import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite"

/** The parts of a Durable Object's storage this adapter uses. */
export interface DoStorage {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
  }
  transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T>
}

/**
 * Errors after which this object's storage is gone for good (the instance was reset, e.g. by a
 * deploy). Retrying is pointless; the instance must be discarded so a fresh one takes over.
 */
export const isFatalStorageError = (error: unknown): boolean =>
  error instanceof Error &&
  /Network connection lost|Durable Object reset|Durable Object storage is no longer|object to be reset|broken\.outputGateBroken/i.test(
    error.message
  )

const toBinding = (value: SqliteValue): unknown => {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return value.toString()
    return Number(value)
  }
  return value
}

const fromRow = <T>(row: Record<string, unknown>): T => {
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof ArrayBuffer) row[k] = new Uint8Array(v)
  }
  return row as T
}

/** Serializes access: a transaction holds the lock, and every other operation waits for it. */
class Lock {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

class Executor implements SqliteExecutor {
  constructor(
    protected readonly storage: DoStorage,
    private readonly guard: <T>(operation: () => T) => Promise<T>
  ) {}

  protected static checked<T>(operation: () => T, onFatal: (error: Error) => void): T {
    try {
      return operation()
    } catch (error) {
      if (isFatalStorageError(error)) onFatal(error as Error)
      throw error
    }
  }

  exec(sql: string): Promise<void> {
    return this.guard(() => {
      this.storage.sql.exec(sql).toArray()
    })
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.guard(() => {
      this.storage.sql.exec(sql, ...params.map(toBinding)).toArray()
    })
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.guard(() => {
      const rows = this.storage.sql.exec(sql, ...params.map(toBinding)).toArray()
      return rows.length === 0 ? undefined : fromRow<T>(rows[0]!)
    })
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.guard(() => this.storage.sql.exec(sql, ...params.map(toBinding)).toArray().map((r) => fromRow<T>(r)))
  }
}

/**
 * pi-durable's asynchronous `SqliteDatabase` over a Durable Object's synchronous SQLite.
 *
 * Transactions run inside `storage.transaction()`, which commits the closure's writes atomically
 * and rolls them all back if it throws. Operations outside a transaction queue behind it.
 */
export class DoSqliteDatabase extends Executor implements SqliteDatabase {
  private readonly lock: Lock
  private closed = false

  constructor(storage: DoStorage, private readonly onFatal: (error: Error) => void = () => {}) {
    const lock = new Lock()
    super(storage, (operation) => lock.run(async () => Executor.checked(operation, onFatal)))
    this.lock = lock
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("database is closed"))
    return this.lock.run(() =>
      this.storage.transaction(async () => {
        let active = true
        const handle = new Executor(this.storage, async (operation) => {
          if (!active) throw new Error("SQLite transaction handle is no longer active")
          return Executor.checked(operation, this.onFatal)
        })
        try {
          return await callback(handle)
        } finally {
          active = false
        }
      })
    )
  }

  close(): Promise<void> {
    this.closed = true
    return this.lock.run(async () => undefined)
  }
}
