import { describe, expect, it, vi } from 'vitest'
import type { ObservedHookEvent } from '../../core/observedHook.js'
import { observedAgentId, ObservedSource, type ObservedDeps } from './observed.js'

function setup(over: Partial<ObservedDeps> = {}) {
  const clock = { t: 1_000_000 }
  const gens = new Map<number, string | null>()
  const open = new Map<string, 'terminal' | 'app' | 'harness' | 'maybe'>()
  const owners = new Map<string, { pid: number; engine: string }>()
  const working = new Map<string, boolean | null>()
  const externals = new Map<string, { cwd?: string; transcriptPath?: string | null }>()
  const answers = new Map<string, string>()
  const deps: ObservedDeps = {
    now: () => clock.t,
    pidGeneration: (pid) => (gens.has(pid) ? gens.get(pid)! : `g${pid}`),
    openSessions: {
      // The cached answer is empty before the first look, as it is when a dial attaches; only a fresh look sees.
      known: () => new Map(),
      fresh: async () => open,
      working: async (id: string) => (working.has(id) ? working.get(id)! : false),
      owner: async (id: string) => (owners.get(id) as never) ?? null,
    } as ObservedDeps['openSessions'],
    externalSessions: { scan: async () => [], get: (id) => externals.get(id) },
    lastAnswer: async (_engine, path) => answers.get(path),
    excluded: ['/data/harness'],
    log: () => {},
    ...over,
  }
  const src = new ObservedSource(deps)
  const changes = vi.fn()
  src.onChange(changes)
  const ev = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 's1', event, cwd: '/work/proj', callerPid: 100, hostHints: {}, at: clock.t, ...over,
  })
  return { src, clock, gens, open, owners, working, externals, answers, changes, ev }
}

describe('ObservedSource states', () => {
  it('drives each event to the spec table and resets since on turn-start', () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-start'))
    expect(src.list()[0]).toMatchObject({ state: 'idle', name: 'proj', engine: 'claude', host: 'terminal' })
    clock.t += 1000
    src.ingest(ev('turn-start'))
    expect(src.list()[0]).toMatchObject({ state: 'working', since: clock.t })
    const first = clock.t
    clock.t += 1000
    src.ingest(ev('needs-input'))
    expect(src.list()[0]).toMatchObject({ state: 'needs-you', since: clock.t })
    clock.t += 1000
    src.ingest(ev('turn-start'))
    expect(src.list()[0].since).toBe(clock.t)
    expect(clock.t).toBeGreaterThan(first)
    src.ingest(ev('turn-error'))
    expect(src.list()[0].state).toBe('error')
    src.ingest(ev('turn-stop'))
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
  })

  it('a turn-start without a session-start still creates the session', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    expect(src.list()).toHaveLength(1)
  })

  it('takes the host from the hints', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { hostHints: { ORCA_AGENT_SESSION_ID: 'x' } }))
    expect(src.list()[0].host).toBe('orca')
  })

  it('fires onChange on every visible change', () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('turn-start'))
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('markSeen clears unseenDone and tells listeners once', () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('turn-stop'))
    const id = src.list()[0].id
    changes.mockClear()
    src.markSeen(id)
    src.markSeen(id)
    expect(src.list()[0].unseenDone).toBe(false)
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('capabilities are status only', () => {
    const { src } = setup()
    expect(src.capabilities()).toEqual({ status: true, voice: false, focus: false, answer: false })
  })

  it('turn-stop for claude sets lastAnswer and unseenDone', async () => {
    const { src, answers, ev } = setup()
    answers.set('/t/s.jsonl', 'Fixed the bug.')
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
    await vi.waitFor(() => expect(src.list()[0].lastAnswer).toBe('Fixed the bug.'))
  })

  it('does not read a transcript for other engines', () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-stop', { engine: 'cursor', transcriptPath: '/t/s.jsonl' }))
    expect(lastAnswer).not.toHaveBeenCalled()
    expect(src.list()[0].state).toBe('done')
  })

  it('a new turn clears the last answer, so the same answer twice is told twice', async () => {
    const { src, answers, ev } = setup()
    // Each answer the listeners see, as a change from the one before.
    const told: (string | undefined)[] = []
    src.onChange(() => { const a = src.list()[0].lastAnswer; if (a !== told.at(-1)) told.push(a) })
    answers.set('/t/s.jsonl', 'Done.')
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    await vi.waitFor(() => expect(src.list()[0].lastAnswer).toBe('Done.'))
    src.ingest(ev('turn-start'))
    expect(src.list()[0].lastAnswer).toBeUndefined()
    src.ingest(ev('turn-stop'))
    await vi.waitFor(() => expect(told).toEqual(['Done.', undefined, 'Done.']))
  })

  it('a late answer does not land on a newer turn', async () => {
    let release: (v: string) => void = () => {}
    const { src, ev } = setup({ lastAnswer: () => new Promise((r) => { release = r }) })
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    src.ingest(ev('turn-start'))
    release('old')
    await new Promise((r) => setTimeout(r, 0))
    expect(src.list()[0].lastAnswer).toBeUndefined()
  })
})

describe('ObservedSource removal', () => {
  it('session-end removes after 10 s', () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('session-end'))
    clock.t += 9_000
    src.tick()
    expect(src.list()).toHaveLength(1)
    clock.t += 1_000
    src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('a resume after session-end keeps the session', () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-end'))
    clock.t += 5_000
    src.ingest(ev('session-start'))
    clock.t += 20_000
    src.tick()
    expect(src.list()).toHaveLength(1)
  })

  it('removes a session whose pid is gone', () => {
    const { src, gens, ev } = setup()
    src.ingest(ev('session-start'))
    src.tick()
    expect(src.list()).toHaveLength(1)
    gens.set(100, null)
    src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('removes a session whose pid generation changed', () => {
    const { src, gens, ev } = setup()
    src.ingest(ev('session-start'))
    gens.set(100, 'reused')
    src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('removes a pidless session after 12 h without an event', () => {
    const { src, clock, gens, ev } = setup()
    gens.set(100, null) // a pid whose generation cannot be read counts as no pid
    src.ingest(ev('session-start'))
    clock.t += 12 * 3600_000 - 1
    src.tick()
    expect(src.list()).toHaveLength(1)
    clock.t += 1
    src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('holds at most 50, evicting the oldest idle', () => {
    const { src, clock, ev } = setup()
    for (let i = 0; i < 50; i++) {
      clock.t += 10
      src.ingest(ev('session-start', { sessionId: `s${i}`, callerPid: 200 + i }))
    }
    src.ingest(ev('turn-start', { sessionId: 's0', callerPid: 200 }))
    clock.t += 10
    src.ingest(ev('session-start', { sessionId: 'new', callerPid: 999 }))
    const ids = src.list().map((a) => a.sessionId)
    expect(ids).toHaveLength(50)
    expect(ids).toContain('s0') // working, so kept
    expect(ids).not.toContain('s1') // the oldest idle
    expect(ids).toContain('new')
  })

  it('drops the newcomer when all 50 are busy', () => {
    const { src, ev } = setup()
    for (let i = 0; i < 50; i++) src.ingest(ev('turn-start', { sessionId: `s${i}`, callerPid: 200 + i }))
    src.ingest(ev('session-start', { sessionId: 'new', callerPid: 999 }))
    expect(src.list()).toHaveLength(50)
    expect(src.list().some((a) => a.sessionId === 'new')).toBe(false)
  })
})

describe('ObservedSource codex and open sessions', () => {
  it('codex working → done when openSessions.working turns false (3 s check)', async () => {
    const { src, working, answers, ev } = setup()
    answers.set('/c/r.jsonl', 'Codex says hi')
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1', transcriptPath: '/c/r.jsonl' }))
    working.set('c1', true)
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
    working.set('c1', null)
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
    working.set('c1', false)
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Codex says hi' })
  })

  it('checkWorking ignores claude sessions', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
  })

  it('scanOpen adds terminal/app sessions as idle and skips harness-owned ones', async () => {
    const { src, open, owners, externals } = setup()
    open.set('a', 'terminal')
    open.set('b', 'app')
    open.set('c', 'harness')
    open.set('d', 'maybe')
    owners.set('a', { pid: 11, engine: 'claude' })
    owners.set('b', { pid: 12, engine: 'codex' })
    owners.set('c', { pid: 13, engine: 'claude' })
    owners.set('d', { pid: 14, engine: 'claude' })
    externals.set('a', { cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' })
    await src.scanOpen()
    const list = src.list()
    expect(list.map((a) => a.sessionId).sort()).toEqual(['a', 'b', 'd'])
    expect(list.find((a) => a.sessionId === 'a')).toMatchObject({ state: 'idle', name: 'alpha', callerPid: 11, cwd: '/x/alpha' })
    expect(list.every((a) => a.state === 'idle')).toBe(true)
  })

  it('scanOpen looks afresh, so the scan when a dial attaches lists an agent already running', async () => {
    const { src, open, owners } = setup()
    open.set('a', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    await src.scanOpen()
    expect(src.list().map((a) => a.sessionId)).toEqual(['a'])
  })

  it('scanOpen leaves a session a hook already knows', async () => {
    const { src, open, owners, ev } = setup()
    src.ingest(ev('turn-start'))
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    await src.scanOpen()
    expect(src.list()).toHaveLength(1)
    expect(src.list()[0].state).toBe('working')
  })
})

describe('ObservedSource and Harness\'s own sessions', () => {
  // The voice router's Claude Code runs in the data folder, outside a pane: Harness's own, never an agent outside it.
  const scratch = '/data/harness/voice-route-scratch'

  it('a hook event from a session in the data folder lists nothing', () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('session-start', { cwd: scratch }))
    src.ingest(ev('turn-start', { cwd: scratch }))
    expect(src.list()).toEqual([])
    expect(changes).not.toHaveBeenCalled()
  })

  it('the open scan lists no session in the data folder', async () => {
    const { src, open, owners, externals } = setup()
    open.set('v', 'app')
    owners.set('v', { pid: 21, engine: 'claude' })
    externals.set('v', { cwd: scratch })
    await src.scanOpen()
    expect(src.list()).toEqual([])
  })

  it('a session the scan listed without its folder goes once its hook names the data folder', async () => {
    const { src, open, owners, changes, ev } = setup()
    open.set('s1', 'app')
    owners.set('s1', { pid: 100, engine: 'claude' })
    await src.scanOpen()
    expect(src.list()).toHaveLength(1)
    changes.mockClear()
    src.ingest(ev('turn-start', { cwd: scratch }))
    expect(src.list()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(1)
  })
})

describe('observedAgentId', () => {
  it('is stable and 36 chars, in v5 layout', () => {
    const id = observedAgentId('claude', 's1')
    expect(id).toBe(observedAgentId('claude', 's1'))
    expect(id).toHaveLength(36)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(observedAgentId('codex', 's1')).not.toBe(id)
    expect(observedAgentId('claude', 's2')).not.toBe(id)
  })
})
