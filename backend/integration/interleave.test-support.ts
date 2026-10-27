/** Test support: a database whose transactions let another writer in at a chosen point, to make races repeatable. */
import type { PrismaClient } from '@prisma/client'

const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])

/** `db`, but each transaction attempt runs `interleave` (another writer committing, or a barrier) once, before its first
 *  write of any kind: after everything it read, before anything it wrote. */
export function beforeFirstWrite(db: PrismaClient, interleave: () => Promise<void>): PrismaClient {
  const wrap = (tx: PrismaClient) => {
    let waited: Promise<void> | null = null
    return new Proxy(tx, { get(target, key, receiver) {
      const model = Reflect.get(target, key, receiver)
      if (!model || typeof model !== 'object') return model
      return new Proxy(model, { get(delegate, method, delegateReceiver) {
        const original = Reflect.get(delegate, method, delegateReceiver)
        if (typeof method !== 'string' || !WRITES.has(method) || typeof original !== 'function') return original
        return async (...args: unknown[]) => { await (waited ??= interleave()); return original.apply(delegate, args) }
      } })
    } })
  }
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== '$transaction') return Reflect.get(target, key, receiver)
    return (body: (tx: PrismaClient) => Promise<unknown>, options: unknown) =>
      (target.$transaction as (b: unknown, o: unknown) => Promise<unknown>)((tx: PrismaClient) => body(wrap(tx)), options)
  } })
}
