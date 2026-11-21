import { afterEach, describe, expect, it, vi } from 'vitest'
import { questionFrameBytes, QUESTION_OBSERVATION_BYTES, replayLegacyQuestions, startQuestionSnapshot } from './questionObservation.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('question observation bytes', () => {
  it('agrees with JSON at every byte boundary, including omitted fields, holes and inherited properties', () => {
    const nullPrototype = Object.assign(Object.create(null), { value: 'null prototype' })
    const frames = [{}, [], [, 'x'], ['x', 'y'], { a: 'x', b: 2 }, { toJSON: null }, { a: undefined, b: [undefined, true, false, null, NaN, Infinity, -0] }, nullPrototype]
    const compared: Array<[number | null, number | null]> = []
    Object.defineProperty(Object.prototype, 'questionByteFixture', { value: 'inherited', enumerable: true, configurable: true, writable: true })
    try {
      for (const frame of frames) {
        const bytes = Buffer.byteLength(JSON.stringify(frame))
        for (let limit = 0; limit <= bytes + 1; limit++) compared.push([questionFrameBytes(frame, limit), limit < bytes ? null : bytes])
      }
    } finally { Reflect.deleteProperty(Object.prototype, 'questionByteFixture') }
    for (const [actual, expected] of compared) expect(actual).toBe(expected)
    expect(questionFrameBytes(new Date(), 1000)).toBeNull()
    const getter = vi.fn(() => 'changes')
    expect(questionFrameBytes({ get text() { return getter() } }, 1000)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves the legacy adapter order and old treatment of rows without string IDs', () => {
    const send = vi.fn(), rows = [{ type: 'commander_question' }, { payload: { requestId: 1 } }, { payload: { requestId: 'q' } }]
    replayLegacyQuestions(rows, send)
    expect(send.mock.calls).toEqual([...rows.map(row => [row]), [{ type: 'commander_questions_open', payload: { requestIds: ['q'] } }]])
  })
  it.each(['plain', '\\"\n\r\t\b\f\u0000\u001f', 'é中😀', '\ud800', '\udc00', '\ud800x\udc00'])('counts exact escaped JSON UTF-8 bytes for %j', text => {
    const frame = { type: 'question_observation', payload: { text, values: [text, null, false, 1.2e50] } }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    expect(questionFrameBytes(frame, bytes)).toBe(bytes)
    expect(questionFrameBytes(frame, bytes - 1)).toBeNull()
  })

  it('rejects before visiting the remainder or serializing an oversized value', () => {
    const later = vi.fn(() => 'unread')
    const frame = { payload: { text: '\u0000'.repeat(100), get later() { return later() } } }
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(questionFrameBytes(frame, 32)).toBeNull()
    expect(later).not.toHaveBeenCalled()
    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
  })

  it('refuses a UTF-8 lower bound before fragment encoding even when UTF-16 length fits', () => {
    const frame = { text: '中'.repeat(16) }
    const limit = Buffer.byteLength(JSON.stringify({ text: '' })) + 16
    const stringify = vi.spyOn(JSON, 'stringify')
    const bytes = questionFrameBytes(frame, limit)
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(bytes).toBeNull()
    expect(calls).toBe(0)
  })

  it.each([
    '"\\\b\t\n\f\r'.repeat(32),
    '\u0000\u0007\u000b\u000e\u001f'.repeat(32),
    '\ud800\ud801\udc00\udc01'.repeat(32),
    'a"中\u0000😀\\\ud800é\t\udc00'.repeat(32),
  ])('keeps exact budgets for escape runs and mixed Unicode %j', text => {
    const frame = { [text]: [text, { notification: text }] }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    expect(questionFrameBytes(frame, bytes - 1)).toBeNull()
    expect(questionFrameBytes(frame, bytes)).toBe(bytes)
    expect(questionFrameBytes(frame, bytes + 1)).toBe(bytes)
  })

  it('counts every UTF-16 code unit, including surrogate pair boundaries, as JSON does', () => {
    let text = ''
    for (let code = 0; code <= 0xffff; code++) text += String.fromCharCode(code)
    const frame = { text, pairs: ['\ud7ff\ud800\udc00\udfff\ue000', '\udbff\udfff', '\ud800\ud800\udc00'] }
    const bytes = Buffer.byteLength(JSON.stringify(frame))
    expect(questionFrameBytes(frame, bytes)).toBe(bytes)
    expect(questionFrameBytes(frame, bytes - 1)).toBeNull()
  })

  it.each([4094, 4095, 4096])('preserves pairs and orphan surrogates across scan boundary %i', offset => {
    for (const suffix of ['😀\ud800x\udc00', '\ud800😀\udc00', '\ud800x', '\ud800\ue000', '\ud800']) {
      const text = 'x'.repeat(offset) + suffix + '\u0000"'.repeat(16)
      const frame = { text }
      const bytes = Buffer.byteLength(JSON.stringify(frame))
      expect(questionFrameBytes(frame, bytes)).toBe(bytes)
      expect(questionFrameBytes(frame, bytes - 1)).toBeNull()
    }
  })

  it('includes duplicated IDs, accepts the default service maximum and rejects unbounded inline content', () => {
    const requestId = `cloud_q_${'a'.repeat(6 * 1024 * 1024)}`
    const frame = { type: 'commander_question', agentId: 'cloud_a', dbSessionId: 'cloud_a', payload: {
      requestId, questions: [{ key: 'answer', q: 'Ask?', options: [], multi: false }], notification: { id: requestId, kind: 'needsYou' },
    } }
    expect(questionFrameBytes(frame, QUESTION_OBSERVATION_BYTES)).toBe(Buffer.byteLength(JSON.stringify(frame)))
    expect(questionFrameBytes({ text: '\u0000'.repeat(QUESTION_OBSERVATION_BYTES / 6 + 1) }, QUESTION_OBSERVATION_BYTES)).toBeNull()
  })

  it('bounds nesting and refuses non-JSON values without invoking toJSON', () => {
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
    expect(questionFrameBytes(cyclic, 1024)).toBeNull()
    expect(questionFrameBytes(1n, 1024)).toBeNull()
    const toJSON = vi.fn(() => 'not called')
    expect(questionFrameBytes({ toJSON }, 1024)).toBeNull()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('does not count one value and serialize another through hidden methods or array accessors', () => {
    const toJSON = vi.fn(() => 'changed')
    const hidden = Object.defineProperty({ text: 'original' }, 'toJSON', { value: toJSON })
    expect(questionFrameBytes(hidden, 1024)).toBeNull()
    const getter = vi.fn(() => 'changed')
    const array = Object.defineProperty([], '0', { get: getter })
    expect(questionFrameBytes(array, 1024)).toBeNull()
    expect(questionFrameBytes(Object.assign([], { toJSON }), 1024)).toBeNull()
    const hiddenGetter = Object.defineProperty({}, 'toJSON', { get: getter })
    expect(questionFrameBytes(hiddenGetter, 1024)).toBeNull()
    expect(toJSON).not.toHaveBeenCalled()
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('question snapshot', () => {
  it('releases the record iterator on cancellation while a physical send is still held', () => {
    vi.useFakeTimers()
    const returned = vi.fn(() => ({ done: true as const, value: undefined }))
    const next = vi.fn(() => ({ done: false as const, value: {} }))
    let settled!: (ok: boolean) => void
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: { next, return: returned }, current: () => true,
      close: vi.fn(), send: (_frame, done) => { settled = done; return true } })
    snapshot.cancel(); snapshot.cancel(); settled(true)
    expect(returned).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('cancels a queued continuation before it reads any snapshot row', async () => {
    vi.useFakeTimers()
    const next = vi.fn()
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: { next }, current: () => true, close: vi.fn(),
      send: (_frame, settled) => { settled(true); return true } })
    snapshot.cancel()
    await vi.runOnlyPendingTimersAsync()
    expect(next).not.toHaveBeenCalled()
  })

  it.each(['refused', 'throws', 'callback'] as const)('closes an unavailable snapshot once (%s)', mode => {
    vi.useFakeTimers()
    const close = vi.fn()
    let callback: (sent: boolean) => void = () => {}
    startQuestionSnapshot({ generation: 'g', rows: [][Symbol.iterator](), current: () => true, close,
      send: (_frame, settled) => {
        callback = settled
        if (mode === 'throws') throw new Error('transport failed')
        if (mode === 'callback') { settled(false); return true }
        return false
      },
    })
    callback(false); callback(true)
    expect(close).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_UNAVAILABLE')
  })

  it('yields over out-of-scope rows and closes if the authoritative iterator fails', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = [], close = vi.fn()
    let count = 0
    startQuestionSnapshot({ generation: 'g', current: () => true, close, accepts: () => false,
      rows: { next: () => { if (count++ === 0) return { done: false, value: {} }; throw new Error('source failed') } },
      send: (frame, settled) => { sent.push(frame); settled(true); return true },
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(1)
    expect(close).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_UNAVAILABLE')
  })

  it('checks incarnation before begin, at each yielded row and before a deadline close', async () => {
    vi.useFakeTimers()
    const send = vi.fn(() => true), close = vi.fn()
    startQuestionSnapshot({ generation: 'gone', rows: [][Symbol.iterator](), current: () => false, send, close })
    expect(send).not.toHaveBeenCalled()
    let current = true, callback: (sent: boolean) => void = () => {}
    startQuestionSnapshot({ generation: 'yielded', rows: [][Symbol.iterator](), current: () => current, close,
      send: (_frame, settled) => { callback = settled; return true } })
    callback(true); current = false
    await vi.advanceTimersByTimeAsync(1)
    current = true
    startQuestionSnapshot({ generation: 'waiting', rows: [][Symbol.iterator](), current: () => current, send, close })
    current = false
    await vi.advanceTimersByTimeAsync(20_000)
    expect(close).not.toHaveBeenCalled()
  })

  it('sends one row at a time, yields after physical completion and reconciles with end', async () => {
    vi.useFakeTimers()
    const rows = new Map([['a', { type: 'commander_question', agentId: 'a', payload: { requestId: 'qa' } }],
      ['b', { type: 'commander_question', agentId: 'b', payload: { requestId: 'qb' } }]])
    const sent: unknown[] = []
    const callbacks: Array<(ok: boolean) => void> = []
    const close = vi.fn()
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: rows.values(), current: () => true,
      send: (frame, done) => { sent.push(frame); callbacks.push(done); return true }, close })
    expect(sent).toEqual([{ type: 'questions_begin', payload: { generation: 'g' } }])
    callbacks.shift()!(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ type: 'questions_row', payload: { generation: 'g', question: { agentId: 'a' } } })
    rows.delete('b')
    callbacks.shift()!(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.at(-1)).toEqual({ type: 'questions_end', payload: { generation: 'g' } })
    callbacks.shift()!(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(close).not.toHaveBeenCalled()
    snapshot.cancel()
  })

  it('never continues a replaced snapshot and never calls incomplete state complete', async () => {
    vi.useFakeTimers()
    let current = true
    const sent: unknown[] = []
    let callback: (ok: boolean) => void = () => {}
    const close = vi.fn()
    startQuestionSnapshot({ generation: 'old', rows: [{ type: 'commander_question' }][Symbol.iterator](), current: () => current,
      send: (frame, done) => { sent.push(frame); callback = done; return true }, close })
    current = false
    callback(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toHaveLength(1)
    expect(close).not.toHaveBeenCalled()
  })

  it('has one fixed deadline even when callbacks make progress', async () => {
    vi.useFakeTimers()
    const sent: unknown[] = []
    let callback: (ok: boolean) => void = () => {}
    const close = vi.fn()
    startQuestionSnapshot({ generation: 'g', rows: [{ type: 'commander_question' }][Symbol.iterator](), current: () => true,
      send: (frame, done) => { sent.push(frame); callback = done; return true }, close })
    await vi.advanceTimersByTimeAsync(19_000)
    callback(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(close).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_TIMEOUT')
    callback(true)
    await vi.runOnlyPendingTimersAsync()
    expect(sent).toHaveLength(2)
    expect(sent.some(frame => (frame as { type: string }).type === 'questions_end')).toBe(false)
  })
})


describe('bounded settled read slices', () => {
  const controlTurn = () => new Promise<void>(resolve => { setImmediate(resolve) })
  const questions = (count: number) => Array.from({ length: count }, (_, i) => ({ type: 'commander_question', agentId: `a-${i}` }))

  it('drains 32 synchronous rows before yielding to controls without recursive physical sends', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const sent: Record<string, unknown>[] = [], close = vi.fn()
    let depth = 0, peak = 0
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: questions(4097)[Symbol.iterator](), current: () => true, close,
      send: (frame, done) => { depth++; peak = Math.max(peak, depth); sent.push(frame); done(true); depth--; return true } })
    try {
      expect(sent).toHaveLength(1)
      await controlTurn()
      expect(sent.filter(frame => frame.type === 'questions_row')).toHaveLength(32)
      expect(sent.some(frame => frame.type === 'questions_end')).toBe(false)
      expect(peak).toBe(1)
      snapshot.cancel()
      await controlTurn()
      expect(sent).toHaveLength(33)
      expect(close).not.toHaveBeenCalled()
    } finally { snapshot.cancel() }
  })

  it.each([false, true])('yields at 2 ms even below the row count bound (filtered=%s)', async filtered => {
    let clock = 0, reads = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const sent: Record<string, unknown>[] = []
    const rows = { next: () => { clock++; reads++; return { done: false as const, value: { agentId: 'a' } } } }
    const snapshot = startQuestionSnapshot({ generation: 'g', rows, current: () => true, close: vi.fn(), accepts: () => !filtered,
      send: (frame, done) => { sent.push(frame); done(true); return true } })
    try {
      await controlTurn()
      expect(reads).toBe(2)
      expect(sent).toHaveLength(filtered ? 1 : 3)
    } finally { snapshot.cancel() }
  })

  it('counts filtered membership toward the slice and returns its iterator once on cancellation', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const returned = vi.fn(() => ({ done: true as const, value: undefined })), next = vi.fn(() => ({ done: false as const, value: {} }))
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: { next, return: returned }, accepts: () => false,
      current: () => true, close: vi.fn(), send: (_frame, done) => { done(true); return true } })
    try {
      await controlTurn()
      expect(next).toHaveBeenCalledTimes(32)
      snapshot.cancel(); snapshot.cancel()
      await controlTurn()
      expect(next).toHaveBeenCalledTimes(32)
      expect(returned).toHaveBeenCalledOnce()
    } finally { snapshot.cancel() }
  })

  it('stops a synchronous slice at held physical credit and ignores repeated old callbacks', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const sent: Record<string, unknown>[] = [], close = vi.fn()
    let held!: (ok: boolean) => void
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: questions(4)[Symbol.iterator](), current: () => true, close,
      send: (frame, done) => {
        sent.push(frame)
        if (sent.length === 3) held = done
        else done(true)
        return true
      } })
    try {
      await controlTurn()
      expect(sent).toHaveLength(3)
      await controlTurn()
      expect(sent).toHaveLength(3)
      held(true); held(false); held(true)
      expect(sent).toHaveLength(3)
      await controlTurn()
      expect(sent.map(frame => frame.type)).toEqual(['questions_begin', ...Array(4).fill('questions_row'), 'questions_end'])
      expect(close).not.toHaveBeenCalled()
    } finally { snapshot.cancel() }
  })

  it('lets the original deadline stop synchronous slices and returns membership exactly once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const sent: Record<string, unknown>[] = [], close = vi.fn()
    const returned = vi.fn(() => ({ done: true as const, value: undefined }))
    const rows = { next: () => ({ done: false as const, value: {} }), return: returned }
    const snapshot = startQuestionSnapshot({ generation: 'g', rows, current: () => true, close,
      send: (frame, done) => { sent.push(frame); done(true); return true } })
    try {
      await controlTurn()
      expect(sent).toHaveLength(33)
      vi.advanceTimersByTime(20_000)
      await controlTurn()
      expect(close).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_TIMEOUT')
      expect(returned).toHaveBeenCalledOnce()
      expect(sent).toHaveLength(33)
      expect(vi.getTimerCount()).toBe(0)
    } finally { snapshot.cancel() }
  })

  it('closes once when a physically held send later settles unavailable', async () => {
    const close = vi.fn(), next = vi.fn(), returned = vi.fn(() => ({ done: true as const, value: undefined }))
    let settled!: (ok: boolean) => void
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: { next, return: returned }, current: () => true, close,
      send: (_frame, done) => { settled = done; return true } })
    try {
      expect(next).not.toHaveBeenCalled()
      settled(false); settled(true); settled(false)
      await controlTurn()
      expect(close).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_UNAVAILABLE')
      expect(next).not.toHaveBeenCalled()
      expect(returned).toHaveBeenCalledOnce()
    } finally { snapshot.cancel() }
  })

  it('revokes a read replaced while its last filtered row is classified at the slice boundary', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    let current = true, filtered = 0
    const close = vi.fn(), returned = vi.fn(() => ({ done: true as const, value: undefined }))
    const next = vi.fn(() => ({ done: false as const, value: {} }))
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: { next, return: returned }, current: () => current, close,
      accepts: () => { if (++filtered === 32) current = false; return false },
      send: (_frame, done) => { done(true); return true } })
    try {
      await controlTurn(); await controlTurn()
      expect(filtered).toBe(32)
      expect(next).toHaveBeenCalledTimes(32)
      expect(returned).toHaveBeenCalledOnce()
      expect(close).not.toHaveBeenCalled()
    } finally { snapshot.cancel() }
  })

  it.each(['cancel', 'replace'] as const)('rechecks %s after a synchronous completion before reading another row', async mode => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    let current = true
    const sent: Record<string, unknown>[] = [], close = vi.fn()
    const snapshot = startQuestionSnapshot({ generation: 'g', rows: questions(5)[Symbol.iterator](), current: () => current, close,
      send: (frame, done) => {
        sent.push(frame); done(true)
        if (sent.length === 3) {
          if (mode === 'cancel') snapshot.cancel()
          else current = false
        }
        return true
      } })
    try {
      await controlTurn(); await controlTurn()
      expect(sent).toHaveLength(3)
      expect(sent.some(frame => frame.type === 'questions_end')).toBe(false)
      expect(close).not.toHaveBeenCalled()
    } finally { snapshot.cancel() }
  })
})
