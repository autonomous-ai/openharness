import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservedHookEvent } from '../../core/observedHook.js'
import { STOP_HOOK_GRACE_MS } from '../../core/turns/turnHooks.js'
import { type Delivery, Inbox } from './inbox.js'
import { observedAgentId, type ObservedActions, ObservedSource, type ObservedDeps } from './observed.js'

function setup(over: Partial<ObservedDeps> = {}) {
  const clock = { t: 1_000_000 }
  const gens = new Map<number, string | null>()
  // The machine's processes: every pid below 1000 runs, as `g<pid>`, but one `gens` says is gone (null) or another.
  const procs = vi.fn(async (): Promise<{ pid: number; generation?: string }[]> => Array.from({ length: 1000 }, (_, pid) => pid)
    .filter((pid) => gens.get(pid) !== null).map((pid) => ({ pid, generation: gens.get(pid) ?? `g${pid}` })))
  const alive = vi.fn((_pid: number) => true)
  const open = new Map<string, 'terminal' | 'app' | 'harness' | 'maybe'>()
  const owners = new Map<string, { pid: number; engine: string }>()
  const working = new Map<string, boolean | null>()
  const externals = new Map<string, { cwd?: string; transcriptPath?: string | null }>()
  const answers = new Map<string, string>()
  // Each transcript's last change, as its file's stamp says it.
  const stamps = new Map<string, number>()
  // Each look at the machine's processes, as OpenSessions takes one.
  let looks = 0
  let held: Promise<void> | undefined
  const look = async (): Promise<void> => { looks++; await held }
  const find = vi.fn(async (wanted: ReadonlyMap<string, string>) =>
    new Map([...wanted.keys()].flatMap((id) => (externals.has(id) ? [[id, externals.get(id)!] as const] : []))))
  const deps: ObservedDeps = {
    now: () => clock.t,
    processes: procs,
    alive,
    openSessions: {
      // The cached answer is empty before the first look, as it is when a dial attaches; only a fresh look sees.
      known: () => new Map(),
      owners: async () => {
        await look()
        return new Map([...open].flatMap(([id, openIn]) => {
          const owner = owners.get(id)
          return owner ? [[id, { ...owner, tty: null, record: id, ...(openIn === 'harness' ? { harness: true } : {}) }] as const] : []
        }))
      },
      // As OpenSessions says: busy unless the owner's record reads idle.
      busy: async (owner: { record: string }) => working.get(owner.record) !== false,
    } as unknown as ObservedDeps['openSessions'],
    sessionRows: { find } as unknown as ObservedDeps['sessionRows'],
    lastAnswer: async (_engine, path) => answers.get(path),
    fileStamp: async (path: string) => (stamps.has(path) ? { stamp: '', mtime: stamps.get(path)! } : null),
    excluded: ['/data/harness'],
    log: () => {},
    ...over,
  }
  const src = new ObservedSource(deps)
  const changes = vi.fn()
  src.onChange(changes)
  const ev = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 's1', event, cwd: '/work/proj', callerPid: 100, hostHints: {}, ...over,
  })
  return {
    src, clock, gens, procs, alive, open, owners, working, externals, answers, stamps, changes, ev, find,
    looks: () => looks, hold: (until: Promise<void>) => { held = until },
  }
}

/** Past the wait before a turn's answer is read. */
const graced = (): Promise<unknown> => vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)

describe('ObservedSource states', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('drives each event to the spec table', () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-start'))
    expect(src.list()[0]).toMatchObject({ state: 'idle', name: 'proj', engine: 'claude', host: 'terminal' })
    clock.t += 1000
    src.ingest(ev('turn-start'))
    expect(src.list()[0]).toMatchObject({ state: 'working' })
    clock.t += 1000
    src.ingest(ev('needs-input'))
    expect(src.list()[0]).toMatchObject({ state: 'needs-you' })
    clock.t += 1000
    src.ingest(ev('turn-start'))
    expect(src.list()[0]).toMatchObject({ state: 'working' })
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

  it('takes needs-input only while a turn works', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('idle')
    src.ingest(ev('turn-stop'))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('done')
  })

  it('turn-stop for claude sets lastAnswer and unseenDone', async () => {
    const { src, answers, ev } = setup()
    answers.set('/t/s.jsonl', 'Fixed the bug.')
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
    await graced()
    expect(src.list()[0].lastAnswer).toBe('Fixed the bug.')
  })

  it("reads the last answer once the core's Stop grace is over: Claude's transcript can lag its Stop hook", async () => {
    const lastAnswer = vi.fn(async () => 'Fixed it.')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 1)
    expect(lastAnswer).not.toHaveBeenCalled()
    // A next turn ending within the grace is read once, after its own.
    src.ingest(ev('turn-start'))
    src.ingest(ev('turn-stop'))
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 1)
    expect(lastAnswer).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(lastAnswer).toHaveBeenCalledTimes(1)
    expect(src.list()[0].lastAnswer).toBe('Fixed it.')
  })

  it('cuts a long answer to the card on a whole character', async () => {
    const { src, answers, ev } = setup()
    answers.set('/t/s.jsonl', `${'a'.repeat(298)}😀${'b'.repeat(10)}`)
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    await graced()
    expect(src.list()[0].lastAnswer).toBe(`${'a'.repeat(298)}😀…`)
  })

  it('does not read a transcript for other engines', async () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-stop', { engine: 'cursor', transcriptPath: '/t/s.jsonl' }))
    await graced()
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
    await graced()
    expect(src.list()[0].lastAnswer).toBe('Done.')
    src.ingest(ev('turn-start'))
    expect(src.list()[0].lastAnswer).toBeUndefined()
    src.ingest(ev('turn-stop'))
    await graced()
    expect(told).toEqual(['Done.', undefined, 'Done.'])
  })

  it('a late answer does not land on a newer turn', async () => {
    let release: (v: string) => void = () => {}
    const { src, ev } = setup({ lastAnswer: () => new Promise((r) => { release = r }) })
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    await graced()
    src.ingest(ev('turn-start'))
    release('old')
    await vi.advanceTimersByTimeAsync(0)
    expect(src.list()[0].lastAnswer).toBeUndefined()
  })
})

describe('ObservedSource removal', () => {
  it('session-end removes after 10 s', async () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('session-end'))
    clock.t += 9_000
    await src.tick()
    expect(src.list()).toHaveLength(1)
    clock.t += 1_000
    await src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('a session-end for a session it never knew lists nothing', () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('session-end'))
    expect(src.list()).toEqual([])
    expect(changes).not.toHaveBeenCalled()
  })

  it('a resume after session-end keeps the session', async () => {
    const { src, clock, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('session-end'))
    clock.t += 5_000
    src.ingest(ev('session-start'))
    clock.t += 20_000
    await src.tick()
    expect(src.list()).toHaveLength(1)
  })

  it('removes a session whose pid is gone', async () => {
    const { src, gens, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    expect(src.list()).toHaveLength(1)
    gens.set(100, null)
    await src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('removes a session whose pid generation changed', async () => {
    const { src, gens, ev } = setup()
    src.ingest(ev('session-start'))
    // The first look notes its process's generation.
    await src.tick()
    gens.set(100, 'reused')
    await src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('tick reads every session\'s process generation in one call', async () => {
    const { src, procs, ev } = setup()
    for (let i = 0; i < 50; i++) src.ingest(ev('session-start', { sessionId: `s${i}`, callerPid: 200 + i }))
    // A hook is never held up by a process read.
    expect(procs).not.toHaveBeenCalled()
    await src.tick()
    expect(procs).toHaveBeenCalledTimes(1)
    expect(src.list()).toHaveLength(50)
  })

  it('a session first heard of while the process table is read is not judged by that table', async () => {
    const { src, procs, ev } = setup()
    src.ingest(ev('session-start'))
    let read!: (rows: { pid: number; generation?: string }[]) => void
    procs.mockImplementationOnce(() => new Promise((resolve) => { read = resolve }))
    const ticking = src.tick()
    // Its process started after the read began, so the table cannot hold it.
    src.ingest(ev('session-start', { sessionId: 's2', callerPid: 5000 }))
    read([{ pid: 100, generation: 'g100' }])
    await ticking
    expect(src.list().map((a) => a.sessionId)).toEqual(['s1', 's2'])
  })

  it('with no process table to read (Windows here), a session goes once its process is not alive', async () => {
    const { src, procs, alive, ev } = setup()
    procs.mockResolvedValue([])
    src.ingest(ev('session-start'))
    await src.tick()
    expect(src.list()).toHaveLength(1)
    alive.mockReturnValue(false)
    await src.tick()
    expect(src.list()).toHaveLength(0)
    expect(alive).toHaveBeenCalledWith(100)
  })

  it('removes a session after 12 h without an event while the process table cannot be read', async () => {
    const { src, clock, procs, ev } = setup()
    procs.mockResolvedValue([])
    src.ingest(ev('session-start'))
    clock.t += 12 * 3600_000 - 1
    await src.tick()
    expect(src.list()).toHaveLength(1)
    clock.t += 1
    await src.tick()
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
  it('codex working → done when its owner reads idle (3 s check)', async () => {
    const { src, clock, open, owners, working, answers, ev } = setup()
    open.set('c1', 'terminal')
    owners.set('c1', { pid: 100, engine: 'codex' })
    answers.set('/c/r.jsonl', 'Codex says hi')
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1', transcriptPath: '/c/r.jsonl' }))
    clock.t += 3_000
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

  it('a Codex turn goes on while its owner cannot be found: a process read that timed out says nothing', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1' }))
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
  })

  it('a Claude turn stopped with Esc goes idle once its record reads idle, with no done', async () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, clock, open, owners, working, ev } = setup({ lastAnswer })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    src.ingest(ev('turn-start', { transcriptPath: '/t/s.jsonl' }))
    working.set('s1', false)
    // A turn just begun can still read idle: its prompt's hook runs before the engine marks the turn begun.
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
    expect(lastAnswer).not.toHaveBeenCalled()
  })

  it('a waiting agent works again once its transcript grows past the moment it began waiting', async () => {
    const { src, clock, stamps, ev } = setup()
    src.ingest(ev('turn-start', { transcriptPath: '/t/s.jsonl' }))
    stamps.set('/t/s.jsonl', clock.t)
    clock.t += 6_000
    src.ingest(ev('needs-input'))
    await src.checkWorking()
    expect(src.list()[0].state).toBe('needs-you')
    // Allowed in its own terminal, with no hook: the tool's result is written.
    stamps.set('/t/s.jsonl', clock.t + 1)
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
  })

  it('an agent with a card open stays needs-you while its transcript is written, and after the card leaves until it grows again', async () => {
    const { src, clock, stamps, ev } = setup()
    src.ingest(ev('turn-start', { transcriptPath: '/t/s.jsonl' }))
    clock.t += 10
    src.approval('s1', '/work/proj', 'open')
    // The tool call's line is written after its hook asked: the prompt is not answered.
    stamps.set('/t/s.jsonl', clock.t + 5)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0].state).toBe('needs-you')
    // The card expired, and the terminal's prompt still waits: the write before is not its answer.
    clock.t += 300_000
    src.approval('s1', '/work/proj', 'left')
    await src.checkWorking()
    expect(src.list()[0].state).toBe('needs-you')
    // Answered in the terminal: the transcript grows.
    stamps.set('/t/s.jsonl', clock.t + 1)
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
    externals.set('b', { cwd: '/x/beta', transcriptPath: null })
    externals.set('c', { cwd: '/x/gamma', transcriptPath: '/t/c.jsonl' })
    externals.set('d', { cwd: '/x/delta', transcriptPath: '/t/d.jsonl' })
    await src.scanOpen()
    const list = src.list()
    expect(list.map((a) => a.sessionId).sort()).toEqual(['a', 'b', 'd'])
    expect(list.find((a) => a.sessionId === 'a')).toMatchObject({ state: 'idle', name: 'alpha', callerPid: 11, cwd: '/x/alpha' })
    expect(list.every((a) => a.state === 'idle')).toBe(true)
  })

  it('scanOpen looks afresh, so the scan when a dial attaches lists an agent already running', async () => {
    const { src, open, owners, externals } = setup()
    open.set('a', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    externals.set('a', { cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' })
    await src.scanOpen()
    expect(src.list().map((a) => a.sessionId)).toEqual(['a'])
  })

  it('scanOpen reads the process table once, however many sessions', async () => {
    const { src, open, owners, externals, find, looks } = setup()
    for (let i = 0; i < 60; i++) {
      open.set(`s${i}`, 'terminal')
      owners.set(`s${i}`, { pid: 200 + i, engine: i % 2 ? 'codex' : 'claude' })
      externals.set(`s${i}`, { cwd: `/w/p${i}`, transcriptPath: `/t/s${i}.jsonl` })
    }
    open.set('mine', 'harness')
    owners.set('mine', { pid: 300, engine: 'claude' })
    await src.scanOpen()
    expect(looks()).toBe(1)
    // Only the sessions found open are looked up, each in its own engine's store; Harness's own pane is not one.
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0][0]).toEqual(new Map([...owners].filter(([id]) => id !== 'mine').map(([id, owner]) => [id, owner.engine])))
    expect(src.list()).toHaveLength(50)
  })

  it('a second scanOpen while one runs does not start another', async () => {
    const { src, open, owners, looks, hold } = setup()
    open.set('a', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    let release: () => void = () => {}
    hold(new Promise((resolve) => { release = resolve }))
    const scans = [src.scanOpen(), src.scanOpen()]
    release()
    await Promise.all(scans)
    expect(looks()).toBe(1)
  })

  it('a session the scan found takes its host from its hook', async () => {
    const { src, open, owners, externals, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()[0].host).toBe('terminal')
    src.ingest(ev('turn-start', { hostHints: { ORCA_AGENT_SESSION_ID: 'x' } }))
    expect(src.list()[0]).toMatchObject({ host: 'orca', state: 'working' })
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

  it('the open scan lists no session whose folder it cannot tell', async () => {
    const { src, open, owners } = setup()
    // The voice router as the real readers see it: its pid record says it is open, and its store has no row for it
    // (a program's transcript, `sdk-cli`, in the data folder), so nothing says where it runs.
    open.set('router', 'app')
    owners.set('router', { pid: 29140, engine: 'claude' })
    await src.scanOpen()
    expect(src.list()).toEqual([])
  })

  it('the open scan lists no session in the data folder', async () => {
    const { src, open, owners, externals } = setup()
    open.set('v', 'app')
    owners.set('v', { pid: 21, engine: 'claude' })
    externals.set('v', { cwd: scratch })
    await src.scanOpen()
    expect(src.list()).toEqual([])
  })

  it('a session first heard of without its folder goes once a hook names the data folder', async () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('session-start', { cwd: undefined }))
    expect(src.list()).toHaveLength(1)
    changes.mockClear()
    src.ingest(ev('turn-start', { cwd: scratch }))
    expect(src.list()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(1)
  })
})

const HANDLE = 'term_0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'

/** Routes that answer as told, recording what each was handed. */
function fakeActions(over: Partial<ObservedActions> = {}) {
  const ready = new Set<string>()
  const actions = {
    modReady: vi.fn((sessionId: string) => ready.has(sessionId)),
    toMod: vi.fn(async (_sessionId: string, _text: string): Promise<Delivery> => 'taken'),
    orcaSend: vi.fn(async (_handle: string, _text: string) => true),
    orcaOpen: vi.fn(async (_handle: string) => true),
    count: vi.fn((_what: Parameters<ObservedActions['count']>[0]) => {}),
  }
  return { actions: { ...actions, ...over } as typeof actions, ready }
}

describe('ObservedSource actions', () => {
  const withHandle = { hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }

  it('keeps a handle that is term_<uuid> and ignores any other', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: true })
    src.ingest(ev('turn-stop', { hostHints: { ORCA_TERMINAL_HANDLE: `${HANDLE}; rm -rf /` } }))
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: false, focus: false })
  })

  it('an event whose hints carry no handle clears it', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    // Resumed in another terminal: the old handle now holds something else.
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: false, focus: false })
    expect(await src.focus(agent)).toBe(false)
    expect(actions.orcaOpen).not.toHaveBeenCalled()
  })

  it('a session found by the scan takes its host from its first event', async () => {
    const { actions } = fakeActions()
    const { src, open, owners, externals, ev } = setup({ actions })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: false, focus: false })
    src.ingest(ev('session-start', withHandle))
    expect(src.list()[0].host).toBe('orca')
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: true })
  })

  it('caps: s alone with no actions; v and f with a handle; v for a claude session the mod is ready for; never v from the mod for codex; a only while an approval is open', () => {
    const bare = setup()
    bare.src.ingest(bare.ev('session-start', withHandle))
    expect(bare.src.capabilities(bare.src.list()[0])).toEqual({ status: true, voice: false, focus: false, answer: false })

    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'mod' }))
    src.ingest(ev('session-start', { sessionId: 'cx', engine: 'codex' }))
    ready.add('mod')
    ready.add('cx')
    const caps = (sessionId: string) => src.capabilities(src.list().find((a) => a.sessionId === sessionId)!)
    expect(caps('orca')).toEqual({ status: true, voice: true, focus: true, answer: false })
    expect(caps('mod')).toEqual({ status: true, voice: true, focus: false, answer: false })
    expect(caps('cx')).toEqual({ status: true, voice: false, focus: false, answer: false })
    src.approval('mod', '/work/proj', 'open')
    expect(caps('mod').answer).toBe(true)
    src.approval('mod', '/work/proj', 'answered')
    expect(caps('mod').answer).toBe(false)
  })

  it('approval open creates a claude agent the hook never named and turns it needs-you', async () => {
    const { actions } = fakeActions()
    const { src, clock, changes } = setup({ actions })
    const agent = src.approval('new', '/work/fresh', 'open')
    expect(agent).toMatchObject({ id: observedAgentId('claude', 'new'), engine: 'claude', name: 'fresh', state: 'needs-you' })
    expect(src.list()).toEqual([agent])
    expect(src.capabilities(agent!).answer).toBe(true)
    expect(changes).toHaveBeenCalled()
    // No process is known for it until its hook comes: the process sweep keeps it, until 12 h of silence.
    await src.tick()
    expect(src.list()).toHaveLength(1)
    clock.t += 12 * 3600_000
    await src.tick()
    expect(src.list()).toEqual([])
  })

  it('a hook after the approval gives the agent its process', async () => {
    const { actions } = fakeActions()
    const { src, gens, ev } = setup({ actions })
    src.approval('s1', '/work/proj', 'open')
    src.ingest(ev('session-start', { callerPid: 300 }))
    expect(src.list()[0].callerPid).toBe(300)
    gens.set(300, null)
    await src.tick()
    expect(src.list()).toEqual([])
  })

  it('answered turns it working', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start'))
    src.approval('s1', '/work/proj', 'open')
    expect(src.approval('s1', '/work/proj', 'answered')).toMatchObject({ state: 'working' })
    expect(src.capabilities(src.list()[0]).answer).toBe(false)
  })

  it('left keeps it needs-you', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start'))
    src.approval('s1', '/work/proj', 'open')
    expect(src.approval('s1', '/work/proj', 'left')).toMatchObject({ state: 'needs-you' })
    expect(src.capabilities(src.list()[0]).answer).toBe(false)
  })

  it('terminal: a prompt the dial cannot show whole turns the agent needs-you with nothing to answer, until it moves on', () => {
    const { actions } = fakeActions()
    const { src, ev, changes } = setup({ actions })
    const agent = src.approval('new', '/work/fresh', 'terminal')
    expect(agent).toMatchObject({ id: observedAgentId('claude', 'new'), name: 'fresh', state: 'needs-you' })
    expect(src.list()).toEqual([agent])
    expect(src.capabilities(agent!).answer).toBe(false)
    expect(src.terminalOnly(agent!.id)).toBe(true)
    expect(changes).toHaveBeenCalled()
    // The same prompt's notice keeps it; the turn going on ends it.
    src.ingest(ev('needs-input', { sessionId: 'new' }))
    expect(src.terminalOnly(agent!.id)).toBe(true)
    src.ingest(ev('turn-start', { sessionId: 'new' }))
    expect(src.list()[0].state).toBe('working')
    expect(src.terminalOnly(agent!.id)).toBe(false)
  })

  it('terminal: a card for the next prompt is the dial\'s again, and one already open keeps its answer', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start'))
    const id = observedAgentId('claude', 's1')
    src.approval('s1', '/work/proj', 'terminal')
    src.approval('s1', '/work/proj', 'open')
    expect(src.terminalOnly(id)).toBe(false)
    src.approval('s1', '/work/proj', 'terminal')
    expect(src.terminalOnly(id)).toBe(true)
    expect(src.capabilities(src.list()[0]).answer).toBe(true)
    expect(src.terminalOnly('unknown')).toBe(false)
  })

  it('terminal with the source full gives undefined', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    for (let i = 0; i < 50; i++) src.ingest(ev('turn-start', { sessionId: `s${i}`, callerPid: 200 + i }))
    expect(src.approval('new', '/work/proj', 'terminal')).toBeUndefined()
    expect(src.list()).toHaveLength(50)
  })

  it('open with the source full gives undefined', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    for (let i = 0; i < 50; i++) src.ingest(ev('turn-start', { sessionId: `s${i}`, callerPid: 200 + i }))
    expect(src.approval('new', '/work/proj', 'open')).toBeUndefined()
    expect(src.list()).toHaveLength(50)
  })

  it('send is refused while working and while needs-you, and nothing is typed', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start', withHandle))
    const busy = { ok: false, reason: 'proj is busy. Say it when it is done.' }
    expect(await src.send(src.list()[0], 'next')).toEqual(busy)
    src.ingest(ev('needs-input', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual(busy)
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  it('send goes to the mod when it is ready', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'next step')).toEqual({ ok: true })
    expect(actions.toMod).toHaveBeenCalledWith('s1', 'next step')
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  it('to Orca with a handle and no mod', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'next step')).toEqual({ ok: true })
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).toHaveBeenCalledWith(HANDLE, 'next step')
  })

  it('to Orca when the mod missed its 5 s and there is a handle', async () => {
    const { actions, ready } = fakeActions({ toMod: vi.fn(async (): Promise<Delivery> => 'missed') })
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('session-start', withHandle))
    expect(await src.send(src.list()[0], 'next step')).toEqual({ ok: true })
    expect(actions.toMod).toHaveBeenCalledTimes(1)
    expect(actions.orcaSend).toHaveBeenCalledWith(HANDLE, 'next step')
  })

  it('a turn that begins while the mod is waited for is busy, and nothing is typed into Orca', async () => {
    let missed!: (delivery: Delivery) => void
    const { actions, ready } = fakeActions({ toMod: vi.fn(() => new Promise<Delivery>((resolve) => { missed = resolve })) })
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop', withHandle))
    const sent = src.send(src.list()[0], 'run the tests')
    // The person starts a turn in the terminal while the mod's next poll does not come.
    src.ingest(ev('turn-start', withHandle))
    missed('missed')
    expect(await sent).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['busy'])
  })

  it('a session that ends, moves to another terminal or goes while the mod is waited for is not typed into', async () => {
    const other = 'term_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const meanwhile: Array<(t: ReturnType<typeof setup>) => Promise<void>> = [
      async ({ src, ev }) => { src.ingest(ev('session-end', withHandle)) },
      async ({ src, ev }) => { src.ingest(ev('session-start', { hostHints: { ORCA_TERMINAL_HANDLE: other } })) },
      async ({ src, gens }) => { gens.set(100, null); await src.tick() },
    ]
    for (const happen of meanwhile) {
      let missed!: (delivery: Delivery) => void
      const { actions, ready } = fakeActions({ toMod: vi.fn(() => new Promise<Delivery>((resolve) => { missed = resolve })) })
      const t = setup({ actions })
      ready.add('s1')
      t.src.ingest(t.ev('turn-stop', withHandle))
      const sent = t.src.send(t.src.list()[0], 'run the tests')
      await happen(t)
      missed('missed')
      expect(await sent).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.orcaSend).not.toHaveBeenCalled()
    }
  })

  it('a second transcript while the first waits for the mod is busy: typed into Orca, it would land before the first', async () => {
    const inbox = new Inbox({ now: () => 0, after: () => () => {} })
    const { actions } = fakeActions({
      modReady: vi.fn((sessionId: string) => inbox.ready(sessionId)),
      toMod: vi.fn((sessionId: string, text: string) => inbox.deliver(sessionId, text)),
    })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    // The mod's poll just closed; its next is a moment away.
    void inbox.poll('p1', 's1')
    inbox.gone('p1')
    const agent = src.list()[0]
    const first = src.send(agent, 'run the tests')
    expect(await src.send(agent, 'and then deploy')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(await inbox.poll('p2', 's1')).toEqual({ text: 'run the tests' })
    expect(await first).toEqual({ ok: true })
  })

  it('did not answer with neither', async () => {
    const { actions, ready } = fakeActions({ toMod: vi.fn(async (): Promise<Delivery> => 'missed') })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start'))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    ready.add('s1')
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  it('a failed Orca send says did not answer', async () => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async () => false) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
  })

  it('a text over 2000 characters is refused before any route', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    // Busy too: the length is what the person can fix by saying it again.
    src.ingest(ev('turn-start', withHandle))
    expect(await src.send(src.list()[0], 'a'.repeat(2001))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  it('an agent whose session ended takes no voice and no tap: its terminal holds a shell now', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop', withHandle))
    src.ingest(ev('session-end', withHandle))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toEqual({ status: true, voice: false, focus: false, answer: false })
    expect(await src.send(agent, 'git push --force')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(await src.focus(agent)).toBe(false)
    // Ended in a turn too: nobody is there to be busy.
    src.ingest(ev('turn-start', { sessionId: 's2', ...withHandle }))
    src.ingest(ev('session-end', { sessionId: 's2', ...withHandle }))
    expect(await src.send(src.list()[1], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.orcaOpen).not.toHaveBeenCalled()
    // Resumed, it is a live session again.
    src.ingest(ev('session-start', withHandle))
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: true })
  })

  it('focus runs orcaOpen for a handle and is false without one', async () => {
    const { actions } = fakeActions({ orcaOpen: vi.fn(async () => false) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'plain' }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(await src.focus(agent('orca'))).toBe(false)
    expect(actions.orcaOpen).toHaveBeenCalledWith(HANDLE)
    actions.orcaOpen.mockResolvedValue(true)
    expect(await src.focus(agent('orca'))).toBe(true)
    expect(await src.focus(agent('plain'))).toBe(false)
    expect(actions.orcaOpen).toHaveBeenCalledTimes(2)
  })

  it('counts mod, orca, busy, too-long and no-answer', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'mod' }))
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'none' }))
    src.ingest(ev('turn-start', { sessionId: 'busy' }))
    ready.add('mod')
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    await src.send(agent('mod'), 'x')
    await src.send(agent('orca'), 'x')
    await src.send(agent('busy'), 'x')
    await src.send(agent('none'), 'x'.repeat(2001))
    await src.send(agent('none'), 'x')
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['mod', 'orca', 'busy', 'too-long', 'no-answer'])
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
