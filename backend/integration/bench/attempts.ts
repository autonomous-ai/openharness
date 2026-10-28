import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'

export interface Tracked<T> {
  value?: T
  error?: unknown
  ms: number
  /** One code per database transaction attempt that failed with a retryable error: P2034, P2002 or TRANSIENT. */
  failedAttempts: string[]
}

type Transactional = { $transaction: (...args: never[]) => Promise<unknown> }

/** The codes the store's retry loop retries (store.ts `retryable`); anything else is the call's own outcome. */
function retryCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = 'code' in error ? error.code : null
  if (code === 'P2034' || code === 'P2002') return code
  return error instanceof Error && error.message.includes('TransientTransactionError') ? 'TRANSIENT' : null
}

/**
 * Counts write conflicts without touching the store: every store (today's and the parts store, spec "Mongo transactions
 * through Prisma as today") runs each attempt as one `$transaction` call, so a wrapped client sees each failed attempt.
 * AsyncLocalStorage ties each attempt to the scenario call that caused it, while calls run concurrently.
 */
export class AttemptCounter {
  private readonly current = new AsyncLocalStorage<string[]>()

  wrap<D extends Transactional>(db: D): D {
    const failed = (error: unknown) => {
      const code = retryCode(error)
      if (code) this.current.getStore()?.push(code)
    }
    return new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property === '$transaction') {
          return async (...args: never[]) => {
            try { return await (value as Transactional['$transaction']).apply(target, args) } catch (error) { failed(error); throw error }
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  async track<T>(call: () => Promise<T>): Promise<Tracked<T>> {
    const failedAttempts: string[] = []
    const started = performance.now()
    try {
      const value = await this.current.run(failedAttempts, call)
      return { value, ms: performance.now() - started, failedAttempts }
    } catch (error) {
      return { error, ms: performance.now() - started, failedAttempts }
    }
  }
}
