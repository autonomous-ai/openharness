/**
 * The owning machine's half of every write (pair/owner.ts), against a scripted sensor: each refusal a
 * write can meet before anything is keyed or typed (pairing off, watch, gone, untouchable, a stale or
 * non-permission question, a prompt too long), what is journaled when it does act, and the sealed
 * `pair_*` requests another machine may — and may not — make.
 */
import { describe, expect, it, vi } from 'vitest'
import { PairOwner, PROMPT_MAX, REMOTE_ANSWER_LIMITS, type OwnerDeps, type OwnerSubject } from './owner.js'
import type { Autonomy } from './floor.js'
import type { PairHarness, PairQuestion } from './protocol.js'

const SUBJECTS: Record<string, OwnerSubject> = {
  api: { agentId: 'api', name: 'api', engine: 'claude', status: 'live', untouchable: null, cwd: '/w/api' },
  web: { agentId: 'web', name: 'web', engine: 'codex', status: 'live', untouchable: null },
  sh: { agentId: 'sh', name: 'shell', engine: 'terminal', status: 'live', untouchable: 'terminal' },
  pair: { agentId: 'pair', name: 'tim', engine: 'claude', status: 'live', untouchable: 'pair' },
  old: { agentId: 'old', name: 'old', engine: 'codex', status: 'stopped', untouchable: null },
  oldsh: { agentId: 'oldsh', name: 'oldsh', engine: 'terminal', status: 'stopped', untouchable: 'terminal' },
}

const question = (over: Partial<PairQuestion> = {}): PairQuestion => ({
  requestId: 'q1', text: 'Bash command: npm test', options: ['1. Yes', '2. No'], multi: false,
  deny: false, allow: true, permission: true, since: 0, ...over,
})
const harness = (agentId: string, over: Partial<PairHarness> = {}): PairHarness => ({
  agentId, name: agentId, engine: 'claude', working: false, question: null, failing: null, lastDoneAt: null, recap: null, ...over,
})

function world(opts: { autonomy?: Autonomy; enabled?: boolean; harnesses?: Record<string, PairHarness>; recent?: OwnerDeps['recent'] | null; now?: () => number } = {}) {
  const state = { autonomy: opts.autonomy ?? 'suggest' as Autonomy, enabled: opts.enabled ?? true, harnesses: opts.harnesses ?? {} }
  const acted = vi.fn()
  const sensor = { enabled: () => state.enabled, harness: (id: string) => state.harnesses[id] ?? null, acted }
  const calls = {
    message: vi.fn(), cancel: vi.fn(),
    create: vi.fn<OwnerDeps['create']>(async () => ({ ok: true, agentId: 'new-1' })),
    stop: vi.fn<OwnerDeps['stop']>(async () => {}),
    resume: vi.fn<OwnerDeps['resume']>(async () => ({ ok: true })),
    keyAnswer: vi.fn<OwnerDeps['keyAnswer']>(async () => ({ ok: true })),
  }
  const owner = new PairOwner({
    sensor: sensor as unknown as OwnerDeps['sensor'],
    autonomy: () => state.autonomy,
    subject: (id) => SUBJECTS[id] ?? null,
    subjects: () => Object.values(SUBJECTS),
    ...(opts.recent === null ? {} : { recent: opts.recent ?? (() => ({ recaps: ['r'.repeat(700)], asks: ['a\nb'] })) }),
    ...calls,
    newId: () => 'delivery-1',
    ...(opts.now ? { now: opts.now } : {}),
  })
  return { owner, state, acted, calls }
}

describe('reads', () => {
  it('lists every harness with the status the sensor sees: waiting, working, failed, idle or stopped', () => {
    const { owner } = world({ harnesses: {
      api: harness('api', { question: question(), working: true, recap: 'did x' }),
      web: harness('web', { working: true, failing: 'boom' }),
      sh: harness('sh', { failing: 'exit 1' }),
      pair: harness('pair'),
      old: harness('old', { question: question() }),
    } })
    const rows = Object.fromEntries(owner.list().map((r) => [r.agentId, r]))
    expect(rows.api).toEqual({ agentId: 'api', name: 'api', engine: 'claude', status: 'waiting', question: question(), recap: 'did x', cwd: '/w/api' })
    expect(rows.web).toMatchObject({ status: 'working', failing: 'boom' })
    expect(rows.sh).toEqual({ agentId: 'sh', name: 'shell', engine: 'terminal', status: 'failed', failing: 'exit 1', untouchable: 'terminal' })
    expect(rows.pair).toMatchObject({ status: 'idle', untouchable: 'pair' })
    expect(rows.old!.status).toBe('stopped')          // a stopped harness is stopped, whatever the sensor last saw
    expect(rows.oldsh).toEqual({ agentId: 'oldsh', name: 'oldsh', engine: 'terminal', status: 'stopped', untouchable: 'terminal' })
  })

  it('reads one harness with its recaps and asks cut to size — never a terminal\'s, and none without a mirror', () => {
    const { owner } = world({ harnesses: { api: harness('api') } })
    const api = owner.read('api') as Record<string, unknown>
    expect(api).toMatchObject({ ok: true, harness: harness('api'), row: { status: 'idle' }, asks: ['a b'] })
    expect((api.recaps as string[])[0]).toHaveLength(600)
    expect((api.recaps as string[])[0]!.endsWith('...')).toBe(true)
    expect(owner.read('sh')).toEqual({ ok: true, harness: null, row: expect.objectContaining({ agentId: 'sh' }) })
    expect(owner.read('')).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(owner.read('nope')).toEqual({ ok: false, error: 'NOT_FOUND' })
    const bare = world({ recent: null }).owner.read('api')
    expect(bare).not.toHaveProperty('recaps')
  })
})

describe('writes refuse before anything is typed', () => {
  it('pairing off, watch, gone, stopped or untouchable: every drivable write says why', async () => {
    const off = world({ enabled: false })
    for (const result of [off.owner.send({ agentId: 'api', text: 'hi' }, 'key'), off.owner.stop({ agentId: 'api' }, 'key'),
      await off.owner.pause({ agentId: 'api' }, 'key'), await off.owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'key')]) {
      expect(result).toEqual({ ok: false, error: 'PAIR_OFF' })
    }
    const w = world({ autonomy: 'watch' })
    expect(w.owner.stop({ agentId: 'api' }, 'key')).toMatchObject({ ok: false, error: 'AUTONOMY_WATCH' })
    const { owner, calls, acted } = world()
    expect(owner.stop({ agentId: '' }, 'key')).toMatchObject({ error: 'GONE' })
    expect(owner.stop({ agentId: 'old' }, 'key')).toMatchObject({ error: 'GONE' })
    expect(owner.stop({ agentId: 'sh' }, 'key')).toMatchObject({ error: 'UNTOUCHABLE', detail: expect.stringContaining('shell') })
    expect(owner.stop({ agentId: 'pair' }, 'key')).toMatchObject({ error: 'UNTOUCHABLE', detail: expect.stringContaining('own harness') })
    expect(await owner.pause({ agentId: 'pair' }, 'pair')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
    expect(acted).not.toHaveBeenCalled()
  })

  it('send: nothing empty, nothing too long, nothing into an open dialog', () => {
    const { owner, calls, acted, state } = world()
    expect(owner.send({ agentId: 'api', text: '  \n ' }, 'key')).toEqual({ ok: false, error: 'EMPTY' })
    expect(owner.send({ agentId: 'api', text: 'x'.repeat(PROMPT_MAX + 1) }, 'key')).toMatchObject({ ok: false, error: 'TOO_LONG' })
    expect(owner.send({ agentId: 'api', text: ` ${'x'.repeat(PROMPT_MAX)} ` }, 'key')).toEqual({ ok: true, deliveryId: 'delivery-1' })
    state.harnesses.api = harness('api', { question: question() })
    expect(owner.send({ agentId: 'api', text: 'y' }, 'key')).toMatchObject({ ok: false, error: 'QUESTION_OPEN' })
    expect(calls.message).toHaveBeenCalledTimes(1)
    expect(calls.message).toHaveBeenCalledWith('api', 'x'.repeat(PROMPT_MAX), 'delivery-1')
    expect(acted).toHaveBeenCalledTimes(1)
    expect(acted.mock.calls[0]![1]).toMatchObject({ by: 'key', action: 'send' })
    expect(acted.mock.calls[0]![1].text.length).toBeLessThan(140)
  })

  it('stop: cancels the turn and journals it', () => {
    const { owner, calls, acted } = world()
    expect(owner.stop({ agentId: 'api' }, 'pair')).toEqual({ ok: true })
    expect(calls.cancel).toHaveBeenCalledWith('api')
    expect(acted).toHaveBeenCalledWith(SUBJECTS.api, { by: 'pair', action: 'stop', text: 'stopped the turn' })
  })
})

describe('answers', () => {
  it('only to the question on screen now: no id, another id, or no question at all is stale', async () => {
    const { owner, state, calls } = world()
    expect(await owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'key')).toMatchObject({ error: 'STALE_QUESTION' })
    state.harnesses.api = harness('api', { question: question() })
    expect(await owner.answer({ agentId: 'api', requestId: '', choice: 'Yes' }, 'key')).toMatchObject({ error: 'STALE_QUESTION' })
    expect(await owner.answer({ agentId: 'api', requestId: 'q0', choice: 'Yes' }, 'key')).toMatchObject({ error: 'STALE_QUESTION' })
    expect(calls.keyAnswer).not.toHaveBeenCalled()
  })

  it('a remote answer only to an allow-class permission prompt', async () => {
    const { owner, state, calls } = world()
    state.harnesses.api = harness('api', { question: question({ allow: false }) })
    expect(await owner.answer({ agentId: 'api', requestId: 'q1', choice: 'No' }, 'remote')).toMatchObject({ error: 'REMOTE_ANSWERS_ONLY' })
    state.harnesses.api = harness('api', { question: question({ permission: false }) })
    expect(await owner.answer({ agentId: 'api', requestId: 'q1', choice: 'No' }, 'remote')).toMatchObject({ error: 'REMOTE_ANSWERS_ONLY' })
    expect(calls.keyAnswer).not.toHaveBeenCalled()
  })

  it('passes on what the dialog said when keying failed, and journals nothing', async () => {
    const { owner, state, calls, acted } = world()
    state.harnesses.api = harness('api', { question: question() })
    calls.keyAnswer.mockResolvedValueOnce({ ok: false, error: 'STALE_QUESTION', detail: 'changed' })
    expect(await owner.answer({ agentId: 'api', requestId: 'q1', choice: 'Yes' }, 'key')).toEqual({ ok: false, error: 'STALE_QUESTION', detail: 'changed' })
    expect(acted).not.toHaveBeenCalled()
  })

  it('journals the option, the question, the rule that decided it and where it came from', async () => {
    const { owner, state, calls, acted } = world()
    state.harnesses.api = harness('api', { question: question() })
    expect(await owner.answer({ agentId: 'api', requestId: 'q1', choice: 'yes' }, 'rule', 'rule "tests"', 'laptop (abc)')).toEqual({ ok: true, option: '1. Yes' })
    expect(calls.keyAnswer).toHaveBeenCalledWith({ agentId: 'api', requestId: 'q1', question: 'Bash command: npm test', option: '1. Yes' })
    expect(acted).toHaveBeenCalledWith(SUBJECTS.api, {
      by: 'rule', action: 'answer', requestId: 'q1', origin: 'laptop (abc)',
      text: 'answered "1. Yes" to "Bash command: npm test" (rule "tests") (from laptop (abc))',
    })
  })
})

describe('start, pause and resume', () => {
  it('starts only an agent, in an absolute folder, with a bounded prompt and name', async () => {
    const { owner, calls, acted, state } = world()
    const start = (input: Parameters<PairOwner['start']>[0]) => owner.start(input, 'pair')
    expect(await start({ engine: '', cwd: '/w' })).toMatchObject({ error: 'INVALID_ENGINE' })
    expect(await start({ engine: 'terminal', cwd: '/w' })).toMatchObject({ error: 'INVALID_ENGINE' })
    expect(await start({ engine: 'claude', cwd: '' })).toMatchObject({ error: 'INVALID_CWD' })
    expect(await start({ engine: 'claude', cwd: 'w/api' })).toMatchObject({ error: 'INVALID_CWD' })
    expect(await start({ engine: 'claude', cwd: '/w', prompt: 'x'.repeat(PROMPT_MAX + 1) })).toEqual({ ok: false, error: 'TOO_LONG' })
    expect(calls.create).not.toHaveBeenCalled()

    expect(await start({ engine: 'claude', cwd: '/w', prompt: '   ', name: '​​' })).toEqual({ ok: true, agentId: 'new-1' })
    expect(calls.create).toHaveBeenLastCalledWith({ engine: 'claude', cwd: '/w', prompt: null, name: null })
    expect(acted).toHaveBeenLastCalledWith({ agentId: 'new-1', name: 'claude', engine: 'claude' }, { by: 'pair', action: 'start', text: 'started claude in /w (mode ask)' })
    await start({ engine: 'codex', cwd: '/w', prompt: ' fix it ', name: `a${'b'.repeat(80)}` })
    expect(calls.create.mock.calls.at(-1)![0]).toMatchObject({ prompt: 'fix it', name: expect.stringMatching(/^ab+\.\.\.$/) })
    expect(calls.create.mock.calls.at(-1)![0].name).toHaveLength(40)

    calls.create.mockResolvedValueOnce({ ok: false, error: 'NO_ENGINE', detail: 'not installed' })
    acted.mockClear()
    expect(await start({ engine: 'codex', cwd: '/w' })).toEqual({ ok: false, error: 'NO_ENGINE', detail: 'not installed' })
    expect(acted).not.toHaveBeenCalled()

    state.autonomy = 'watch'
    expect(await start({ engine: 'codex', cwd: '/w' })).toMatchObject({ error: 'AUTONOMY_WATCH' })
    state.enabled = false
    expect(await start({ engine: 'codex', cwd: '/w' })).toEqual({ ok: false, error: 'PAIR_OFF' })
  })

  it('a pause that fails says why, with the stop service\'s own code when it has one', async () => {
    const { owner, calls, acted } = world()
    calls.stop.mockRejectedValueOnce(Object.assign(new Error(`busy ${'x'.repeat(300)}`), { code: 'STOP_BUSY' }))
    const busy = await owner.pause({ agentId: 'api' }, 'key')
    expect(busy).toMatchObject({ ok: false, error: 'STOP_BUSY' })
    expect((busy as { detail: string }).detail).toHaveLength(200)
    calls.stop.mockRejectedValueOnce({ code: 42 })
    expect(await owner.pause({ agentId: 'api' }, 'key')).toEqual({ ok: false, error: 'PAUSE_FAILED', detail: undefined })
    calls.stop.mockRejectedValueOnce(null)
    expect(await owner.pause({ agentId: 'api' }, 'key')).toEqual({ ok: false, error: 'PAUSE_FAILED', detail: undefined })
    expect(acted).not.toHaveBeenCalled()
    expect(await owner.pause({ agentId: 'api' }, 'key')).toEqual({ ok: true })
    expect(acted).toHaveBeenCalledWith(SUBJECTS.api, { by: 'key', action: 'pause', text: 'paused (conversation kept)' })
  })

  it('resumes only a stopped harness it may drive; a live one already is', async () => {
    const { owner, calls, acted, state } = world()
    expect(await owner.resume({ agentId: '' }, 'key')).toMatchObject({ error: 'GONE' })
    expect(await owner.resume({ agentId: 'nope' }, 'key')).toMatchObject({ error: 'GONE' })
    expect(await owner.resume({ agentId: 'oldsh' }, 'key')).toMatchObject({ error: 'UNTOUCHABLE' })
    expect(await owner.resume({ agentId: 'api' }, 'key')).toEqual({ ok: true, already: true })
    calls.resume.mockResolvedValueOnce({ ok: false, error: 'NO_SESSION' })
    expect(await owner.resume({ agentId: 'old' }, 'key')).toEqual({ ok: false, error: 'NO_SESSION' })
    expect(acted).not.toHaveBeenCalled()
    expect(await owner.resume({ agentId: 'old' }, 'key')).toEqual({ ok: true })
    expect(acted).toHaveBeenCalledWith(SUBJECTS.old, { by: 'key', action: 'resume', text: 'resumed' })
    state.autonomy = 'watch'
    expect(await owner.resume({ agentId: 'old' }, 'key')).toMatchObject({ error: 'AUTONOMY_WATCH' })
    state.enabled = false
    expect(await owner.resume({ agentId: 'old' }, 'key')).toEqual({ ok: false, error: 'PAIR_OFF' })
    expect(calls.resume).toHaveBeenCalledTimes(2)
  })
})

describe('sealed pair_* requests from another machine', () => {
  it('reads a list and a harness, and nothing while pairing is off', async () => {
    const { owner, state } = world({ harnesses: { api: harness('api') } })
    expect(await owner.handle('pair_list', {})).toEqual({ harnesses: owner.list() })
    expect(await owner.handle('pair_read', { agentId: 'api' })).toMatchObject({ ok: true, row: { agentId: 'api' } })
    expect(await owner.handle('pair_read', { agentId: 'nope' })).toEqual({ error: 'NOT_FOUND' })
    expect(await owner.handle('pair_read', { agentId: 7 })).toEqual({ error: 'NOT_FOUND' })
    state.enabled = false
    expect(await owner.handle('pair_list', {})).toEqual({ error: 'PAIR_OFF' })
    expect(await owner.handle('pair_answer', { agentId: 'api' })).toEqual({ error: 'PAIR_OFF' })
  })

  it('never sends, stops, starts, pauses or resumes for another machine, whatever `by` the payload claims', async () => {
    const { owner, calls } = world()
    for (const type of ['pair_send', 'pair_stop', 'pair_start', 'pair_pause', 'pair_resume']) {
      expect(await owner.handle(type, { agentId: 'api', text: 'x', by: 'key', engine: 'claude', cwd: '/w' })).toMatchObject({ error: 'REMOTE_ANSWERS_ONLY' })
    }
    expect(await owner.handle('agent_delete', { agentId: 'api' })).toEqual({ error: 'UNSUPPORTED' })
    expect(calls.message).not.toHaveBeenCalled()
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.resume).not.toHaveBeenCalled()
  })

  it('answers as `remote`, journals the paired label (or the connection) and rate-limits each connection', async () => {
    let now = 0
    const { owner, state, acted } = world({ now: () => now })
    state.harnesses.api = harness('api', { question: question() })
    const payload = { agentId: 'api', expectRequestId: 'q1', choice: 'Yes', by: 'key' }
    expect(await owner.handle('pair_answer', payload, { connId: 'conn-0123456789abcdef', label: 'laptop' })).toEqual({ ok: true, option: '1. Yes' })
    expect(acted.mock.calls[0]![1]).toMatchObject({ by: 'remote', origin: 'laptop (conn-0123456)' })
    await owner.handle('pair_answer', payload)
    expect(acted.mock.calls[1]![1]).toMatchObject({ by: 'remote', origin: 'unknown' })
    // Refusals from the floor come back without an ok.
    expect(await owner.handle('pair_answer', { ...payload, choice: 'Maybe' }, { connId: 'c2' })).toMatchObject({ error: 'NOT_OFFERED', detail: expect.any(String) })

    const [perMinute] = REMOTE_ANSWER_LIMITS
    const results = []
    for (let i = 0; i < perMinute!.max + 2; i++) results.push(await owner.handle('pair_answer', payload, { connId: 'c3' }))
    expect(results.filter((r) => r.ok === true)).toHaveLength(perMinute!.max)
    expect(results.at(-1)).toMatchObject({ error: 'RATE_LIMITED' })
    // Another connection has its own allowance; the first gets more after the minute.
    expect(await owner.handle('pair_answer', payload, { connId: 'c4' })).toMatchObject({ ok: true })
    now += perMinute!.windowMs
    expect(await owner.handle('pair_answer', payload, { connId: 'c3' })).toMatchObject({ ok: true })
  })
})
