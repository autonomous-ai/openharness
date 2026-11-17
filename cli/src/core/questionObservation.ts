/** The shared question snapshot contract. Connection owners retain interest and physical send ownership. */
export const QUESTION_OBSERVATION_BYTES = 16 * 1024 * 1024
export const QUESTION_OBSERVATION_CONNECTION_FRAMES = 256
export const QUESTION_OBSERVATION_FRAMES = 4096
export const QUESTION_OBSERVATION_TIMEOUT_MS = 20_000

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

/** Count before serialization: inline questions and old Registry identities have no source byte bound.
 * Only plain JSON question records enter here. String copies stay within one scan chunk; no key arrays or toJSON calls. */
export function questionFrameBytes(frame: unknown, limit: number): number | null {
  let bytes = 0
  const add = (size: number): boolean => (bytes += size) <= limit
  const string = (value: string): boolean => {
    // A legal escaped Cloud frame held the core for 215 ms; the per-escape loop dominated its profile.
    // UTF-16 length is a lower bound, so even an unbounded inline value is refused before a native scan.
    if (value.length > limit - bytes - 2 || !add(2 + Buffer.byteLength(value))) return false
    if (!/["\\\u0000-\u001f\ud800-\udfff]/.test(value)) return true
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 4096, value.length)
      const high = value.charCodeAt(end - 1)
      if (high >= 0xd800 && high <= 0xdbff) {
        const low = value.charCodeAt(end)
        if (low >= 0xdc00 && low <= 0xdfff) end--
      }
      // Native replacements hold at most one small chunk; no JS iteration or callback per escape.
      const chunk = value.slice(start, end)
      const short = chunk.length - chunk.replace(/["\\\b\t\n\f\r]/g, '').length
      const control = chunk.length - chunk.replace(/[\u0000-\u0007\u000b\u000e-\u001f]/g, '').length
      // Do not split pairs above: Unicode mode then matches only lone surrogates (3 UTF-8 / 6 JSON bytes).
      const lone = chunk.length - chunk.replace(/[\ud800-\udfff]/gu, '').length
      if (!add(short + control * 5 + lone * 3)) return false
      start = end
    }
    return true
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

/** No copied snapshot or deferred live queue: the current record is put on the ordered socket before yielding. */
export function startQuestionSnapshot(deps: QuestionSnapshotDeps): { cancel(): void } {
  let stopped = false
  let next: NodeJS.Immediate | undefined
  const cancel = (): void => {
    stopped = true
    clearTimeout(deadline)
    if (next) clearImmediate(next)
  }
  const failed = (reason: Parameters<QuestionSnapshotDeps['close']>[0]): void => {
    const current = deps.current()
    cancel()
    if (current) deps.close(reason)
  }
  const deadline = setTimeout(() => failed('QUESTION_OBSERVATION_TIMEOUT'), QUESTION_OBSERVATION_TIMEOUT_MS)
  deadline.unref?.()
  const current = (): boolean => {
    if (stopped) return false
    if (deps.current()) return true
    cancel()
    return false
  }
  const send = (frame: Record<string, unknown>, ended = false): void => {
    if (!current()) return
    let settled = false
    const done = (sent: boolean): void => {
      if (settled) return
      settled = true
      if (!current()) return
      if (!sent) { failed('QUESTION_OBSERVATION_UNAVAILABLE'); return }
      if (ended) { cancel(); return }
      // Even an inline test sink cannot recursively walk the whole map on this stack.
      next = setImmediate(advance)
    }
    try { if (!deps.send(frame, done)) done(false) } catch { done(false) }
  }
  const advance = (): void => {
    next = undefined
    if (!current()) return
    let row: IteratorResult<Record<string, unknown>>
    try { row = deps.rows.next() } catch { failed('QUESTION_OBSERVATION_UNAVAILABLE'); return }
    if (row.done) send({ type: 'questions_end', payload: { generation: deps.generation } }, true)
    else if (deps.accepts && !deps.accepts(row.value)) next = setImmediate(advance)
    else send({ type: 'questions_row', payload: { generation: deps.generation, question: row.value } })
  }
  send({ type: 'questions_begin', payload: { generation: deps.generation } })
  return { cancel }
}
