import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservedAsked, ObservedHookEvent } from '../../core/observedHook.js'
import { STOP_HOOK_GRACE_MS } from '../../core/turns/turnHooks.js'
import { type Delivery, Inbox } from './inbox.js'
import { askedLine, observedAgentId, type ObservedActions, ObservedSource, type ObservedDeps } from './observed.js'
import type { OpenTarget } from './open.js'

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
  const logs: string[] = []
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
    log: (line) => { logs.push(line) },
    ...over,
  }
  const src = new ObservedSource(deps)
  const changes = vi.fn()
  src.onChange(changes)
  const ev = (event: ObservedHookEvent['event'], over: Partial<ObservedHookEvent> = {}): ObservedHookEvent => ({
    engine: 'claude', sessionId: 's1', event, cwd: '/work/proj', callerPid: 100, hostHints: {}, ...over,
  })
  return {
    src, clock, gens, procs, alive, open, owners, working, externals, answers, stamps, changes, ev, find, logs,
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

  // Claude Code's Notification reaches the hook only for a prompt (hook/notify.mjs): an agent the open scan found reads
  // idle until its next hook, though its turn may run; the quota's resume asks after its turn stopped; and a turn another
  // Stop hook keeps going asks after its Stop. Each is a prompt open in the terminal.
  it('takes needs-input in every state', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('needs-you')
    src.ingest(ev('turn-stop'))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('needs-you')
    src.ingest(ev('turn-error'))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('needs-you')
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

  it('scanOpen adds terminal/app sessions, working while their owner reads busy, and skips harness-owned ones', async () => {
    const { src, open, owners, working, externals } = setup()
    open.set('a', 'terminal')
    open.set('b', 'app')
    open.set('c', 'harness')
    open.set('d', 'maybe')
    open.set('e', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    owners.set('b', { pid: 12, engine: 'codex' })
    owners.set('c', { pid: 13, engine: 'claude' })
    owners.set('d', { pid: 14, engine: 'claude' })
    owners.set('e', { pid: 15, engine: 'grok' })
    externals.set('a', { cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' })
    externals.set('b', { cwd: '/x/beta', transcriptPath: null })
    externals.set('c', { cwd: '/x/gamma', transcriptPath: '/t/c.jsonl' })
    externals.set('d', { cwd: '/x/delta', transcriptPath: '/t/d.jsonl' })
    externals.set('e', { cwd: '/x/eps', transcriptPath: null })
    working.set('a', false)
    await src.scanOpen()
    const list = src.list()
    expect(list.map((a) => a.sessionId).sort()).toEqual(['a', 'b', 'd', 'e'])
    expect(list.find((a) => a.sessionId === 'a')).toMatchObject({ state: 'idle', name: 'alpha', callerPid: 11, cwd: '/x/alpha' })
    // Only Claude Code's and Codex's turns are read (checkWorking ends them): another engine's stays idle.
    expect(Object.fromEntries(list.map((a) => [a.sessionId, a.state]))).toEqual({ a: 'idle', b: 'working', d: 'working', e: 'idle' })
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

  it('a session the open scan found is not known yet, on the unknown app\'s page, until its first hook', async () => {
    const { src, open, owners, externals, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()[0]).toMatchObject({ app: 'terminal', appPending: true })
    src.ingest(ev('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(src.list()[0]).toMatchObject({ host: 'ghostty', app: 'ghostty' })
    expect(src.list()[0]).not.toHaveProperty('appPending')
  })

  it('a hook with no hints makes it known to be in the unknown app', async () => {
    const { src, open, owners, externals, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()[0].appPending).toBe(true)
    src.ingest(ev('session-start', { hostHints: {} }))
    expect(src.list()[0].app).toBe('terminal')
    expect(src.list()[0]).not.toHaveProperty('appPending')
  })

  it('an agent a hook told of first is never not known yet', async () => {
    const { src, open, owners, externals, ev } = setup()
    src.ingest(ev('session-start'))
    expect(src.list()[0]).not.toHaveProperty('appPending')
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()).toHaveLength(1)
    expect(src.list()[0]).not.toHaveProperty('appPending')
  })

  it('a hook from zellij inside Ghostty gives host zellij and app ghostty', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { hostHints: { ZELLIJ: '0', TERM_PROGRAM: 'ghostty' } }))
    expect(src.list()[0]).toMatchObject({ host: 'zellij', app: 'ghostty' })
  })

  it('a session resumed in another terminal changes app', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    src.ingest(ev('session-end'))
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'iTerm.app' } }))
    expect(src.list()[0]).toMatchObject({ host: 'iterm', app: 'iterm' })
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

describe('ObservedSource and the app the scan learns', () => {
  /** A session found open in a terminal, its owner `pid`. */
  const found = (s: ReturnType<typeof setup>, sessionId: string, pid: number): void => {
    s.open.set(sessionId, 'terminal')
    s.owners.set(sessionId, { pid, engine: 'claude' })
    s.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath: `/t/${sessionId}.jsonl` })
  }

  it('a session the scan found under a listed app is on that app\'s page from its first listing, and known', async () => {
    const s = setup({ apps: async () => new Map([[11, 'ghostty']]) })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ app: 'ghostty', host: 'terminal' })
    expect(s.src.list()[0]).not.toHaveProperty('appPending')
  })

  it('the scan asks once a pass, for the new sessions\' pids alone, and never again for one it listed', async () => {
    const apps = vi.fn(async (_pids: readonly number[]) => new Map<number, string>())
    const s = setup({ apps })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    found(s, 'c', 13)
    await s.src.scanOpen()
    await s.src.scanOpen()
    expect(apps.mock.calls).toEqual([[[11, 12]], [[13]]])
  })

  it('a session nothing was learned of is not known yet, and its first hook still names its app', async () => {
    const s = setup({ apps: async () => new Map() })
    found(s, 's1', 100)
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ app: 'terminal', appPending: true })
    s.src.ingest(s.ev('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(s.src.list()[0].app).toBe('ghostty')
    expect(s.src.list()[0]).not.toHaveProperty('appPending')
  })

  it('a learn that fails still lists every session, not known yet', async () => {
    const s = setup({ apps: async () => { throw new Error('ps timed out under /Users/someone') } })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(s.src.list().map((a) => [a.sessionId, a.app, a.appPending])).toEqual([['a', 'terminal', true], ['b', 'terminal', true]])
    expect(s.logs).toContain('[observed] scan · apps not read')
    // No error text: a path holds the account's name.
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  it('a process table that cannot be read leaves every session not known yet, and listed', async () => {
    const s = setup({ apps: async () => new Map() })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(s.src.list().map((a) => [a.sessionId, a.app, a.appPending])).toEqual([['a', 'terminal', true], ['b', 'terminal', true]])
  })

  it('a hook that told of a session while its app was being learned wins', async () => {
    let answer: (apps: ReadonlyMap<number, string>) => void = () => {}
    const apps = vi.fn(() => new Promise<ReadonlyMap<number, string>>((resolve) => { answer = resolve }))
    const s = setup({ apps })
    found(s, 's1', 100)
    const scan = s.src.scanOpen()
    await vi.waitFor(() => expect(apps).toHaveBeenCalled())
    s.src.ingest(s.ev('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    answer(new Map([[100, 'vscode']]))
    await scan
    expect(s.src.list()).toHaveLength(1)
    expect(s.src.list()[0]).toMatchObject({ app: 'ghostty', state: 'working' })
    expect(s.src.list()[0]).not.toHaveProperty('appPending')
  })

  it('the scan\'s log line counts and names nothing', async () => {
    const s = setup({ apps: async () => { s.clock.t += 7; return new Map([[11, 'ghostty']]) } })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(s.logs).toEqual(['[observed] scan · 2 found · 1 app known · 7 ms'])
    for (const word of ['ghostty', 'terminal', '11', '12', '/x/', '/t/']) expect(s.logs.join('\n')).not.toContain(word)
  })

  it('with no apps reader the scan lists as before', async () => {
    const s = setup()
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ sessionId: 'a', app: 'terminal', appPending: true })
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
    // As on macOS: an app or a pane is something a tap can open (open.ts).
    canOpen: vi.fn((target: OpenTarget) => !!target.bundle || !!target.pane),
    open: vi.fn(async (_agentId: string, _target: OpenTarget) => true),
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

  it('an event whose hints carry no handle clears it: a tap opens the app it runs in now', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    // Resumed in another terminal: the old handle now holds something else.
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: false, focus: true })
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty' }]])
  })

  it('f for an agent whose app a tap can bring forward, with no handle and no mod', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'warp', hostHints: { TERM_PROGRAM: 'WarpTerminal' } }))
    src.ingest(ev('session-start', { sessionId: 'app', hostHints: { __CFBundleIdentifier: 'org.alacritty' } }))
    const caps = (sessionId: string) => src.capabilities(src.list().find((a) => a.sessionId === sessionId)!)
    expect(caps('warp')).toEqual({ status: true, voice: false, focus: true, answer: false })
    expect(caps('app')).toEqual({ status: true, voice: false, focus: true, answer: false })
    expect(actions.canOpen.mock.calls).toEqual([[{ bundle: 'dev.warp.Warp-Stable' }], [{ bundle: 'org.alacritty' }]])
    // What cannot open it (Linux, with no pane) gives no f.
    actions.canOpen.mockReturnValue(false)
    expect(caps('warp')).toMatchObject({ focus: false })
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

  it('caps: s alone with no actions; v and f with a handle; v for a claude session the mod is ready for; never v from the mod for codex; never a', () => {
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
    // Waiting on a prompt it is not the dial's to answer: the prompt is the app's.
    src.ingest(ev('turn-start', { sessionId: 'mod' }))
    src.ingest(ev('needs-input', { sessionId: 'mod' }))
    expect(caps('mod')).toEqual({ status: true, voice: true, focus: false, answer: false })
  })

  // As a Harness agent's words are (lib/sessionInput.ts): delivered at once, and the engine takes them after its turn.
  it('to the mod while working and while waiting on a prompt: its prompt.submit waits for the turn to end', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
    src.ingest(ev('needs-input', withHandle))
    expect(src.list()[0].state).toBe('needs-you')
    expect(await src.send(src.list()[0], 'and then this')).toEqual({ ok: true })
    expect(actions.toMod.mock.calls).toEqual([['s1', 'next'], ['s1', 'and then this']])
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  // A working turn may show a permission prompt the daemon has not heard of yet (Codex has no hook for its approval, which
  // takes `y` or Enter; Claude Code's comes a few hundred ms late): the words and their Enter would answer it.
  it.each(['claude', 'codex'] as const)('with no mod, %s is typed into only at its prompt: busy while it works, waiting while it asks', async (engine) => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const after = async (event: ObservedHookEvent['event'], text: string) => {
      src.ingest(ev(event, { engine, ...withHandle }))
      return src.send(src.list()[0], text)
    }
    expect(await after('session-start', 'one')).toEqual({ ok: true })
    expect(await after('turn-start', 'yes run it')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(await after('needs-input', '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(await after('turn-stop', 'two')).toEqual({ ok: true })
    src.ingest(ev('turn-start', { engine, ...withHandle }))
    expect(await after('turn-error', 'three')).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'one'], [HANDLE, 'two'], [HANDLE, 'three']])
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['orca', 'busy', 'waiting', 'orca', 'orca'])
  })

  // No scan or transcript reads another engine's turn: it is at its prompt only once a hook said its turn ended.
  it('another engine is typed into only after a hook said its turn ended', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const busy = { ok: false, reason: 'proj is busy. Say it when it is done.' }
    const after = async (event: ObservedHookEvent['event'], text: string) => {
      src.ingest(ev(event, { engine: 'grok', ...withHandle }))
      return src.send(src.list()[0], text)
    }
    expect(await after('session-start', 'one')).toEqual(busy)
    expect(await after('turn-start', 'yes run it')).toEqual(busy)
    expect(await after('needs-input', '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(await after('turn-stop', 'two')).toEqual({ ok: true })
    // A session-start after its turn ended (a compaction, a resume) keeps it at its prompt.
    expect(await after('session-start', 'three')).toEqual({ ok: true })
    expect(await after('turn-start', 'four')).toEqual(busy)
    expect(await after('turn-error', 'five')).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'two'], [HANDLE, 'three'], [HANDLE, 'five']])
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['busy', 'busy', 'waiting', 'orca', 'orca', 'busy', 'orca'])
  })

  // The scan lists another engine's agent idle though its turn may run: its first hook with a handle is no turn's end.
  it('another engine the scan found is busy until a hook said its turn ended', async () => {
    const { actions } = fakeActions()
    const { src, open, owners, externals, ev } = setup({ actions })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'grok' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: null })
    await src.scanOpen()
    src.ingest(ev('session-start', { engine: 'grok', ...withHandle }))
    expect(src.list()[0].state).toBe('idle')
    expect(await src.send(src.list()[0], 'yes do it')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    src.ingest(ev('turn-stop', { engine: 'grok', ...withHandle }))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
    src.ingest(ev('turn-start', { engine: 'grok', ...withHandle }))
    expect(await src.send(src.list()[0], 'later')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'next']])
  })

  // The dial never answers a prompt: typed into a terminal that shows one, the words and their Enter would.
  it('never typed into Orca while the agent waits on a prompt there', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start', withHandle))
    src.ingest(ev('needs-input', withHandle))
    expect(await src.send(src.list()[0], 'yes do it')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    src.ingest({ engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'rm -rf build' })
    expect(await src.send(src.list()[0], '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['waiting', 'waiting'])
  })

  // The scan lists a running agent idle; with no mod, its first hook can be the prompt its turn opened.
  it('never typed into Orca when an agent the scan found asks before any other hook', async () => {
    const { actions } = fakeActions()
    const { src, open, owners, externals, ev } = setup({ actions })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    src.ingest(ev('needs-input', withHandle))
    expect(src.list()[0].state).toBe('needs-you')
    expect(await src.send(src.list()[0], 'yes do it')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['waiting'])
  })

  // The quota's resume asks once its turn stopped, and a turn another Stop hook keeps going asks after its Stop.
  it.each(['turn-stop', 'turn-error'] as const)('never typed into Orca when a prompt opens after %s', async (ended) => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start', withHandle))
    src.ingest(ev(ended, withHandle))
    src.ingest(ev('needs-input', withHandle))
    expect(await src.send(src.list()[0], '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  // Its compaction's SessionStart, mid-turn, gives it a handle and no state: a turn listed idle would be typed into, and a
  // prompt it opens is heard a few hundred ms late.
  it('an agent the scan found mid-turn is listed working, and never typed into until its turn ends', async () => {
    const { actions } = fakeActions()
    const { src, clock, open, owners, working, externals, ev } = setup({ actions })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()[0].state).toBe('working')
    src.ingest(ev('session-start', withHandle))
    expect(await src.send(src.list()[0], 'yes do it')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    // Its owner's record reads idle: the turn is over.
    working.set('s1', false)
    clock.t += 3_000
    await src.checkWorking()
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'next']])
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

  it('words the mod missed are never typed into a turn or a prompt, though it began while the mod was waited for', async () => {
    const busy = { ok: false, reason: 'proj is busy. Say it when it is done.' }
    const waiting = { ok: false, reason: 'proj is waiting for your answer in Orca.' }
    for (const [before, meanwhile, sent] of [
      ['turn-start', [], busy],
      ['turn-stop', ['turn-start'], busy],
      ['turn-stop', ['turn-start', 'needs-input'], waiting],
    ] as const) {
      let missed!: (delivery: Delivery) => void
      const { actions, ready } = fakeActions({ toMod: vi.fn(() => new Promise<Delivery>((resolve) => { missed = resolve })) })
      const { src, ev } = setup({ actions })
      ready.add('s1')
      src.ingest(ev(before, withHandle))
      const words = src.send(src.list()[0], 'run the tests')
      // The mod's next poll does not come, and meanwhile the person goes on in the terminal.
      for (const event of meanwhile) src.ingest(ev(event, withHandle))
      missed('missed')
      expect(await words).toEqual(sent)
      expect(actions.orcaSend).not.toHaveBeenCalled()
    }
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

  it('a second transcript while the first waits for the mod is refused: typed into Orca, it would land before the first', async () => {
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
    expect(await src.send(agent, 'and then deploy')).toEqual({ ok: false, reason: 'proj has not taken your last words yet.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count).toHaveBeenLastCalledWith('pending')
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
    // Waiting too: the length is what the person can fix by saying it again.
    src.ingest(ev('turn-start', withHandle))
    src.ingest(ev('needs-input', withHandle))
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
    // Ended in a turn too: nobody is there to take them.
    src.ingest(ev('turn-start', { sessionId: 's2', ...withHandle }))
    src.ingest(ev('session-end', { sessionId: 's2', ...withHandle }))
    expect(await src.send(src.list()[1], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.open).not.toHaveBeenCalled()
    // Resumed, it is a live session again.
    src.ingest(ev('session-start', withHandle))
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: true })
  })

  it('focus opens what its last event names, as the agent\'s own, and is false when nothing can open it', async () => {
    const { actions } = fakeActions({ open: vi.fn(async () => false) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'plain' }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(await src.focus(agent('orca'))).toBe(false)
    expect(actions.open).toHaveBeenCalledWith(agent('orca').id, { bundle: 'com.stablyai.orca', pane: { app: 'orca', id: HANDLE } })
    actions.open.mockResolvedValue(true)
    expect(await src.focus(agent('orca'))).toBe(true)
    expect(await src.focus(agent('plain'))).toBe(false)
    expect(actions.open).toHaveBeenCalledTimes(2)
  })

  it('counts mod, orca, busy, waiting, too-long and no-answer', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-start', { sessionId: 'mod' }))
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('turn-start', { sessionId: 'working', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'none' }))
    src.ingest(ev('turn-start', { sessionId: 'asking', ...withHandle }))
    src.ingest(ev('needs-input', { sessionId: 'asking', ...withHandle }))
    ready.add('mod')
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    await src.send(agent('mod'), 'x')
    await src.send(agent('orca'), 'x')
    await src.send(agent('working'), 'x')
    await src.send(agent('asking'), 'x')
    await src.send(agent('none'), 'x'.repeat(2001))
    await src.send(agent('none'), 'x')
    expect(actions.count.mock.calls.map(([what]) => what)).toEqual(['mod', 'orca', 'busy', 'waiting', 'too-long', 'no-answer'])
  })
})

// A permission prompt that waits (deviceClaude/asked.ts): the dial shows the agent waiting and for what, and the prompt is
// answered in its own app.
describe('ObservedSource and a waiting prompt', () => {
  const asked = (over: Partial<ObservedAsked> = {}): ObservedAsked => ({
    engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/elsewhere', ...over,
  })

  it('asked turns a listed agent needs-you with what its prompt asks, and keeps its host, handle, process and folder', () => {
    const { actions } = fakeActions()
    const { src, ev, changes } = setup({ actions })
    src.ingest(ev('turn-start', { hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }))
    changes.mockClear()
    src.ingest(asked())
    const agent = src.list()[0]
    expect(agent).toMatchObject({ state: 'needs-you', host: 'orca', callerPid: 100, cwd: '/work/proj', name: 'proj' })
    expect(src.waitingOn(agent.id)).toBe('npm test')
    expect(src.capabilities(agent)).toEqual({ status: true, voice: true, focus: true, answer: false })
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('asked for a session no hook listed lists nothing: the plugin\'s hook runs in a Harness pane too', () => {
    const { src, changes } = setup()
    src.ingest(asked({ sessionId: 'in-a-pane' }))
    expect(src.list()).toEqual([])
    expect(src.waitingOn(observedAgentId('claude', 'in-a-pane'))).toBeUndefined()
    expect(changes).not.toHaveBeenCalled()
  })

  it('a waiting prompt on a session the scan found leaves it not known yet', async () => {
    const { src, open, owners, externals } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    src.ingest(asked())
    expect(src.list()[0]).toMatchObject({ state: 'needs-you', app: 'terminal', appPending: true })
  })

  it('asked for a session that ended changes nothing', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start'))
    src.ingest(ev('session-end'))
    src.ingest(asked())
    expect(src.list()[0].state).toBe('idle')
    expect(src.waitingOn(src.list()[0].id)).toBeUndefined()
  })

  it('a prompt with no summary waits on its tool\'s name, and with neither on nothing to show', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    const id = src.list()[0].id
    src.ingest(asked({ summary: undefined }))
    expect(src.waitingOn(id)).toBe('Bash')
    src.ingest(asked({ summary: '', tool: undefined }))
    expect(src.waitingOn(id)).toBe('')
    expect(src.list()[0].state).toBe('needs-you')
  })

  it('its Notification, before or after, keeps what the prompt asks: one wait, one line', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('needs-input'))
    const id = src.list()[0].id
    expect(src.waitingOn(id)).toBeUndefined()
    src.ingest(asked())
    expect(src.waitingOn(id)).toBe('npm test')
    src.ingest(ev('needs-input'))
    expect(src.list()[0].state).toBe('needs-you')
    expect(src.waitingOn(id)).toBe('npm test')
    // A later prompt of the same turn says what it asks instead.
    src.ingest(asked({ summary: 'ls' }))
    expect(src.waitingOn(id)).toBe('ls')
  })

  it.each(['turn-start', 'turn-stop', 'turn-error', 'session-end'] as const)(
    'the session\'s own %s clears it, and another session\'s does not', (event) => {
      const { src, ev } = setup()
      src.ingest(ev('turn-start'))
      src.ingest(ev('turn-start', { sessionId: 's2' }))
      src.ingest(asked())
      const id = observedAgentId('claude', 's1')
      src.ingest(ev(event, { sessionId: 's2' }))
      expect(src.waitingOn(id)).toBe('npm test')
      src.ingest(ev(event))
      expect(src.waitingOn(id)).toBeUndefined()
    })

  it('answered in its app: the transcript growing past the prompt clears it, the asking\'s own line and the last prompt\'s answer do not', async () => {
    const { src, clock, stamps, ev } = setup()
    src.ingest(ev('turn-start', { transcriptPath: '/t/s.jsonl' }))
    clock.t += 10_000
    src.ingest(asked())
    const id = src.list()[0].id
    // The tool call's line is written just after its hook ran.
    stamps.set('/t/s.jsonl', clock.t + 5)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0].state).toBe('needs-you')
    expect(src.waitingOn(id)).toBe('npm test')
    // Allowed in its app: the tool's result is written.
    stamps.set('/t/s.jsonl', clock.t + 1)
    // The next prompt asks before the 3 s check has seen that answer: the agent still reads needs-you.
    clock.t += 500
    src.ingest(asked({ summary: 'ls' }))
    stamps.set('/t/s.jsonl', clock.t + 5)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0].state).toBe('needs-you')
    expect(src.waitingOn(id)).toBe('ls')
    // Answered again.
    stamps.set('/t/s.jsonl', clock.t + 1)
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
    expect(src.waitingOn(id)).toBeUndefined()
  })

  it('logs each prompt shown and each wait cleared, and nothing of either', () => {
    const log = vi.fn()
    const { src, ev } = setup({ log })
    src.ingest(ev('turn-start'))
    src.ingest(asked())
    src.ingest(asked({ summary: 'ls' }))
    src.ingest(ev('turn-stop'))
    src.ingest(ev('turn-start'))
    src.ingest(asked())
    src.ingest(ev('session-end'))
    expect(log.mock.calls).toEqual([
      ['[observed] waiting prompt · shown'], ['[observed] waiting prompt · shown'], ['[observed] waiting prompt · cleared'],
      ['[observed] waiting prompt · shown'], ['[observed] waiting prompt · cleared'],
    ])
  })
})

describe('askedLine', () => {
  /** ` · answer in Orca`: 18 bytes, its dot two. */
  const WHERE = ' · answer in Orca'

  it('is what the prompt asks and the app to answer it in', () => {
    expect(askedLine('npm test', 'Orca')).toBe('npm test · answer in Orca')
  })

  it('draws each letter the round dial cannot as ?', () => {
    expect(askedLine('echo 你好 🙂', 'Ghostty')).toBe('echo ?? ? · answer in Ghostty')
  })

  // The firmware holds the line in `activity[100]` (ui_habitat.c) and cuts a longer one at its byte, app and all.
  it('fits the dial\'s 99 bytes by cutting the summary on a character, never the app', () => {
    expect(Buffer.byteLength(WHERE)).toBe(18)
    const fits = 'b'.repeat(81)
    expect(askedLine(fits, 'Orca')).toBe(`${fits}${WHERE}`)
    expect(askedLine(`${fits}b`, 'Orca')).toBe(`${'b'.repeat(78)}…${WHERE}`)
    const cut = askedLine('é'.repeat(60), 'Orca')
    expect(cut).toBe(`${'é'.repeat(39)}…${WHERE}`)
    for (const line of [cut, askedLine('x'.repeat(200), 'VS Code')]) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(99)
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
