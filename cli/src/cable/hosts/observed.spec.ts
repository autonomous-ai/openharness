import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservedAsked, ObservedHookEvent } from '../../core/observedHook.js'
import { STOP_HOOK_GRACE_MS } from '../../core/turns/turnHooks.js'
import type { HostAdapter, Pane, Place } from './adapter.js'
import { createClaudeAppAdapter } from './claudeApp.js'
import { createCodexAppAdapter } from './codexApp.js'
import type { CodexQueueResult } from './codexQueue.js'
import { createHerdrAdapter } from './herdr.js'
import type { HerdrPrompt } from './herdrClient.js'
import { type Delivery, Inbox } from './inbox.js'
import { askedLine, countWord, observedAgentId, type ObservedActions, ObservedSource, type ObservedDeps, type PromptSource } from './observed.js'
import type { OpenTarget } from './open.js'
import { createOrcaAdapter, type OrcaDeps } from './orca.js'
import { createTabsAdapter, type TabApp } from './tabs.js'
import { createTmuxAdapter } from './tmux.js'
import type { PaneSwitch, TypeResult } from './types.js'
import { createVscodeAdapter } from './vscode.js'
import { createWeztermAdapter } from './wezterm.js'

function setup(over: Partial<ObservedDeps> = {}) {
  const clock = { t: 1_000_000 }
  const gens = new Map<number, string | null>()
  // The machine's processes: every pid below 1000 runs, as `g<pid>`, but one `gens` says is gone (null) or another.
  const procs = vi.fn(async (): Promise<{ pid: number; generation?: string }[]> => Array.from({ length: 1000 }, (_, pid) => pid)
    .filter((pid) => gens.get(pid) !== null).map((pid) => ({ pid, generation: gens.get(pid) ?? `g${pid}` })))
  const alive = vi.fn((_pid: number) => true)
  const open = new Map<string, 'terminal' | 'app' | 'harness' | 'maybe'>()
  // An owner's record path is its session id unless one is given.
  const owners = new Map<string, { pid: number; engine: string; record?: string }>()
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
          return owner ? [[id, { record: id, ...owner, tty: null, ...(openIn === 'harness' ? { harness: true } : {}) }] as const] : []
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

/** Every answer a read was given has reached the source. */
const flushed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe('ObservedSource states', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('drives each event to the spec table', async () => {
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
    await graced()
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

  it('markSeen clears unseenDone and tells listeners once', async () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('turn-stop'))
    await graced()
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
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Fixed the bug.' })
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

  it('scanOpen hands every owner it read to scanned, once a scan', async () => {
    const scanned = vi.fn()
    const { src, open, owners, externals, ev } = setup({ scanned })
    const owner = (id: string, pid: number, harness = false) =>
      [id, { record: id, pid, engine: 'claude', tty: null, ...(harness ? { harness: true } : {}) }] as const
    open.set('h', 'harness')
    owners.set('h', { pid: 11, engine: 'claude' })
    // Harness-run only: nothing to list, and still told.
    await src.scanOpen()
    expect(scanned).toHaveBeenCalledTimes(1)
    expect(scanned).toHaveBeenLastCalledWith(new Map([owner('h', 11, true)]))
    // One already listed by its hook, one with no row, one in an app (no terminal).
    src.ingest(ev('session-start', { sessionId: 'k' }))
    open.set('k', 'terminal')
    owners.set('k', { pid: 12, engine: 'claude' })
    open.set('n', 'terminal')
    owners.set('n', { pid: 13, engine: 'claude' })
    open.set('b', 'app')
    owners.set('b', { pid: 14, engine: 'claude' })
    externals.set('b', { cwd: '/x/beta', transcriptPath: '/t/b.jsonl' })
    await src.scanOpen()
    expect(scanned).toHaveBeenCalledTimes(2)
    expect(scanned).toHaveBeenLastCalledWith(new Map([owner('h', 11, true), owner('k', 12), owner('n', 13), owner('b', 14)]))
  })

  it('a source built without scanned scans as before', async () => {
    const { src, open, owners, externals } = setup()
    open.set('a', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    externals.set('a', { cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' })
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

// A turn outside a pane ends by its engine's own hooks, as a Harness pane's does: its Stop is told as done only once
// 1.5 s pass with no word of the turn going on, and a lead's subagents keep it working.
describe('ObservedSource and a turn\'s end by hook', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const codex = { engine: 'codex', sessionId: 'c1', transcriptPath: '/c/r.jsonl' } as const
  /** Every state the listeners are told from now on, in order. */
  const told = (src: ObservedSource): string[] => {
    const states: string[] = []
    src.onChange(() => { states.push(src.list()[0].state) })
    return states
  }

  it('a Codex turn-stop reads working until 1.5 s of quiet, then done with its answer', async () => {
    const { src, answers, ev } = setup()
    answers.set('/c/r.jsonl', 'Codex says hi')
    src.ingest(ev('turn-start', codex))
    src.ingest(ev('turn-stop', codex))
    await vi.advanceTimersByTimeAsync(1_499)
    expect(src.list()[0]).toMatchObject({ state: 'working', unseenDone: false })
    await vi.advanceTimersByTimeAsync(1)
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Codex says hi' })
  })

  it('a turn that starts within the 1.5 s is never done, and works', async () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-start', codex))
    src.ingest(ev('turn-stop', codex))
    const states = told(src)
    await vi.advanceTimersByTimeAsync(1_000)
    src.ingest(ev('turn-start', codex))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'working', unseenDone: false })
    expect(states).not.toContain('done')
    expect(lastAnswer).not.toHaveBeenCalled()
  })

  it.each([['needs-input', 'needs-you'], ['turn-error', 'error']] as const)('%s within the 1.5 s is never done', async (event, state) => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('turn-stop'))
    const states = told(src)
    src.ingest(ev(event))
    await graced()
    expect(src.list()[0]).toMatchObject({ state, unseenDone: false })
    expect(states).not.toContain('done')
  })

  it('a prompt asked within the 1.5 s is never done', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('turn-stop'))
    src.ingest({ engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash' })
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'needs-you', unseenDone: false })
  })

  // Its turn is over all the same (`claude -p` ends its session at once): it does not read working until it is removed.
  it('a session that ends within the 1.5 s is never done, and its turn is over', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('turn-stop'))
    src.ingest(ev('session-end'))
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
  })

  // Ended at its prompt (Ctrl-C), it waits on nobody, and the interrupt its transcript then gets is no answer.
  it('a session that ends while it waits on a prompt reads idle, though its transcript grows', async () => {
    const { src, clock, stamps, ev } = setup()
    src.ingest(ev('turn-start', { transcriptPath: '/t/s.jsonl' }))
    clock.t += 6_000
    src.ingest(ev('needs-input'))
    clock.t += 3_000
    src.ingest(ev('session-end'))
    stamps.set('/t/s.jsonl', clock.t)
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
  })

  it('a lead that ends its session after its Stop, its subagent running, does not read working', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-stop'))
    src.ingest(ev('session-end'))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
  })

  // The person stopped the turn: nothing to tell as done, as a Claude turn stopped with Esc.
  it.each([['within the 1.5 s', ['turn-start', 'turn-stop']], ['mid-turn', ['turn-start']]] as const)(
    'turn-aborted %s ends the turn idle, never done', async (_when, before) => {
      const lastAnswer = vi.fn(async () => 'x')
      const { src, ev } = setup({ lastAnswer })
      for (const event of before) src.ingest(ev(event, codex))
      const states = told(src)
      src.ingest(ev('turn-aborted', codex))
      expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
      await graced()
      expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
      expect(states).not.toContain('done')
      expect(lastAnswer).not.toHaveBeenCalled()
    })

  it('a lead whose subagent runs stays working past its Stop, and its owner reading idle does not end it', async () => {
    const { src, clock, open, owners, working, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0].state).toBe('working')
    working.set('s1', false)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'working', unseenDone: false })
  })

  // Its wrap-up after its last subagent is still to come: its own Stop ends the turn (engines/kit/stopHook.ts).
  it('a lead\'s Stop while its subagent runs is not done though the subagent stops within the 1.5 s', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-stop'))
    const states = told(src)
    await vi.advanceTimersByTimeAsync(1_000)
    src.ingest(ev('subagent-stop'))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'working', unseenDone: false })
    expect(states).not.toContain('done')
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
  })

  it('a lead whose subagents all stopped is done 1.5 s after its Stop', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('subagent-stop'))
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
  })

  it('its owner reading idle does not end a turn whose Stop waits out the 1.5 s', async () => {
    const { src, clock, open, owners, working, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    working.set('s1', false)
    src.ingest(ev('turn-start'))
    clock.t += 3_000
    src.ingest(ev('turn-stop'))
    await src.checkWorking()
    expect(src.list()[0].state).toBe('working')
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
  })

  it('a subagent-stop with none running counts none below 0', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-stop'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0].state).toBe('working')
  })

  it('counts 64 subagents at most: the 65th start is not counted, and logged once with no session', async () => {
    const { src, ev, logs } = setup()
    src.ingest(ev('turn-start'))
    for (let i = 0; i < 65; i++) src.ingest(ev('subagent-start'))
    for (let i = 0; i < 64; i++) src.ingest(ev('subagent-stop'))
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0].state).toBe('done')
    expect(logs.filter((line) => line.includes('subagent'))).toEqual(['[observed] subagent not counted · 64 running'])
  })

  it('a new turn counts its subagents afresh', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-start'))
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0].state).toBe('done')
  })

  // A SubagentStop that was lost would keep the lead working for good.
  it('10 minutes with no event for the session count none, and the next Stop is done', async () => {
    const { src, clock, ev, logs } = setup()
    src.ingest(ev('turn-start'))
    src.ingest(ev('subagent-start'))
    src.ingest(ev('turn-stop'))
    await graced()
    clock.t += 599_999
    await src.checkWorking()
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0].state).toBe('working')
    clock.t += 600_000
    await src.checkWorking()
    expect(logs.filter((line) => line.includes('subagent'))).toEqual(['[observed] subagent count reset · no event in 10 min'])
    src.ingest(ev('turn-stop'))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
  })

  // Its Finished comes from its Stop: an owner reading idle with no Stop is a turn the person stopped (Esc).
  it('a Codex turn with no Stop, after one with a Stop, ends idle once its owner reads idle', async () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, clock, open, owners, working, ev } = setup({ lastAnswer })
    open.set('c1', 'terminal')
    owners.set('c1', { pid: 100, engine: 'codex' })
    src.ingest(ev('turn-start', codex))
    src.ingest(ev('turn-stop', codex))
    await graced()
    expect(lastAnswer).toHaveBeenCalledTimes(1)
    src.ingest(ev('turn-start', codex))
    working.set('c1', false)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false })
    expect(lastAnswer).toHaveBeenCalledTimes(1)
  })

  // An older Codex sends no Stop: its owner reading idle is the only word that its turn is over.
  it('a Codex session that never sent a Stop is done once its owner reads idle', async () => {
    const { src, clock, open, owners, working, ev } = setup()
    open.set('c1', 'terminal')
    owners.set('c1', { pid: 100, engine: 'codex' })
    src.ingest(ev('turn-start', codex))
    working.set('c1', false)
    clock.t += 3_000
    await src.checkWorking()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
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
    expect(s.logs).toEqual(['[observed] scan · 2 found · 1 app known · 0 named · 7 ms'])
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

describe('ObservedSource and the name a session gives itself', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('a title names the agent, a new one renames it, a turn-stop keeps it, and a Claude turn-start with none reads the folder again', () => {
    const { src, changes, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho', cwd: '/x/scratch-2016' }))
    expect(src.list()[0]).toMatchObject({ name: 'Tho', cwd: '/x/scratch-2016' })
    changes.mockClear()
    src.ingest(ev('turn-start', { title: 'Math' }))
    expect(src.list()[0].name).toBe('Math')
    expect(changes).toHaveBeenCalled()
    src.ingest(ev('turn-stop', { cwd: '/x/other' }))
    expect(src.list()[0]).toMatchObject({ name: 'Math', cwd: '/x/other' })
    src.ingest(ev('turn-start', { cwd: undefined }))
    expect(src.list()[0].name).toBe('other')
  })

  it('a Claude turn-start with no title and a new folder reads that folder', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho' }))
    src.ingest(ev('turn-start', { cwd: '/x/third' }))
    expect(src.list()[0].name).toBe('third')
  })

  it('a Claude session-start with no title clears it too', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho' }))
    src.ingest(ev('session-start'))
    expect(src.list()[0].name).toBe('proj')
  })

  it('a session-start with a title renames a session the scan listed', async () => {
    const { src, open, owners, externals, ev } = setup()
    open.set('a', 'terminal')
    owners.set('a', { pid: 11, engine: 'claude' })
    externals.set('a', { cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' })
    await src.scanOpen()
    expect(src.list()[0].name).toBe('alpha')
    src.ingest(ev('session-start', { sessionId: 'a', callerPid: 11, cwd: '/x/alpha', title: 'Tho' }))
    expect(src.list()[0].name).toBe('Tho')
  })

  it('another engine\'s turn-start with no title keeps its title', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1', title: 'Tho' }))
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1' }))
    expect(src.list()[0].name).toBe('Tho')
  })

  it('needs-input, asked, turn-error and session-end leave the name', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho' }))
    src.ingest(ev('needs-input'))
    expect(src.list()[0].name).toBe('Tho')
    src.ingest({ engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/x/elsewhere' })
    expect(src.list()[0].name).toBe('Tho')
    src.ingest(ev('turn-error'))
    expect(src.list()[0].name).toBe('Tho')
    src.ingest(ev('session-end'))
    expect(src.list()[0].name).toBe('Tho')
  })

  it('with no folder known, a cleared title reads the engine', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { cwd: undefined, title: 'Tho' }))
    expect(src.list()[0].name).toBe('Tho')
    src.ingest(ev('turn-start', { cwd: undefined }))
    expect(src.list()[0].name).toBe('claude')
  })

  // Claude Code's compaction starts a session again in the middle of a turn.
  it('a session-start in the middle of a turn renames it and leaves it working', () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho' }))
    src.ingest(ev('session-start', { title: 'Math' }))
    expect(src.list()[0]).toMatchObject({ name: 'Math', state: 'working' })
  })

  it('a refusal names the agent by its title', async () => {
    const { src, ev } = setup()
    src.ingest(ev('turn-start', { title: 'Tho' }))
    expect(await src.send(src.list()[0], 'hi')).toEqual({ ok: false, reason: 'Tho did not answer.' })
  })

  it('no log line holds a title', () => {
    const { src, ev, logs } = setup()
    // Fifty working sessions fill the list: the fifty-first is dropped, and that is logged.
    for (let i = 0; i <= 50; i++) src.ingest(ev('turn-start', { sessionId: `s${i}`, title: `Name ${i}` }))
    src.ingest({ engine: 'claude', sessionId: 's0', event: 'asked', tool: 'Bash', summary: 'npm test' })
    expect(logs).not.toEqual([])
    expect(logs.join('\n')).not.toMatch(/Name \d/)
  })
})

describe('ObservedSource and the name in a session\'s own record', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** A session found open in a terminal, its owner `pid`, whose record path is not its id: the reader must be told both. */
  const found = (s: ReturnType<typeof setup>, sessionId: string, pid: number, engine = 'claude'): void => {
    s.open.set(sessionId, 'terminal')
    s.owners.set(sessionId, { pid, engine, record: `/s/${pid}.json` })
    s.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath: `/t/${sessionId}.jsonl` })
  }

  it('a Claude session the scan lists reads the name its record gives', async () => {
    const s = setup({ recordName: async () => 'Tho' })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ name: 'Tho', cwd: '/x/a' })
    expect(s.changes).toHaveBeenCalled()
  })

  it.each<[string, ObservedDeps['recordName']]>([
    ['gives none', async () => undefined],
    ['fails', async () => { throw new Error('EACCES /Users/someone/.claude/sessions/11.json') }],
  ])('a reader that %s still lists the session by its folder', async (_what, recordName) => {
    const s = setup({ recordName })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0].name).toBe('a')
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 ms'])
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  it('the reader is asked once, for the Claude sessions the scan is about to list', async () => {
    const recordName = vi.fn(async (_owner: unknown): Promise<string | undefined> => undefined)
    const s = setup({ recordName })
    found(s, 'a', 11)
    found(s, 'b', 12, 'codex')
    // No row: never listed.
    found(s, 'c', 13)
    s.externals.delete('c')
    // Harness's own pane.
    found(s, 'h', 14)
    s.open.set('h', 'harness')
    await s.src.scanOpen()
    found(s, 'd', 15)
    await s.src.scanOpen()
    await s.src.scanOpen()
    expect(recordName.mock.calls).toEqual([[{ pid: 11, record: '/s/11.json', sessionId: 'a' }], [{ pid: 15, record: '/s/15.json', sessionId: 'd' }]])
  })

  it('at most 50 are asked a look', async () => {
    const recordName = vi.fn(async (_owner: unknown): Promise<string | undefined> => undefined)
    const s = setup({ recordName })
    for (let i = 0; i < 51; i++) found(s, `s${i}`, 200 + i)
    await s.src.scanOpen()
    expect(recordName).toHaveBeenCalledTimes(50)
  })

  it.each<[Partial<ObservedHookEvent>, string]>([[{ title: 'Math' }, 'Math'], [{}, 'a']])(
    'a hook that came while the names were read keeps what it said (%j)', async (over, name) => {
      let answer: (recorded: string | undefined) => void = () => {}
      const recordName = vi.fn(() => new Promise<string | undefined>((resolve) => { answer = resolve }))
      const s = setup({ recordName })
      found(s, 'a', 11)
      const scan = s.src.scanOpen()
      await vi.waitFor(() => expect(recordName).toHaveBeenCalled())
      s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...over }))
      answer('Tho')
      await scan
      expect(s.src.list()).toHaveLength(1)
      expect(s.src.list()[0].name).toBe(name)
    })

  it('the record\'s name holds until a hook says otherwise', async () => {
    const s = setup({ recordName: async () => 'Tho' })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0].name).toBe('Tho')
    s.src.ingest(s.ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/moved' }))
    expect(s.src.list()[0]).toMatchObject({ name: 'Tho', cwd: '/x/moved' })
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/moved' }))
    expect(s.src.list()[0].name).toBe('moved')
    s.src.ingest(s.ev('session-start', { sessionId: 'a', callerPid: 11, cwd: '/x/moved', title: 'Math' }))
    expect(s.src.list()[0].name).toBe('Math')
  })

  it('the scan\'s line counts the named ones and holds no name', async () => {
    const s = setup({ recordName: async (owner) => (owner.pid === 11 ? 'Tho 7f3a91c2' : undefined) })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(s.logs).toEqual(['[observed] scan · 2 found · 0 app known · 1 named · 0 ms'])
  })

  it('with no reader the scan names by folder', async () => {
    const s = setup()
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0].name).toBe('a')
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 ms'])
  })
})

const HANDLE = 'term_0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'

/** What the tests answer for the source's routes: its own, and the Orca, Claude app, Codex app and tab verbs its adapters run. */
interface Fakes extends Omit<ObservedActions, 'adapters'> {
  orcaSend(handle: string, text: string): Promise<TypeResult>
  orcaSwitch(handle: string): Promise<PaneSwitch>
  herdrPrompt(pane: string, kind: string, text: string): Promise<HerdrPrompt>
  herdrStamp(): string | undefined
  claudeInFront(): boolean
  claudeShow(agentId: string, session: string): Promise<PaneSwitch>
  codexInFront(): boolean
  tabsOpen(): boolean
  tabSelect(app: TabApp, tty: string, raise: boolean): PaneSwitch
}

/** What each count says, as devices.ts logs it. */
const counted = (count: { mock: { calls: Array<Parameters<ObservedActions['count']>> } }): string[] =>
  count.mock.calls.map(([what]) => countWord(what))

/** Routes that answer as told, recording what each was handed. The adapters are the real ones for that platform, their
 *  verbs the fakes, and any command of their own goes to an inert runner. */
function fakeActions(over: Partial<Fakes> = {}, platform: NodeJS.Platform = 'darwin') {
  const ready = new Set<string>()
  const fakes = {
    modReady: vi.fn((sessionId: string) => ready.has(sessionId)),
    toMod: vi.fn(async (_sessionId: string, _text: string): Promise<Delivery> => 'taken'),
    orcaSend: vi.fn(async (_handle: string, _text: string): Promise<TypeResult> => true),
    orcaSwitch: vi.fn(async (_handle: string): Promise<PaneSwitch> => 'ok'),
    // herdr takes every prompt.
    herdrPrompt: vi.fn(async (_pane: string, _kind: string, _text: string): Promise<HerdrPrompt> => ({ outcome: 'sent' })),
    // herdr's socket is where the daemon looks.
    herdrStamp: vi.fn((): string | undefined => '1:1'),
    // As on macOS: an app or a pane is something a tap can open (open.ts).
    canOpen: vi.fn((target: OpenTarget) => !!target.bundle || !!target.pane),
    open: vi.fn(async (_agentId: string, _target: OpenTarget) => true),
    claudeInFront: vi.fn(() => true),
    claudeShow: vi.fn(async (_agentId: string, _session: string): Promise<PaneSwitch> => 'ok'),
    codexInFront: vi.fn(() => true),
    // A watch holds the tabs stream open, and takes each select.
    tabsOpen: vi.fn(() => true),
    tabSelect: vi.fn((_app: TabApp, _tty: string, _raise: boolean): PaneSwitch => 'ok'),
    // Codex is there, and queues every message.
    codexQueue: {
      can: vi.fn(() => true),
      send: vi.fn(async (_threadId: string, _text: string): Promise<CodexQueueResult> => ({ outcome: 'queued' })),
    },
    codexHome: '/home/u/.codex',
    count: vi.fn((_what: Parameters<ObservedActions['count']>[0]) => {}),
  }
  const fake = { ...fakes, ...over } as typeof fakes
  const ran = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ code: 0, stdout: '' }))
  const deps: OrcaDeps = { run: ran, onPath: (name) => `/fake/bin/${name}`, exists: () => false, platform }
  const orca = createOrcaAdapter(deps)
  const claude = createClaudeAppAdapter({ ...deps, inFront: () => fake.claudeInFront() })
  const adapters: HostAdapter[] = [
    createHerdrAdapter({ ...deps, client: {
      prompt: (pane, kind, text) => fake.herdrPrompt(pane, kind, text),
      socketStamp: () => fake.herdrStamp(),
    } }),
    createTmuxAdapter({ run: ran, processes: async () => [], log: () => {} }),
    createWeztermAdapter(deps),
    { ...orca, type: (pane, text) => fake.orcaSend(pane.id, text), show: (pane) => fake.orcaSwitch(pane.id) },
    { ...claude, show: (pane, agentId) => fake.claudeShow(agentId, pane.id) },
    createCodexAppAdapter({ ...deps, inFront: () => fake.codexInFront(), log: () => {} }),
    createVscodeAdapter(deps),
    createTabsAdapter({ isOpen: () => fake.tabsOpen(), select: (tab, raise) => fake.tabSelect(tab.app, tab.tty, raise) === 'ok' }),
  ]
  return { actions: { ...fake, adapters }, ready, ran }
}

describe('ObservedSource actions', () => {
  afterEach(() => { vi.useRealTimers() })
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

  // The other order: the scan skips a session a hook already listed, so it is one agent and keeps what its hook said.
  it('one Orca session its hook told of, then the open scan found, is listed once and keeps its Orca pane', async () => {
    const { actions } = fakeActions()
    const apps = vi.fn(async (_pids: readonly number[]) => new Map<number, string>())
    const { src, open, owners, externals, ev } = setup({ actions, apps })
    src.ingest(ev('session-start', withHandle))
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    expect(src.list()).toHaveLength(1)
    const agent = src.list()[0]
    expect(agent.host).toBe('orca')
    expect(agent.appPending).toBeUndefined()
    expect(apps).not.toHaveBeenCalled()
    expect(src.hasPane(agent)).toBe(true)
    expect(await src.showPane(agent)).toBe('ok')
    expect(actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
    expect(src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
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
    vi.useFakeTimers()
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const after = async (event: ObservedHookEvent['event'], text: string) => {
      src.ingest(ev(event, { engine, ...withHandle }))
      // A Stop is its turn's end once it waits out its grace.
      if (event === 'turn-stop') await graced()
      return src.send(src.list()[0], text)
    }
    expect(await after('session-start', 'one')).toEqual({ ok: true })
    expect(await after('turn-start', 'yes run it')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(await after('needs-input', '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(await after('turn-stop', 'two')).toEqual({ ok: true })
    src.ingest(ev('turn-start', { engine, ...withHandle }))
    expect(await after('turn-error', 'three')).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'one'], [HANDLE, 'two'], [HANDLE, 'three']])
    expect(counted(actions.count)).toEqual(['orca', 'busy', 'waiting', 'orca', 'orca'])
  })

  // No scan or transcript reads another engine's turn: it is at its prompt only once a hook said its turn ended.
  it('another engine is typed into only after a hook said its turn ended', async () => {
    vi.useFakeTimers()
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const busy = { ok: false, reason: 'proj is busy. Say it when it is done.' }
    const after = async (event: ObservedHookEvent['event'], text: string) => {
      src.ingest(ev(event, { engine: 'grok', ...withHandle }))
      if (event === 'turn-stop') await graced()
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
    expect(counted(actions.count)).toEqual(['busy', 'busy', 'waiting', 'orca', 'orca', 'busy', 'orca'])
  })

  // The scan lists another engine's agent idle though its turn may run: its first hook with a handle is no turn's end.
  it('another engine the scan found is busy until a hook said its turn ended', async () => {
    vi.useFakeTimers()
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
    await graced()
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

  // Every event names its pane afresh: the same terminal named again is the one the words were meant for.
  it('an event from the same pane while the mod is waited for does not cancel the words', async () => {
    let missed!: (delivery: Delivery) => void
    const { actions, ready } = fakeActions({ toMod: vi.fn(() => new Promise<Delivery>((resolve) => { missed = resolve })) })
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop', withHandle))
    const sent = src.send(src.list()[0], 'run the tests')
    src.ingest(ev('session-start', withHandle))
    missed('missed')
    expect(await sent).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'run the tests']])
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

  // An adapter's answer outside its type says nothing either: no refusal is read off it.
  it.each([undefined, null, 'typed', {}, { refused: 7 }])('an adapter that answers %j says did not answer', async (answer) => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async () => answer as unknown as TypeResult) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
  })

  // The app may know better than the hook: an agent its hook left idle can be in a turn, or asking, there.
  it('an adapter that says busy gives the busy sentence, counted busy', async () => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async (): Promise<TypeResult> => 'busy') })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(counted(actions.count)).toEqual(['busy'])
  })

  it('an adapter that says waiting gives the waiting sentence, counted waiting', async () => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async (): Promise<TypeResult> => 'waiting') })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj is waiting for your answer in Orca.' })
    expect(counted(actions.count)).toEqual(['waiting'])
  })

  // An object is truthy: it must not count as typed.
  it('an adapter\'s own sentence reaches the dial as it is, counted refused (orca)', async () => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async (): Promise<TypeResult> => ({ refused: 'Turn on Automation mode in cmux.' })) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'Turn on Automation mode in cmux.' })
    expect(counted(actions.count)).toEqual(['refused (orca)'])
  })

  it('after each of the three, the next turn\'s hook is a person\'s, not the dial\'s', async () => {
    for (const result of ['busy', 'waiting', { refused: 'Turn on Automation mode in cmux.' }] as const) {
      const { actions } = fakeActions({ orcaSend: vi.fn(async (): Promise<TypeResult> => result) })
      const { src, ev } = setup({ actions })
      src.ingest(ev('turn-stop', withHandle))
      expect((await src.send(src.list()[0], 'next')).ok).toBe(false)
      expect(src.ingest(ev('turn-start', withHandle))).toBe('person')
    }
  })

  it('countWord says a word as it is, an adapter by its id, and a refusal by its adapter\'s id', () => {
    const { actions } = fakeActions()
    const orca = actions.adapters.find((a) => a.id === 'orca')!
    expect(countWord('busy')).toBe('busy')
    expect(countWord('codex-failed (exit 1)')).toBe('codex-failed (exit 1)')
    expect(countWord(orca)).toBe('orca')
    expect(countWord({ refused: orca })).toBe('refused (orca)')
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

  // Each hook is a process of its own, and a subagent stopped as its lead exits still sends SubagentStop: one that comes
  // after the lead's SessionEnd is no resume.
  it.each(['subagent-start', 'subagent-stop'] as const)('%s after its lead\'s session-end does not bring it back', async (event) => {
    const { actions, ready } = fakeActions()
    const { src, clock, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start', withHandle))
    src.ingest(ev('subagent-start', withHandle))
    src.ingest(ev('session-end', withHandle))
    src.ingest(ev(event, withHandle))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toEqual({ status: true, voice: false, focus: false, answer: false })
    expect(await src.send(agent, 'git push --force')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.toMod).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
    clock.t += 10_000
    await src.tick()
    expect(src.list()).toEqual([])
  })

  it('focus opens what its last event names, as the agent\'s own, and is false when nothing can open it', async () => {
    const { actions } = fakeActions({ open: vi.fn(async () => false) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', ...withHandle }))
    src.ingest(ev('session-start', { sessionId: 'plain' }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(await src.focus(agent('orca'))).toBe(false)
    expect(actions.open).toHaveBeenCalledWith(agent('orca').id, { bundle: 'com.stablyai.orca', pane: { adapter: 'orca', id: HANDLE } })
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
    expect(counted(actions.count)).toEqual(['mod', 'orca', 'busy', 'waiting', 'too-long', 'no-answer'])
  })

  it('the pane a tap opens is its latest event\'s, with that event\'s process', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { callerPid: 100, hostHints: { TMUX_PANE: '%3' } }))
    src.ingest(ev('session-start', { callerPid: 200, hostHints: { TMUX_PANE: '%9' } }))
    expect(await src.focus(src.list()[0])).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { pane: { adapter: 'tmux', id: '%9:200' } }]])
  })

  it('a session in the VS Code extension\'s tab opens by its own session id', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const sessionId = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    src.ingest(ev('session-start', { sessionId, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    expect(await src.focus(src.list()[0])).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { bundle: 'com.microsoft.VSCode', pane: { adapter: 'vscode', id: sessionId } }]])
  })

  it('a Codex session started from the extension\'s tab is not opened by Claude Code\'s link', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { engine: 'codex', sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    expect(await src.focus(src.list()[0])).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { bundle: 'com.microsoft.VSCode' }]])
  })
})

const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const FAILED: CodexQueueResult = { outcome: 'failed', reason: 'exit 1' }

// Codex outside Harness takes the dial's words through its own queue, in every state: a queued message types nothing and
// answers no approval (docs/specs/2026-11-15-device-codex.md).
describe('ObservedSource and codex queue', () => {
  const cx = {
    engine: 'codex' as const, sessionId: THREAD, hostHints: { TERM_PROGRAM: 'ghostty' },
    transcriptPath: `/home/u/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl`,
  }
  const inOrca = { ...cx, hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }
  const HOOKS: Record<'idle' | 'working' | 'needs-you', ObservedHookEvent['event'][]> = {
    idle: ['session-start'], working: ['turn-start'], 'needs-you': ['turn-start', 'needs-input'],
  }
  /** The routes as the fakes answer, and the session in that state, told by its hooks. */
  const given = (session: Partial<ObservedHookEvent>, state: keyof typeof HOOKS = 'idle') => {
    const { actions } = fakeActions()
    const t = setup({ actions })
    for (const event of HOOKS[state]) t.src.ingest(t.ev(event, session))
    return { ...t, actions }
  }
  /** Its queue's run, held until the test ends it. */
  const held = (actions: ReturnType<typeof fakeActions>['actions']) => {
    let end!: (result: CodexQueueResult) => void
    actions.codexQueue.send.mockImplementation(() => new Promise<CodexQueueResult>((resolve) => { end = resolve }))
    return (result: CodexQueueResult) => end(result)
  }

  it('a queue-able Codex session in Ghostty lists voice, with no handle and no mod', () => {
    const { src } = given(cx)
    expect(src.capabilities(src.list()[0])).toEqual({ status: true, voice: true, focus: true, answer: false })
  })

  it('not queue-able: each lists no voice, and its words never reach the queue', async () => {
    const cases: Array<{ session: Partial<ObservedHookEvent>; ended?: boolean; can?: boolean }> = [
      { session: { ...cx, engine: 'claude' } },
      { session: cx, ended: true },
      // No hook named its transcript yet.
      { session: { ...cx, transcriptPath: undefined } },
      // Another Codex home's: `codex queue` would load that home's config.
      { session: { ...cx, transcriptPath: `/other/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl` } },
      { session: { ...cx, transcriptPath: '/home/u/.codex/sessions/../../x/rollout.jsonl' } },
      { session: { ...cx, transcriptPath: '/home/u/.codex/sessions-old/rollout.jsonl' } },
      // `--thread` takes a session's name too: only a thread id may reach it.
      { session: { ...cx, sessionId: 'cx' } },
      { session: { ...cx, sessionId: THREAD.toUpperCase() } },
      { session: cx, can: false },
    ]
    for (const { session, ended, can } of cases) {
      const { src, ev, actions } = given(session)
      if (ended) src.ingest(ev('session-end', session))
      if (can === false) actions.codexQueue.can.mockReturnValue(false)
      expect(src.capabilities(src.list()[0]).voice).toBe(false)
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.codexQueue.send).not.toHaveBeenCalled()
    }
  })

  // Asked each time, it looks for the binary: never for a session the cheaper checks already turned away.
  it('can() is asked last', async () => {
    for (const session of [{ ...cx, engine: 'claude' as const }, { ...cx, transcriptPath: '/other/.codex/sessions/rollout.jsonl' }]) {
      const { src, actions } = given(session)
      src.capabilities(src.list()[0])
      await src.send(src.list()[0], 'next')
      expect(actions.codexQueue.can).not.toHaveBeenCalled()
    }
  })

  it('idle, working and needs-you: the words go to the queue and nothing is typed', async () => {
    for (const session of [cx, inOrca]) {
      for (const state of ['idle', 'working', 'needs-you'] as const) {
        const { src, actions } = given(session, state)
        expect(src.list()[0].state).toBe(state)
        expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
        expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next']])
        expect(actions.orcaSend).not.toHaveBeenCalled()
        expect(actions.toMod).not.toHaveBeenCalled()
        expect(actions.count.mock.calls).toEqual([['codex']])
      }
    }
  })

  it('failed falls back to Orca only when idle at a handle, with today\'s sentences', async () => {
    const cases: Array<[Partial<ObservedHookEvent>, keyof typeof HOOKS, object, string]> = [
      [inOrca, 'idle', { ok: true }, 'orca'],
      [inOrca, 'working', { ok: false, reason: 'proj is busy. Say it when it is done.' }, 'busy'],
      [inOrca, 'needs-you', { ok: false, reason: 'proj is waiting for your answer in Orca.' }, 'waiting'],
      [cx, 'idle', { ok: false, reason: 'proj did not answer.' }, 'no-answer'],
    ]
    for (const [session, state, sent, said] of cases) {
      const { src, actions } = given(session, state)
      actions.codexQueue.send.mockResolvedValue(FAILED)
      expect(await src.send(src.list()[0], 'next')).toEqual(sent)
      expect(actions.orcaSend.mock.calls).toEqual(said === 'orca' ? [[HANDLE, 'next']] : [])
      expect(counted(actions.count)).toEqual(['codex-failed (exit 1)', said])
    }
  })

  // Zellij, herdr, Rex and tmux started in an Orca terminal pass its handle to their panes: typed there, the words would
  // land in whichever pane the multiplexer shows. herdr's own socket, there in these fakes, types into the agent's own
  // pane instead (herdr.ts).
  it('in Zellij, herdr, Rex or tmux inside Orca, an idle agent with no mod and a Codex whose queue failed are not typed into through Orca', async () => {
    for (const hints of [{ ZELLIJ: '0' }, { HERDR_PANE_ID: 'w1:p2' }, { REX_BLOCK: 'x' }, { TMUX_PANE: '%3' }] as Record<string, string>[]) {
      const herdrSocket = 'HERDR_PANE_ID' in hints
      for (const engine of ['claude', 'codex'] as const) {
        const { src, actions } = given({ ...inOrca, engine, hostHints: { ...inOrca.hostHints, ...hints } })
        actions.codexQueue.send.mockResolvedValue(FAILED)
        expect(await src.send(src.list()[0], 'next')).toEqual(herdrSocket ? { ok: true } : { ok: false, reason: 'proj did not answer.' })
        expect(actions.herdrPrompt.mock.calls).toEqual(herdrSocket ? [['w1:p2', engine, 'next']] : [])
        expect(actions.orcaSend).not.toHaveBeenCalled()
        expect(counted(actions.count)).toEqual([...(engine === 'codex' ? ['codex-failed (exit 1)'] : []), herdrSocket ? 'herdr' : 'no-answer'])
      }
    }
  })

  it('a failure is counted with its reason', async () => {
    for (const reason of ['no binary', 'refused'] as const) {
      const { src, actions } = given(cx)
      actions.codexQueue.send.mockResolvedValue({ outcome: 'failed', reason })
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.count.mock.calls).toEqual([[`codex-failed (${reason})`], ['no-answer']])
    }
  })

  // The message may be in the queue: typed too, it would run twice.
  it('timeout never types', async () => {
    const { src, actions } = given(inOrca)
    actions.codexQueue.send.mockResolvedValue({ outcome: 'timeout' })
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count.mock.calls).toEqual([['codex-timeout']])
  })

  it('busy says the last words are not taken yet, and types nothing', async () => {
    const { src, actions } = given(inOrca)
    actions.codexQueue.send.mockResolvedValue({ outcome: 'busy' })
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj has not taken your last words yet.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.count.mock.calls).toEqual([['pending']])
  })

  it('a session that ended, or moved to another terminal, while the queue ran is not typed into', async () => {
    const other = 'term_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    for (const meanwhile of [
      { event: 'session-end', session: inOrca },
      { event: 'session-start', session: { ...inOrca, hostHints: { ORCA_TERMINAL_HANDLE: other } } },
    ] as const) {
      const { src, ev, actions } = given(inOrca)
      const end = held(actions)
      const sent = src.send(src.list()[0], 'next')
      expect(actions.codexQueue.send).toHaveBeenCalledTimes(1)
      src.ingest(ev(meanwhile.event, meanwhile.session))
      end(FAILED)
      expect(await sent).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.orcaSend).not.toHaveBeenCalled()
    }
  })

  // Its message waits in the thread's queue for its next resume.
  it('a session that ends while codex queue runs is still answered sent once it queued', async () => {
    const { src, ev, actions } = given(cx)
    const end = held(actions)
    const sent = src.send(src.list()[0], 'next')
    expect(actions.codexQueue.send).toHaveBeenCalledTimes(1)
    src.ingest(ev('session-end', cx))
    end({ outcome: 'queued' })
    expect(await sent).toEqual({ ok: true })
    expect(actions.count.mock.calls).toEqual([['codex']])
  })

  // An idle Codex starts the queued turn within 0.4 s, while `codex queue` may still run.
  it('the turn that starts while codex queue still runs is the dial\'s', async () => {
    const { src, ev, actions } = given(cx)
    const end = held(actions)
    const sent = src.send(src.list()[0], 'next')
    expect(actions.codexQueue.send).toHaveBeenCalledTimes(1)
    expect(src.ingest(ev('turn-start', cx))).toBe('dial')
    end({ outcome: 'queued' })
    expect(await sent).toEqual({ ok: true })
    expect(src.ingest(ev('turn-start', cx))).toBe('person')
  })

  it('after queued the next turn is the dial\'s; after failed, timeout or busy it is a person\'s', async () => {
    const cases: Array<[CodexQueueResult, PromptSource]> = [
      [{ outcome: 'queued' }, 'dial'], [FAILED, 'person'], [{ outcome: 'timeout' }, 'person'], [{ outcome: 'busy' }, 'person'],
    ]
    for (const [result, turn] of cases) {
      const { src, ev, actions } = given(cx)
      actions.codexQueue.send.mockResolvedValue(result)
      await src.send(src.list()[0], 'next')
      expect(src.ingest(ev('turn-start', cx))).toBe(turn)
    }
  })

  it('a Codex session the open scan found takes voice before its first hook', async () => {
    const { actions } = fakeActions()
    const { src, open, owners, externals } = setup({ actions })
    open.set(THREAD, 'terminal')
    owners.set(THREAD, { pid: 100, engine: 'codex' })
    externals.set(THREAD, { cwd: '/work/proj', transcriptPath: cx.transcriptPath })
    await src.scanOpen()
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true })
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
    expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next']])
  })

  it('a text over 2000 characters is refused before the queue', async () => {
    const { src, actions } = given(cx)
    expect(await src.send(src.list()[0], 'a'.repeat(2001))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
    expect(actions.codexQueue.send).not.toHaveBeenCalled()
  })
})

// The Codex app's chat opens by its thread's link, a hook's session and a scanned one alike, and its words still go
// through codex queue (docs/specs/2026-11-15-device-host-adapter.md).
describe('ObservedSource and the Codex app', () => {
  const rollout = `/home/u/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl`
  const inApp = { engine: 'codex' as const, sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }
  const pane = { adapter: 'codex', id: THREAD }
  /** A session a hook told of. */
  const hooked = (session: Partial<ObservedHookEvent> = inApp, platform: NodeJS.Platform = 'darwin') => {
    const { actions, ran } = fakeActions({}, platform)
    const t = setup({ actions })
    t.src.ingest(t.ev('session-start', session))
    return { ...t, actions, ran }
  }
  /** A session only the open scan found, under the app `apps` names for its pid. */
  const scanned = async (apps: ReadonlyMap<number, string> = new Map([[100, 'codex']])) => {
    const { actions, ran } = fakeActions()
    const t = setup({ actions, apps: async () => apps })
    t.open.set(THREAD, 'terminal')
    t.owners.set(THREAD, { pid: 100, engine: 'codex' })
    t.externals.set(THREAD, { cwd: '/work/proj', transcriptPath: rollout })
    await t.src.scanOpen()
    return { ...t, actions, ran }
  }

  it('a Codex app session a hook told of is on the Codex page, and a tap takes its thread\'s pane and its app', async () => {
    const { src, actions } = hooked()
    const agent = src.list()[0]
    expect(agent).toMatchObject({ app: 'codex', host: 'codex' })
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.openai.codex', pane }]])
  })

  it('one only the scan found has its thread\'s pane before any hook, and no bundle', async () => {
    const { src, actions } = await scanned()
    const agent = src.list()[0]
    expect(agent).toMatchObject({ app: 'codex', host: 'terminal' })
    expect(agent).not.toHaveProperty('appPending')
    expect(src.capabilities(agent)).toMatchObject({ focus: true })
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { pane }]])
    expect(actions.open.mock.calls[0][1]).not.toHaveProperty('bundle')
  })

  it('a rest shows it in the app only while the app is in front', async () => {
    const { src, actions, ran } = hooked()
    const agent = src.list()[0]
    expect(src.hasPane(agent)).toBe(true)
    expect(await src.showPane(agent)).toBe('ok')
    expect(ran.mock.calls).toEqual([['/usr/bin/open', ['-b', 'com.openai.codex', 'codex://threads/' + THREAD], 10_000]])
    actions.codexInFront.mockReturnValue(false)
    expect(src.hasPane(agent)).toBe(false)
    expect(await src.showPane(agent)).toBe('failed')
    expect(ran).toHaveBeenCalledTimes(1)

    const linux = hooked(inApp, 'linux')
    expect(linux.src.hasPane(linux.src.list()[0])).toBe(false)
  })

  it('the dial\'s words still go through codex queue, a hook\'s session and a scanned one alike', async () => {
    for (const { src, actions, ran } of [hooked({ ...inApp, transcriptPath: rollout }), await scanned()]) {
      const agent = src.list()[0]
      expect(src.capabilities(agent)).toMatchObject({ voice: true })
      expect(await src.send(agent, 'next')).toEqual({ ok: true })
      expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next']])
      expect(counted(actions.count).at(-1)).toBe('codex')
      expect(ran).not.toHaveBeenCalled()
    }
  })

  it('a Codex session in Ghostty has no Codex pane', async () => {
    const { src, actions } = hooked({ ...inApp, hostHints: { TERM_PROGRAM: 'ghostty' } })
    const agent = src.list()[0]
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty' }]])
    expect(src.hasPane(agent)).toBe(false)
  })

  it('a scanned Codex session whose app is not known yet has no pane', async () => {
    const { src } = await scanned(new Map())
    expect(src.capabilities(src.list()[0])).toMatchObject({ focus: false })
  })

  it('a Claude Code session under the Codex app has no Codex pane', async () => {
    const { src, actions } = hooked({ ...inApp, engine: 'claude' })
    const agent = src.list()[0]
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.openai.codex' }]])
  })

  it('the pane is the latest event\'s', async () => {
    const { src, ev, actions } = hooked()
    src.ingest(ev('turn-start', { ...inApp, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(src.hasPane(agent)).toBe(false)
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty' }]])
  })
})

// The Codex app's own Codex runs hooks whose hints name no listed app (Diego's first try, 2026-11-16).
describe('ObservedSource and the app a hook\'s caller runs in', () => {
  const inApp = { engine: 'codex' as const, sessionId: THREAD }

  /** A source whose walks of a process's parents the test answers by hand, in the order they began. */
  function walked() {
    const walks: Array<{ answer(app?: string): Promise<void>; fail(): Promise<void> }> = []
    const apps = vi.fn((pids: readonly number[]) => new Promise<ReadonlyMap<number, string>>((resolve, reject) => {
      walks.push({
        answer: (app) => { resolve(new Map(app ? pids.map((pid) => [pid, app]) : [])); return flushed() },
        fail: () => { reject(new Error('ps timed out under /Users/someone')); return flushed() },
      })
    }))
    const { actions } = fakeActions()
    const s = setup({ actions, apps })
    const agent = (sessionId: string = THREAD) => s.src.list().find((a) => a.sessionId === sessionId)!
    return { ...s, apps, walks, agent }
  }

  /** Codex sessions the open scan found, each under its owner's pid, whose parents name the Codex app. */
  async function scanned(s: ReturnType<typeof walked>, sessions: ReadonlyArray<readonly [string, number]>): Promise<void> {
    for (const [sessionId, pid] of sessions) {
      s.open.set(sessionId, 'terminal')
      s.owners.set(sessionId, { pid, engine: 'codex' })
      s.externals.set(sessionId, { cwd: '/work/proj', transcriptPath: null })
    }
    const scan = s.src.scanOpen()
    await flushed()
    await s.walks[0].answer('codex')
    await scan
  }

  it('a scanned Codex app session stays on the Codex page through a hook that names no app, and keeps its pane', async () => {
    const s = walked()
    await scanned(s, [[THREAD, 100]])
    expect(s.agent()).toMatchObject({ app: 'codex' })
    const apps: string[] = []
    s.src.onChange(() => { apps.push(s.agent().app) })
    s.src.ingest(s.ev('turn-start', inApp))
    expect(s.agent()).toMatchObject({ app: 'codex', host: 'terminal' })
    expect(s.src.hasPane(s.agent())).toBe(true)
    expect(s.apps.mock.calls).toEqual([[[100]], [[100]]])
    await s.walks[1].answer('codex')
    expect(apps).toEqual(['codex', 'codex'])
    expect(s.agent()).toMatchObject({ app: 'codex', host: 'terminal' })
    expect(s.src.hasPane(s.agent())).toBe(true)
  })

  it('a session a hook told of first is on the unknown app\'s page until its caller\'s parents name the Codex app', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', inApp))
    expect(s.agent()).toMatchObject({ app: 'terminal', host: 'terminal' })
    expect(s.src.hasPane(s.agent())).toBe(false)
    s.changes.mockClear()
    await s.walks[0].answer('codex')
    expect(s.agent()).toMatchObject({ app: 'codex', host: 'terminal' })
    expect(s.src.hasPane(s.agent())).toBe(true)
    expect(s.changes).toHaveBeenCalledTimes(1)
  })

  it('one walk per caller: its next hooks, during the walk and after, walk nothing and take the app learnt at once', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', inApp))
    s.src.ingest(s.ev('turn-start', inApp))
    expect(s.apps).toHaveBeenCalledTimes(1)
    await s.walks[0].answer('codex')
    s.src.ingest(s.ev('needs-input', inApp))
    s.src.ingest(s.ev('turn-start', inApp))
    expect(s.agent().app).toBe('codex')
    expect(s.apps).toHaveBeenCalledTimes(1)
  })

  it('a walk that names no listed app, or fails, leaves the unknown app, and logs no error text', async () => {
    const s = walked()
    await scanned(s, [['a', 101], ['b', 102]])
    s.src.ingest(s.ev('turn-start', { engine: 'codex', sessionId: 'a', callerPid: 101 }))
    s.src.ingest(s.ev('turn-start', { engine: 'codex', sessionId: 'b', callerPid: 102 }))
    // Until a walk answers, each keeps the app the scan named.
    expect([s.agent('a').app, s.agent('b').app]).toEqual(['codex', 'codex'])
    await s.walks[1].answer()
    await s.walks[2].fail()
    expect([s.agent('a').app, s.agent('b').app]).toEqual(['terminal', 'terminal'])
    expect(s.logs).toContain('[observed] app · not read')
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  it('a hook whose hints name an app walks nothing', () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { ...inApp, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }))
    s.src.ingest(s.ev('session-start', { sessionId: 'g', callerPid: 101, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect([s.agent().app, s.agent('g').app]).toEqual(['codex', 'ghostty'])
    expect(s.apps).not.toHaveBeenCalled()
  })

  it('an answer for a caller the session has left is dropped, and its latest caller is walked next', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { ...inApp, callerPid: 100 }))
    // Resumed in another process while the first walk runs: one walk at a time.
    s.src.ingest(s.ev('session-start', { ...inApp, callerPid: 200 }))
    expect(s.apps.mock.calls).toEqual([[[100]]])
    await s.walks[0].answer('codex')
    expect(s.agent().app).toBe('terminal')
    expect(s.apps.mock.calls).toEqual([[[100]], [[200]]])
    await s.walks[1].answer('vscode')
    expect(s.agent().app).toBe('vscode')
  })

  it('an answer for a session no longer listed is dropped: nothing is told, and its latest caller is not walked', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { ...inApp, cwd: undefined, callerPid: 100 }))
    s.src.ingest(s.ev('turn-start', { ...inApp, cwd: undefined, callerPid: 200 }))
    // Its folder, once known, is Harness's own: it goes.
    s.src.ingest(s.ev('turn-start', { ...inApp, cwd: '/data/harness/router', callerPid: 200 }))
    expect(s.src.list()).toEqual([])
    s.changes.mockClear()
    await s.walks[0].answer('codex')
    expect(s.apps.mock.calls).toEqual([[[100]]])
    expect(s.changes).not.toHaveBeenCalled()
  })

  it('an answer for a session that ended is kept for its caller, and lands only when it comes back', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', inApp))
    s.src.ingest(s.ev('session-end', inApp))
    s.changes.mockClear()
    await s.walks[0].answer('codex')
    expect(s.agent().app).toBe('terminal')
    expect(s.changes).not.toHaveBeenCalled()
    s.src.ingest(s.ev('session-start', inApp))
    expect(s.agent().app).toBe('codex')
    expect(s.apps).toHaveBeenCalledTimes(1)
  })

  it('a caller whose parents name a tab app has its tty read then, and its tab is its pane', async () => {
    const tty = vi.fn(async (_pid: number): Promise<string | undefined> => '/dev/ttys023')
    let answer!: (apps: ReadonlyMap<number, string>) => void
    const apps = vi.fn((_pids: readonly number[]) => new Promise<ReadonlyMap<number, string>>((resolve) => { answer = resolve }))
    const { actions } = fakeActions()
    const s = setup({ actions, apps, tty })
    s.src.ingest(s.ev('session-start', inApp))
    expect(tty).not.toHaveBeenCalled()
    answer(new Map([[100, 'iterm']]))
    await flushed()
    const agent = s.src.list()[0]
    expect(agent.app).toBe('iterm')
    expect(tty.mock.calls).toEqual([[100]])
    expect(s.src.hasPane(agent)).toBe(true)
  })
})

describe('ObservedSource panes', () => {
  const OTHER = 'term_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
  const inOrca = (handle = HANDLE) => ({ hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: handle } })

  it('hasPane: an agent in an Orca terminal, while its session lives', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', ...inOrca() }))
    src.ingest(ev('session-start', { sessionId: 'wez', hostHints: { WEZTERM_PANE: '3' } }))
    src.ingest(ev('session-start', { sessionId: 'herdr', hostHints: { HERDR_PANE_ID: 'p1' } }))
    src.ingest(ev('session-start', { sessionId: 'app', hostHints: { __CFBundleIdentifier: 'com.anthropic.claudefordesktop' } }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(src.hasPane(agent('orca'))).toBe(true)
    expect(src.hasPane(agent('wez'))).toBe(false)
    expect(src.hasPane(agent('herdr'))).toBe(false)
    expect(src.hasPane(agent('app'))).toBe(false)
    src.ingest(ev('session-end', { sessionId: 'orca', ...inOrca() }))
    expect(src.hasPane(agent('orca'))).toBe(false)

    const bare = setup()
    bare.src.ingest(bare.ev('session-start', inOrca()))
    expect(bare.src.hasPane(bare.src.list()[0])).toBe(false)
  })

  it('showPane switches Orca to the terminal and answers what Orca said', async () => {
    for (const said of ['ok', 'failed', 'busy'] as const) {
      const { actions } = fakeActions({ orcaSwitch: vi.fn(async () => said) })
      const { src, ev } = setup({ actions })
      src.ingest(ev('turn-start', inOrca()))
      expect(await src.showPane(src.list()[0])).toBe(said)
      expect(actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
      expect(actions.open).not.toHaveBeenCalled()
    }
  })

  it('the handle is the latest event\'s', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    // Resumed in another Orca terminal: the old one holds something else now.
    src.ingest(ev('turn-start', inOrca(OTHER)))
    const agent = src.list()[0]
    expect(await src.showPane(agent)).toBe('ok')
    expect(actions.orcaSwitch.mock.calls).toEqual([[OTHER]])
    actions.orcaSwitch.mockClear()

    // Its next event carries no handle: it runs elsewhere now.
    src.ingest(ev('turn-stop', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(await src.showPane(agent)).toBe('failed')
    src.ingest(ev('turn-start', inOrca()))
    src.ingest(ev('session-end', inOrca()))
    expect(await src.showPane(agent)).toBe('failed')
    // One the source never listed.
    expect(await src.showPane({ ...agent, id: 'gone' })).toBe('failed')
    expect(actions.orcaSwitch).not.toHaveBeenCalled()
    expect(actions.open).not.toHaveBeenCalled()
  })

  // WezTerm's pane is the nearer for a tap, and Orca's terminal still takes the words and the rest.
  it.each([
    ['WezTerm', { WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE }, '7'],
  ])('%s inside an Orca terminal still takes the dial\'s words and a rest through Orca', async (_, hostHints, tapped) => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', { hostHints }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
    expect(await src.send(agent, 'next')).toEqual({ ok: true })
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'next']])
    expect(counted(actions.count).at(-1)).toBe('orca')
    expect(src.hasPane(agent)).toBe(true)
    expect(await src.showPane(agent)).toBe('ok')
    expect(actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.open.mock.calls[0][1].pane?.id).toBe(tapped)
  })

  // A multiplexer started in an Orca terminal passes that terminal's handle, and its tty, to every pane: typed through
  // Orca, the dial's words land in whichever pane it shows, another agent's or a shell's (PM, 2026-11-15). herdr's own
  // socket, there in these fakes, types into the agent's own pane instead (herdr.ts).
  it.each([
    ['herdr', { HERDR_PANE_ID: 'w1:p2' }, true],
    ['Rex', { REX_BLOCK: 'x' }, false],
    ['Zellij', { ZELLIJ: '0' }, false],
    ['tmux', { TMUX_PANE: '%3' }, false],
  ])('%s inside an Orca terminal takes no words and no rest through Orca', async (_name, hints, herdrSocket) => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', { hostHints: { ...hints, ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE, __CFBundleIdentifier: 'com.stablyai.orca' } }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: herdrSocket, focus: true })
    expect(src.hasPane(agent)).toBe(false)
    expect(await src.showPane(agent)).toBe('failed')
    expect(await src.send(agent, 'next')).toEqual(herdrSocket ? { ok: true } : { ok: false, reason: 'proj did not answer.' })
    expect(actions.herdrPrompt.mock.calls).toEqual(herdrSocket ? [['w1:p2', 'claude', 'next']] : [])
    // Its voice is its mod's.
    ready.add('s1')
    expect(src.capabilities(agent)).toMatchObject({ voice: true })
    expect(await src.send(agent, 'next')).toEqual({ ok: true })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.orcaSwitch).not.toHaveBeenCalled()
    // A tap: Orca comes forward, and never by its terminal's handle (open question 1).
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open.mock.calls[0][1].bundle).toBe('com.stablyai.orca')
    expect(actions.open.mock.calls[0][1].pane?.adapter).not.toBe('orca')
  })

  // Orca types into whichever pane herdr has in front, so a multiplexer's agent has no Orca pane (orca.ts): herdr's socket
  // types into the agent's own pane, and a rest has nothing to show.
  it('herdr inside an Orca terminal takes the dial\'s words through herdr, and no rest through Orca', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', { hostHints: { HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: HANDLE } }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
    expect(await src.send(agent, 'next')).toEqual({ ok: true })
    expect(actions.herdrPrompt.mock.calls).toEqual([['w1:p2', 'claude', 'next']])
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(counted(actions.count).at(-1)).toBe('herdr')
    expect(src.hasPane(agent)).toBe(false)
    expect(await src.showPane(agent)).toBe('failed')
    expect(actions.orcaSwitch).not.toHaveBeenCalled()
    expect(await src.focus(agent)).toBe(true)
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.open.mock.calls[0][1].pane?.id).toBe('w1:p2')
  })

  // A daemon started by launchd or systemd may not have the shell's XDG_CONFIG_HOME, and so finds no herdr socket: herdr
  // then lists no voice, inside an Orca terminal too, where Orca's terminal is no pane of a multiplexer's agent (orca.ts).
  it('with no herdr socket, an agent in a herdr pane takes no words, inside an Orca terminal or not', async () => {
    const { actions } = fakeActions({ herdrStamp: vi.fn(() => undefined) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', { sessionId: 'in-orca', hostHints: { HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: HANDLE } }))
    src.ingest(ev('turn-stop', { sessionId: 'in-ghostty', hostHints: { HERDR_PANE_ID: 'w1:p3', __CFBundleIdentifier: 'com.mitchellh.ghostty' } }))
    for (const sessionId of ['in-orca', 'in-ghostty']) {
      const agent = src.list().find((a) => a.sessionId === sessionId)!
      expect(src.capabilities(agent), sessionId).toMatchObject({ voice: false, focus: true })
      expect(await src.send(agent, 'next'), sessionId).toEqual({ ok: false, reason: 'proj did not answer.' })
    }
    expect(actions.herdrPrompt).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(counted(actions.count)).toEqual(['no-answer', 'no-answer'])
  })

  // herdr types into a working agent as readily as an idle one: the source's idle rules decide, as for Orca.
  it('a hooked agent in a herdr pane lists voice, and takes words only at its prompt', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const hostHints = { HERDR_PANE_ID: 'w1:p2' }
    src.ingest(ev('turn-stop', { hostHints }))
    expect(src.capabilities(src.list()[0])).toEqual({ status: true, voice: true, focus: true, answer: false })
    expect(await src.send(src.list()[0], 'one')).toEqual({ ok: true })
    src.ingest(ev('turn-start', { hostHints }))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    src.ingest(ev('needs-input', { hostHints }))
    expect(await src.send(src.list()[0], '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in herdr.' })
    expect(actions.herdrPrompt.mock.calls).toEqual([['w1:p2', 'claude', 'one']])
    expect(counted(actions.count)).toEqual(['herdr', 'busy', 'waiting'])
  })

  it('a prompt herdr did not take is no answer, and its turn is a person\'s', async () => {
    for (const answer of [{ outcome: 'busy' }, { outcome: 'failed', fault: 'rejected', code: 'agent_not_ready' }] as HerdrPrompt[]) {
      const { actions } = fakeActions({ herdrPrompt: vi.fn(async () => answer) })
      const { src, ev } = setup({ actions })
      const hostHints = { HERDR_PANE_ID: 'w1:p2' }
      src.ingest(ev('turn-stop', { hostHints }))
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.herdrPrompt.mock.calls).toEqual([['w1:p2', 'claude', 'next']])
      expect(counted(actions.count)).toEqual(['no-answer'])
      expect(src.ingest(ev('turn-start', { hostHints }))).toBe('person')
    }
  })

  // The key a listing source knows the same pane by (registry.ts): an ended session's pane holds something else now.
  it('a live agent in a herdr pane carries its pane key', async () => {
    const { actions } = fakeActions()
    const { src, ev, open, owners, externals } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'herdr', hostHints: { HERDR_PANE_ID: 'w1:p2' } }))
    src.ingest(ev('session-start', { sessionId: 'ended', hostHints: { HERDR_PANE_ID: 'w1:p3' } }))
    src.ingest(ev('session-end', { sessionId: 'ended', hostHints: { HERDR_PANE_ID: 'w1:p3' } }))
    src.ingest(ev('session-start', { sessionId: 'orca', ...inOrca() }))
    open.set('found', 'terminal')
    owners.set('found', { pid: 200, engine: 'claude' })
    externals.set('found', { cwd: '/work/proj', transcriptPath: '/t/found.jsonl' })
    await src.scanOpen()
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(agent('herdr').paneKeys).toEqual(['herdr:w1:p2'])
    for (const sessionId of ['ended', 'orca', 'found']) expect(agent(sessionId), sessionId).not.toHaveProperty('paneKeys')
  })

  // A wave 1 app is one adapter: the source asks it as it asks the others, and what it cannot do the next pane does.
  it('an app the source never heard of costs one adapter, and what it cannot do falls to the next pane', async () => {
    const PANE: Pane = { adapter: 'made-up', id: 'p1' }
    const madeUp = () => ({
      id: 'made-up',
      tap: 'before' as const,
      paneOf: vi.fn((place: Place) => (place.hints.MADE_UP === 'p1' ? PANE : undefined)),
      canFocus: vi.fn((_pane: Pane) => true),
      focus: vi.fn(async (_pane: Pane) => true),
      canShow: vi.fn((_pane: Pane) => true),
      show: vi.fn(async (_pane: Pane, _agentId: string): Promise<PaneSwitch> => 'busy'),
      type: vi.fn(async (_pane: Pane, _text: string) => true),
    })
    /** A source that asks this adapter first, its agent after a turn-stop with these hints. */
    const first = (adapter: HostAdapter, hostHints: Record<string, string>, over: Partial<Fakes> = {}) => {
      const { actions } = fakeActions(over)
      const t = setup({ actions: { ...actions, adapters: [adapter, ...actions.adapters] } })
      t.src.ingest(t.ev('turn-stop', { hostHints }))
      return { src: t.src, actions, agent: t.src.list()[0] }
    }
    const both = { MADE_UP: 'p1', ORCA_TERMINAL_HANDLE: HANDLE }

    const adapter = madeUp()
    const a = first(adapter, both)
    expect(adapter.paneOf).toHaveBeenLastCalledWith({ host: 'terminal', app: 'terminal', hints: both, pid: 100, sessionId: 's1', engine: 'claude' })
    expect(a.src.capabilities(a.agent)).toMatchObject({ voice: true })
    expect(await a.src.send(a.agent, 'next')).toEqual({ ok: true })
    expect(adapter.type.mock.calls).toEqual([[PANE, 'next', 'claude']])
    expect(counted(a.actions.count).at(-1)).toBe('made-up')
    expect(a.actions.orcaSend).not.toHaveBeenCalled()
    expect(await a.src.showPane(a.agent)).toBe('busy')
    expect(adapter.show.mock.calls).toEqual([[PANE, a.agent.id]])
    expect(a.actions.orcaSwitch).not.toHaveBeenCalled()
    // It cannot show its pane now: Orca's terminal is shown.
    adapter.canShow.mockReturnValue(false)
    expect(a.src.hasPane(a.agent)).toBe(true)
    expect(await a.src.showPane(a.agent)).toBe('ok')
    expect(a.actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
    expect(adapter.show).toHaveBeenCalledTimes(1)

    // It types nothing: Orca's terminal takes the words.
    const mute = first({ ...madeUp(), type: undefined }, both)
    expect(mute.src.capabilities(mute.agent)).toMatchObject({ voice: true })
    expect(await mute.src.send(mute.agent, 'next')).toEqual({ ok: true })
    expect(mute.actions.orcaSend.mock.calls).toEqual([[HANDLE, 'next']])
    expect(counted(mute.actions.count).at(-1)).toBe('orca')

    // Its pane alone: nothing is left to fall to.
    const hidden = madeUp()
    hidden.canShow.mockReturnValue(false)
    const unseen = first(hidden, { MADE_UP: 'p1' })
    expect(unseen.src.hasPane(unseen.agent)).toBe(false)
    expect(await unseen.src.showPane(unseen.agent)).toBe('failed')
    const alone = first({ ...madeUp(), type: undefined }, { MADE_UP: 'p1' })
    expect(alone.src.capabilities(alone.agent)).toMatchObject({ voice: false })
    expect(await alone.src.send(alone.agent, 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })

    // A tap hands its pane to the opener, which brings it forward: the source runs none of its own.
    const near = madeUp()
    const tap = first(near, both)
    expect(await tap.src.focus(tap.agent)).toBe(true)
    expect(tap.actions.open.mock.calls).toEqual([[tap.agent.id, { pane: PANE }]])
    expect(near.focus).not.toHaveBeenCalled()
    // It cannot bring its pane forward here: Orca's terminal is the first that can.
    near.canFocus.mockReturnValue(false)
    expect(await tap.src.focus(tap.agent)).toBe(true)
    expect(tap.actions.open.mock.calls[1]).toEqual([tap.agent.id, { pane: { adapter: 'orca', id: HANDLE } }])
    expect(near.focus).not.toHaveBeenCalled()

    // It comes after its app: Orca's terminal is the tap's pane, and its own is raised once the app came.
    const late = { ...madeUp(), tap: 'after' as const }
    let opened!: (yes: boolean) => void
    const raised = first(late, both, { open: vi.fn(() => new Promise<boolean>((resolve) => { opened = resolve })) })
    const raising = raised.src.focus(raised.agent)
    expect(raised.actions.open.mock.calls).toEqual([[raised.agent.id, { pane: { adapter: 'orca', id: HANDLE } }]])
    expect(late.focus).not.toHaveBeenCalled()
    opened(true)
    expect(await raising).toBe(true)
    expect(late.focus.mock.calls).toEqual([[PANE]])
    // Its app did not come: nothing is raised.
    const unopened = { ...madeUp(), tap: 'after' as const }
    const closed = first(unopened, both, { open: vi.fn(async () => false) })
    expect(await closed.src.focus(closed.agent)).toBe(false)
    expect(unopened.focus).not.toHaveBeenCalled()
    // It cannot show its pane now: the pane a rest would show is Orca's, which comes before its app.
    const unshown = { ...madeUp(), tap: 'after' as const }
    unshown.canShow.mockReturnValue(false)
    const behind = first(unshown, both)
    expect(await behind.src.focus(behind.agent)).toBe(true)
    expect(unshown.focus).not.toHaveBeenCalled()
    // It is the pane a rest would show, but it cannot be brought forward here: nothing is raised.
    const stuck = { ...madeUp(), tap: 'after' as const }
    stuck.canFocus.mockReturnValue(false)
    const fixed = first(stuck, both)
    expect(await fixed.src.focus(fixed.agent)).toBe(true)
    expect(stuck.focus).not.toHaveBeenCalled()
  })
  // A rest shows a Claude app session in the app, only while that app is in front (docs/specs/2026-11-15-dial-claude-app-follow.md).
  const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const inClaude = (session = SESSION, bundle = 'com.anthropic.claudefordesktop') =>
    ({ hostHints: { __CFBundleIdentifier: bundle, CLAUDE_CODE_HOST_SESSION_ID: session } })

  it('hasPane: a Claude app session, where a tap can open it, while the Claude app is in front', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inClaude()))
    src.ingest(ev('session-start', { sessionId: 'ghostty', ...inClaude(SESSION, 'com.mitchellh.ghostty') }))
    src.ingest(ev('session-start', { sessionId: 'uuid', ...inClaude('8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b') }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(src.hasPane(agent('s1'))).toBe(true)
    actions.claudeInFront.mockReturnValueOnce(false)
    expect(src.hasPane(agent('s1'))).toBe(false)
    const linux = setup({ actions: fakeActions({}, 'linux').actions })
    linux.src.ingest(linux.ev('session-start', inClaude()))
    expect(linux.src.hasPane(linux.src.list()[0])).toBe(false)
    expect(src.hasPane(agent('ghostty'))).toBe(false)
    expect(src.hasPane(agent('uuid'))).toBe(false)
    src.ingest(ev('session-end', inClaude()))
    expect(src.hasPane(agent('s1'))).toBe(false)

    const bare = setup()
    bare.src.ingest(bare.ev('session-start', inClaude()))
    expect(bare.src.hasPane(bare.src.list()[0])).toBe(false)
  })

  it('showPane shows the session through claudeShow and answers what it said', async () => {
    for (const said of ['ok', 'failed', 'busy'] as const) {
      const { actions } = fakeActions({ claudeShow: vi.fn(async () => said) })
      const { src, ev } = setup({ actions })
      src.ingest(ev('turn-start', inClaude()))
      const agent = src.list()[0]
      expect(await src.showPane(agent)).toBe(said)
      expect(actions.claudeShow.mock.calls).toEqual([[agent.id, SESSION]])
      expect(actions.orcaSwitch).not.toHaveBeenCalled()
      expect(actions.open).not.toHaveBeenCalled()
    }
  })

  it('showPane asks the front again: no longer in front, it is failed and nothing runs', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inClaude()))
    const agent = src.list()[0]
    expect(src.hasPane(agent)).toBe(true)
    actions.claudeInFront.mockReturnValue(false)
    expect(await src.showPane(agent)).toBe('failed')
    expect(actions.claudeShow).not.toHaveBeenCalled()
    expect(actions.open).not.toHaveBeenCalled()
  })

  it('the session is the latest event\'s', async () => {
    const NEXT = 'local_0f1e2d3c-4b5a-4968-8776-655443322110'
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inClaude()))
    // Resumed under another of the app's sessions: the old one shows something else now.
    src.ingest(ev('turn-start', inClaude(NEXT)))
    const agent = src.list()[0]
    expect(await src.showPane(agent)).toBe('ok')
    expect(actions.claudeShow.mock.calls).toEqual([[agent.id, NEXT]])
    actions.claudeShow.mockClear()

    // Its next event comes from another app: the Claude app no longer holds it.
    src.ingest(ev('turn-stop', inClaude(NEXT, 'com.mitchellh.ghostty')))
    expect(await src.showPane(agent)).toBe('failed')
    src.ingest(ev('turn-start', inClaude()))
    src.ingest(ev('session-end', inClaude()))
    expect(await src.showPane(agent)).toBe('failed')
    expect(actions.claudeShow).not.toHaveBeenCalled()
    expect(actions.open).not.toHaveBeenCalled()
  })

  it('byPane: the live agent whose pane of that adapter has that id, the one heard from last of two, none for another adapter, an ended session or an unknown id', () => {
    const { actions } = fakeActions()
    const { src, ev, clock } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'a', callerPid: 100, ...inOrca() }))
    clock.t += 1_000
    src.ingest(ev('session-start', { sessionId: 'b', callerPid: 101, ...inOrca() }))
    expect(src.byPane('orca', HANDLE)).toMatchObject({ sessionId: 'b' })
    clock.t += 1_000
    src.ingest(ev('turn-start', { sessionId: 'a', callerPid: 100, ...inOrca() }))
    expect(src.byPane('orca', HANDLE)).toMatchObject({ sessionId: 'a' })
    expect(src.byPane('tabs', HANDLE)).toBeUndefined()
    expect(src.byPane('orca', OTHER)).toBeUndefined()
    src.ingest(ev('session-end', { sessionId: 'a', callerPid: 100, ...inOrca() }))
    src.ingest(ev('session-end', { sessionId: 'b', callerPid: 101, ...inOrca() }))
    expect(src.byPane('orca', HANDLE)).toBeUndefined()
  })

  it('a session ended in an Orca terminal and another started there: the pane is the live one\'s', () => {
    const { actions } = fakeActions()
    const { src, ev, clock } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'old', callerPid: 100, ...inOrca() }))
    clock.t += 1_000
    src.ingest(ev('session-start', { sessionId: 'new', callerPid: 101, ...inOrca() }))
    // The ended one is heard from last, and its end is still listed.
    clock.t += 1_000
    src.ingest(ev('session-end', { sessionId: 'old', callerPid: 100, ...inOrca() }))
    expect(src.list()).toHaveLength(2)
    expect(src.byPane('orca', HANDLE)).toMatchObject({ sessionId: 'new' })
  })

  it('paneOf: a live agent\'s pane id of that adapter; none for an agent in tmux inside Orca, another adapter, an ended session or an unknown agent', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'orca', callerPid: 100, ...inOrca() }))
    src.ingest(ev('session-start', { sessionId: 'tmux', callerPid: 101,
      hostHints: { TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: HANDLE } }))
    const id = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!.id
    expect(src.paneOf(id('orca'), 'orca')).toBe(HANDLE)
    expect(src.paneOf(id('tmux'), 'orca')).toBeUndefined()
    expect(src.paneOf(id('orca'), 'tmux')).toBeUndefined()
    expect(src.paneOf('observed:unknown', 'orca')).toBeUndefined()
    src.ingest(ev('session-end', { sessionId: 'orca', callerPid: 100, ...inOrca() }))
    expect(src.paneOf(id('orca'), 'orca')).toBeUndefined()
  })

  it('a session resumed in another Orca terminal is found by its new handle alone', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    src.ingest(ev('session-start', inOrca(OTHER)))
    const agent = src.list()[0]
    expect(src.byPane('orca', OTHER)).toMatchObject({ id: agent.id })
    expect(src.byPane('orca', HANDLE)).toBeUndefined()
    expect(src.paneOf(agent.id, 'orca')).toBe(OTHER)
  })

  /** Pane names by pane id, each `[id, title, renamed?]`. */
  const named = (...names: Array<[string, string, boolean?]>) => new Map(names.map(([id, title, renamed = false]) => [id, { title, renamed }]))
  /** No agent placed. */
  const none = new Map<string, string>()

  it('an agent in a pane with a name, and none of its own, is called by it', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    src.setPaneNames('orca', named([HANDLE, 'PM'], [OTHER, 'Dev']), none)
    expect(src.list()[0].name).toBe('PM')
    // One heard of after the names were given is called by them at once.
    src.ingest(ev('session-start', { sessionId: 's2', ...inOrca(OTHER) }))
    expect(src.list().find((a) => a.sessionId === 's2')!.name).toBe('Dev')
  })

  it('its own title (the hook\'s) and a user record name win over a pane name the person did not set', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions, recordName: async () => 'Mine' })
    s.src.ingest(s.ev('turn-start', { title: 'Tho', ...inOrca() }))
    s.open.set('a', 'terminal')
    s.owners.set('a', { pid: 11, engine: 'claude' })
    s.externals.set('a', { cwd: '/x/a', transcriptPath: '/t/a.jsonl' })
    await s.src.scanOpen()
    // Its record's name, then a hook that keeps it and says where it runs.
    s.src.ingest(s.ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...inOrca(OTHER) }))
    s.src.setPaneNames('orca', named([HANDLE, 'PM'], [OTHER, 'Dev']), none)
    const agent = (sessionId: string) => s.src.list().find((a) => a.sessionId === sessionId)!
    expect(agent('s1').name).toBe('Tho')
    expect(agent('a').name).toBe('Mine')
  })

  it('with no pane name it keeps its folder\'s name; names set again with that pane gone give it back its folder\'s', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    src.setPaneNames('orca', named([OTHER, 'Dev']), none)
    expect(src.list()[0].name).toBe('proj')
    src.setPaneNames('orca', named([HANDLE, 'PM']), none)
    expect(src.list()[0].name).toBe('PM')
    src.setPaneNames('orca', named([OTHER, 'Dev']), none)
    expect(src.list()[0].name).toBe('proj')
  })

  it('new names rename it, and the change is told once; the same names again tell nothing', () => {
    const { actions } = fakeActions()
    const { src, ev, changes } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    src.ingest(ev('session-start', { sessionId: 's2', ...inOrca(OTHER) }))
    src.setPaneNames('orca', named([HANDLE, 'PM'], [OTHER, 'Dev']), none)
    changes.mockClear()
    src.setPaneNames('orca', named([HANDLE, 'Lead'], [OTHER, 'Test']), none)
    expect(src.list().map((a) => a.name)).toEqual(['Lead', 'Test'])
    expect(changes).toHaveBeenCalledTimes(1)
    changes.mockClear()
    src.setPaneNames('orca', named([HANDLE, 'Lead'], [OTHER, 'Test']), none)
    expect(changes).not.toHaveBeenCalled()
  })

  it('names for another adapter, or for a pane it is not in, leave it alone', () => {
    const { actions } = fakeActions()
    const { src, ev, changes } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    changes.mockClear()
    src.setPaneNames('herdr', named([HANDLE, 'PM']), none)
    src.setPaneNames('orca', named([OTHER, 'PM']), none)
    expect(src.list()[0].name).toBe('proj')
    expect(changes).not.toHaveBeenCalled()
  })

  it('an agent in a multiplexer inside Orca (no Orca pane) is not renamed', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { hostHints: { TMUX_PANE: '%3', ORCA_TERMINAL_HANDLE: HANDLE } }))
    src.setPaneNames('orca', named([HANDLE, 'PM']), none)
    expect(src.list()[0].name).toBe('proj')
  })

  it('a pane name the person set wins over the session\'s own name; one they did not set leaves it', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions, recordName: async () => 'harness root' })
    // Diego's PM: the session he named "harness root" in a tab he renamed "PM". Its name from its hook, then its record's.
    s.src.ingest(s.ev('turn-start', { title: 'harness root', ...inOrca() }))
    s.open.set('a', 'terminal')
    s.owners.set('a', { pid: 11, engine: 'claude' })
    s.externals.set('a', { cwd: '/x/a', transcriptPath: '/t/a.jsonl' })
    await s.src.scanOpen()
    s.src.ingest(s.ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...inOrca(OTHER) }))
    const agent = (sessionId: string) => s.src.list().find((a) => a.sessionId === sessionId)!
    s.src.setPaneNames('orca', named([HANDLE, 'PM', true], [OTHER, 'PM', true]), none)
    expect(agent('s1').name).toBe('PM')
    expect(agent('a').name).toBe('PM')
    // A tab titled as its pane is Orca's own title: the session's name stays.
    s.src.setPaneNames('orca', named([HANDLE, 'harness'], [OTHER, 'harness']), none)
    expect(agent('s1').name).toBe('harness root')
    expect(agent('a').name).toBe('harness root')
  })

  /** One open session the scan found, idle: no hook has said its pane. */
  const scannedIdle = async (s: ReturnType<typeof setup>) => {
    s.open.set('a', 'terminal')
    s.owners.set('a', { pid: 11, engine: 'claude' })
    s.externals.set('a', { cwd: '/x/a', transcriptPath: '/t/a.jsonl' })
    await s.src.scanOpen()
    return s.src.list()[0].id
  }

  it('an agent the caller placed at a pane, with none of that adapter\'s, is called by its name', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions })
    const id = await scannedIdle(s)
    s.src.setPaneNames('orca', named([HANDLE, 'Skill từ SKILL.md']), new Map([[id, HANDLE]]))
    expect(s.src.list()[0].name).toBe('Skill từ SKILL.md')
    // Placed nowhere again: its folder's name.
    s.src.setPaneNames('orca', named([HANDLE, 'Skill từ SKILL.md']), none)
    expect(s.src.list()[0].name).toBe('a')
  })

  it('a rest and a tap show its place; words are never typed there, and the place never becomes its pane', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions })
    const id = await scannedIdle(s)
    s.src.setPaneNames('orca', named([HANDLE, 'Skill từ SKILL.md']), new Map([[id, HANDLE]]))
    const agent = s.src.list()[0]
    expect(s.src.hasPane(agent)).toBe(true)
    expect(await s.src.showPane(agent)).toBe('ok')
    expect(actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
    expect(s.src.capabilities(agent)).toMatchObject({ focus: true, voice: false })
    expect(await s.src.focus(agent)).toBe(true)
    // No hook named its app: the app of the adapter it was placed in comes forward.
    expect(actions.open.mock.calls).toEqual([[id, { bundle: 'com.stablyai.orca', pane: { adapter: 'orca', id: HANDLE } }]])
    expect(await s.src.send(agent, 'run the tests')).toMatchObject({ ok: false })
    expect(actions.orcaSend).not.toHaveBeenCalled()
    // Focus and a prompt follow only a pane its own hook named.
    expect(s.src.paneOf(id, 'orca')).toBeUndefined()
    expect(s.src.byPane('orca', HANDLE)).toBeUndefined()
  })

  it('placed nowhere again, a rest and a tap reach nothing; its own pane wins over its place', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions })
    const id = await scannedIdle(s)
    s.src.setPaneNames('orca', named(), new Map([[id, OTHER]]))
    s.src.setPaneNames('orca', named(), none)
    expect(s.src.hasPane(s.src.list()[0])).toBe(false)
    expect(s.src.capabilities(s.src.list()[0]).focus).toBe(false)
    s.src.setPaneNames('orca', named(), new Map([[id, OTHER]]))
    // Its first hook names its own terminal, before a new read drops the place.
    s.src.ingest(s.ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...inOrca(HANDLE) }))
    expect(await s.src.showPane(s.src.list()[0])).toBe('ok')
    expect(actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
  })

  it('a place alone, with no name, tells the change: a tap reaches it now', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions })
    const id = await scannedIdle(s)
    s.changes.mockClear()
    s.src.setPaneNames('orca', named(), new Map([[id, HANDLE]]))
    expect(s.changes).toHaveBeenCalledTimes(1)
    s.src.setPaneNames('orca', named(), new Map([[id, HANDLE]]))
    expect(s.changes).toHaveBeenCalledTimes(1)
    s.src.setPaneNames('orca', named(), none)
    expect(s.changes).toHaveBeenCalledTimes(2)
  })

  it('a place given an agent with a pane of that adapter is not taken', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inOrca()))
    src.setPaneNames('orca', named([OTHER, 'Dev', true]), new Map([[src.list()[0].id, OTHER]]))
    expect(src.list()[0].name).toBe('proj')
  })
})

// An agent in Terminal, iTerm2 or Ghostty has a tab a rest selects, by the tty of its process
// (docs/specs/2026-11-15-dial-terminal-follow.md, "1. A swipe selects the agent's tab").
describe('ObservedSource tabs', () => {
  const TTY = '/dev/ttys023'
  const inTerminal = { hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }

  /** A source whose tty reads the test answers by hand, in the order they began, with a watch's stream open. */
  function tabs(over: Partial<Fakes> = {}, deps: Partial<ObservedDeps> = {}) {
    const reads: Array<{ answer(tty: string | undefined): Promise<void>; fail(): Promise<void> }> = []
    const tty = vi.fn((_pid: number) => new Promise<string | undefined>((resolve, reject) => {
      reads.push({
        answer: (answered) => { resolve(answered); return flushed() },
        fail: () => { reject(new Error('ps failed')); return flushed() },
      })
    }))
    const { actions, ran } = fakeActions(over)
    const s = setup({ actions, tty, ...deps })
    const agent = (sessionId = 's1') => s.src.list().find((a) => a.sessionId === sessionId)!
    return { ...s, actions, ran, tty, reads, agent }
  }

  it('an agent in Terminal gets its tty from one read for its pid', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    expect(t.tty.mock.calls).toEqual([[100]])
    expect(t.src.hasPane(t.agent())).toBe(false)
    await t.reads[0].answer(TTY)
    t.src.ingest(t.ev('turn-start', inTerminal))
    t.src.ingest(t.ev('turn-stop', inTerminal))
    t.src.ingest(t.ev('turn-start', inTerminal))
    expect(t.tty.mock.calls).toEqual([[100]])
    expect(t.src.hasPane(t.agent())).toBe(true)
  })

  it('iTerm2 and Ghostty are read too; Orca, VS Code and an unknown terminal are not', () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', { sessionId: 'iterm', callerPid: 101, hostHints: { TERM_PROGRAM: 'iTerm.app' } }))
    t.src.ingest(t.ev('session-start', { sessionId: 'ghostty', callerPid: 102, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    t.src.ingest(t.ev('session-start', { sessionId: 'orca', callerPid: 103, hostHints: { __CFBundleIdentifier: 'com.stablyai.orca' } }))
    t.src.ingest(t.ev('session-start', { sessionId: 'vscode', callerPid: 104, hostHints: { TERM_PROGRAM: 'vscode' } }))
    t.src.ingest(t.ev('session-start', { sessionId: 'other', callerPid: 105, hostHints: { TERM_PROGRAM: 'Hyper' } }))
    expect(t.tty.mock.calls).toEqual([[101], [102]])
  })

  it('an agent in tmux inside Terminal: a tap opens through its tmux pane', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', { hostHints: { ...inTerminal.hostHints, TMUX_PANE: '%3' } }))
    await t.reads[0].answer('/dev/ttys031')
    expect(await t.src.focus(t.agent())).toBe(true)
    expect(t.actions.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100' } }]])
  })

  it('no tty (??) is no pane', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(undefined)
    expect(t.src.hasPane(t.agent())).toBe(false)
    expect(await t.src.showPane(t.agent())).toBe('failed')
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  it('a new pid reads again, and the old tty is gone at once', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    expect(t.src.hasPane(t.agent())).toBe(true)
    // Resumed in another tab: the same session, in a process of its own.
    t.src.ingest(t.ev('session-start', { ...inTerminal, callerPid: 101 }))
    expect(t.tty.mock.calls).toEqual([[100], [101]])
    expect(t.src.hasPane(t.agent())).toBe(false)
    expect(t.src.byTab('terminal-app', TTY)).toBeUndefined()
    await t.reads[1].answer('/dev/ttys024')
    expect(await t.src.showPane(t.agent())).toBe('ok')
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys024', false]])
  })

  it('a read that ends after its agent went, or after a newer pid\'s began, is dropped', async () => {
    // Either read may end first: only the newer pid's is its tty.
    for (const order of [[0, 1], [1, 0]]) {
      const t = tabs()
      t.src.ingest(t.ev('session-start', inTerminal))
      t.src.ingest(t.ev('session-start', { ...inTerminal, callerPid: 101 }))
      for (const i of order) await t.reads[i].answer(i === 0 ? TTY : '/dev/ttys024')
      expect(await t.src.showPane(t.agent())).toBe('ok')
      expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys024', false]])
    }

    // Gone from the list while its read ran: the session heard of again is listed anew, and waits for a read of its own.
    const gone = tabs()
    gone.src.ingest(gone.ev('session-start', inTerminal))
    gone.src.ingest(gone.ev('session-end', inTerminal))
    gone.clock.t += 10_000
    await gone.src.tick()
    expect(gone.src.list()).toEqual([])
    gone.src.ingest(gone.ev('session-start', inTerminal))
    await gone.reads[0].answer(TTY)
    expect(gone.tty.mock.calls).toEqual([[100], [100]])
    expect(gone.src.hasPane(gone.agent())).toBe(false)
    await gone.reads[1].answer('/dev/ttys024')
    expect(await gone.src.showPane(gone.agent())).toBe('ok')
    expect(gone.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys024', false]])
  })

  it('a read that fails is not no tty: a later event reads that pid again, 10 s on, and it is counted; ?? is final', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    t.src.ingest(t.ev('session-start', { ...inTerminal, sessionId: 's2', callerPid: 101 }))
    await t.reads[0].fail()
    await t.reads[1].answer(undefined)
    expect(t.src.hasPane(t.agent())).toBe(false)
    expect(t.logs).toEqual(['[observed] tty · not read'])
    // Under load each `ps` may time out: no pid is asked more often than once every 10 s.
    t.clock.t += 9_999
    t.src.ingest(t.ev('turn-start', inTerminal))
    expect(t.tty.mock.calls).toEqual([[100], [101]])
    t.clock.t += 1
    t.src.ingest(t.ev('turn-start', inTerminal))
    t.src.ingest(t.ev('turn-start', { ...inTerminal, sessionId: 's2', callerPid: 101 }))
    expect(t.tty.mock.calls).toEqual([[100], [101], [100]])
    await t.reads[2].answer(TTY)
    expect(t.src.hasPane(t.agent())).toBe(true)
    // Read once, it is not read again.
    t.clock.t += 10_000
    t.src.ingest(t.ev('turn-start', inTerminal))
    expect(t.tty).toHaveBeenCalledTimes(3)
  })

  it('the open scan reads the tty of an agent whose parents name a tab app', async () => {
    const t = tabs({}, { apps: async () => new Map([[11, 'terminal-app'], [12, 'vscode']]) })
    for (const [sessionId, pid] of [['a', 11], ['b', 12], ['c', 13]] as const) {
      t.open.set(sessionId, 'terminal')
      t.owners.set(sessionId, { pid, engine: 'claude' })
      t.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath: `/t/${sessionId}.jsonl` })
      t.working.set(sessionId, false)
    }
    await t.src.scanOpen()
    expect(t.tty.mock.calls).toEqual([[11]])
    await t.reads[0].answer(TTY)
    expect(t.src.hasPane(t.agent('a'))).toBe(true)
    // Their first hooks: the process read already is not read again; the one nothing named is read now.
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', callerPid: 11, ...inTerminal }))
    t.src.ingest(t.ev('turn-start', { sessionId: 'c', callerPid: 13, ...inTerminal }))
    expect(t.tty.mock.calls).toEqual([[11], [13]])
  })

  it('hasPane needs a tab app, a tty, a live session and an open stream', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    expect(t.src.hasPane(t.agent())).toBe(true)
    t.actions.tabsOpen.mockReturnValue(false)
    expect(t.src.hasPane(t.agent())).toBe(false)
    t.actions.tabsOpen.mockReturnValue(true)
    t.src.ingest(t.ev('session-end', inTerminal))
    expect(t.src.hasPane(t.agent())).toBe(false)
    // Resumed in the same process: its tty is still its own.
    t.src.ingest(t.ev('session-start', inTerminal))
    expect(t.src.hasPane(t.agent())).toBe(true)
    // The same process says another app now: no tab app holds it.
    t.src.ingest(t.ev('turn-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    expect(t.src.hasPane(t.agent())).toBe(false)
    expect(t.tty).toHaveBeenCalledTimes(1)

    // No routes for the dial's voice and tap: status only.
    const bare = setup({ tty: vi.fn(async () => TTY) })
    bare.src.ingest(bare.ev('session-start', inTerminal))
    await flushed()
    expect(bare.src.hasPane(bare.src.list()[0])).toBe(false)
  })

  it('with no tty reader (off macOS) nothing is read and no agent has a tab', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', inTerminal))
    expect(src.hasPane(src.list()[0])).toBe(false)
    expect(src.byTab('terminal-app', TTY)).toBeUndefined()
  })

  it('showPane writes one select that does not raise and answers ok, and failed with no stream', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    expect(await t.src.showPane(t.agent())).toBe('ok')
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', TTY, false]])
    expect(t.actions.orcaSwitch).not.toHaveBeenCalled()
    expect(t.actions.open).not.toHaveBeenCalled()
    // A line the stream did not take.
    t.actions.tabSelect.mockReturnValue('failed')
    expect(await t.src.showPane(t.agent())).toBe('failed')
    t.actions.tabsOpen.mockReturnValue(false)
    expect(await t.src.showPane(t.agent())).toBe('failed')
    expect(t.actions.tabSelect).toHaveBeenCalledTimes(2)
  })

  it('an agent with an Orca handle is shown by Orca, whatever its app', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', { hostHints: { ...inTerminal.hostHints, ORCA_TERMINAL_HANDLE: HANDLE } }))
    await t.reads[0].answer(TTY)
    expect(await t.src.showPane(t.agent())).toBe('ok')
    expect(t.actions.orcaSwitch.mock.calls).toEqual([[HANDLE]])
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  /** A tap's open, held until the test answers it. */
  const heldOpen = () => {
    let answer!: (opened: boolean) => void
    const open = vi.fn((_agentId: string, _target: OpenTarget) => new Promise<boolean>((resolve) => { answer = resolve }))
    return { open, answer: (opened: boolean) => answer(opened) }
  }

  it('a tap opens the app, then selects the tab with raise', async () => {
    const held = heldOpen()
    const t = tabs({ open: held.open })
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    const tap = t.src.focus(t.agent())
    await flushed()
    expect(held.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.apple.Terminal' }]])
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
    held.answer(true)
    expect(await tap).toBe(true)
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', TTY, true]])
  })

  it('a tap whose open fails selects nothing, and answers false', async () => {
    const t = tabs({ open: vi.fn(async () => false) })
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    expect(await t.src.focus(t.agent())).toBe(false)
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  it('an agent that ended, or whose pid changed, while open ran gets no select', async () => {
    for (const meanwhile of [{ event: 'session-end', pid: 100 }, { event: 'turn-start', pid: 101 }] as const) {
      const held = heldOpen()
      const t = tabs({ open: held.open })
      t.src.ingest(t.ev('session-start', inTerminal))
      await t.reads[0].answer(TTY)
      const tap = t.src.focus(t.agent())
      t.src.ingest(t.ev(meanwhile.event, { ...inTerminal, callerPid: meanwhile.pid }))
      held.answer(true)
      expect(await tap).toBe(true)
      expect(t.actions.tabSelect).not.toHaveBeenCalled()
    }
  })

  // Its pane a rest would show is Orca's now, which comes before its app, not after: a tap has nothing left to raise.
  it('an agent resumed in an Orca terminal while open ran gets no command', async () => {
    const held = heldOpen()
    const t = tabs({ open: held.open })
    t.src.ingest(t.ev('session-start', inTerminal))
    await t.reads[0].answer(TTY)
    const tap = t.src.focus(t.agent())
    t.src.ingest(t.ev('turn-start', { hostHints: { ...inTerminal.hostHints, ORCA_TERMINAL_HANDLE: HANDLE } }))
    held.answer(true)
    expect(await tap).toBe(true)
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
    expect(t.actions.orcaSwitch).not.toHaveBeenCalled()
    expect(t.ran).not.toHaveBeenCalled()
  })

  it('with no stream a tap only opens; a tap on an agent with an Orca handle writes no select', async () => {
    const t = tabs({ tabsOpen: vi.fn(() => false) })
    t.src.ingest(t.ev('session-start', inTerminal))
    t.src.ingest(t.ev('session-start', { sessionId: 'orca', callerPid: 101, hostHints: { ...inTerminal.hostHints, ORCA_TERMINAL_HANDLE: HANDLE } }))
    await t.reads[0].answer(TTY)
    await t.reads[1].answer('/dev/ttys024')
    expect(await t.src.focus(t.agent())).toBe(true)
    t.actions.tabsOpen.mockReturnValue(true)
    expect(await t.src.focus(t.agent('orca'))).toBe(true)
    expect(t.actions.open).toHaveBeenCalledTimes(2)
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  // Its tty is the multiplexer pane's, which no tab holds: a select would find nothing, and a rest would count as shown.
  it.each([
    ['herdr', { HERDR_PANE_ID: 'w1:p2' }],
    ['Rex', { REX_BLOCK: 'x' }],
    ['Zellij', { ZELLIJ: '0' }],
    ['tmux', { TMUX_PANE: '%3' }],
  ])('an agent in %s inside Ghostty has no tab: a rest shows nothing, and a tap selects none', async (_name, hints) => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', { hostHints: { ...hints, __CFBundleIdentifier: 'com.mitchellh.ghostty' } }))
    await t.reads[0].answer(TTY)
    expect(t.src.hasPane(t.agent())).toBe(false)
    expect(await t.src.showPane(t.agent())).toBe('failed')
    expect(await t.src.focus(t.agent())).toBe(true)
    expect(t.actions.open).toHaveBeenCalledTimes(1)
    expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.mitchellh.ghostty')
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
    expect(t.actions.orcaSwitch).not.toHaveBeenCalled()
  })

  it('byTab: the live agent of that app and tty, the most recently active of two, none for another app, an ended session or an unknown tty', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', { sessionId: 'a', callerPid: 100, ...inTerminal }))
    t.clock.t += 1_000
    t.src.ingest(t.ev('session-start', { sessionId: 'b', callerPid: 101, ...inTerminal }))
    t.src.ingest(t.ev('session-start', { sessionId: 'c', callerPid: 102, hostHints: { TERM_PROGRAM: 'iTerm.app' } }))
    for (const read of t.reads) await read.answer(TTY)
    expect(t.src.byTab('terminal-app', TTY)).toMatchObject({ sessionId: 'b' })
    t.clock.t += 1_000
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', callerPid: 100, ...inTerminal }))
    expect(t.src.byTab('terminal-app', TTY)).toMatchObject({ sessionId: 'a' })
    expect(t.src.byTab('iterm', TTY)).toMatchObject({ sessionId: 'c' })
    expect(t.src.byTab('ghostty', TTY)).toBeUndefined()
    expect(t.src.byTab('terminal-app', '/dev/ttys024')).toBeUndefined()
    t.src.ingest(t.ev('session-end', { sessionId: 'a', callerPid: 100, ...inTerminal }))
    t.src.ingest(t.ev('session-end', { sessionId: 'b', callerPid: 101, ...inTerminal }))
    expect(t.src.byTab('terminal-app', TTY)).toBeUndefined()
  })
})

// Only a person's prompt moves the dial: not one another session sent, nor the turn of words the dial delivered.
describe('ObservedSource and what a turn\'s start was', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const withHandle = { hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }

  it('a turn\'s start says what it was', () => {
    const { src, ev } = setup()
    expect(src.ingest(ev('session-start'))).toBeUndefined()
    expect(src.ingest(ev('turn-start'))).toBe('person')
    expect(src.ingest(ev('turn-start', { relayed: true }))).toBe('relayed')
    expect(src.ingest(ev('turn-start', { relayed: false }))).toBe('person')
    expect(src.ingest(ev('needs-input'))).toBeUndefined()
    expect(src.ingest({ engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'npm test' })).toBeUndefined()
    expect(src.ingest(ev('turn-error'))).toBeUndefined()
    expect(src.ingest(ev('turn-stop'))).toBeUndefined()
    expect(src.ingest(ev('session-end'))).toBeUndefined()
    // A session it does not list: Harness's own, and one with no room left.
    expect(src.ingest(ev('turn-start', { sessionId: 'router', cwd: '/data/harness/voice-route-scratch' }))).toBeUndefined()
    for (let i = 0; i < 50; i++) src.ingest(ev('turn-start', { sessionId: `busy${i}`, callerPid: 200 + i }))
    expect(src.ingest(ev('turn-start', { sessionId: 'new', callerPid: 999 }))).toBeUndefined()
  })

  // Theirs is a model call or a tool call, not a prompt (hook/notify.mjs, observedEvent).
  it('Command Code\'s and agy\'s turn-start say nothing', () => {
    const { src, ev } = setup()
    expect(src.ingest(ev('turn-start', { engine: 'commandcode' }))).toBeUndefined()
    expect(src.ingest(ev('turn-start', { engine: 'agy' }))).toBeUndefined()
    expect(src.list().map((a) => a.state)).toEqual(['working', 'working'])
  })

  it('the turn after the mod took the dial\'s words is the dial\'s, and the one after is the person\'s', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop'))
    src.ingest(ev('turn-stop', { sessionId: 's2' }))
    expect(await src.send(src.list().find((a) => a.sessionId === 's1')!, 'run the tests')).toEqual({ ok: true })
    // Another session's turn is its own.
    expect(src.ingest(ev('turn-start', { sessionId: 's2' }))).toBe('person')
    expect(src.ingest(ev('turn-start'))).toBe('dial')
    src.ingest(ev('turn-stop'))
    expect(src.ingest(ev('turn-start'))).toBe('person')
  })

  it('the turn after orca terminal send is the dial\'s, and the one after is the person\'s', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'run the tests')).toEqual({ ok: true })
    expect(actions.orcaSend).toHaveBeenCalledTimes(1)
    expect(src.ingest(ev('turn-start', withHandle))).toBe('dial')
    src.ingest(ev('turn-stop', withHandle))
    expect(src.ingest(ev('turn-start', withHandle))).toBe('person')
  })

  // Its `--wait-submit` returns once the prompt is submitted: the turn's hook can be heard first.
  it('the turn that starts while orca terminal send still runs is the dial\'s', async () => {
    let submitted!: (ok: boolean) => void
    const { actions } = fakeActions({ orcaSend: vi.fn(() => new Promise<boolean>((resolve) => { submitted = resolve })) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    const sent = src.send(src.list()[0], 'run the tests')
    expect(actions.orcaSend).toHaveBeenCalledTimes(1)
    expect(src.ingest(ev('turn-start', withHandle))).toBe('dial')
    submitted(true)
    expect(await sent).toEqual({ ok: true })
    src.ingest(ev('turn-stop', withHandle))
    expect(src.ingest(ev('turn-start', withHandle))).toBe('person')
  })

  it('a send Orca refuses leaves no record', async () => {
    const { actions } = fakeActions({ orcaSend: vi.fn(async () => false) })
    const { src, ev } = setup({ actions })
    src.ingest(ev('turn-stop', withHandle))
    expect(await src.send(src.list()[0], 'run the tests')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(src.ingest(ev('turn-start', withHandle))).toBe('person')
  })

  // The words the mod took are still to come: a refused send takes back its own record, which would outlive theirs.
  it('a send Orca refuses takes back its own record, not the one the mod left before it', async () => {
    /** The mod takes the first words; a minute later Orca refuses the next. */
    const refused = async () => {
      const { actions, ready } = fakeActions({
        toMod: vi.fn(async (): Promise<Delivery> => 'missed').mockResolvedValueOnce('taken'),
        orcaSend: vi.fn(async () => false),
      })
      const { src, clock, ev } = setup({ actions })
      ready.add('s1')
      src.ingest(ev('turn-stop', withHandle))
      expect(await src.send(src.list()[0], 'run the tests')).toEqual({ ok: true })
      clock.t += 60_000
      expect(await src.send(src.list()[0], 'then deploy')).toEqual({ ok: false, reason: 'proj did not answer.' })
      return { src, clock, turn: () => src.ingest(ev('turn-start', withHandle)) }
    }
    // One record is left.
    const now = await refused()
    expect(now.turn()).toBe('dial')
    expect(now.turn()).toBe('person')
    // It is the mod's: past its 10 minutes, though Orca's would still have a minute to go, the next turn is a person's.
    const later = await refused()
    later.clock.t += 540_000
    expect(later.turn()).toBe('person')
  })

  it('a refused or missed delivery records nothing', async () => {
    for (const [mod, before, hints, text, refused] of [
      // The mod has not taken the last words yet.
      ['busy', ['turn-stop'], withHandle.hostHints, 'next', 'pending'],
      // The mod missed them, and no Orca terminal takes them instead.
      ['missed', ['turn-stop'], {}, 'next', 'no-answer'],
      [undefined, ['turn-start'], withHandle.hostHints, 'next', 'busy'],
      [undefined, ['turn-start', 'needs-input'], withHandle.hostHints, 'next', 'waiting'],
      [undefined, ['turn-stop'], withHandle.hostHints, 'x'.repeat(2001), 'too-long'],
    ] as const) {
      const { actions, ready } = fakeActions({ toMod: vi.fn(async (): Promise<Delivery> => mod ?? 'taken') })
      const { src, ev } = setup({ actions })
      if (mod) ready.add('s1')
      for (const event of before) src.ingest(ev(event, { hostHints: hints }))
      expect((await src.send(src.list()[0], text)).ok).toBe(false)
      expect(actions.count).toHaveBeenLastCalledWith(refused)
      expect(src.ingest(ev('turn-start', { hostHints: hints }))).toBe('person')
    }
  })

  it('two prompts the mod took: the next two turns are the dial\'s, the third the person\'s', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start'))
    await src.send(src.list()[0], 'run the tests')
    await src.send(src.list()[0], 'then deploy')
    expect([1, 2, 3].map(() => src.ingest(ev('turn-start')))).toEqual(['dial', 'dial', 'person'])
  })

  // The mod holds the dial's words until a long turn is over, and no longer than this.
  it('a dial prompt expires after 10 minutes', async () => {
    const { actions, ready } = fakeActions()
    const { src, clock, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start'))
    await src.send(src.list()[0], 'run the tests')
    clock.t += 599_999
    expect(src.ingest(ev('turn-start'))).toBe('dial')
    await src.send(src.list()[0], 'then deploy')
    clock.t += 600_000
    expect(src.ingest(ev('turn-start'))).toBe('person')
  })

  // Another session's message is not the dial's words: their turn is still to come.
  it('a relayed turn does not use up the dial\'s prompt', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-stop'))
    await src.send(src.list()[0], 'run the tests')
    expect(src.ingest(ev('turn-start', { relayed: true }))).toBe('relayed')
    expect(src.ingest(ev('turn-start'))).toBe('dial')
  })

  it('at most 8 are kept for a session', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('turn-start'))
    for (let i = 0; i < 9; i++) await src.send(src.list()[0], `step ${i}`)
    expect(Array.from({ length: 9 }, () => src.ingest(ev('turn-start')))).toEqual([...Array(8).fill('dial'), 'person'])
  })
})

// A permission prompt that waits (deviceClaude/asked.ts): the dial shows the agent waiting and for what, and the prompt is
// answered in its own app.
describe('ObservedSource and a waiting prompt', () => {
  afterEach(() => { vi.useRealTimers() })
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
    'the session\'s own %s clears it, and another session\'s does not', async (event) => {
      vi.useFakeTimers()
      const { src, ev } = setup()
      src.ingest(ev('turn-start'))
      src.ingest(ev('turn-start', { sessionId: 's2' }))
      src.ingest(asked())
      const id = observedAgentId('claude', 's1')
      src.ingest(ev(event, { sessionId: 's2' }))
      await graced()
      expect(src.waitingOn(id)).toBe('npm test')
      src.ingest(ev(event))
      // A Stop ends the turn once it waits out its grace.
      await graced()
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
