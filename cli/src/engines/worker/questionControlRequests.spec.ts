import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineQuestionControl, QuestionControlHost, QuestionStep } from '../facets/questionControl.js'
import { createQuestionControl as claude } from '../claude/questionControl.js'
import { createQuestionControl as codex } from '../codex/questionControl.js'
import { engineQuestionControlRequests } from './questionControlRequests.js'
import { createQuestionControlHost } from './questionControlHost.js'
import { questionControlStep, questionControlAction, QUESTION_CONTROL_APPLY as APPLY, QUESTION_CONTROL_CAPABILITIES as CAP,
  QUESTION_CONTROL_IN_FLIGHT, QUESTION_CONTROL_QUERY_MS, QUESTION_CONTROL_WAIT_MS } from './questionControlProtocol.js'

const row = { number: '2', label: 'Coffee', checked: false }
const step: QuestionStep = { kind: 'select', row, enterSubmits: true }
const request = { version: 1, token: 'a'.repeat(64), step, requestId: 'core-request' }
const asker = { owner: true, local: true }
const denied = { version: 1, error: 'ANSWER_FAILED' }
function setup(engine: 'claude' | 'codex' = 'claude') {
  const control: EngineQuestionControl = { apply: vi.fn(async () => true) }
  const deps = { load: vi.fn(async () => control), recycle: vi.fn(), query: vi.fn(async () => ({ version: 1, value: true, requestId: 'core-reply' } as Record<string, unknown>)) }
  const requests = engineQuestionControlRequests(engine, deps)
  return { requests, control, deps }
}

describe('private question-control worker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('loads only for a private, bounded core request and retries a failed import', async () => {
    const s = setup()
    expect(await s.requests[CAP]({ version: 1 }, asker)).toEqual({ version: 1, questionControl: 1, engine: 'claude' })
    expect(s.deps.load).not.toHaveBeenCalled()
    for (const who of [{ owner: false, local: true }, { owner: true, local: false }, { ...asker, connection: 'client' }]) {
      expect(await s.requests[APPLY](request, who)).toEqual(denied)
    }
    for (const payload of [{ ...request, version: 2 }, { ...request, token: 'guess' }, { ...request, terminal: '%9' }, { ...request, requestId: 3 }, { ...request, step: {} }]) {
      expect(await s.requests[APPLY](payload, asker)).toEqual(denied)
    }
    s.deps.load.mockRejectedValueOnce(new Error('load failed'))
    expect(await s.requests[APPLY](request, asker)).toEqual(denied)
    expect(await s.requests[APPLY](request, asker)).toEqual({ version: 1, ok: true })
    expect(await s.requests[APPLY](request, asker)).toEqual({ version: 1, ok: true })
    expect(s.deps.load).toHaveBeenCalledTimes(2)
    s.control.apply = vi.fn(async () => false)
    expect(await s.requests[APPLY](request, asker)).toEqual(denied)
  })

  it.each(['claude', 'codex'] as const)('runs %s native navigation and free-text sequencing through the host', async engine => {
    const s = setup(engine), keys: string[] = []
    s.control.apply = (engine === 'claude' ? claude : codex)(async () => {}).apply
    s.deps.query.mockImplementation(async () => ({ version: 1, value: true, requestId: 'core-reply' }))
    const actions: QuestionStep[] = [step, { kind: 'select', row }, { kind: 'text', row, text: 'My answer' },
      { kind: 'multiple', rows: [row] }, { kind: 'multiple', rows: [], freeText: { row, text: 'Custom choice' } }, { kind: 'review', key: 'Enter' }]
    for (const step of actions) expect(await s.requests[APPLY]({ ...request, step }, asker)).toEqual({ version: 1, ok: true })
    for (const call of s.deps.query.mock.calls) {
      const [query, payload] = call as unknown as [string, { token: string; action: { kind: string; key?: string; text?: string } }]
      expect(query).toBe('engine.questionControl'); expect(payload.token).toBe(request.token)
      keys.push(payload.action.key ?? `text:${payload.action.text}`)
    }
    expect(keys).toEqual([...(engine === 'codex' ? ['2', 'Enter'] : ['2']), '2', '2', 'text:My answer', 'Enter', '2', 'Tab', '2', 'text:Custom choice', 'Enter', 'Tab', 'Enter'])
  })

  it('bounds the step and effect vocabulary, including total payload bytes', () => {
    for (const value of [null, [], {}, { ...step, terminal: '%9' }, { ...step, enterSubmits: 1 }, { ...step, row: { ...row, number: 'C-c' } },
      { ...step, row: { ...row, walk: 'up' } }, { kind: 'text', row, text: 'a\u0000b' }, { kind: 'text', row, text: 'x'.repeat(32769) },
      { kind: 'review', key: 'C-c' }, { kind: 'multiple', rows: Array(100).fill(row) }, { kind: 'multiple', rows: [], freeText: { row, text: 2 } },
      { kind: 'multiple', rows: Array(5).fill({ ...row, label: 'x'.repeat(262144) }) }]) expect(questionControlStep(value)).toBe(false)
    for (const value of [null, {}, { kind: 'key', key: 'C-c' }, { kind: 'text', text: '\t' }, { kind: 'key', key: '2', target: '%9' }]) expect(questionControlAction(value)).toBe(false)
    for (const value of [{ kind: 'key', key: '99' }, { kind: 'key', key: 'Tab' }, { kind: 'text', text: 'two\nlines' }]) expect(questionControlAction(value)).toBe(true)
  })

  it('refuses malformed host replies and makes no late request after completion or abort', async () => {
    for (const reply of [{ version: 2, value: true }, { version: 1, value: 1 }, { version: 1, value: true, terminal: '%9' },
      { version: 1, value: true, error: 'ANSWER_FAILED' }, { version: 1, value: 'x'.repeat(1024 * 1024) }]) {
      await expect(createQuestionControlHost(async () => reply).key('2')).rejects.toThrow()
    }
    const s = setup(), already = new AbortController()
    already.abort()
    expect(await s.requests[APPLY](request, asker, already.signal)).toEqual(denied)
    let host!: QuestionControlHost
    s.control.apply = vi.fn(async (_step, value) => { host = value; return value.key('2') })
    expect(await s.requests[APPLY](request, asker)).toHaveProperty('ok', true)
    await expect(host.key('Enter')).rejects.toThrow()
    const closed = new AbortController()
    s.control.apply = vi.fn(async (_step, value) => { closed.abort(); return value.key('Enter') })
    expect(await s.requests[APPLY](request, asker, closed.signal)).toEqual(denied)
    expect(s.deps.query).toHaveBeenCalledOnce()
  })

  it.each(['load', 'apply', 'query'] as const)('bounds and recycles a hung %s', async kind => {
    const s = setup()
    let host!: QuestionControlHost
    if (kind === 'load') s.deps.load.mockImplementation(() => new Promise(() => {}))
    else s.control.apply = vi.fn(async (_step, value) => { host = value; return kind === 'query' ? value.key('2') : new Promise(() => {}) })
    if (kind === 'query') s.deps.query.mockImplementation(() => new Promise(() => {}))
    const result = s.requests[APPLY](request, asker)
    await vi.advanceTimersByTimeAsync((kind === 'query' ? QUESTION_CONTROL_QUERY_MS : QUESTION_CONTROL_WAIT_MS) + 1)
    expect(await result).toEqual(denied)
    expect(s.deps.recycle).toHaveBeenCalledOnce()
    if (host) await expect(host.text('late')).rejects.toThrow()
  })

  it('refuses overflow without queueing and aborts pending work when core disconnects', async () => {
    const s = setup(), closed = new AbortController()
    s.control.apply = vi.fn(() => new Promise<boolean>(() => {}))
    const pending = Array.from({ length: QUESTION_CONTROL_IN_FLIGHT }, () => s.requests[APPLY](request, asker, closed.signal))
    expect(await s.requests[APPLY](request, asker)).toEqual(denied)
    closed.abort()
    expect(await Promise.all(pending)).toEqual(Array(QUESTION_CONTROL_IN_FLIGHT).fill(denied))
    expect(s.deps.recycle).not.toHaveBeenCalled()
  })
})
