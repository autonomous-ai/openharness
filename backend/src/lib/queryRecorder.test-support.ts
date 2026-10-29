/** Records the model calls a function sends to Prisma, to prove a read is not sent at all (empty id lists, phase 0.3). */
export interface Query { model: string; op: string; args: unknown }

/** Whether a query holds an empty `in` or `$in` list anywhere: what Prisma turns into `$or: []`, a scan of the collection. */
export function sendsEmptyIn(query: Query): boolean {
  const walk = (value: unknown): boolean => Array.isArray(value) ? value.some(walk)
    : value && typeof value === 'object' ? Object.entries(value).some(([key, inner]) => (['in', '$in'].includes(key) && Array.isArray(inner) && !inner.length) || walk(inner))
    : false
  return walk(query.args)
}

/** A client or transaction that answers every model call with nothing (`[]` for lists and raw reads, null for one row), unless
 *  `answers` gives `model.op`, and records each call. */
export function recordingDb(queries: Query[], answers: Record<string, unknown> = {}): never {
  const model = (name: string) => new Proxy({}, { get: (_, op: string) => async (args: unknown) => {
    queries.push({ model: name, op, args })
    return `${name}.${op}` in answers ? answers[`${name}.${op}`] : /^(findMany|aggregateRaw)$/.test(op) ? [] : op === 'count' ? 0 : null
  } })
  const models = new Map<string, unknown>()
  const db: object = new Proxy({}, { get: (_, key: string) => {
    if (key === '$transaction') return async (run: (tx: unknown) => unknown) => run(db)
    if (key === 'then') return undefined
    if (!models.has(key)) models.set(key, model(key))
    return models.get(key)
  } })
  return db as never
}

/** The same client with every call still running, and recorded. */
export function watched<T extends object>(db: T, queries: Query[]): T {
  const models = new Map<string, unknown>()
  return new Proxy(db, { get: (target, key) => {
    const value = Reflect.get(target, key, target)
    if (typeof key === 'string' && key.startsWith('$') && typeof value === 'function') return value.bind(target)
    if (typeof key !== 'string' || key.startsWith('$') || !value || typeof value !== 'object') return value
    if (!models.has(key)) models.set(key, new Proxy(value, { get: (delegate, op, r) => {
      const method = Reflect.get(delegate, op, r)
      return typeof method === 'function' && typeof op === 'string'
        ? (args: unknown) => { queries.push({ model: key, op, args }); return method.call(delegate, args) } : method
    } }))
    return models.get(key)
  } })
}
