import { RECORD_READ_BYTES, RECORD_READ_TIMEOUT_MS } from '../lib/recordReadWire.js'
import { jsonStringBytes } from '../lib/jsonStringBytes.js'

/** The shared question snapshot contract. Connection owners retain interest and physical send ownership. */
export const QUESTION_OBSERVATION_BYTES = RECORD_READ_BYTES
export const QUESTION_OBSERVATION_CONNECTION_FRAMES = 256
export const QUESTION_OBSERVATION_FRAMES = 4096
export const QUESTION_OBSERVATION_TIMEOUT_MS = RECORD_READ_TIMEOUT_MS

/** Public app compatibility, retained from 2026-11-18. Old mobile readers require ONE complete final
 * ID list. This adapter remains unbounded; date its removal from the first shipped capable clients. */
export function replayLegacyQuestions(rows: Iterable<Record<string, unknown>>, send: (frame: Record<string, unknown>) => void): void {
  const requestIds: string[] = []
  for (const question of rows) {
    send(question)
    const id = (question.payload as { requestId?: unknown } | undefined)?.requestId
    if (typeof id === 'string') requestIds.push(id)
  }
  send({ type: 'commander_questions_open', payload: { requestIds } })
}

/** Count before full-frame serialization: inline questions and old Registry identities have no source byte bound.
 * Only plain JSON records enter here. Primitive fragments stay bounded; no object serialization, key arrays or toJSON calls. */
export function questionFrameBytes(frame: unknown, limit: number): number | null {
  let bytes = 0
  const add = (size: number): boolean => (bytes += size) <= limit
  const string = (value: string): boolean => {
    const size = jsonStringBytes(value, limit - bytes)
    return size !== null && add(size)
  }
  const value = (item: unknown, depth: number): boolean => {
    if (depth > 8) return false
    if (item === null) return add(4)
    if (typeof item === 'string') return string(item)
    if (typeof item === 'boolean') return add(item ? 4 : 5)
    if (typeof item === 'number') return add(Number.isFinite(item) ? String(item).length : 4)
    if (typeof item !== 'object') return false
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return false
    const descriptor = (key: string): PropertyDescriptor | undefined => {
      for (let owner: object | null = item; owner !== null; owner = Object.getPrototypeOf(owner)) {
        const found = Object.getOwnPropertyDescriptor(owner, key)
        if (found) return found
      }
      return undefined
    }
    const toJSON = descriptor('toJSON')
    if (toJSON && (!('value' in toJSON) || typeof toJSON.value === 'function')) return false
    if (array) {
      if (!add(2)) return false
      for (let i = 0; i < item.length; i++) {
        if (i && !add(1)) return false
        const entry = descriptor(String(i))
        if (entry && !('value' in entry)) return false
        if (!value(entry?.value === undefined ? null : entry.value, depth + 1)) return false
      }
      return true
    }
    if (!add(2)) return false
    let first = true
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      // Counting must not invoke a getter that changes the value before serialization.
      if (!('value' in descriptor)) return false
      const held = descriptor.value
      if (held === undefined) continue
      if (!first && !add(1)) return false
      first = false
      if (!string(key) || !add(1) || !value(held, depth + 1)) return false
    }
    return true
  }
  return value(frame, 0) ? bytes : null
}

export interface QuestionSnapshotDeps {
  generation: string
  rows: Iterator<Record<string, unknown>>
  accepts?(row: Record<string, unknown>): boolean
  current(): boolean
  send(frame: Record<string, unknown>, settled: (sent: boolean) => void): boolean
  close(reason: 'QUESTION_OBSERVATION_TIMEOUT' | 'QUESTION_OBSERVATION_UNAVAILABLE'): void
}

/** Questions and service reads advance only when the physical transport settles the previous record. */
export function startSettledRecords<Row, Frame>(deps: {
  rows: Iterator<Row>
  begin: Frame
  row(value: Row): Frame | null
  end: Frame
  current(): boolean
  send(frame: Frame, settled: (sent: boolean) => void): boolean
  finished(reason: 'cancelled' | 'unavailable' | 'timeout' | null): void
  timeoutMs?: number
}): { cancel(): void } {
  let stopped = false
  let next: NodeJS.Immediate | undefined
  const finish = (reason: Parameters<typeof deps.finished>[0]): void => {
    if (stopped) return
    stopped = true
    clearTimeout(deadline)
    if (next) clearImmediate(next)
    // Release membership even while an old physical send still owns its socket credit.
    try { deps.rows.return?.() } catch { /* the source is already unavailable */ }
    deps.finished(reason)
  }
  const deadline = setTimeout(() => finish('timeout'), deps.timeoutMs ?? QUESTION_OBSERVATION_TIMEOUT_MS)
  deadline.unref?.()
  const current = (): boolean => {
    if (stopped) return false
    if (deps.current()) return true
    finish('cancelled')
    return false
  }
  const send = (frame: Frame, ended = false): void => {
    if (!current()) return
    let settled = false
    const done = (sent: boolean): void => {
      if (settled) return
      settled = true
      if (!current()) return
      if (!sent) { finish('unavailable'); return }
      if (ended) { finish(null); return }
      // A synchronously settling sink cannot recursively walk the whole source on this stack.
      next = setImmediate(advance)
    }
    try { if (!deps.send(frame, done)) done(false) } catch { done(false) }
  }
  const advance = (): void => {
    next = undefined
    if (!current()) return
    try {
      const row = deps.rows.next()
      if (row.done) send(deps.end, true)
      else {
        const frame = deps.row(row.value)
        if (frame === null) next = setImmediate(advance)
        else send(frame)
      }
    } catch { finish('unavailable') }
  }
  send(deps.begin)
  return { cancel: () => finish('cancelled') }
}

/** Preserve the existing question frames and interest filtering over the shared physical-send pump. */
export function startQuestionSnapshot(deps: QuestionSnapshotDeps): { cancel(): void } {
  return startSettledRecords({
    rows: deps.rows,
    begin: { type: 'questions_begin', payload: { generation: deps.generation } },
    row: question => deps.accepts && !deps.accepts(question) ? null : { type: 'questions_row', payload: { generation: deps.generation, question } },
    end: { type: 'questions_end', payload: { generation: deps.generation } },
    current: deps.current, send: deps.send,
    finished: reason => {
      if (deps.current() && (reason === 'timeout' || reason === 'unavailable')) {
        deps.close(reason === 'timeout' ? 'QUESTION_OBSERVATION_TIMEOUT' : 'QUESTION_OBSERVATION_UNAVAILABLE')
      }
    },
  })
}
