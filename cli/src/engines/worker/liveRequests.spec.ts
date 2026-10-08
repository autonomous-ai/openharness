import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liveFor } from '../live.js'
import type { ServiceRequests } from '../../core/api.js'
import type { LivePage, LiveSession } from './liveProtocol.js'
import { LIVE_CAPABILITIES, LIVE_CLOSE, LIVE_FORGET, LIVE_PART, LIVE_PREPARE, LIVE_READ, LIVE_WAIT_MS } from './liveProtocol.js'
import { engineLiveRequests, type LiveRequestDeps } from './liveRequests.js'

vi.mock('../../lib/runtimeProfile.js', () => { throw new Error('Engine workers must not load the monolithic runtime profile manager') })

const dirs: string[] = []
const who = { owner: true, local: true }
const prompt = (engine: string, text: string) => JSON.stringify(engine === 'claude'
  ? { type: 'user', message: { role: 'user', content: text } }
  : { type: 'event_msg', payload: { type: 'user_message', message: text } }) + '\n'
const done = (engine: string) => JSON.stringify(engine === 'claude'
  ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
  : { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }) + '\n'
async function setup(engine: 'claude' | 'codex' = 'claude', lines = '', limits?: LiveRequestDeps['limits']) {
  const dir = await mkdtemp(join(tmpdir(), 'engine-stream-')); dirs.push(dir)
  const file = join(dir, 'transcript.jsonl'); await writeFile(file, lines)
  const session: LiveSession = { agentId: 'agent', sessionId: 'session', engine, transcriptPath: file,
    cwd: dir, model: null, cliVersion: null, codexHome: dir }
  const fresh = () => engineLiveRequests(engine, { limits })
  let worker = fresh()
  const payload = { version: 1, token: 'binding', session, cursor: null as LivePage['cursor'] | null, fromStart: false, replay: false }
  const send = (type = payload.cursor ? LIVE_READ : LIVE_PREPARE, overrides: Record<string, unknown> = {}) => worker[type]({ ...payload, ...overrides }, who) as Promise<Record<string, any>>
  const page = async (overrides: Record<string, unknown> = {}): Promise<LivePage> => {
    const reply = await send(undefined, overrides)
    expect(reply.error).toBeUndefined()
    expect(reply.answer).toBeDefined()
    payload.cursor = reply.answer.cursor
    return reply.answer
  }
  return { file, session, payload, fresh, send, page, worker: () => worker, restart: () => { worker = fresh() } }
}
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('engine live checkpoints', () => {
  it('emits compact profile evidence without loading the shared runtime manager', async () => {
    const raw = JSON.stringify({ type: 'assistant', version: '2.1.209', message: { role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'x'.repeat(2_000_000) }], stop_reason: 'end_turn' } }) + '\n'
    const t = await setup('claude', raw)
    const page = await t.page()
    const evidence = page.frames.find(frame => frame.runtime?.model === 'claude-opus-5')?.runtime
    expect(evidence).toMatchObject({ model: 'claude-opus-5', version: '2.1.209' })
    expect(JSON.stringify(evidence).length).toBeLessThan(200)
  })
  it.each(['claude', 'codex'] as const)('%s preserves thinking identities and cross-turn state across a restart', async engine => {
    const thinking = (text: string) => JSON.stringify(engine === 'claude'
      ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } }
      : { type: 'response_item', payload: { type: 'reasoning', summary: [{ text }] } }) + '\n'
    const t = await setup(engine, prompt(engine, 'old') + thinking('earlier') + done(engine))
    const continuous = t.fresh()
    const firstAsk = { ...t.payload }
    await t.page()
    await continuous[LIVE_PREPARE](firstAsk, who)
    await appendFile(t.file, prompt(engine, 'current') + thinking('before restart'))
    const secondAsk = { ...t.payload }
    await t.page()
    await continuous[LIVE_READ](secondAsk, who)
    const finalAsk = { ...t.payload }
    t.restart()
    await appendFile(t.file, thinking('after restart') + done(engine))
    const recovered = await t.page()
    const expected = await continuous[LIVE_READ](finalAsk, who) as { answer: LivePage }
    expect(recovered.frames.flatMap(frame => frame.events)).toEqual(expected.answer.frames.flatMap(frame => frame.events))
    expect(recovered.cursor.turn).toEqual(expected.answer.cursor.turn)
  })

  it('remembers a Codex goal across an ordinary turn and worker restart', async () => {
    const goal = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text',
      text: '<codex_internal_context source="goal"><objective>Finish the task</objective></codex_internal_context>' }] } }) + '\n'
    const t = await setup('codex', goal + done('codex'))
    await t.page()
    await appendFile(t.file, prompt('codex', 'ordinary') + done('codex'))
    await t.page()
    t.restart()
    await appendFile(t.file, goal)
    expect((await t.page()).frames.flatMap(frame => frame.events).find(event => event.type === 'turn_started')?.payload)
      .toEqual({ userMessage: 'Continuing goal: Finish the task' })
  })

  it.each(['claude', 'codex'] as const)('%s reconstructs after a worker restart without redelivering accepted turns', async engine => {
    const t = await setup(engine, prompt(engine, 'history') + done(engine))
    const first = await t.page()
    expect(first.prepared).toBe(true)
    expect(first.frames.flatMap(f => f.events)).toEqual([])
    expect(first.cursor.turn.turnOpen).toBe(false)
    await appendFile(t.file, prompt(engine, 'live'))
    const live = await t.page()
    expect(live.frames.flatMap(f => f.events).filter(e => e.type === 'turn_started')).toHaveLength(1)
    expect(live.cursor.turn.turnOpen).toBe(true)
    t.restart()
    const caughtUp = await t.page()
    expect(caughtUp.frames).toEqual([])
    expect(caughtUp.cursor.turn).toEqual(live.cursor.turn)
    await appendFile(t.file, done(engine))
    const end = await t.page()
    expect(end.frames.flatMap(f => f.events).filter(e => e.type === 'turn_ended')).toHaveLength(1)
    expect(end.cursor.turn.identity).toBe(live.cursor.turn.identity)
    expect(end.cursor.turn.turnOpen).toBe(false)
  })

  it('returns the exact unacknowledged page on a retry, even after new file content arrives', async () => {
    const t = await setup('claude', prompt('claude', 'first'))
    t.payload.fromStart = true; t.payload.replay = true
    const first = await t.send()
    await appendFile(t.file, done('claude'))
    expect(await t.send()).toEqual(first)
    t.payload.cursor = first.answer.cursor
    const next = await t.page()
    expect(next.frames.flatMap(f => f.events).some(e => e.type === 'turn_ended')).toBe(true)
  })

  it('keeps a frozen attach end across pages and a worker restart, then delivers subsequent appends live', async () => {
    const t = await setup('claude', prompt('claude', 'x'.repeat(700_000)) + done('claude'))
    t.payload.fromStart = true; t.payload.replay = true
    const first = await t.page()
    expect(first.prepared).toBeUndefined()
    expect(first.cursor.prepareEnd).toBe(first.end)
    const frozen = first.end
    await appendFile(t.file, prompt('claude', 'after freeze'))
    t.restart()
    const final = await t.page()
    expect(final.prepared).toBe(true)
    expect(final.end).toBe(frozen)
    expect(final.frames.flatMap(f => f.events).some(e => e.type === 'turn_started')).toBe(false)
    const next = await t.page()
    expect(next.frames.flatMap(f => f.events).find(e => e.type === 'turn_started')?.payload).toEqual({ userMessage: 'after freeze' })
  })

  it('holds partial UTF-8 records on disk until a newline completes them', async () => {
    const t = await setup()
    await t.page()
    const record = Buffer.from(prompt('claude', '😺 partial'))
    const split = record.indexOf(Buffer.from('😺')) + 2
    await appendFile(t.file, record.subarray(0, split))
    const partial = await t.page()
    expect(partial.frames).toEqual([])
    expect(partial.cursor.offset).toBe(0)
    await appendFile(t.file, record.subarray(split))
    const whole = await t.page()
    expect(whole.frames.flatMap(f => f.events).find(e => e.type === 'turn_started')?.payload).toEqual({ userMessage: '😺 partial' })
    expect(whole.cursor.offset).toBe(record.length)
  })

  it.each(['claude', 'codex'] as const)('%s replays a small rewritten file as history across pages and restart, then resumes live delivery', async engine => {
    const t = await setup(engine, prompt(engine, 'x'.repeat(700_000)) + done(engine))
    const active = await t.page({ rewritten: true, end: 1 })
    expect(active.prepared).toBe(true)
    expect(active.frames).toEqual([])
    expect(active.cursor.historyUntil).toBe(active.end)
    const first = await t.page({ rewritten: true })
    expect(first.more).toBe(true)
    expect(first.frames.every(frame => frame.replay)).toBe(true)
    t.restart()
    await appendFile(t.file, prompt(engine, 'fresh'))
    const rest = await t.page({ rewritten: true })
    expect(rest.frames.flatMap(frame => frame.events.map(event => [event.type, frame.replay])))
      .toContainEqual(['turn_ended', true])
    expect(rest.frames.flatMap(frame => frame.events.map(event => [event.type, frame.replay])))
      .toContainEqual(['turn_started', false])
    expect(rest.cursor.historyUntil).toBeUndefined()
  })

  it('accepts complete attach records without a trailing newline and finishes after trailing blank bytes', async () => {
    const t = await setup('claude', prompt('claude', 'attached').trimEnd())
    expect((await t.page()).prepared).toBe(true)
    const empty = await setup('claude', '  ')
    expect((await empty.page()).prepared).toBe(true)
  })

  it('detects replacement, truncation and a rewritten acknowledged boundary without acknowledging any new bytes', async () => {
    for (const change of ['replace', 'truncate', 'rewrite']) {
      const t = await setup('claude', prompt('claude', 'one'))
      const first = await t.page()
      if (change === 'replace') { await writeFile(t.file + '.new', await readFile(t.file)); await rename(t.file + '.new', t.file) }
      else await writeFile(t.file, change === 'truncate' ? '' : prompt('claude', 'two'))
      expect(await t.send()).toMatchObject({ error: 'ENGINE_TRANSCRIPT_CHANGED' })
      expect(t.payload.cursor).toEqual(first.cursor)
    }
  })

  it('closes only the expected turn and preserves explicit closure through restart', async () => {
    const t = await setup('claude', prompt('claude', 'one'))
    const first = await t.page()
    expect((await t.send(LIVE_CLOSE, { identity: 'stale', reason: 'hook' })).answer.closed).toBe(false)
    const close = await t.send(LIVE_CLOSE, { identity: first.cursor.turn.identity, reason: 'hook' })
    expect(close.answer.closed).toBe(true)
    expect(await t.send(LIVE_CLOSE, { identity: first.cursor.turn.identity, reason: 'hook' })).toEqual(close)
    t.payload.cursor = close.answer.cursor
    t.restart()
    expect((await t.page()).cursor.turn.turnOpen).toBe(false)
    await appendFile(t.file, prompt('claude', 'two'))
    const second = await t.page()
    expect(second.cursor.turn.identity).not.toBe(first.cursor.turn.identity)
    expect(second.cursor.closed).toBe(false)
    expect((await t.send(LIVE_CLOSE, { identity: first.cursor.turn.identity, reason: 'hook' })).answer.closed).toBe(false)
  })

  it('recovers evicted parser state from core checkpoints and forgets detached candidates', async () => {
    const t = await setup('claude', prompt('claude', 'one'), { sessions: 1 })
    const first = await t.page()
    await t.send(LIVE_PREPARE, { token: 'second', cursor: null })
    await appendFile(t.file, done('claude'))
    expect((await t.page()).frames.flatMap(f => f.events).filter(e => e.type === 'turn_ended')).toHaveLength(1)
    expect(await t.send(LIVE_FORGET)).toMatchObject({ forgotten: true })
    expect((await t.page()).cursor.turn.identity).toBe(first.cursor.turn.identity)
  })

  it('fragments large results with a stable digest and refuses expired or invalid fragments', async () => {
    const t = await setup('claude', prompt('claude', 'first'), { inline: 100, part: 123 })
    const first = await t.send()
    expect(first.part).toBeTypeOf('string')
    const chunks: Buffer[] = [Buffer.from(first.data, 'base64')]
    for (let offset = chunks[0].length; offset < first.bytes;) {
      const part = await t.send(LIVE_PART, { part: first.part, offset })
      expect(part.hash).toBe(first.hash)
      expect(part.offset).toBe(offset)
      const chunk = Buffer.from(part.data, 'base64'); chunks.push(chunk); offset += chunk.length
    }
    const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    expect(decoded.answer.prepared).toBe(true)
    expect(await t.send(LIVE_PART, { part: first.part, offset: -1 })).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    await t.send(LIVE_FORGET)
    expect(await t.send(LIVE_PART, { part: first.part, offset: 0 })).toMatchObject({ error: 'ENGINE_STALE_REPLY' })
  })

  it('rejects oversized results explicitly without advancing the caller checkpoint', async () => {
    const t = await setup('claude', prompt('claude', 'first'), { reply: 100 })
    expect(await t.send()).toMatchObject({ error: 'ENGINE_REPLY_TOO_LARGE', retryable: false })
    expect(t.payload.cursor).toBeNull()
  })

  it('limits work and recycles a hung worker, without any capability to kill core or an engine CLI', async () => {
    vi.useFakeTimers()
    let resolve!: (value: NonNullable<ReturnType<typeof liveFor>>) => void
    const adapter = new Promise<NonNullable<ReturnType<typeof liveFor>>>(r => { resolve = r })
    const recycle = vi.fn()
    const requests = engineLiveRequests('claude', { load: () => adapter, recycle })
    const payload = { version: 1, token: 'one', cursor: null, fromStart: false, replay: false,
      session: { agentId: 'agent', sessionId: 'one', engine: 'claude', transcriptPath: null, cwd: null, model: null, cliVersion: null } }
    const first = requests[LIVE_PREPARE](payload, who)
    expect(await requests[LIVE_PREPARE](payload, who)).toMatchObject({ error: 'ENGINE_BUSY' })
    await vi.advanceTimersByTimeAsync(LIVE_WAIT_MS)
    expect(await first).toMatchObject({ error: 'ENGINE_UNAVAILABLE' })
    expect(recycle).toHaveBeenCalledOnce()
    resolve(liveFor('claude')!)
  })

  it('rejects public calls, wrong versions, wrong engines and malformed cursors before loading a parser', async () => {
    const t = await setup()
    const load = vi.fn(async () => liveFor('claude')!)
    const requests: ServiceRequests = engineLiveRequests('claude', { load })
    expect(await requests[LIVE_CAPABILITIES]({ version: 1 }, who)).toEqual({ version: 1, live: 1, engine: 'claude' })
    for (const caller of [{ ...who, owner: false }, { ...who, local: false }, { ...who, connection: 'public' }]) {
      expect(await requests[LIVE_PREPARE](t.payload, caller)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
    for (const fields of [{ version: 2 }, { token: '' }, { cursor: {} }, { session: { ...t.session, engine: 'codex' } },
      { session: { ...t.session, transcriptPath: 'relative' } }, { fromStart: 'yes' }, { end: -1 }]) {
      expect(await requests[LIVE_PREPARE]({ ...t.payload, ...fields }, who)).toMatchObject({ error: 'ENGINE_INVALID_REQUEST' })
    }
    expect(load).not.toHaveBeenCalled()
  })
})
