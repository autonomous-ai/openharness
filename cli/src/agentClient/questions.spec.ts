import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { observeQuestions, type QuestionAnswerBudget } from './questions.js'
import type { ClientSocket } from './daemon.js'
import { DeviceWorkBudget } from '../lib/autonomous-device/pendingWork.js'

afterEach(() => vi.useRealTimers())

function fixture(options: { budget?: QuestionAnswerBudget | null; closes?: boolean } = {}) {
  const socket = new EventEmitter() as EventEmitter & ClientSocket
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  socket.send = text => { sent.push(JSON.parse(text)) }
  socket.close = vi.fn(() => { if (options.closes !== false) socket.emit('close', 1000) })
  const listener = { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }
  const client = observeQuestions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, listener, () => socket,
    options.budget === null ? undefined : options.budget ?? new DeviceWorkBudget())
  const frame = (type: string, payload: Record<string, unknown>) => socket.emit('message', { toString: () => JSON.stringify({ type, payload }) }, false)
  return { socket, sent, listener, client, frame }
}

async function ready(f: ReturnType<typeof fixture>) {
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' }); f.frame('questions_end', { generation: 'g' })
  await f.client.ready
}

it('refuses before the snapshot, and accepts only the exact question response without overwriting a pending answer', async () => {
  const f = fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await f.client.answer('a', 'q', { choice: 'yes' }, () => true)).toBe(false)
  await ready(f)
  let settled = false
  const first = f.client.answer('a', 'q', { choice: 'yes' }, () => true).then(ok => { settled = true; return ok })
  expect(await f.client.answer('b', 'q', { choice: 'no' }, () => true)).toBe(false)
  expect(f.sent.filter(frame => frame.type === 'question_response')).toEqual([{ type: 'question_response', payload: {
    agentId: 'a', requestId: 'q', answers: { choice: 'yes' }, allowPermissions: false,
  } }])
  f.frame('other_result', { requestId: 'q', ok: true })
  f.frame('question_response_result', { requestId: 'other', ok: true })
  f.frame('question_response_result', { ok: true })
  await Promise.resolve(); expect(settled).toBe(false)
  f.frame('question_response_result', { requestId: 'q', error: 'STALE_QUESTION' })
  expect(await first).toBe(false)
  expect(f.socket.close).not.toHaveBeenCalled()
  const next = f.client.answer('a', 'next', { choice: 'yes' }, () => true)
  f.frame('question_response_result', { requestId: 'next', ok: true })
  expect(await next).toBe(true)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[questions] QUESTION_ANSWER_BUSY')
  f.client.close(); warn.mockRestore()
})

it('bounds actual pending payload across replaced observations until the original socket closes', async () => {
  vi.useFakeTimers()
  const pool = new DeviceWorkBudget(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const old = fixture({ budget: pool, closes: false }); await ready(old)
  const answers = Array.from({ length: 100 }, (_, i) => old.client.answer('a', `q${i}`, { choice: 'yes' }, () => true))
  expect(await old.client.answer('a', 'over', { choice: 'yes' }, () => true)).toBe(false)
  old.client.close()
  expect(await Promise.all(answers)).toEqual(Array(100).fill(false))
  const fresh = fixture({ budget: pool }); await ready(fresh)
  expect(await fresh.client.answer('a', 'fresh', { choice: 'yes' }, () => true)).toBe(false)
  old.frame('question_response_result', { requestId: 'q0', ok: true })
  expect(await fresh.client.answer('a', 'fresh', { choice: 'yes' }, () => true)).toBe(false)
  old.socket.emit('close', 1000)
  const confirmed = fresh.client.answer('a', 'fresh', { choice: 'yes' }, () => true)
  fresh.frame('question_response_result', { requestId: 'fresh', ok: true })
  expect(await confirmed).toBe(true)
  fresh.client.close(); warn.mockRestore()
})

it('refuses oversized retained answers and a read-only observer without disrupting observation', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  for (const [f, answers] of [[fixture(), { q: 'x'.repeat(16 * 1024 * 1024) }], [fixture({ budget: null }), { q: 'yes' }]] as const) {
    await ready(f)
    expect(await f.client.answer('a', 'q', answers, () => true)).toBe(false)
    expect(f.sent).toHaveLength(2)
    expect(f.socket.close).not.toHaveBeenCalled()
    f.client.close()
  }
  expect(warn.mock.calls).toEqual(Array(2).fill(['[questions] QUESTION_ANSWER_BACKPRESSURE']))
  warn.mockRestore()
})

it('retires the socket on an answer deadline and holds its charge until actual close, without replay', async () => {
  vi.useFakeTimers()
  const release = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = fixture({ budget: { reserve: () => release }, closes: false }); await ready(f)
  const answer = f.client.answer('a', 'q', { choice: 'yes' }, () => true)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await answer).toBe(false)
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_ANSWER_TIMEOUT')
  expect(release).not.toHaveBeenCalled()
  expect(await f.client.answer('a', 'q', { choice: 'yes' }, () => true)).toBe(false)
  f.frame('question_response_result', { requestId: 'q', ok: true })
  expect(release).not.toHaveBeenCalled()
  expect(f.sent.filter(frame => frame.type === 'question_response')).toHaveLength(1)
  f.socket.emit('close', 1000); f.socket.emit('close', 1000)
  expect(release).toHaveBeenCalledOnce()
  expect(warn).toHaveBeenCalledExactlyOnceWith('[questions] QUESTION_ANSWER_TIMEOUT')
  warn.mockRestore()
})

it('keeps an ambiguous send charged and makes every pending answer unconfirmed on socket failure', async () => {
  const release = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const f = fixture({ budget: { reserve: () => release }, closes: false }); await ready(f)
  const first = f.client.answer('a', 'q', { q: 'yes' }, () => true)
  f.socket.send = () => { throw new Error('untrusted socket detail') }
  const second = f.client.answer('b', 'r', { q: 'no' }, () => true)
  expect(await Promise.all([first, second])).toEqual([false, false])
  expect(release).not.toHaveBeenCalled()
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_UNAVAILABLE')
  f.socket.emit('close', 1000)
  expect(release).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledExactlyOnceWith('[questions] QUESTION_ANSWER_UNAVAILABLE · Error')
  warn.mockRestore()
})

it('checks caller authority before admission, beside send and after the correlated result', async () => {
  let current = true
  const release = vi.fn(), reserve = vi.fn(() => release)
  const f = fixture({ budget: { reserve } }); await ready(f)
  expect(await f.client.answer('a', 'q', { q: 'yes' }, () => false)).toBe(false)
  expect(reserve).not.toHaveBeenCalled()
  reserve.mockImplementationOnce(() => { current = false; return release })
  expect(await f.client.answer('a', 'q', { q: 'yes' }, () => current)).toBe(false)
  expect(release).toHaveBeenCalledOnce()
  expect(f.sent).toHaveLength(2)
  current = true
  const answer = f.client.answer('a', 'q', { q: 'yes' }, () => current)
  current = false
  f.frame('question_response_result', { requestId: 'q', ok: true })
  expect(await answer).toBe(false)
  expect(release).toHaveBeenCalledTimes(2)
  f.client.close()
})

it('releases an unsent admission when the observer closes while reserving it', async () => {
  const release = vi.fn()
  const f = fixture({ budget: { reserve: () => { f.client.close(); return release } } })
  await ready(f)
  expect(await f.client.answer('a', 'q', { q: 'yes' }, () => true)).toBe(false)
  expect(release).toHaveBeenCalledOnce()
  expect(f.sent).toHaveLength(2)
  f.socket.emit('open')
  expect(f.sent).toHaveLength(2)
})

it.each([
  { ok: false, error: 'TOO_MANY' }, { ok: false }, { ok: true },
])('refuses an unsuccessful observation result without admitting answers (%j)', async result => {
  const f = fixture(), failure = f.client.ready.catch(error => error)
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ...result })
  expect((await failure).code).toBe('error' in result ? result.error : 'QUESTION_OBSERVATION_PROTOCOL')
  expect(await f.client.answer('a', 'q', { q: 'yes' }, () => true)).toBe(false)
})

it.each(['result', 'begin', 'row', 'listener'] as const)('invalidates a broken snapshot at %s', async stage => {
  const f = fixture(), failure = f.client.ready.catch(error => error)
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  const result = { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' }
  f.frame('questions_observe_result', result)
  if (stage === 'result') f.frame('questions_observe_result', result)
  else {
    if (stage === 'listener') f.listener.begin.mockImplementationOnce(() => { throw new Error('listener details') })
    f.frame('questions_begin', { generation: 'g' })
    if (stage === 'begin') f.frame('questions_begin', { generation: 'g' })
    if (stage === 'row') f.frame('questions_row', { generation: 'g', question: [] })
  }
  expect((await failure).code).toBe(stage === 'listener' ? 'QUESTION_OBSERVATION_UNAVAILABLE' : 'QUESTION_OBSERVATION_PROTOCOL')
})

it.each([null, 'invalid'])('refuses a malformed question row (%j)', async question => {
  const f = fixture(), failure = f.client.ready.catch(error => error)
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' }); f.frame('questions_row', { generation: 'g', question })
  expect((await failure).code).toBe('QUESTION_OBSERVATION_PROTOCOL')
})

it('ignores binary and out-of-order state and delivers later question closes on the negotiated generation', async () => {
  const f = fixture()
  await Promise.resolve(); f.socket.emit('open')
  f.socket.emit('message', { toString: () => { throw new Error('binary must not be decoded') } }, true)
  f.frame('connected', { questionProtocol: 1 })
  f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: 'unrelated', ok: true, generation: 'wrong' })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' })
  f.frame('questions_row', { generation: 'g', question: {} })
  f.frame('questions_end', { generation: 'g' })
  expect(f.listener.question).not.toHaveBeenCalled(); expect(f.listener.end).not.toHaveBeenCalled()
  f.frame('questions_begin', { generation: 'g' }); f.frame('questions_end', { generation: 'g' })
  await f.client.ready
  f.frame('questions_end', { generation: 'g' })
  f.frame('questions_close', { generation: 'g', question: { type: 'commander_question_close', payload: { requestId: 'q' } } })
  expect(f.listener.end).toHaveBeenCalledOnce()
  expect(f.listener.question).toHaveBeenCalledExactlyOnceWith('g', { type: 'commander_question_close', payload: { requestId: 'q' } })
  expect(f.sent).toHaveLength(2)
  f.client.close()
})

it.each(['json', 'error', 'backpressure', 'close', 'select', 'large'] as const)('fails pending observation for %s without exposing transport details', async kind => {
  const f = fixture(), failure = f.client.ready.catch(error => error)
  await Promise.resolve()
  if (kind === 'json') f.socket.emit('message', { toString: () => '{' }, false)
  else if (kind === 'error') f.socket.emit('error', new Error('private content'))
  else if (kind === 'backpressure' || kind === 'close') f.socket.emit('close', kind === 'backpressure' ? 1013 : 1006)
  else f.frame(kind === 'select' ? 'machine_select_error' : 'frame_too_large', {})
  expect((await failure).code).toBe(kind === 'json' ? 'QUESTION_OBSERVATION_PROTOCOL' : kind === 'backpressure' ? 'QUESTION_OBSERVATION_BACKPRESSURE' : 'QUESTION_OBSERVATION_UNAVAILABLE')
})

it('handles a refused connection and the real connector failing on a missing private socket', async () => {
  const listener = { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }
  const refused = observeQuestions({ port: 1, dataDir: '/fixture', machineId: 'machine' }, listener,
    async () => { throw new Error('private transport details') })
  await expect(refused.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_UNAVAILABLE' })
  const dataDir = mkdtempSync(join(tmpdir(), 'question-missing-'))
  try {
    const absent = observeQuestions({ port: 1, dataDir, machineId: 'machine' }, listener)
    await expect(absent.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_UNAVAILABLE' })
  } finally { rmSync(dataDir, { recursive: true, force: true }) }
})

it('selects a real tool, ignores legacy unsolicited replay and is ready only after its complete generation', async () => {
  const f = fixture()
  await Promise.resolve()
  f.socket.emit('open')
  expect(f.sent[0]).toMatchObject({ type: 'machine_select', payload: { tool: true, machineId: 'machine' } })
  f.frame('connected', { questionProtocol: 1 })
  f.frame('commander_question', { requestId: 'old' })
  const requestId = f.sent[1].payload.requestId
  expect(f.sent[1]).toMatchObject({ type: 'questions_observe', payload: { scope: 'all' } })
  f.frame('questions_observe_result', { requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' })
  const question = { type: 'commander_question', agentId: 'a', payload: { requestId: 'q' } }
  f.frame('questions_row', { generation: 'other', question })
  f.frame('questions_row', { generation: 'g', question })
  expect(f.listener.begin).toHaveBeenCalledExactlyOnceWith('g')
  expect(f.listener.question).toHaveBeenCalledExactlyOnceWith('g', question)
  const ready = vi.fn(); void f.client.ready.then(ready)
  await Promise.resolve(); expect(ready).not.toHaveBeenCalled()
  f.frame('questions_end', { generation: 'g' })
  await f.client.ready
  expect(f.listener.end).toHaveBeenCalledExactlyOnceWith('g')
  f.client.close()
})

it('fails an incomplete snapshot visibly and does not let late frames reconcile it', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const failure = expect(f.client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_TIMEOUT' })
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', { questionProtocol: 1 })
  f.frame('questions_observe_result', { requestId: f.sent[1].payload.requestId, ok: true, generation: 'g' })
  f.frame('questions_begin', { generation: 'g' })
  await vi.advanceTimersByTimeAsync(20_000)
  await failure
  f.frame('questions_end', { generation: 'g' })
  expect(f.listener.end).not.toHaveBeenCalled()
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_TIMEOUT')
  expect(f.socket.close).toHaveBeenCalledOnce()
})

it('closes a connection that completes dialing after cancellation', async () => {
  let connected!: (socket: ClientSocket) => void
  const pending = new Promise<ClientSocket>(resolve => { connected = resolve })
  const client = observeQuestions({ port: 1, dataDir: '/fixture', machineId: 'machine' },
    { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }, () => pending)
  const failure = expect(client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_CLOSED' })
  client.close()
  const close = vi.fn()
  connected({ close } as unknown as ClientSocket)
  await failure; await Promise.resolve()
  expect(close).toHaveBeenCalledOnce()
})

it('refuses an old daemon before pretending it negotiated bounded question replay', async () => {
  const f = fixture()
  const failed = expect(f.client.ready).rejects.toMatchObject({ code: 'QUESTION_OBSERVATION_UNSUPPORTED' })
  await Promise.resolve(); f.socket.emit('open'); f.frame('connected', {})
  await failed
  expect(f.sent).toHaveLength(1)
  expect(f.listener.begin).not.toHaveBeenCalled()
})

it.each([null, [], 1, { type: 'connected', payload: null }, { type: 'connected', payload: [] },
  { type: 'connected', payload: 1 }, { type: 'connected', payload: 'text' }, { payload: {} }].map(frame => [frame]))('fails malformed JSON shape once without throwing (%j)', async frame => {
  const f = fixture()
  const failed = f.client.ready.catch(error => error)
  await Promise.resolve()
  let thrown: unknown
  try { f.socket.emit('message', { toString: () => JSON.stringify(frame) }, false) } catch (error) { thrown = error }
  if (!f.listener.unavailable.mock.calls.length) f.client.close()
  const error = await failed
  expect(thrown).toBeUndefined()
  expect(error).toMatchObject({ code: 'QUESTION_OBSERVATION_PROTOCOL' })
  expect(f.listener.unavailable).toHaveBeenCalledExactlyOnceWith('QUESTION_OBSERVATION_PROTOCOL')
  f.socket.emit('message', { toString: () => 'null' }, false)
  expect(f.listener.unavailable).toHaveBeenCalledOnce()
})
