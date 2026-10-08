import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LiveFrame } from '../../engines/worker/liveProtocol.js'
import { LIVE_PREPARE, LIVE_READ } from '../../engines/worker/liveProtocol.js'
import { engineLiveRequests } from '../../engines/worker/liveRequests.js'
import { createLiveTransport } from './liveTransport.js'
import { createLiveSessions, type LiveSessionDeps, type LiveSessions } from './liveSessions.js'

const dirs: string[] = [], sessions: LiveSessions[] = []
const prompt = (message: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n'
const done = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }], stop_reason: 'end_turn' } }) + '\n'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

async function setup(content = '', prepareFrames?: LiveSessionDeps['prepareFrames']) {
  const dir = await mkdtemp(join(tmpdir(), 'core-engine-stream-')); dirs.push(dir)
  const file = join(dir, 'transcript.jsonl'); await writeFile(file, content)
  const session = { agentId: 'agent', sessionId: 'session', engine: 'claude', transcriptPath: file,
    cwd: dir, model: null, cliVersion: null, boundAt: 1 } as RegisteredSession
  let bound: RegisteredSession | undefined = session
  let worker = engineLiveRequests('claude', { fields: () => [] })
  let connected = false
  let intercept: ((method: string, reply: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null
  const transport = createLiveTransport({ call: async (service, method, payload) => {
    if (!connected) { connected = true; transport.connected(service) }
    const reply = await worker[method](payload, { local: true, owner: true }) as Record<string, unknown>
    return intercept ? intercept(method, reply) : reply
  } })
  const frames: LiveFrame[] = []
  const reattach = vi.fn(async () => {})
  const watch = vi.fn(), unwatch = vi.fn(), log = vi.fn()
  const live = createLiveSessions({ handles: engine => engine === 'claude', transport, bySession: () => bound,
    frame: (_session, frame) => { frames.push(frame) }, prepareFrames, reattach, watch, unwatch, log })
  sessions.push(live)
  const prepare = (first = false) => live.prepare(session, { live: first }, () => {})
  const attach = async (first = false) => {
    const prepared = await prepare(first)
    expect(live.install(prepared)).toBe(true)
    await live.follow(session)
    return prepared
  }
  return { file, session, frames, live, prepare, attach, reattach, watch, unwatch, log,
    events: () => frames.flatMap(frame => frame.events),
    unbind: () => { bound = undefined },
    intercept: (fn: typeof intercept) => { intercept = fn },
    restart: () => { transport.disconnected('engine-claude'); worker = engineLiveRequests('claude', { fields: () => [] }); connected = false },
  }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(live => live.stop()))
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('core engine stream authority', () => {
  it('keeps a failed profile page unacknowledged and retries it exactly once without another file event', async () => {
    const prepareFrames = vi.fn(async (): Promise<() => boolean> => () => true)
    const t = await setup('', prepareFrames), prepared = await t.attach()
    const initial = prepared.state.ask.cursor
    await appendFile(t.file, prompt('profile first') + done)
    prepareFrames.mockRejectedValueOnce(new Error('ENGINE_UNAVAILABLE'))
    await expect(t.live.pollSession(t.session.sessionId)).rejects.toThrow('ENGINE_UNAVAILABLE')
    expect(prepared.state.ask.cursor).toBe(initial)
    expect(t.frames).toEqual([])
    await vi.waitFor(() => expect(t.events().filter(e => e.type === 'turn_ended')).toHaveLength(1), { timeout: 2500 })
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().filter(e => e.type === 'turn_started')).toHaveLength(1)
    expect(t.events().filter(e => e.type === 'turn_ended')).toHaveLength(1)
  })

  it('does not accept a profile or cursor if a turn closes while profile interpretation is in flight', async () => {
    const prepareFrames = vi.fn(async (): Promise<() => boolean> => () => true)
    const t = await setup(prompt('old'), prepareFrames), prepared = await t.attach()
    const entered = deferred<void>(), resume = deferred<void>(), commit = vi.fn(() => true)
    prepareFrames.mockImplementationOnce(async () => { entered.resolve(); await resume.promise; return commit })
    await appendFile(t.file, prompt('new'))
    const pending = t.live.pollSession(t.session.sessionId)
    await entered.promise; prepared.state.handle.closeTurn('cancel'); resume.resolve(); await pending
    expect(commit).not.toHaveBeenCalled()
    expect(t.frames).toEqual([])
    prepareFrames.mockResolvedValueOnce(() => false)
    await expect(t.live.pollSession(t.session.sessionId)).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(t.frames).toEqual([])
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().filter(e => e.type === 'turn_started')).toHaveLength(1)
  })

  it('awaits profile hydration per page and discards a candidate invalidated while that work runs', async () => {
    const t = await setup(prompt('history') + done)
    const observed = vi.fn(), page = vi.fn(async () => { expect(observed).not.toHaveBeenCalled(); t.unbind() })
    const hydrated = vi.fn(), hydratedPage = vi.fn(async () => { expect(hydrated).not.toHaveBeenCalled() })
    const candidate = await t.live.prepare(t.session, { live: false }, hydrated, hydratedPage)
    expect(hydratedPage).toHaveBeenCalledOnce()
    expect(hydrated).toHaveBeenCalled()
    t.live.discard(candidate)
    await expect(t.live.prepare(t.session, { live: false }, observed, page)).rejects.toThrow('ENGINE_STALE_REPLY')
    expect(page).toHaveBeenCalledOnce()
    expect(observed).not.toHaveBeenCalled()
    expect(t.frames).toEqual([])
  })

  it('remembers first-turn delivery when initial preparation fails and a normal retry follows', async () => {
    const t = await setup(prompt('born after the agent') + done)
    t.intercept(async (method, reply) => { if (method === LIVE_PREPARE) throw new Error('worker disconnected'); return reply })
    await expect(t.prepare(true)).rejects.toThrow('ENGINE_UNAVAILABLE')
    t.intercept(null)
    await t.attach()
    expect(t.events().filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(t.events().filter(event => event.type === 'turn_ended')).toHaveLength(1)
  })

  it('activates before emitting the first turn and streams it in bounded pages', async () => {
    const t = await setup(prompt('x'.repeat(700_000)) + done)
    const prepared = await t.prepare(true)
    expect(prepared.page.frames).toEqual([])
    expect(prepared.page.cursor.offset).toBe(0)
    expect(t.frames).toEqual([])
    expect(t.live.install(prepared)).toBe(true)
    await t.live.follow(t.session)
    expect(t.events().filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(t.events().filter(event => event.type === 'turn_ended')).toHaveLength(1)
    expect(prepared.state.handle.turnOpen).toBe(false)
    expect(t.live.current(t.session)).toBe(true)
    expect(t.watch).toHaveBeenCalledWith(t.file)
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().filter(event => event.type === 'turn_started')).toHaveLength(1)
  })

  it('hydrates history silently and resumes from the accepted checkpoint after worker restart', async () => {
    const t = await setup(prompt('old') + done)
    const prepared = await t.attach()
    expect(t.events()).toEqual([])
    await appendFile(t.file, prompt('new'))
    await t.live.pollSession(t.session.sessionId)
    const turn = prepared.state.handle.snapshot()
    expect(turn.turnOpen).toBe(true)
    t.restart()
    await appendFile(t.file, done)
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().map(event => event.type)).toEqual(['turn_started', 'text_delta', 'turn_ended'])
    expect(prepared.state.handle.snapshot()).toEqual({ ...turn, turnOpen: false })
  })

  it('discards a reply for a binding that changed while its worker was reading', async () => {
    const t = await setup()
    const prepared = await t.attach()
    const entered = deferred<void>(), release = deferred<void>()
    t.intercept(async (method, reply) => { if (method === LIVE_READ) { entered.resolve(); await release.promise }; return reply })
    await appendFile(t.file, prompt('late'))
    const read = t.live.pollSession(t.session.sessionId)
    await entered.promise
    t.unbind(); release.resolve(); await read
    expect(t.frames).toEqual([])
    expect(prepared.state.handle.turnOpen).toBe(false)
    expect(t.live.current({ ...t.session, boundAt: 2 })).toBe(false)
  })

  it('fences an in-flight page when cancel closes the observed turn, then accepts the newer turn', async () => {
    const t = await setup(prompt('one'))
    const prepared = await t.attach()
    const first = prepared.state.handle.snapshot()
    const entered = deferred<void>(), release = deferred<void>()
    t.intercept(async (method, reply) => { if (method === LIVE_READ) { entered.resolve(); await release.promise }; return reply })
    await appendFile(t.file, prompt('two'))
    const read = t.live.pollSession(t.session.sessionId)
    await entered.promise
    prepared.state.handle.closeTurn('cancel')
    expect(prepared.state.handle.turnOpen).toBe(false)
    release.resolve(); await read
    expect(t.frames).toEqual([])
    t.intercept(null)
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().filter(event => event.type === 'turn_ended')).toHaveLength(0)
    expect(t.events().filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(prepared.state.handle.snapshot().identity).not.toBe(first.identity)
    expect(prepared.state.handle.turnOpen).toBe(true)
  })

  it('accepts a read across a Linux clock correction but rejects a changed process start tick', async () => {
    const t = await setup()
    t.session.processIdentity = { pid: 7, executable: 'claude', startMarker: 'one', startTicks: 42 }
    const prepared = await t.attach()
    let entered = deferred<void>(), release = deferred<void>()
    t.intercept(async (method, reply) => { if (method === LIVE_READ) { entered.resolve(); await release.promise }; return reply })
    await appendFile(t.file, prompt('current'))
    const read = t.live.pollSession(t.session.sessionId)
    await entered.promise
    t.session.processIdentity.startMarker = 'two'
    release.resolve(); await read
    expect(t.events().map(event => event.type)).toEqual(['turn_started'])
    expect(prepared.state.handle.turnOpen).toBe(true)
    entered = deferred<void>(); release = deferred<void>()
    await appendFile(t.file, done)
    const stale = t.live.pollSession(t.session.sessionId)
    await entered.promise
    t.session.processIdentity.startTicks = 43
    release.resolve(); await stale
    expect(t.events().map(event => event.type)).toEqual(['turn_started'])
    expect(prepared.state.handle.turnOpen).toBe(true)
  })

  it('holds delivery while a replacement parser hydrates, and cannot install a candidate after cancellation', async () => {
    const t = await setup(prompt('one'))
    const first = await t.attach()
    const hold = await t.live.hold(t.session.sessionId, t.file)
    expect(hold?.offset).toBe(Buffer.byteLength(prompt('one')))
    const candidate = await t.prepare()
    first.state.handle.closeTurn('cancel')
    expect(t.live.install(candidate)).toBe(false)
    t.live.discard(candidate)
    await appendFile(t.file, prompt('two'))
    let finished = false
    const drain = t.live.pollSession(t.session.sessionId).then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    hold!.release(); await drain
    expect(t.events().filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(first.state.handle.turnOpen).toBe(true)
  })

  it('preserves the checkpoint on rewrite, schedules recovery, and removes all watches when detached', async () => {
    const t = await setup(prompt('before'))
    const prepared = await t.attach()
    const before = prepared.state.handle.snapshot()
    await writeFile(t.file, prompt('after!'))
    await expect(t.live.pollSession(t.session.sessionId)).rejects.toThrow('ENGINE_TRANSCRIPT_CHANGED')
    expect(prepared.state.handle.snapshot()).toEqual(before)
    expect(t.frames).toEqual([])
    await t.live.removeSession(t.session.sessionId)
    expect(t.unwatch).toHaveBeenCalledWith(t.file)
    expect(t.live.tails(t.session.sessionId, t.file)).toBe(false)
  })

  it('activates a replacement under a hold and replays its history before delivering a fresh turn', async () => {
    const t = await setup(prompt('a much longer original turn'))
    await t.attach()
    await writeFile(t.file, prompt('history') + done)
    await expect(t.live.pollSession(t.session.sessionId)).rejects.toThrow('ENGINE_TRANSCRIPT_CHANGED')
    const hold = await t.live.hold(t.session.sessionId, t.file)
    const replacement = await t.prepare()
    expect(replacement.page.frames).toEqual([])
    expect(t.live.install(replacement)).toBe(true)
    hold!.release()
    await t.live.pollSession(t.session.sessionId)
    expect(t.events().map(event => event.type)).toEqual(['turn_started', 'text_delta', 'turn_ended'])
    expect(t.frames.every(frame => frame.replay)).toBe(true)
    await appendFile(t.file, prompt('fresh'))
    await t.live.pollSession(t.session.sessionId)
    expect(t.frames.at(-1)).toMatchObject({ replay: false, events: [{ type: 'turn_started', payload: { userMessage: 'fresh' } }] })
  })
})
