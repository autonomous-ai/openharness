import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ObservedAsked, ObservedHookEvent } from '../../core/observedHook.js'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { STOP_HOOK_GRACE_MS } from '../../core/turns/turnHooks.js'
import type { TrustedCodexHome } from '../../lib/codexProfiles.js'
import type { ProcessRow } from '../../lib/processTable.js'
import { OpenSessions, SessionRows } from '../../lib/sessionSearch/external.js'
import { claudeProvider } from '../../lib/sessionSearch/externals/claude.js'
import { codexProvider } from '../../lib/sessionSearch/externals/codex.js'
import { processCwds, processView } from '../../lib/sessionSearch/externals/support.js'
import type { WindowsFilesRead } from '../../lib/windows/openFiles.js'
import { type HostAdapter, oncePerCaller, type Pane, type Place } from './adapter.js'
import { createClaudeAppAdapter } from './claudeApp.js'
import { createCodexAppAdapter } from './codexApp.js'
import type { CodexQueueResult } from './codexQueue.js'
import { codexServed, type CodexServedDeps, type Served, type ServedAsk } from './codexServed.js'
import type { HcPrompt } from './hcClient.js'
import { createHerdrAdapter } from './herdr.js'
import { createHerdrAppAdapter } from './herdrApp.js'
import type { HerdrPrompt } from './herdrClient.js'
import { APP_BUNDLES } from './hostDetect.js'
import { type Delivery, Inbox } from './inbox.js'
import { askedLine, CLAUDE_PLUGIN_OFF, CLAUDE_RESTART, CONTINUE_MAX_MS, CONTINUE_QUIET_MS, countWord, cutAnswer, observedAgentId, type ObservedActions, ObservedSource, type ObservedDeps, OUTER_FRESH_WAIT_MS, type PromptSource, REPORT_WAIT_MS } from './observed.js'
import type { OpenTarget } from './open.js'
import { createOrcaAdapter, MAX_TEXT, type OrcaDeps } from './orca.js'
import { createOrcaChatAdapter } from './orcaChat.js'
import { type Fresh, FRESH_WITHIN_MS, type Nested, type NestedPlace, type OuterLookup } from './outer.js'
import { appRoots, learnApps, type ProcessName, scannedApps } from './scannedApp.js'
import { pagesOf } from './select.js'
import { createTabsAdapter, type TabApp, type TabTty } from './tabs.js'
import type { TabsLine } from './tabsLines.js'
import { tabsTyping } from './tabsType.js'
import { createTmuxAdapter } from './tmux.js'
import type { HostAgent, Nest, PaneSwitch, TypeResult } from './types.js'
import { createVscodeAdapter, createVscodeClientAdapter } from './vscode.js'
import { createWeztermAdapter } from './wezterm.js'
import { createZellijAdapter } from './zellij.js'

function setup(over: Partial<ObservedDeps> = {}) {
  const clock = { t: 1_000_000 }
  const gens = new Map<number, string | null>()
  // The machine's processes: every pid below 1000 runs, as `g<pid>`, but one `gens` says is gone (null) or another.
  const procs = vi.fn(async (): Promise<{ pid: number; generation?: string }[]> => Array.from({ length: 1000 }, (_, pid) => pid)
    .filter((pid) => gens.get(pid) !== null).map((pid) => ({ pid, generation: gens.get(pid) ?? `g${pid}` })))
  const alive = vi.fn((_pid: number) => true)
  const open = new Map<string, 'terminal' | 'app' | 'harness' | 'maybe'>()
  // An owner's record path is its session id unless one is given, and it runs on no terminal unless one is given.
  const owners = new Map<string, { pid: number; engine: string; record?: string; tty?: string | null }>()
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
  // What each busy read waits on first, as a look waits on `held`.
  let beforeBusy: () => Promise<void> = async () => {}
  const find = vi.fn(async (wanted: ReadonlyMap<string, string>) =>
    new Map([...wanted.keys()].flatMap((id) => (externals.has(id) ? [[id, externals.get(id)!] as const] : []))))
  const deps: ObservedDeps = {
    now: () => clock.t,
    platform: 'darwin',
    processes: procs,
    alive,
    openSessions: {
      // The cached answer is empty before the first look, as it is when a dial attaches; only a fresh look sees.
      known: () => new Map(),
      owners: async () => {
        await look()
        return new Map([...open].flatMap(([id, openIn]) => {
          const owner = owners.get(id)
          return owner ? [[id, { record: id, tty: null, ...owner, ...(openIn === 'harness' ? { harness: true } : {}) }] as const] : []
        }))
      },
      // As OpenSessions says: busy unless the owner's record reads idle.
      busy: async (owner: { record: string }) => {
        await beforeBusy()
        return working.get(owner.record) !== false
      },
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
    holdBusy: (wait: () => Promise<void>) => { beforeBusy = wait },
  }
}

/** Past the wait before a turn's answer is read. */
const graced = (): Promise<unknown> => vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)

/** Every answer a read was given has reached the source. */
const flushed = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/** A tap no later tap on any agent replaced, as cableHost's count says. */
const latestTap = (): boolean => true

/** What an outer lookup answers once it settles (outer.ts OuterLookup). */
type OuterAnswer = NonNullable<Awaited<ReturnType<OuterLookup>>>

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

  it('a read that fails logs its kind and no error text: it can hold a path', async () => {
    const { src, ev, logs } = setup({ lastAnswer: async () => { throw new Error('EACCES /Users/someone/.claude/projects/x.jsonl') } })
    src.ingest(ev('turn-stop', { transcriptPath: '/t/s.jsonl' }))
    await graced()
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true })
    expect(src.list()[0].lastAnswer).toBeUndefined()
    expect(logs).toEqual(['[observed] last answer · not read · Error'])
  })

  it('turn-stop for cursor sets lastAnswer and unseenDone', async () => {
    const lastAnswer = vi.fn(async (_engine: string, _path: string): Promise<string | undefined> => 'Renamed it.')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-stop', { engine: 'cursor', transcriptPath: '/t/s.jsonl' }))
    await graced()
    expect(lastAnswer.mock.calls).toEqual([['cursor', '/t/s.jsonl']])
    expect(src.list()[0]).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: 'Renamed it.' })
  })

  it('does not read a transcript for other engines', async () => {
    const lastAnswer = vi.fn(async () => 'x')
    const { src, ev } = setup({ lastAnswer })
    src.ingest(ev('turn-stop', { engine: 'grok', transcriptPath: '/t/s.jsonl' }))
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
  it('list() says an ended session is ended, and a live or resumed one is not', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start'))
    expect(src.list()[0]).not.toHaveProperty('ended')
    src.ingest(ev('session-end'))
    expect(src.list()[0].ended).toBe(true)
    src.ingest(ev('session-start'))
    expect(src.list()[0]).not.toHaveProperty('ended')
  })

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

  it('a session its app brings back in a new process after its end stays listed', async () => {
    const { src, clock, gens, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    // The app quits: its agent ends, and the app's relaunch resumes the session in a process of its own.
    src.ingest(ev('session-end'))
    gens.set(100, null)
    src.ingest(ev('session-start', { callerPid: 200 }))
    clock.t += 20_000
    await src.tick()
    await src.tick()
    expect(src.list()).toHaveLength(1)
    expect(src.list()[0]).not.toHaveProperty('ended')
  })

  it('a session that comes back in a new process with no end of its old one stays listed', async () => {
    const { src, clock, gens, alive, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    // Its process is killed with no hook, and a new one carries on the session.
    gens.set(100, null)
    alive.mockImplementation((pid) => pid !== 100)
    src.ingest(ev('turn-start', { callerPid: 200 }))
    clock.t += 20_000
    await src.tick()
    await src.tick()
    expect(src.list()).toHaveLength(1)
  })

  it('a session that came back in a new process is removed once that process goes', async () => {
    const { src, gens, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    src.ingest(ev('session-start', { callerPid: 200 }))
    await src.tick()
    gens.set(200, 'reused')
    await src.tick()
    expect(src.list()).toHaveLength(0)
  })

  it('a hook that names a process passing by leaves a live session in its own', async () => {
    const { src, gens, alive, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    // On Windows a hook whose climb past its runner failed names that PowerShell, which exits with the hook.
    src.ingest(ev('turn-start', { callerPid: 300 }))
    gens.set(300, null)
    alive.mockImplementation((pid) => pid !== 300)
    await src.tick()
    expect(src.list()).toHaveLength(1)
  })

  it('a late hook of the process a session left does not take it back there', async () => {
    const { src, gens, alive, ev } = setup()
    src.ingest(ev('session-start'))
    await src.tick()
    gens.set(100, null)
    alive.mockImplementation((pid) => pid !== 100)
    src.ingest(ev('session-start', { callerPid: 200 }))
    // A subagent stopped as the old process exited still sends its SubagentStop, after the new one took the session.
    src.ingest(ev('subagent-stop'))
    await src.tick()
    expect(src.list()).toHaveLength(1)
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

  it('a session that moves to a new process while the process table is read is not judged by that table', async () => {
    const { src, procs, ev } = setup()
    src.ingest(ev('session-start'))
    let read!: (rows: { pid: number; generation?: string }[]) => void
    procs.mockImplementationOnce(() => new Promise((resolve) => { read = resolve }))
    const ticking = src.tick()
    // Its app brought it back in a process that started after the read began, so the table cannot hold it.
    src.ingest(ev('session-start', { callerPid: 5000 }))
    read([{ pid: 100, generation: 'g100' }])
    await ticking
    expect(src.list()).toHaveLength(1)
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

  describe('a transcript stamp read that never answers (a stalled network share)', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('holds no pass: another waiting agent still works again, and every pass after leaves one read waiting', async () => {
      const stalled = '/share/a.jsonl'
      const grown = new Map<string, number>()
      const fileStamp = vi.fn((path: string) => (path === stalled
        ? new Promise<{ stamp: string; mtime: number } | null>(() => {})
        : Promise.resolve(grown.has(path) ? { stamp: '', mtime: grown.get(path)! } : null)))
      const { src, clock, ev } = setup({ fileStamp })
      src.ingest(ev('turn-start', { sessionId: 'a', callerPid: 100, transcriptPath: stalled }))
      src.ingest(ev('turn-start', { sessionId: 'b', callerPid: 101, transcriptPath: '/t/b.jsonl' }))
      clock.t += 6_000
      src.ingest(ev('needs-input', { sessionId: 'a', callerPid: 100 }))
      src.ingest(ev('needs-input', { sessionId: 'b', callerPid: 101 }))
      grown.set('/t/b.jsonl', clock.t + 1)
      const state = (id: string): string | undefined => src.list().find((x) => x.sessionId === id)?.state
      void src.checkWorking()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(state('b')).toBe('working')
      expect(state('a')).toBe('needs-you')
      // The 3 s passes after it: the stalled transcript's one read is still the one waiting.
      for (let i = 0; i < 5; i++) {
        void src.checkWorking()
        await vi.advanceTimersByTimeAsync(3_000)
      }
      expect(fileStamp.mock.calls.filter(([path]) => path === stalled)).toHaveLength(1)
      expect(state('a')).toBe('needs-you')
    })
  })

  it('one pass at a time: a pass called while one runs starts no other', async () => {
    const { src, clock, open, owners, ev, hold, looks } = setup()
    open.set('c1', 'terminal')
    owners.set('c1', { pid: 100, engine: 'codex' })
    src.ingest(ev('turn-start', { engine: 'codex', sessionId: 'c1' }))
    clock.t += 3_000
    let release!: () => void
    hold(new Promise((resolve) => { release = resolve }))
    const before = looks()
    const first = src.checkWorking()
    const second = src.checkWorking()
    await flushed()
    expect(looks()).toBe(before + 1)
    release()
    await Promise.all([first, second])
    expect(looks()).toBe(before + 1)
    await src.checkWorking()
    expect(looks()).toBe(before + 2)
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

  it("otherApp from the latest hook on the Other page, none on a host's page", () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'zed' } }))
    const id = src.list()[0].id
    expect(src.list()[0].app).toBe('terminal')
    expect(src.otherApp(id)).toBe('zed')
    src.ingest(ev('turn-start', { hostHints: { __CFBundleIdentifier: 'com.jetbrains.goland' } }))
    expect(src.otherApp(id)).toBe('jetbrains')
    src.ingest(ev('turn-start', { hostHints: { __CFBundleIdentifier: 'com.example.term' } }))
    expect(src.otherApp(id)).toBe('unlisted')
    src.ingest(ev('turn-start', { hostHints: {} }))
    expect(src.otherApp(id)).toBe('unknown')
    src.ingest(ev('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(src.list()[0].app).toBe('ghostty')
    expect(src.otherApp(id)).toBeUndefined()
    expect(src.otherApp('observed:unknown')).toBeUndefined()
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

// Part 5 (docs/plans/2026-11-27-needs-you-right-part5-plan.md, decisions 12 and 18): the plugin's Stop hook reports each
// stop to the devices, which tell the source: a no releases the stop, a yes holds the turn the engine keeps going.
describe('ObservedSource and a stop its Stop hook reports', () => {
  const SESSION = 'sess-second-look-4e1b'
  const TRANSCRIPT = '/t/look.jsonl'
  const ANSWER = 'Which region should it deploy to?'
  /** Each rig's log lines, read after each case. */
  let logged: string[][] = []
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    // Fixed words only: never the session.
    expect(logged.flat().filter((line) => line.includes(SESSION))).toEqual([])
    logged = []
  })

  /** A listed session with a transcript, on the fake clock. `told` holds each time its turn end was told, by the read of
   *  its answer that each telling makes. */
  const rig = (engine: ObservedHookEvent['engine'] = 'claude', over: Partial<ObservedDeps> = {}) => {
    const told: number[] = []
    const s = setup({ now: () => Date.now(), lastAnswer: async () => { told.push(Date.now()); return ANSWER }, ...over })
    logged.push(s.logs)
    const hook = (event: ObservedHookEvent['event'], more: Partial<ObservedHookEvent> = {}): void => {
      s.src.ingest(s.ev(event, { engine, sessionId: SESSION, transcriptPath: TRANSCRIPT, ...more }))
    }
    const id = observedAgentId(engine, SESSION)
    const report = (goesOn: boolean): boolean => s.src.stopReported(id, goesOn)
    /** A notice of the agent rang now: the engine whose yes it counts after, or null. */
    const rang = (): 'claude' | 'codex' | null => s.src.rangInHold(id)
    const advance = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)
    // The transcript as it was when the session was listed.
    s.stamps.set(TRANSCRIPT, Date.now())
    hook('session-start')
    return {
      ...s, told, hook, report, rang, advance,
      agent: () => s.src.list()[0],
      missed: () => s.logs.filter((line) => line === '[observed] stop report missed').length,
      /** Each hold that ended with no next stop, by the log line that says why. */
      heldEnds: () => s.logs.filter((line) => line.startsWith('[observed] held stop')),
      /** The transcript grows now. */
      grow: () => { s.stamps.set(TRANSCRIPT, Date.now()) },
      /** An earlier turn whose stop its hook reported: the session's stops wait for their report from here. */
      mark: async () => {
        hook('turn-start')
        hook('turn-stop')
        report(false)
        await advance(1_500)
        told.length = 0
      },
    }
  }
  type Rig = ReturnType<typeof rig>

  /** The stop heard now waits for its own report, which comes at 2 s: told then, and not before. */
  const waitsForItsReport = async (r: Rig): Promise<void> => {
    r.hook('turn-stop')
    const stop = Date.now()
    await r.advance(1_999)
    expect(r.told).toEqual([])
    await r.advance(1)
    r.report(false)
    expect(r.told).toEqual([stop + 2_000])
  }

  /** The continuation's own stop, its report 0.3 s after it as its hook sends it: told done once, 1.5 s after it, with
   *  its answer. */
  const nextStopTold = async (r: Rig): Promise<void> => {
    r.hook('turn-stop')
    const stop = Date.now()
    await r.advance(300)
    r.report(false)
    await r.advance(1_199)
    expect(r.told).toEqual([])
    await r.advance(1)
    expect(r.told).toEqual([stop + 1_500])
    await r.advance(0)
    expect(r.agent()).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: ANSWER })
    await r.advance(130_000)
    expect(r.told).toHaveLength(1)
    expect(r.heldEnds()).toEqual([])
  }

  /** A marked session's turn whose stop the devices said yes to 1.3 s after it, the order Task 1 saw: when the yes came. */
  const heldAfterYes = async (r: Rig): Promise<number> => {
    await r.mark()
    r.hook('turn-start')
    r.hook('turn-stop')
    await r.advance(1_300)
    expect(r.report(true)).toBe(true)
    return Date.now()
  }

  describe('the stop waits for its report (decision 18)', () => {
    it('waits 6 s for a report, and holds a turn a yes keeps going until 10 s quiet, 120 s at most', () => {
      expect([REPORT_WAIT_MS, CONTINUE_QUIET_MS, CONTINUE_MAX_MS]).toEqual([6_000, 10_000, 120_000])
    })

    it.each(['claude', 'codex'] as const)('a marked session\'s stop waits for its report (%s)', async (engine) => {
      const r = rig(engine)
      await r.mark()
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(2_900)
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe('working')
      await r.advance(100)
      expect(r.report(false)).toBe(true)
      expect(r.told).toEqual([stop + 3_000])
      await r.advance(0)
      expect(r.agent()).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: ANSWER })
      await r.advance(10_000)
      expect(r.told).toHaveLength(1)
    })

    it('a report inside the grace is told at the grace\'s end, never before', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(300)
      r.report(false)
      await r.advance(1_100)
      expect(r.told).toEqual([])
      await r.advance(100)
      expect(r.told).toEqual([stop + 1_500])
    })

    it('no report: told at 6 s, and the session is no longer marked', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(5_900)
      expect(r.told).toEqual([])
      expect(r.missed()).toBe(0)
      await r.advance(100)
      expect(r.told).toEqual([stop + 6_000])
      await r.advance(0)
      expect(r.agent()).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: ANSWER })
      expect(r.missed()).toBe(1)
      // Its next turn, with no report: the grace, as a session never marked.
      r.hook('turn-start')
      r.hook('turn-stop')
      const next = Date.now()
      await r.advance(1_500)
      expect(r.told).toEqual([stop + 6_000, next + 1_500])
      expect(r.missed()).toBe(1)
    })

    it('a session that never reported: the grace, as today', async () => {
      const r = rig()
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_500)
      expect(r.told).toEqual([stop + 1_500])
      // Its reports at 2 s, its end already told.
      await r.advance(500)
      r.report(false)
      expect(r.report(true)).toBe(false)
      await r.advance(2_000)
      expect(r.told).toEqual([stop + 1_500])
      // The engine goes on in the same turn: no hold was started, so its next stop is told 1.5 s after it.
      r.told.length = 0
      await nextStopTold(r)
    })

    it('a report before its turn-stop', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      await r.advance(1_000)
      r.report(false)
      await r.advance(200)
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_499)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([stop + 1_500])
      // Used once: a second stop with no report of its own waits until 6 s.
      await r.advance(500)
      r.hook('turn-stop')
      const second = Date.now()
      await r.advance(5_999)
      expect(r.told).toEqual([stop + 1_500])
      await r.advance(1)
      expect(r.told).toEqual([stop + 1_500, second + 6_000])
    })

    it.each(['turn-start', 'needs-input', 'turn-error', 'turn-aborted', 'session-end'] as const)(
      'an early report is dropped by %s', async (event) => {
        const r = rig()
        await r.mark()
        r.hook('turn-start')
        r.report(false)
        r.hook(event)
        await waitsForItsReport(r)
      })

    it('an early report older than 6 s is not used', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.report(false)
      await r.advance(6_000)
      await waitsForItsReport(r)
    })

    it('a report while the lead\'s subagents run is not kept for its own stop', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.hook('subagent-start')
      r.hook('turn-stop')
      r.report(false)
      r.hook('subagent-stop')
      await waitsForItsReport(r)
    })

    it.each([
      ['a prompt', 'turn-start', 'working'], ['needs-input', 'needs-input', 'needs-you'], ['turn-error', 'turn-error', 'error'],
      ['turn-aborted', 'turn-aborted', 'idle'], ['session-end', 'session-end', 'idle'],
    ] as const)('a stop waiting for its report: %s tells nothing for it', async (_what, event, state) => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.hook('turn-stop')
      await r.advance(1_000)
      r.hook(event)
      // Its report, late.
      await r.advance(1_000)
      r.report(false)
      await r.advance(10_000)
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe(state)
      expect(r.missed()).toBe(0)
    })

    it('a removed session forgets its mark', async () => {
      const r = rig()
      await r.mark()
      r.gens.set(100, null)
      await r.src.tick()
      expect(r.src.list()).toEqual([])
      r.gens.delete(100)
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_500)
      expect(r.told).toEqual([stop + 1_500])
    })
  })

  describe('a stop that goes on (Part 5)', () => {
    it.each([['a marked session', true, 1_300], ['an unmarked one, inside the grace', false, 1_200]] as const)(
      'the yes after the blocked stop, %s: nothing told at 1.5 s or 9.9 s; the next stop is told done once, 1.5 s after it, with its answer',
      async (_which, marked, yesAt) => {
        const r = rig()
        if (marked) await r.mark()
        r.hook('turn-start')
        r.hook('turn-stop')
        await r.advance(yesAt)
        expect(r.report(true)).toBe(true)
        await r.advance(1_500 - yesAt)
        expect(r.told).toEqual([])
        await r.advance(8_400)
        expect(r.told).toEqual([])
        expect(r.agent().state).toBe('working')
        await nextStopTold(r)
      })

    it('the yes before the blocked stop: that stop is held; the next one is told done once', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      await r.advance(1_000)
      expect(r.report(true)).toBe(true)
      await r.advance(300)
      r.hook('turn-stop')
      await r.advance(9_000)
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe('working')
      await nextStopTold(r)
    })

    it('a continuation longer than 10 s that keeps showing activity is still held, and is announced at its next stop', async () => {
      const r = rig()
      await heldAfterYes(r)
      await r.advance(6_000)
      r.grow()
      await r.advance(4_000)
      expect(r.told).toEqual([])
      await r.advance(4_000)
      r.grow()
      await r.advance(6_000)
      expect(r.told).toEqual([])
      await r.advance(2_000)
      r.grow()
      await r.advance(8_000)
      r.grow()
      expect(r.told).toEqual([])
      await r.advance(8_000)
      expect(r.told).toEqual([])
      await nextStopTold(r)
    })

    it('a hook for the session counts as activity', async () => {
      const r = rig()
      const yes = await heldAfterYes(r)
      await r.advance(8_000)
      r.hook('subagent-start')
      r.hook('subagent-stop')
      await r.advance(9_900)
      expect(r.told).toEqual([])
      await r.advance(100)
      expect(r.told).toEqual([yes + 18_000])
    })

    it('no next stop, quiet: told once 10 s after the last activity', async () => {
      const r = rig()
      const yes = await heldAfterYes(r)
      await r.advance(4_000)
      r.grow()
      await r.advance(9_900)
      expect(r.told).toEqual([])
      await r.advance(100)
      expect(r.told).toEqual([yes + 14_000])
      await r.advance(0)
      expect(r.agent()).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: ANSWER })
      await r.advance(16_000)
      expect(r.told).toHaveLength(1)
      expect(r.heldEnds()).toEqual(['[observed] held stop · quiet'])
    })

    it('the 120 s cap', async () => {
      const r = rig()
      const yes = await heldAfterYes(r)
      for (let at = 5_000; at < 120_000; at += 5_000) {
        await r.advance(5_000)
        r.grow()
      }
      await r.advance(4_900)
      expect(r.told).toEqual([])
      await r.advance(100)
      expect(r.told).toEqual([yes + 120_000])
      for (let i = 0; i < 6; i++) {
        await r.advance(5_000)
        r.grow()
      }
      await r.advance(20_000)
      expect(r.told).toHaveLength(1)
      expect(r.heldEnds()).toEqual(['[observed] held stop · cap'])
    })

    it('an unreadable transcript shows no activity', async () => {
      const r = rig('claude', { fileStamp: async () => null })
      const yes = await heldAfterYes(r)
      await r.advance(4_000)
      r.grow()
      await r.advance(5_999)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([yes + 10_000])
    })

    it('a stop while the stamp is being read', async () => {
      let read!: (stamp: { stamp: string; mtime: number } | null) => void
      const fileStamp = vi.fn((_path: string) => new Promise<{ stamp: string; mtime: number } | null>((resolve) => { read = resolve }))
      const r = rig('claude', { fileStamp })
      const yes = await heldAfterYes(r)
      await r.advance(10_000)
      expect(fileStamp).toHaveBeenCalledTimes(1)
      r.hook('turn-stop')
      const stop = Date.now()
      read({ stamp: '', mtime: yes - 2_000 })
      await r.advance(0)
      expect(r.told).toEqual([])
      await r.advance(300)
      r.report(false)
      await r.advance(1_199)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([stop + 1_500])
      await r.advance(130_000)
      expect(r.told).toHaveLength(1)
    })

    it.each<[string, (r: Rig) => Promise<void>]>([
      ['a prompt', async (r) => { r.hook('turn-start') }],
      ['a removal', async (r) => {
        r.gens.set(100, null)
        await r.src.tick()
        expect(r.src.list()).toEqual([])
      }],
    ])('%s while the stamp is being read: nothing told at the read, and no timer left', async (_what, end) => {
      let read!: (stamp: { stamp: string; mtime: number } | null) => void
      const fileStamp = vi.fn((_path: string) => new Promise<{ stamp: string; mtime: number } | null>((resolve) => { read = resolve }))
      const r = rig('claude', { fileStamp })
      const yes = await heldAfterYes(r)
      await r.advance(10_000)
      expect(fileStamp).toHaveBeenCalledTimes(1)
      await end(r)
      read({ stamp: '', mtime: yes - 2_000 })
      await r.advance(0)
      expect(r.told).toEqual([])
      expect(vi.getTimerCount()).toBe(0)
      expect(r.heldEnds()).toEqual([])
    })

    it('a stamp read that never answers (a stalled network share): told at the 120 s cap all the same', async () => {
      const fileStamp = vi.fn((_path: string) => new Promise<{ stamp: string; mtime: number } | null>(() => {}))
      const r = rig('claude', { fileStamp })
      const yes = await heldAfterYes(r)
      await r.advance(10_000)
      expect(fileStamp).toHaveBeenCalledTimes(1)
      await r.advance(109_999)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([yes + 120_000])
      await r.advance(0)
      expect(r.agent()).toMatchObject({ state: 'done', unseenDone: true, lastAnswer: ANSWER })
      expect(r.heldEnds()).toEqual(['[observed] held stop · cap'])
    })

    it('the yes before its stop, and no stop at all, quiet for 10 s: nothing told, and the turn still works', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      expect(r.report(true)).toBe(true)
      await r.advance(30_000)
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe('working')
      expect(r.heldEnds()).toEqual(['[observed] held stop · unheard'])
      // The hold is gone: the owner's record reading idle ends the turn, as it does any turn no stop is held for.
      r.open.set(SESSION, 'terminal')
      r.owners.set(SESSION, { pid: 100, engine: 'claude' })
      r.working.set(SESSION, false)
      await r.src.checkWorking()
      expect(r.agent().state).toBe('idle')
      expect(r.told).toEqual([])
    })

    it('the yes before its stop, and no stop at all, the transcript growing: nothing told at 120 s either', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.report(true)
      for (let at = 5_000; at <= 125_000; at += 5_000) {
        await r.advance(5_000)
        r.grow()
      }
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe('working')
      expect(r.heldEnds()).toEqual(['[observed] held stop · unheard'])
    })

    it.each([
      ['a prompt', 'turn-start', 'working'], ['needs-input', 'needs-input', 'needs-you'], ['turn-error', 'turn-error', 'error'],
      ['session-end', 'session-end', 'idle'], ['turn-aborted', 'turn-aborted', 'idle'],
    ] as const)('%s during the hold: nothing told for the held stop', async (_what, event, state) => {
      const r = rig()
      await heldAfterYes(r)
      await r.advance(2_000)
      r.hook(event)
      await r.advance(130_000)
      expect(r.told).toEqual([])
      expect(r.agent().state).toBe(state)
    })

    it('the continuation\'s report before its own stop leaves the hold as it is: that stop is told 1.5 s after it', async () => {
      const r = rig()
      await heldAfterYes(r)
      await r.advance(5_000)
      r.report(false)
      await r.advance(200)
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_499)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([stop + 1_500])
    })

    it('stopReported for an agent no hook listed, an ended session, or another engine is false and changes nothing', async () => {
      const r = rig()
      expect(r.src.stopReported(observedAgentId('claude', 'never-listed'), false)).toBe(false)
      expect(r.src.stopReported(observedAgentId('claude', 'never-listed'), true)).toBe(false)
      expect(r.src.list()).toHaveLength(1)
      r.hook('turn-start')
      r.hook('session-end')
      expect(r.report(false)).toBe(false)
      expect(r.report(true)).toBe(false)
      // Resumed, it was never marked: its stop takes the grace.
      r.hook('session-start')
      r.hook('turn-start')
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_500)
      expect(r.told).toEqual([stop + 1_500])
      const cursor = rig('cursor')
      cursor.hook('turn-start')
      cursor.hook('turn-stop')
      expect(cursor.report(true)).toBe(false)
      expect(cursor.report(false)).toBe(false)
      const cursorStop = Date.now()
      await cursor.advance(1_500)
      cursor.hook('turn-start')
      cursor.hook('turn-stop')
      const next = Date.now()
      await cursor.advance(1_500)
      expect(cursor.told).toEqual([cursorStop + 1_500, next + 1_500])
    })

    it('a second yes keeps the first deadline', async () => {
      const r = rig()
      const yes = await heldAfterYes(r)
      for (let at = 5_000; at <= 100_000; at += 5_000) {
        await r.advance(5_000)
        r.grow()
      }
      r.report(true)
      for (let at = 105_000; at < 120_000; at += 5_000) {
        await r.advance(5_000)
        r.grow()
      }
      await r.advance(4_999)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([yes + 120_000])
    })

    it('a second yes is no activity: the hold still goes quiet 10 s after the first', async () => {
      const r = rig()
      const yes = await heldAfterYes(r)
      await r.advance(5_000)
      r.report(true)
      await r.advance(4_999)
      expect(r.told).toEqual([])
      await r.advance(1)
      expect(r.told).toEqual([yes + 10_000])
    })

    it('checkWorking leaves a held turn alone', async () => {
      let read: ((stamp: { stamp: string; mtime: number } | null) => void) | undefined
      const fileStamp = vi.fn((_path: string) => new Promise<{ stamp: string; mtime: number } | null>((resolve) => { read = resolve }))
      const r = rig('claude', { fileStamp })
      r.open.set(SESSION, 'terminal')
      r.owners.set(SESSION, { pid: 100, engine: 'claude' })
      r.working.set(SESSION, false)
      await r.mark()
      // Inside a report wait.
      r.hook('turn-start')
      await r.advance(3_000)
      r.hook('turn-stop')
      const stop = Date.now()
      await r.advance(1_000)
      await r.src.checkWorking()
      expect(r.agent().state).toBe('working')
      await r.advance(1_000)
      r.report(false)
      expect(r.told).toEqual([stop + 2_000])
      // Inside a hold, and while its stamp is read.
      r.hook('turn-start')
      await r.advance(3_000)
      r.hook('turn-stop')
      await r.advance(1_300)
      r.report(true)
      const yes = Date.now()
      await r.advance(3_000)
      await r.src.checkWorking()
      expect(r.agent().state).toBe('working')
      await r.advance(7_000)
      expect(fileStamp).toHaveBeenCalledTimes(1)
      await r.src.checkWorking()
      expect(r.agent().state).toBe('working')
      expect(r.told).toEqual([stop + 2_000])
      read!({ stamp: '', mtime: yes - 4_000 })
      await r.advance(0)
      expect(r.told).toEqual([stop + 2_000, yes + 10_000])
    })

    it('a lead with subagents running: the stop is not held by the yes, as today', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      r.hook('subagent-start')
      r.hook('turn-stop')
      expect(r.report(true)).toBe(false)
      r.hook('subagent-stop')
      await nextStopTold(r)
    })
  })

  // A notice rung while a yes holds the turn is the yes's ring, counted once a yes (the spec's "Part 5's counts").
  describe('the ring after a yes (Part 5\'s counts)', () => {
    it.each(['claude', 'codex'] as const)('the yes\'s hold answers its engine once (%s)', async (engine) => {
      const r = rig(engine)
      await heldAfterYes(r)
      expect(r.rang()).toBe(engine)
      expect(r.rang()).toBeNull()
    })

    it('the yes before the blocked stop: its hold answers once, though it goes on past that stop', async () => {
      const r = rig()
      await r.mark()
      r.hook('turn-start')
      expect(r.report(true)).toBe(true)
      expect(r.rang()).toBe('claude')
      r.hook('turn-stop')
      expect(r.rang()).toBeNull()
    })

    it.each<[string, (r: Rig) => Promise<void>]>([
      ['its next stop', async (r) => { r.hook('turn-stop') }],
      ['10 s quiet', async (r) => {
        await r.advance(CONTINUE_QUIET_MS)
        expect(r.told).toHaveLength(1)
      }],
      ['the 120 s cap', async (r) => {
        for (let at = 0; at < CONTINUE_MAX_MS; at += 5_000) {
          await r.advance(5_000)
          r.grow()
        }
        expect(r.told).toHaveLength(1)
      }],
      ['a prompt', async (r) => { r.hook('turn-start') }],
      ['session-end', async (r) => { r.hook('session-end') }],
    ])('null once the hold ends: %s', async (_, end) => {
      const r = rig()
      await heldAfterYes(r)
      await end(r)
      expect(r.rang()).toBeNull()
    })

    it.each<[string, (r: Rig) => Promise<void>]>([
      ['no report', async (r) => {
        r.hook('turn-start')
        r.hook('turn-stop')
      }],
      ['a no', async (r) => {
        await r.mark()
        r.hook('turn-start')
        r.hook('turn-stop')
        expect(r.report(false)).toBe(true)
      }],
      ['a second yes, the first one\'s ring read', async (r) => {
        await heldAfterYes(r)
        expect(r.rang()).toBe('claude')
        expect(r.report(true)).toBe(true)
      }],
      ['a yes that started no hold', async (r) => {
        r.hook('turn-start')
        r.hook('turn-stop')
        await r.advance(1_500)
        expect(r.report(true)).toBe(false)
      }],
    ])('null with %s', async (_, setup) => {
      const r = rig()
      await setup(r)
      expect(r.rang()).toBeNull()
    })

    it('null for an agent no hook listed', () => {
      const r = rig()
      expect(r.src.rangInHold(observedAgentId('claude', 'never-listed'))).toBeNull()
    })
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

  it('windowOf: a live agent\'s latest caller and its app, a scanned one\'s own pid; none for an ended or unknown one', async () => {
    const s = setup({ apps: async () => new Map([[11, 'ghostty']]) })
    s.src.ingest(s.ev('session-start', { sessionId: 'hooked', callerPid: 100, hostHints: { TERM_PROGRAM: 'WezTerm' } }))
    const id = (sessionId: string) => s.src.list().find((a) => a.sessionId === sessionId)!.id
    expect(s.src.windowOf(id('hooked'))).toEqual({ pid: 100, app: 'wezterm' })
    s.src.ingest(s.ev('turn-start', { sessionId: 'hooked', callerPid: 222, hostHints: { TERM_PROGRAM: 'WezTerm' } }))
    expect(s.src.windowOf(id('hooked'))).toEqual({ pid: 222, app: 'wezterm' })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.windowOf(id('a'))).toEqual({ pid: 11, app: 'ghostty' })
    s.src.ingest(s.ev('session-end', { sessionId: 'hooked', callerPid: 222, hostHints: { TERM_PROGRAM: 'WezTerm' } }))
    expect(s.src.windowOf(id('hooked'))).toBeUndefined()
    expect(s.src.windowOf('observed:unknown')).toBeUndefined()
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
    expect(s.logs).toContain('[observed] scan · apps not read · Error')
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
    expect(s.logs).toEqual(['[observed] scan · 2 found · 1 app known · 0 named · 0 answered · 7 ms · 0 nested placed'])
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
    const s = setup({ record: async () => ({ name: 'Tho' }) })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ name: 'Tho', cwd: '/x/a' })
    expect(s.changes).toHaveBeenCalled()
  })

  it.each<[string, ObservedDeps['record']]>([
    ['gives none', async () => ({})],
    ['fails', async () => { throw new Error('EACCES /Users/someone/.claude/sessions/11.json') }],
  ])('a reader that %s still lists the session by its folder', async (_what, record) => {
    const s = setup({ record })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0].name).toBe('a')
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  it('the reader is asked once, for the Claude sessions the scan is about to list', async () => {
    const record = vi.fn(async (_owner: unknown): Promise<{ name?: string }> => ({}))
    const s = setup({ record })
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
    expect(record.mock.calls).toEqual([[{ pid: 11, record: '/s/11.json', sessionId: 'a' }], [{ pid: 15, record: '/s/15.json', sessionId: 'd' }]])
  })

  it('at most 50 are asked a look', async () => {
    const record = vi.fn(async (_owner: unknown): Promise<{ name?: string }> => ({}))
    const s = setup({ record })
    for (let i = 0; i < 51; i++) found(s, `s${i}`, 200 + i)
    await s.src.scanOpen()
    expect(record).toHaveBeenCalledTimes(50)
  })

  it.each<[Partial<ObservedHookEvent>, string]>([[{ title: 'Math' }, 'Math'], [{}, 'a']])(
    'a hook that came while the names were read keeps what it said (%j)', async (over, name) => {
      let answer: (recorded: string | undefined) => void = () => {}
      const record = vi.fn(() => new Promise<{ name?: string }>((resolve) => { answer = (name) => resolve(name ? { name } : {}) }))
      const s = setup({ record })
      found(s, 'a', 11)
      const scan = s.src.scanOpen()
      await vi.waitFor(() => expect(record).toHaveBeenCalled())
      s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...over }))
      answer('Tho')
      await scan
      expect(s.src.list()).toHaveLength(1)
      expect(s.src.list()[0].name).toBe(name)
    })

  it('the record\'s name holds until a hook says otherwise', async () => {
    const s = setup({ record: async () => ({ name: 'Tho' }) })
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
    const s = setup({ record: async (owner) => (owner.pid === 11 ? { name: 'Tho 7f3a91c2' } : {}) })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(s.logs).toEqual(['[observed] scan · 2 found · 0 app known · 1 named · 0 answered · 0 ms · 0 nested placed'])
  })

  it('with no reader the scan names by folder', async () => {
    const s = setup()
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list()[0].name).toBe('a')
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
  })
})

describe('ObservedSource and the last answer the scan reads', () => {
  /** A session found open in a terminal and idle, its owner `pid`, its record its session id. */
  const found = (
    s: ReturnType<typeof setup>, sessionId: string, pid: number, engine = 'claude',
    transcriptPath: string | null = `/t/${sessionId}.jsonl`,
  ): void => {
    s.open.set(sessionId, 'terminal')
    s.owners.set(sessionId, { pid, engine })
    s.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath })
    s.working.set(sessionId, false)
  }

  it('a Claude session the scan lists idle reads its last answer, cut at 300 code points', async () => {
    const s = setup()
    found(s, 'a', 11)
    found(s, 'b', 12)
    s.answers.set('/t/a.jsonl', 'Done: 3 files')
    s.answers.set('/t/b.jsonl', '😀'.repeat(301))
    await s.src.scanOpen()
    expect(s.src.list().map((a) => [a.sessionId, a.lastAnswer])).toEqual([['a', 'Done: 3 files'], ['b', `${'😀'.repeat(299)}…`]])
  })

  it('a Codex session the scan lists idle reads its last answer, once', async () => {
    const lastAnswer = vi.fn(async (_engine: string, _path: string): Promise<string | undefined> => 'Codex says hi')
    const s = setup({ lastAnswer })
    found(s, 'c', 13, 'codex')
    await s.src.scanOpen()
    expect(lastAnswer.mock.calls).toEqual([['codex', '/t/c.jsonl']])
    expect(s.src.list()[0]).toMatchObject({ engine: 'codex', state: 'idle', lastAnswer: 'Codex says hi' })
    await s.src.scanOpen()
    await s.src.scanOpen()
    expect(lastAnswer).toHaveBeenCalledTimes(1)
  })

  it('a Cursor session the scan lists reads its last answer', async () => {
    const lastAnswer = vi.fn(async (_engine: string, _path: string): Promise<string | undefined> => 'Renamed it.')
    const s = setup({ lastAnswer })
    found(s, 'u', 14, 'cursor')
    await s.src.scanOpen()
    expect(lastAnswer.mock.calls).toEqual([['cursor', '/t/u.jsonl']])
    expect(s.src.list()[0]).toMatchObject({ engine: 'cursor', state: 'idle', lastAnswer: 'Renamed it.' })
  })

  // Its transcript in a turn holds that turn's words so far, which are no answer: the dial would show them as its recap.
  it('a Cursor session found in a turn, or whose turn cannot be told, is not read and stays listed idle', async () => {
    const lastAnswer = vi.fn(async (): Promise<string | undefined> => 'Let me look at the config first.')
    const s = setup({ lastAnswer })
    found(s, 'u', 14, 'cursor')
    found(s, 'v', 15, 'cursor')
    s.working.set('u', true)
    s.working.set('v', null)
    await s.src.scanOpen()
    expect(lastAnswer).not.toHaveBeenCalled()
    expect(s.src.list().map((a) => [a.sessionId, a.state, a.lastAnswer])).toEqual([['u', 'idle', undefined], ['v', 'idle', undefined]])
  })

  it('one found in a turn is not read and reads working', async () => {
    const lastAnswer = vi.fn(async (): Promise<string | undefined> => 'x')
    const s = setup({ lastAnswer })
    found(s, 'a', 11)
    s.working.set('a', true)
    await s.src.scanOpen()
    expect(lastAnswer).not.toHaveBeenCalled()
    expect(s.src.list()[0].state).toBe('working')
    expect(s.src.list()[0].lastAnswer).toBeUndefined()
  })

  it('one with no transcript path, or of another engine, is not read', async () => {
    const lastAnswer = vi.fn(async (): Promise<string | undefined> => 'x')
    const s = setup({ lastAnswer })
    found(s, 'a', 11, 'claude', null)
    found(s, 'g', 12, 'grok')
    await s.src.scanOpen()
    expect(lastAnswer).not.toHaveBeenCalled()
    expect(s.src.list().map((a) => [a.sessionId, a.state, a.lastAnswer])).toEqual([['a', 'idle', undefined], ['g', 'idle', undefined]])
  })

  it.each<[string, ObservedDeps['lastAnswer']]>([
    ['finds no answer', async () => undefined],
    ['finds an empty one', async () => ''],
    ['fails', async () => { throw new Error('EACCES /Users/someone/.claude/projects/x.jsonl') }],
  ])('a read that %s leaves no recap, still lists it, and logs no error text', async (_what, lastAnswer) => {
    const s = setup({ lastAnswer })
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(s.src.list().map((a) => [a.sessionId, a.state, a.lastAnswer])).toEqual([['a', 'idle', undefined]])
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  // As OpenSessions.busy counts an engine that cannot say: listed idle, a running turn would get a handle to type into.
  it('a busy check that fails counts as busy: it reads working, its answer is not read, and the look lists the rest', async () => {
    const lastAnswer = vi.fn(async (_engine: string, path: string): Promise<string | undefined> => `answer of ${path}`)
    const s = setup({ lastAnswer })
    let checks = 0
    s.holdBusy(async () => { if (checks++ === 0) throw new Error('EACCES /Users/someone/.claude/sessions/11.json') })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    expect(lastAnswer.mock.calls).toEqual([['claude', '/t/b.jsonl']])
    expect(s.src.list().map((a) => [a.sessionId, a.state, a.lastAnswer])).toEqual([['a', 'working', undefined], ['b', 'idle', 'answer of /t/b.jsonl']])
    expect(s.logs).toEqual(['[observed] scan · 2 found · 0 app known · 0 named · 1 answered · 0 ms · 0 nested placed'])
  })

  it('a hook heard while the answers are read wins', async () => {
    let answer: (text: string | undefined) => void = () => {}
    const lastAnswer = vi.fn(() => new Promise<string | undefined>((resolve) => { answer = resolve }))
    const s = setup({ lastAnswer })
    found(s, 'a', 11)
    const scan = s.src.scanOpen()
    await vi.waitFor(() => expect(lastAnswer).toHaveBeenCalled())
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a' }))
    answer('old answer')
    await scan
    expect(s.src.list()).toHaveLength(1)
    expect(s.src.list()[0].state).toBe('working')
    expect(s.src.list()[0].lastAnswer).toBeUndefined()
  })

  // The dial reads list() every second, and its restore marks an agent restored before reading its recap.
  it('no reader of list() sees a session of the look half-read', async () => {
    let releaseAnswers: () => void = () => {}
    const answersHeld = new Promise<void>((resolve) => { releaseAnswers = resolve })
    const lastAnswer = vi.fn(async (_engine: string, path: string): Promise<string | undefined> => {
      await answersHeld
      return path === '/t/a.jsonl' ? 'A done' : 'B done'
    })
    const s = setup({ lastAnswer })
    let releaseBusy: () => void = () => {}
    const busyHeld = new Promise<void>((resolve) => { releaseBusy = resolve })
    const busy = vi.fn(() => busyHeld)
    s.holdBusy(busy)
    found(s, 'a', 11)
    found(s, 'b', 12)
    const seen: HostAgent[][] = []
    s.changes.mockImplementation(() => { seen.push(s.src.list()) })
    const scan = s.src.scanOpen()
    await vi.waitFor(() => expect(busy).toHaveBeenCalled())
    expect(s.src.list()).toEqual([])
    releaseBusy()
    await vi.waitFor(() => expect(lastAnswer).toHaveBeenCalled())
    expect(s.src.list()).toEqual([])
    releaseAnswers()
    await scan
    expect(s.changes).toHaveBeenCalledTimes(1)
    expect(seen[0].map((a) => [a.sessionId, a.lastAnswer])).toEqual([['a', 'A done'], ['b', 'B done']])
  })

  it('a recap from before the dial is history: idle, not unseen, nothing told', async () => {
    const s = setup()
    found(s, 'a', 11)
    s.answers.set('/t/a.jsonl', 'Done')
    await s.src.scanOpen()
    expect(s.src.list()[0]).toMatchObject({ state: 'idle', unseenDone: false, lastAnswer: 'Done' })
    expect(s.changes).toHaveBeenCalledTimes(1)
  })

  it('at most 50 answers are read a look, and none past them is listed', async () => {
    const lastAnswer = vi.fn(async (_engine: string, path: string): Promise<string | undefined> => `answer of ${path}`)
    const s = setup({ lastAnswer })
    for (let i = 0; i < 51; i++) found(s, `s${i}`, 200 + i)
    await s.src.scanOpen()
    expect(lastAnswer).toHaveBeenCalledTimes(50)
    expect(s.src.list()).toHaveLength(50)
    for (const agent of s.src.list()) expect(agent.lastAnswer).toBe(`answer of /t/${agent.sessionId}.jsonl`)
  })

  it('Harness\'s own session is never read for an answer', async () => {
    const lastAnswer = vi.fn(async (): Promise<string | undefined> => 'x')
    const s = setup({ lastAnswer })
    found(s, 'v', 21)
    s.externals.set('v', { cwd: '/data/harness/voice', transcriptPath: '/t/v.jsonl' })
    await s.src.scanOpen()
    expect(lastAnswer).not.toHaveBeenCalled()
    expect(s.src.list()).toEqual([])
  })

  it('the scan\'s line counts the answered ones and times every read of the look', async () => {
    const s = setup({
      apps: async () => { s.clock.t += 7; return new Map([[11, 'ghostty']]) },
      record: async (owner) => { s.clock.t += 5; return owner.sessionId === 'a' ? { name: 'Tho 7f3a91c2' } : {} },
      lastAnswer: async (_engine, path) => { s.clock.t += 2; return path === '/t/a.jsonl' ? 'Done: 3 files' : undefined },
    })
    s.holdBusy(async () => { s.clock.t += 3 })
    found(s, 'a', 11)
    found(s, 'b', 12)
    await s.src.scanOpen()
    // 7 for the apps, 5 for each name, 3 for each busy check and 2 for each answer.
    expect(s.logs).toEqual(['[observed] scan · 2 found · 1 app known · 1 named · 1 answered · 27 ms · 0 nested placed'])
    for (const word of ['Done', '/t/', 'Tho', '7f3a91c2']) expect(s.logs.join('\n')).not.toContain(word)
  })
})

const HANDLE = 'term_0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'

/** What the tests answer for the source's routes: its own, and the Orca, herdr, Herdr Core, Claude app, Codex app and tab
 *  verbs its adapters run. */
interface Fakes extends Omit<ObservedActions, 'adapters'> {
  orcaSend(handle: string, text: string): Promise<TypeResult>
  orcaSwitch(handle: string): Promise<PaneSwitch>
  herdrPrompt(pane: string, kind: string, text: string): Promise<HerdrPrompt>
  herdrStamp(): string | undefined
  hcPrompt(address: string, kind: string, text: string): Promise<HcPrompt>
  hcShows(address: string): boolean
  hcReports(address: string): boolean
  herdrInFront(): boolean
  claudeInFront(): boolean
  claudeShow(agentId: string, session: string): Promise<PaneSwitch>
  codexInFront(): boolean
  tabsOpen(): boolean
  tabSelect(app: TabApp, tty: string, raise: boolean): PaneSwitch
  tmuxFront(): string | undefined
}

/** What each count says, as devices.ts logs it. */
const counted = (count: { mock: { calls: Array<Parameters<ObservedActions['count']>> } }): string[] =>
  count.mock.calls.map(([what]) => countWord(what))

/** Trusted Codex homes in the order given, each with its sessions folder, as trustedCodexHomes lists them. */
const trusted = (...homes: string[]): TrustedCodexHome[] => homes.map((home) => ({ home, sessions: `${home}/sessions` }))

/** Routes that answer as told, recording what each was handed. The adapters are the real ones for that platform, their
 *  verbs the fakes, and any command of their own goes to an inert runner. */
function fakeActions(over: Partial<Fakes> = {}, platform: NodeJS.Platform = 'darwin') {
  const ready = new Set<string>()
  // The plugin's state in each settings file, as claudePluginState reads it: a file not set here says nothing.
  const plugin = new Map<string, 'on' | 'off' | 'unknown'>()
  const fakes = {
    modReady: vi.fn((sessionId: string) => ready.has(sessionId)),
    toMod: vi.fn(async (_sessionId: string, _text: string): Promise<Delivery> => 'taken'),
    orcaSend: vi.fn(async (_handle: string, _text: string): Promise<TypeResult> => true),
    orcaSwitch: vi.fn(async (_handle: string): Promise<PaneSwitch> => 'ok'),
    // herdr takes every prompt.
    herdrPrompt: vi.fn(async (_pane: string, _kind: string, _text: string): Promise<HerdrPrompt> => ({ outcome: 'sent' })),
    // herdr's socket is where the daemon looks.
    herdrStamp: vi.fn((): string | undefined => '1:1'),
    // hc types into every terminal, Herdr's window shows each, and hc reports an agent in each; Herdr is not in front.
    hcPrompt: vi.fn(async (_address: string, _kind: string, _text: string): Promise<HcPrompt> => ({ outcome: 'sent' })),
    hcShows: vi.fn((_address: string) => true),
    hcReports: vi.fn((_address: string) => true),
    herdrInFront: vi.fn(() => false),
    // As on macOS: an app or a pane is something a tap can open (open.ts).
    canOpen: vi.fn((_agentId: string, target: OpenTarget) => !!target.bundle || !!target.pane),
    open: vi.fn(async (_agentId: string, _target: OpenTarget) => true),
    claudeInFront: vi.fn(() => true),
    claudeShow: vi.fn(async (_agentId: string, _session: string): Promise<PaneSwitch> => 'ok'),
    codexInFront: vi.fn(() => true),
    // A watch holds the tabs stream open, and takes each select.
    tabsOpen: vi.fn(() => true),
    tabSelect: vi.fn((_app: TabApp, _tty: string, _raise: boolean): PaneSwitch => 'ok'),
    // Terminal is in front: a tmux pane whose client it holds can be shown.
    tmuxFront: vi.fn((): string | undefined => 'terminal-app'),
    // Codex is there, and queues every message.
    codexQueue: {
      can: vi.fn((_isApp: boolean) => true),
      send: vi.fn(async (_threadId: string, _text: string, _isApp: boolean, _home: string): Promise<CodexQueueResult> => ({ outcome: 'queued' })),
    },
    // Harness trusts its own Codex home alone.
    codexHomes: (): readonly TrustedCodexHome[] => trusted('/home/u/.codex'),
    claudeHome: '/home/u/.claude',
    claudePluginState: vi.fn((settingsPath: string) => plugin.get(settingsPath) ?? 'unknown'),
    count: vi.fn((_what: Parameters<ObservedActions['count']>[0]) => {}),
  }
  const fake = { ...fakes, ...over } as typeof fakes
  // tmux says a pane's process is 100, the agent's, in a session of the person's: a tmux show passes its checks.
  const ran = vi.fn(async (_file: string, args: string[], _timeoutMs: number) =>
    ({ code: 0, stdout: args[0] === 'display-message' ? '100|work|\n' : '' }))
  const deps: OrcaDeps = { run: ran, onPath: (name) => `/fake/bin/${name}`, exists: () => false, platform }
  // Its agents run on the terminal their Orca terminal's or herdr pane's host made, as a read of their caller's maker
  // would find: one a test reads itself keeps what its read said.
  const madeBy = <A extends HostAdapter>(adapter: A, host: string): A =>
    ({ ...adapter, paneOf: (place: Place) => adapter.paneOf(place.ptyOwner === undefined ? { ...place, ptyOwner: host } : place) })
  const orca = madeBy(createOrcaAdapter(deps), 'orca')
  const claude = createClaudeAppAdapter({ ...deps, inFront: () => fake.claudeInFront() })
  const adapters: HostAdapter[] = [
    madeBy(createHerdrAdapter({ ...deps, log: () => {}, client: {
      prompt: (pane, kind, text) => fake.herdrPrompt(pane, kind, text),
      socketStamp: () => fake.herdrStamp(),
      binary: () => undefined,
    }, front: () => undefined }), 'herdr'),
    createTmuxAdapter({ run: ran, tmux: async () => ({ state: 'present' }), processes: async () => [{ pid: 100, ppid: 1, executable: 'claude' }],
      log: () => {}, front: () => fake.tmuxFront(), platform: 'darwin' }),
    // As devices.ts takes it where the hook's addresses are hc's own session's.
    createHerdrAppAdapter({ ...deps,
      client: { prompt: (address, kind, text) => fake.hcPrompt(address, kind, text), keys: async () => false },
      hookIds: true, inFront: () => fake.herdrInFront(), shows: (address) => fake.hcShows(address),
      // No stroke reaches it here: only the dial's scroll asks a terminal's tab, kind and status, and presses keys.
      tabOf: () => undefined, kindOf: () => undefined, statusOf: () => undefined,
      reports: (address) => fake.hcReports(address), log: () => {} }),
    createWeztermAdapter(deps),
    { ...orca, type: (pane, text) => fake.orcaSend(pane.id, text), show: (pane) => fake.orcaSwitch(pane.id) },
    { ...claude, show: (pane, agentId) => fake.claudeShow(agentId, pane.id) },
    createCodexAppAdapter({ ...deps, inFront: () => fake.codexInFront(), log: () => {} }),
    createVscodeAdapter('vscode', { ...deps, inFront: () => true, terminals: {
      terminalOf: () => undefined, show: () => false, scroll: () => false, pageKeys: () => false,
      canType: () => false, type: async () => 'failed' as const } }),
    createTabsAdapter({ isOpen: () => fake.tabsOpen(), select: (tab, raise) => fake.tabSelect(tab.app, tab.tty, raise) === 'ok' }),
  ]
  return { actions: { ...fake, adapters }, ready, ran, plugin }
}

describe('ObservedSource actions', () => {
  afterEach(() => { vi.useRealTimers() })
  const withHandle = { hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE } }
  /** An adapter whose pane is the place's folder, as Cursor's folder window's is (cursorFolder.ts). */
  const byFolder: HostAdapter = { id: 'by-folder', tap: 'instead', canFocus: () => true, focus: async () => true,
    paneOf: (place) => (place.cwd ? { adapter: 'by-folder', id: place.cwd } : undefined) }

  it('a place carries the folder of the hook that placed it: a session that moved is placed there at that hook', () => {
    const { src, ev } = setup({ actions: { ...fakeActions().actions, adapters: [byFolder] } })
    src.ingest(ev('session-start', { cwd: '/work/one' }))
    const { id } = src.list()[0]
    expect(src.paneOf(id, 'by-folder')).toBe('/work/one')
    // The same caller: no tty read places it a second time, so the place must be right at this hook's own look.
    src.ingest(ev('turn-start', { cwd: '/work/two' }))
    expect(src.paneOf(id, 'by-folder')).toBe('/work/two')
    // A hook cut to its bound names no folder: the last one stands.
    src.ingest(ev('turn-stop', { cwd: undefined }))
    expect(src.paneOf(id, 'by-folder')).toBe('/work/two')
  })

  it('a session the scan found is placed at its row\'s folder', async () => {
    const { src, open, owners, externals } = setup({ actions: { ...fakeActions().actions, adapters: [byFolder] } })
    open.set('s9', 'terminal')
    owners.set('s9', { pid: 77, engine: 'claude' })
    externals.set('s9', { cwd: '/work/scan', transcriptPath: '/t/s9.jsonl' })
    await src.scanOpen()
    expect(src.paneOf(observedAgentId('claude', 's9'), 'by-folder')).toBe('/work/scan')
  })

  it('keeps a handle that is term_<uuid> and ignores any other', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: true })
    expect(src.voiceRefusal(src.list()[0])).toBeUndefined()
    src.ingest(ev('turn-stop', { hostHints: { ORCA_TERMINAL_HANDLE: `${HANDLE}; rm -rf /` } }))
    // No route: Claude Code still takes voice, and its start is told how to reach it.
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: false })
    expect(src.voiceRefusal(src.list()[0])).toBe(CLAUDE_PLUGIN_OFF)
  })

  it('an event whose hints carry no handle clears it: a tap opens the app it runs in now', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', withHandle))
    // Resumed in another terminal: the old handle now holds something else.
    src.ingest(ev('session-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
    expect(src.voiceRefusal(agent)).toBe(CLAUDE_PLUGIN_OFF)
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty' }]])
  })

  it('f for an agent whose app a tap can bring forward, with no handle and no mod', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { sessionId: 'warp', hostHints: { TERM_PROGRAM: 'WarpTerminal' } }))
    src.ingest(ev('session-start', { sessionId: 'app', hostHints: { __CFBundleIdentifier: 'org.alacritty' } }))
    const caps = (sessionId: string) => src.capabilities(src.list().find((a) => a.sessionId === sessionId)!)
    expect(caps('warp')).toEqual({ status: true, voice: true, focus: true, answer: false })
    expect(caps('app')).toEqual({ status: true, voice: true, focus: true, answer: false })
    const id = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!.id
    expect(actions.canOpen.mock.calls).toEqual([[id('warp'), { bundle: 'dev.warp.Warp-Stable' }], [id('app'), { bundle: 'org.alacritty' }]])
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
    expect(src.capabilities(src.list()[0])).toMatchObject({ voice: true, focus: false })
    expect(src.voiceRefusal(src.list()[0])).toBe(CLAUDE_PLUGIN_OFF)
    src.ingest(ev('session-start', withHandle))
    expect(src.list()[0].host).toBe('orca')
    expect(src.voiceRefusal(src.list()[0])).toBeUndefined()
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

  // U11: cursor-agent in an editor's terminal is typed into before its first turn ends (the spec's "cursor-agent's idle").
  it('cursor-agent is at its prompt from its session-start until a turn starts', async () => {
    vi.useFakeTimers()
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const busy = { ok: false, reason: 'proj is busy. Say it when it is done.' }
    const after = async (event: ObservedHookEvent['event'], text: string) => {
      src.ingest(ev(event, { engine: 'cursor', ...withHandle }))
      if (event === 'turn-stop') await graced()
      return src.send(src.list()[0], text)
    }
    expect(await after('session-start', 'one')).toEqual({ ok: true })
    expect(await after('turn-start', 'two')).toEqual(busy)
    expect(await after('turn-stop', 'three')).toEqual({ ok: true })
    expect(await after('session-start', 'four')).toEqual({ ok: true })
    expect(await after('turn-start', 'five')).toEqual(busy)
    expect(actions.orcaSend.mock.calls).toEqual([[HANDLE, 'one'], [HANDLE, 'three'], [HANDLE, 'four']])
  })

  it('a cursor session the scan found is busy until a hook: the scan says nothing of its prompt', async () => {
    const type = vi.fn(async (_pane: Pane, _text: string, _engine: string): Promise<TypeResult> => true)
    const { src, open, owners, externals, ev } = setup({ actions: { ...fakeActions().actions, adapters: [{ ...byFolder, type }] } })
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'cursor' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: null })
    await src.scanOpen()
    expect(src.list()[0].state).toBe('idle')
    expect(await src.send(src.list()[0], 'yes do it')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
    expect(type).not.toHaveBeenCalled()
    src.ingest(ev('session-start', { engine: 'cursor' }))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
    expect(type.mock.calls.map(([pane, text]) => [pane, text])).toEqual([[{ adapter: 'by-folder', id: '/work/proj' }, 'next']])
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
    const { actions } = fakeActions({ toMod: vi.fn(async (): Promise<Delivery> => 'missed') })
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start'))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(actions.orcaSend).not.toHaveBeenCalled()
  })

  // "Did not answer" named nothing to do, though the mod asks again within moments of a poll closing.
  it('a mod that missed its 5 s, with no terminal to type into, is not listening yet', async () => {
    const { actions, ready } = fakeActions({ toMod: vi.fn(async (): Promise<Delivery> => 'missed') })
    const { src, ev } = setup({ actions })
    ready.add('s1')
    src.ingest(ev('session-start'))
    expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj is not listening yet. Try again in a moment.' })
    expect(actions.count).toHaveBeenLastCalledWith('no-answer')
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
    expect(countWord('codex-failed (exit 1 · path)')).toBe('codex-failed (exit 1 · path)')
    expect(countWord(orca)).toBe('orca')
    expect(countWord({ refused: orca })).toBe('refused (orca)')
  })

  describe('a terminal tab\'s words not sent, by reason', () => {
    /** An adapter by the tab typer's id, whose pane is its hint's, and whose `type` answers [typed]. */
    const tabsTyper = (typed: unknown) => {
      const type = vi.fn(async () => typed as TypeResult)
      const adapter: HostAdapter = { id: 'tabs', tap: 'after', canFocus: () => false, focus: async () => false, type,
        paneOf: (place) => (place.hints.TAB_PANE ? { adapter: 'tabs', id: place.hints.TAB_PANE } : undefined) }
      const { actions } = fakeActions()
      const t = setup({ actions: { ...actions, adapters: [adapter] } })
      return { ...t, actions, type }
    }
    const inTab = { hostHints: { TAB_PANE: 'iterm:/dev/ttys003' } }

    it('a reason of the list says did not answer, counted once as refused (tabs · <reason>), and its prompt record is forgotten', async () => {
      const t = tabsTyper({ notSent: 'shared' })
      t.src.ingest(t.ev('turn-stop', inTab))
      expect(await t.src.send(t.src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(counted(t.actions.count)).toEqual(['refused (tabs · shared)'])
      expect(t.src.ingest(t.ev('turn-start', inTab))).toBe('person')
    })

    it('a reason outside the list counts no-answer only: no word of an adapter\'s reaches the log', async () => {
      const t = tabsTyper({ notSent: 'oops' })
      t.src.ingest(t.ev('turn-stop', inTab))
      expect(await t.src.send(t.src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(counted(t.actions.count)).toEqual(['no-answer'])
    })

    // Decision 4: an engine whose turn's end no hook tells is at its prompt only once a hook said so.
    it('an engine other than Claude Code, Codex or cursor-agent heard at its turn-start, and nothing after, is busy: no typer is asked', async () => {
      const t = tabsTyper(true)
      t.src.ingest(t.ev('turn-start', { ...inTab, engine: 'opencode' }))
      expect(await t.src.send(t.src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj is busy. Say it when it is done.' })
      expect(t.type).not.toHaveBeenCalled()
    })
  })

  describe('othersOnTty', () => {
    const TTY = '/dev/ttys003'
    const inIterm = { hostHints: { TERM_PROGRAM: 'iTerm.app' } }
    const inGhostty = { hostHints: { TERM_PROGRAM: 'ghostty' } }
    /** A source whose every tty read answers [TTY], and whose tmux events sit in an iTerm2 tab of [TTY]. */
    const onTty = () => setup({
      tty: vi.fn(async (_pid: number): Promise<TabTty> => ({ tty: TTY })),
      outer: vi.fn((hints: Readonly<Record<string, string>>) =>
        (hints.TMUX_PANE ? Promise.resolve<OuterAnswer>({ app: 'iterm', tty: TTY, pid: 4300 }) : undefined)),
    })

    it('another live agent on that tty is there; the agent alone is not', async () => {
      const t = onTty()
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'a', callerPid: 4101 }))
      await flushed()
      expect(t.src.othersOnTty('iterm', TTY, 4101)).toBe(false)
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'b', callerPid: 4102 }))
      await flushed()
      expect(t.src.othersOnTty('iterm', TTY, 4101)).toBe(true)
      expect(t.src.othersOnTty('iterm', '/dev/ttys004', 4101)).toBe(false)
    })

    it('an ended one does not count', async () => {
      const t = onTty()
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'a', callerPid: 4101 }))
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'b', callerPid: 4102 }))
      await flushed()
      t.src.ingest(t.ev('session-end', { ...inIterm, sessionId: 'b', callerPid: 4102 }))
      expect(t.src.othersOnTty('iterm', TTY, 4101)).toBe(false)
    })

    it('a nested one whose client\'s tab is that tty counts', async () => {
      const t = onTty()
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'a', callerPid: 4101 }))
      t.src.ingest(t.ev('session-start', { sessionId: 'b', callerPid: 4102, hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' } }))
      await flushed()
      expect(t.src.tabTty(t.src.list().find((a) => a.sessionId === 'b')!.id)).toBe(TTY)
      expect(t.src.othersOnTty('iterm', TTY, 4101)).toBe(true)
    })

    // A codex exec Claude Code runs reads Claude's tty: until Claude's own read answers, Claude may be on it.
    it('one in the same tab app whose tty read failed, or has not answered, may be on that tty', async () => {
      const reads = [(): Promise<TabTty> => Promise.reject(new Error('ps')), (): Promise<TabTty> => new Promise(() => {})]
      for (const claudeRead of reads) {
        const t = setup({ tty: vi.fn((pid: number) => (pid === 4101 ? claudeRead() : Promise.resolve({ tty: TTY }))) })
        t.src.ingest(t.ev('session-start', { ...inGhostty, sessionId: 'a', callerPid: 4101 }))
        t.src.ingest(t.ev('session-start', { ...inGhostty, engine: 'codex', sessionId: 'b', callerPid: 4102 }))
        await flushed()
        expect(t.src.othersOnTty('ghostty', TTY, 4102)).toBe(true)
      }
    })

    // One read failed in another tab app is no reason to refuse every Ghostty tab: a codex exec gets its app from
    // Claude's own environment, so the two are always in one app.
    it('one in another tab app whose tty read failed, or has not answered, is on no tab of this app', async () => {
      const reads = [(): Promise<TabTty> => Promise.reject(new Error('ps')), (): Promise<TabTty> => new Promise(() => {})]
      for (const itermRead of reads) {
        const t = setup({ tty: vi.fn((pid: number) => (pid === 4101 ? itermRead() : Promise.resolve({ tty: TTY }))) })
        t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'a', callerPid: 4101 }))
        t.src.ingest(t.ev('session-start', { ...inGhostty, engine: 'codex', sessionId: 'b', callerPid: 4102 }))
        await flushed()
        expect(t.src.othersOnTty('ghostty', TTY, 4102)).toBe(false)
        expect(t.src.othersOnTty('iterm', TTY, 4102)).toBe(true)
      }
    })

    it('one whose tty read answered none is on no tty', async () => {
      const t = setup({ tty: vi.fn(async (pid: number) => (pid === 4101 ? undefined : { tty: TTY })) })
      t.src.ingest(t.ev('session-start', { ...inIterm, sessionId: 'a', callerPid: 4101 }))
      t.src.ingest(t.ev('session-start', { ...inIterm, engine: 'codex', sessionId: 'b', callerPid: 4102 }))
      await flushed()
      expect(t.src.othersOnTty('iterm', TTY, 4102)).toBe(false)
    })
  })

  it('a text over MAX_TEXT characters is refused before any route', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    ready.add('s1')
    // Waiting too: the length is what the person can fix by saying it again.
    src.ingest(ev('turn-start', withHandle))
    src.ingest(ev('needs-input', withHandle))
    expect(await src.send(src.list()[0], 'a'.repeat(MAX_TEXT + 1))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
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
    expect(await src.focus(agent, latestTap)).toBe(false)
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
    src.ingest(ev('session-start', { sessionId: 'plain', callerPid: 102 }))
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    expect(await src.focus(agent('orca'), latestTap)).toBe(false)
    expect(actions.open).toHaveBeenCalledWith(agent('orca').id, { bundle: 'com.stablyai.orca', pane: { adapter: 'orca', id: HANDLE } })
    actions.open.mockResolvedValue(true)
    expect(await src.focus(agent('orca'), latestTap)).toBe(true)
    expect(await src.focus(agent('plain'), latestTap)).toBe(false)
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
    await src.send(agent('none'), 'x'.repeat(MAX_TEXT + 1))
    await src.send(agent('none'), 'x')
    expect(counted(actions.count)).toEqual(['mod', 'orca', 'busy', 'waiting', 'too-long', 'no-answer'])
  })

  it('the pane a tap opens is its latest event\'s, with that event\'s process', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { callerPid: 100, hostHints: { TMUX_PANE: '%3' } }))
    src.ingest(ev('session-start', { callerPid: 200, hostHints: { TMUX_PANE: '%9' } }))
    expect(await src.focus(src.list()[0], latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { pane: { adapter: 'tmux', id: '%9:200' } }]])
  })

  it('a session in the VS Code extension\'s tab opens by its own session id', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const sessionId = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    src.ingest(ev('session-start', { sessionId, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    expect(await src.focus(src.list()[0], latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { bundle: 'com.microsoft.VSCode', pane: { adapter: 'vscode', id: sessionId } }]])
  })

  // The extension's tab has no terminal to type into: the mod's inbox poll is the only way the dial's words reach it.
  it('a session in the VS Code extension\'s tab takes the dial\'s words through its mod, and none without it', async () => {
    const { actions, ready } = fakeActions()
    const { src, ev } = setup({ actions })
    const sessionId = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    src.ingest(ev('session-start', { sessionId, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    const [agent] = src.list()
    expect(src.voiceRefusal(agent)).toBe(CLAUDE_PLUGIN_OFF)
    expect(await src.send(agent, 'run the tests')).toMatchObject({ ok: false })
    expect(actions.toMod).not.toHaveBeenCalled()
    ready.add(sessionId)
    expect(src.capabilities(agent).voice).toBe(true)
    expect(src.voiceRefusal(agent)).toBeUndefined()
    expect(await src.send(agent, 'run the tests')).toEqual({ ok: true })
    expect(actions.toMod.mock.calls).toEqual([[sessionId, 'run the tests']])
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(actions.herdrPrompt).not.toHaveBeenCalled()
    expect(actions.hcPrompt).not.toHaveBeenCalled()
  })

  it('a Codex session started from the extension\'s tab is not opened by Claude Code\'s link', async () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { engine: 'codex', sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    expect(await src.focus(src.list()[0], latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[src.list()[0].id, { bundle: 'com.microsoft.VSCode' }]])
  })

  describe('a typer that waits between its words and their Enter', () => {
    // Another Codex home's: not queue-able, so its words are typed (V9 at this layer).
    const outside = {
      engine: 'codex' as const, sessionId: THREAD, hostHints: { TYPER_PANE: 'p1' },
      transcriptPath: `/other/.codex/sessions/2026/11/22/rollout-2026-11-22T10-00-00-${THREAD}.jsonl`,
    }
    /** An adapter whose pane is its hint's, and whose `type` keeps the prompt check it was handed and answers once told. */
    const typing = () => {
      let atPrompt: (() => boolean) | undefined
      let answer!: (typed: TypeResult) => void
      const type = vi.fn((_pane: Pane, _text: string, _engine: string, check?: () => boolean) => {
        atPrompt = check
        return new Promise<TypeResult>((resolve) => { answer = resolve })
      })
      const typer: HostAdapter = { id: 'typer', tap: 'before', canFocus: () => false, focus: async () => false, type,
        paneOf: (place) => (place.hints.TYPER_PANE ? { adapter: 'typer', id: place.hints.TYPER_PANE } : undefined) }
      const { actions } = fakeActions()
      const t = setup({ actions: { ...actions, adapters: [typer] } })
      t.src.ingest(t.ev('session-start', outside))
      return { ...t, actions, type, atPrompt: () => atPrompt!(), answer: (typed: TypeResult) => answer(typed) }
    }

    it('a Codex outside Harness\'s own Codex home, at its prompt, with a pane whose app types, is typed there and counted by that adapter: no codex queue', async () => {
      const { src, actions, type, answer } = typing()
      const sent = src.send(src.list()[0], 'next')
      await flushed()
      answer(true)
      expect(await sent).toEqual({ ok: true })
      expect(type.mock.calls.map(([pane, text, engine]) => [pane, text, engine])).toEqual([[{ adapter: 'typer', id: 'p1' }, 'next', 'codex']])
      expect(actions.codexQueue.send).not.toHaveBeenCalled()
      expect(counted(actions.count)).toEqual(['typer'])
    })

    it.each([
      ['a turn starts', 'turn-start', {}],
      ['the agent waits', 'needs-input', {}],
      ['its session ends', 'session-end', {}],
      ['a hook gives it another pane', 'session-start', { hostHints: { TYPER_PANE: 'p2' } }],
    ] as const)('the typer is handed the prompt check: true at the prompt, false once %s', async (_what, event, over) => {
      const { src, ev, atPrompt, answer } = typing()
      const sent = src.send(src.list()[0], 'next')
      await flushed()
      expect(atPrompt()).toBe(true)
      src.ingest(ev(event, { ...outside, ...over }))
      expect(atPrompt()).toBe(false)
      answer(false)
      await sent
    })
  })

  // U10: the app's own adapter says why no route reaches its agent; the source names no app. Codex's here: Claude Code's
  // agent with none of theirs is told how to reach it (below).
  it('an agent with no route says its first adapter\'s sentence; one with a route, an ended one, or one whose adapters have none, says none', () => {
    const silent: HostAdapter = { id: 'silent', tap: 'instead', canFocus: () => false, focus: async () => false,
      paneOf: () => undefined }
    const saying = (id: string): HostAdapter => ({ ...silent, id,
      voiceRefusal: (place) => (place.hints.OWN_AGENT ? `${id} says no.` : undefined) })
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions: { ...actions, adapters: [...actions.adapters, silent, saying('first'), saying('second')] } })
    const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
    const codex = { engine: 'codex' as const }
    src.ingest(ev('session-start', { ...codex, sessionId: 'mute', callerPid: 101, hostHints: { OWN_AGENT: '1' } }))
    expect(src.voiceRefusal(agent('mute'))).toBe('first says no.')
    src.ingest(ev('session-start', { ...codex, sessionId: 'plain', callerPid: 102 }))
    expect(src.voiceRefusal(agent('plain'))).toBeUndefined()
    src.ingest(ev('session-start', { ...codex, sessionId: 'voiced', callerPid: 103, hostHints: { ...withHandle.hostHints, OWN_AGENT: '1' } }))
    expect(src.capabilities(agent('voiced')).voice).toBe(true)
    expect(src.voiceRefusal(agent('voiced'))).toBeUndefined()
    src.ingest(ev('session-end', { ...codex, sessionId: 'mute', callerPid: 101, hostHints: { OWN_AGENT: '1' } }))
    expect(src.voiceRefusal(agent('mute'))).toBeUndefined()

    const none = setup({ actions: { ...actions, adapters: [silent] } })
    none.src.ingest(none.ev('session-start', { ...codex, hostHints: { OWN_AGENT: '1' } }))
    expect(none.src.voiceRefusal(none.src.list()[0])).toBeUndefined()
  })

  // The dial shows only "See it in <host>" for an agent with no v, and the daemon never hears of it: Claude Code with no
  // route takes voice, and its start is refused with how to reach it (docs/plans/2026-11-26-dial-claude-plugin-install-design.md, 3).
  describe('Claude Code with no route', () => {
    const HOME = '/home/u/.claude-work'
    const SETTINGS = join(HOME, 'settings.json')
    const IN_HOME = join(HOME, 'projects', '-work-proj', 's1.jsonl')
    /** Claude Code's own folders, as devices.ts gives them: HOME's is one. */
    const claudeRoots = () => ['/home/u/.claude/projects', join(HOME, 'projects')]

    it('the two sentences, word for word', () => {
      expect(CLAUDE_PLUGIN_OFF).toBe('For voice, run: harness device claude enable')
      expect(CLAUDE_RESTART).toBe('Restart Claude Code for voice.')
    })

    it('a live Claude Code agent with no route takes voice; an ended one, or another engine, does not', () => {
      const { actions } = fakeActions()
      const { src, ev } = setup({ actions })
      const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
      src.ingest(ev('session-start', { sessionId: 'live', callerPid: 101 }))
      src.ingest(ev('session-start', { sessionId: 'ended', callerPid: 102 }))
      src.ingest(ev('session-end', { sessionId: 'ended', callerPid: 102 }))
      src.ingest(ev('session-start', { sessionId: 'cx', callerPid: 103, engine: 'codex' }))
      expect(src.capabilities(agent('live')).voice).toBe(true)
      expect(src.capabilities(agent('ended')).voice).toBe(false)
      expect(src.capabilities(agent('cx')).voice).toBe(false)
      expect(src.voiceRefusal(agent('ended'))).toBeUndefined()
      expect(src.voiceRefusal(agent('cx'))).toBeUndefined()
    })

    it('with no route and the plugin not on in its own home, the enable sentence', () => {
      for (const state of ['off', 'unknown'] as const) {
        const { actions, plugin } = fakeActions()
        plugin.set(SETTINGS, state)
        // The default home's is never asked for a session whose transcript names its own.
        plugin.set(join(actions.claudeHome, 'settings.json'), 'on')
        const { src, ev } = setup({ actions, claudeRoots })
        src.ingest(ev('session-start', { transcriptPath: IN_HOME }))
        expect(src.voiceRefusal(src.list()[0]), state).toBe(CLAUDE_PLUGIN_OFF)
        expect(actions.claudePluginState.mock.calls, state).toEqual([[SETTINGS]])
      }
    })

    // "Restart" also shows while a mod waits out its retry, or right after the devices restarted: a restart fixes it too.
    it('with the plugin on and no mod polling, the restart sentence', () => {
      const { actions, plugin, ready } = fakeActions()
      plugin.set(SETTINGS, 'on')
      const { src, ev } = setup({ actions, claudeRoots })
      src.ingest(ev('session-start', { transcriptPath: IN_HOME }))
      const [agent] = src.list()
      expect(src.voiceRefusal(agent)).toBe(CLAUDE_RESTART)
      expect(actions.claudePluginState.mock.calls).toEqual([[SETTINGS]])
      // Its mod has a poll open, or closed one in the last 5 s: the words go to it.
      ready.add('s1')
      expect(src.voiceRefusal(agent)).toBeUndefined()
      expect(actions.claudePluginState).toHaveBeenCalledTimes(1)
    })

    // A hook gives the path: only one plainly shaped <home>/projects/<slug>/<id>.jsonl names a home to read in.
    it('with no transcript path, or one of another shape, the default home decides', () => {
      for (const transcriptPath of [undefined, 'projects/p/s.jsonl', `${HOME}/projects/../x/s.jsonl`, join(HOME, 'projects', 'p', 's.txt')]) {
        const { actions, plugin } = fakeActions()
        plugin.set(join(actions.claudeHome, 'settings.json'), 'on')
        const { src, ev } = setup({ actions, claudeRoots })
        src.ingest(ev('session-start', { transcriptPath }))
        expect(src.voiceRefusal(src.list()[0]), transcriptPath).toBe(CLAUDE_RESTART)
        expect(actions.claudePluginState.mock.calls, transcriptPath).toEqual([[join(actions.claudeHome, 'settings.json')]])
      }
    })

    // The read is synchronous: a home on a network share (/net/<host>/..., \\host\share\...) would hold the devices, and
    // every dial, at a voice start. A home is taken from a hook's path only inside Claude Code's own folders.
    it('a transcript path outside Claude Code\'s own folders names no home: the default home decides', () => {
      // With no folders given, none is Claude Code's. A `projects` folder inside one of them is no home: only the folder
      // a transcript's own projects folder is names one, and one inside could be a link to a share.
      for (const [home, roots] of [['/net/host', claudeRoots], [HOME, undefined], [join(HOME, 'projects', 'x'), claudeRoots]] as const) {
        const transcriptPath = join(home, 'projects', '-work-proj', 's1.jsonl')
        const { actions, plugin } = fakeActions()
        plugin.set(join(actions.claudeHome, 'settings.json'), 'on')
        plugin.set(join(home, 'settings.json'), 'off')
        const { src, ev } = setup({ actions, ...(roots ? { claudeRoots: roots } : {}) })
        src.ingest(ev('session-start', { transcriptPath }))
        expect(src.voiceRefusal(src.list()[0]), transcriptPath).toBe(CLAUDE_RESTART)
        expect(actions.claudePluginState.mock.calls, transcriptPath).toEqual([[join(actions.claudeHome, 'settings.json')]])
      }
    })

    it('an agent with a route gives no sentence and reads no settings', () => {
      const { actions, ready } = fakeActions()
      const { src, ev } = setup({ actions })
      const agent = (sessionId: string) => src.list().find((a) => a.sessionId === sessionId)!
      src.ingest(ev('session-start', { sessionId: 'mod', callerPid: 101 }))
      ready.add('mod')
      src.ingest(ev('session-start', { sessionId: 'pane', callerPid: 102, ...withHandle }))
      src.ingest(ev('session-start', { sessionId: THREAD, callerPid: 103, engine: 'codex', hostHints: { TERM_PROGRAM: 'ghostty' },
        transcriptPath: `/home/u/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl` }))
      for (const sessionId of ['mod', 'pane', THREAD]) {
        expect(src.capabilities(agent(sessionId)).voice, sessionId).toBe(true)
        expect(src.voiceRefusal(agent(sessionId)), sessionId).toBeUndefined()
      }
      expect(actions.claudePluginState).not.toHaveBeenCalled()
    })

    it('an adapter\'s sentence comes first', () => {
      const { actions } = fakeActions()
      const chats = createOrcaChatAdapter({ run: async () => ({ code: 0, stdout: '' }), onPath: () => null, exists: () => false,
        platform: 'darwin', worktreeOf: () => undefined, log: () => {} })
      const { src, ev } = setup({ actions: { ...actions, adapters: [...actions.adapters, chats] } })
      src.ingest(ev('session-start', { hostHints: { ORCA_AGENT_SESSION_ID: '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8' } }))
      expect(src.capabilities(src.list()[0]).voice).toBe(true)
      expect(src.voiceRefusal(src.list()[0])).toBe('Type in Orca for chats.')
      expect(actions.claudePluginState).not.toHaveBeenCalled()
    })

    // Caps are worked out for every list the dial is sent: the settings are read at a voice start alone.
    it('caps read no settings', () => {
      const { actions } = fakeActions()
      const { src, ev } = setup({ actions })
      src.ingest(ev('session-start', { transcriptPath: IN_HOME }))
      expect(src.capabilities(src.list()[0]).voice).toBe(true)
      expect(actions.claudePluginState).not.toHaveBeenCalled()
    })
  })
})

// hc's own foreground pid equal to the pid the scan lists a session by, in one terminal only, is where it runs (the
// addendum of docs/plans/2026-11-17-dial-recap-after-restart-design.md, decision 5).
describe('ObservedSource and the Herdr terminal a session the scan found runs in', () => {
  /** A Claude session found open in a terminal and idle, its owner `pid`, its last answer `Done`. */
  const found = (s: ReturnType<typeof setup>, sessionId: string, pid: number): void => {
    s.open.set(sessionId, 'terminal')
    s.owners.set(sessionId, { pid, engine: 'claude' })
    s.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath: `/t/${sessionId}.jsonl` })
    s.working.set(sessionId, false)
    s.answers.set(`/t/${sessionId}.jsonl`, 'Done')
  }
  /** A source whose lookup answers from `terminals` (pid → hc terminal), with the real adapters on `fakes`. */
  const paired = (over: Partial<ObservedDeps> = {}, fakes: Partial<Fakes> = {}) => {
    const terminals = new Map<number, string>()
    const herdrTerminal = vi.fn((pid: number) => terminals.get(pid))
    const { actions } = fakeActions(fakes)
    return { ...setup({ actions, herdrTerminal, ...over }), actions, terminals, herdrTerminal }
  }
  /** The same session `a` of pid 11, as a hook with these hints places it. */
  const hooked = (hostHints: Record<string, string>, fakes: Partial<Fakes> = {}) => {
    const { actions } = fakeActions(fakes)
    const s = setup({ actions })
    s.src.ingest(s.ev('session-start', { sessionId: 'a', callerPid: 11, hostHints }))
    return { ...s, actions }
  }
  const inT7 = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }
  const placeOf = ({ host, app, appPending, paneKeys }: HostAgent) => ({ host, app, appPending, paneKeys })
  const herdrLines = (logs: string[]): string[] => logs.filter((line) => line.startsWith('[observed] herdr'))

  it('paired by its pid, it is placed as its hook would place it, on Herdr\'s page, with its pane, words and tap there', async () => {
    const s = paired()
    found(s, 'a', 11)
    s.terminals.set(11, 't7')
    await s.src.scanOpen()
    const [agent] = s.src.list()
    expect(agent).toMatchObject({ host: 'herdr', app: 'herdr', paneKeys: ['herdr-app:t7'], state: 'idle', lastAnswer: 'Done' })
    expect(agent).not.toHaveProperty('appPending')
    expect(s.changes).toHaveBeenCalledTimes(1)
    expect(s.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 1 answered · 0 ms · 0 nested placed', '[observed] herdr · 1 paired'])
    const h = hooked(inT7)
    const [twin] = h.src.list()
    expect(placeOf(agent)).toEqual(placeOf(twin))
    expect(s.src.capabilities(agent)).toEqual(h.src.capabilities(twin))
    expect(s.src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
    expect(await s.src.focus(agent, latestTap)).toBe(true)
    expect(await h.src.focus(twin, latestTap)).toBe(true)
    expect(s.actions.open.mock.calls).toEqual([[agent.id, { bundle: 'dev.herdr.app', pane: { adapter: 'herdr-app', id: 't7' } }]])
    expect(h.actions.open.mock.calls).toEqual(s.actions.open.mock.calls)
    expect(await s.src.send(agent, 'next')).toEqual({ ok: true })
    expect(s.actions.hcPrompt.mock.calls).toEqual([['t7', 'claude', 'next']])
    expect(counted(s.actions.count)).toEqual(['herdr-app'])
  })

  it('a terminal hc reports no agent in takes no words, as for a hooked agent', async () => {
    const quiet = { hcReports: vi.fn((_address: string) => false) }
    const s = paired({}, quiet)
    found(s, 'a', 11)
    s.terminals.set(11, 't7')
    await s.src.scanOpen()
    const [agent] = s.src.list()
    expect(agent.paneKeys).toEqual(['herdr-app:t7'])
    const h = hooked(inT7, quiet)
    expect(s.src.voiceRefusal(agent)).toBe(CLAUDE_PLUGIN_OFF)
    expect(h.src.voiceRefusal(h.src.list()[0])).toBe(CLAUDE_PLUGIN_OFF)
    expect(await s.src.send(agent, 'next')).toEqual({ ok: false, reason: 'a did not answer.' })
    expect(await h.src.send(h.src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
    expect(s.actions.hcPrompt).not.toHaveBeenCalled()
  })

  it('no lookup, or one that answers none, pairs nothing and logs no herdr line', async () => {
    for (const herdrTerminal of [undefined, vi.fn((_pid: number): string | undefined => undefined)]) {
      const s = setup({ actions: fakeActions().actions, herdrTerminal })
      found(s, 'a', 11)
      await s.src.scanOpen()
      s.src.placeHerdr()
      expect(placeOf(s.src.list()[0])).toEqual({ host: 'terminal', app: 'terminal', appPending: true, paneKeys: undefined })
      expect(s.changes).toHaveBeenCalledTimes(1)
      expect(herdrLines(s.logs)).toEqual([])
    }
  })

  it('Herdr\'s list after the scan: placeHerdr pairs it and tells one change; again with nothing new, none', async () => {
    const s = paired()
    found(s, 'a', 11)
    await s.src.scanOpen()
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'terminal', app: 'terminal', appPending: true, paneKeys: undefined })
    expect(herdrLines(s.logs)).toEqual([])
    s.terminals.set(11, 't7')
    s.src.placeHerdr()
    expect(s.src.list()[0]).toMatchObject({ host: 'herdr', app: 'herdr', paneKeys: ['herdr-app:t7'], lastAnswer: 'Done' })
    expect(s.src.list()[0]).not.toHaveProperty('appPending')
    expect(s.changes).toHaveBeenCalledTimes(2)
    expect(herdrLines(s.logs)).toEqual(['[observed] herdr · 1 paired'])
    s.src.placeHerdr()
    expect(s.changes).toHaveBeenCalledTimes(2)
    expect(herdrLines(s.logs)).toEqual(['[observed] herdr · 1 paired'])
  })

  it('a pairing that no longer holds is taken back to what the scan gave it; one that moves follows its terminal', async () => {
    const s = paired({ apps: async () => new Map([[11, 'vscode']]) })
    found(s, 'a', 11)
    found(s, 'b', 12)
    s.terminals.set(11, 't7').set(12, 't9')
    await s.src.scanOpen()
    const row = (sessionId: string): HostAgent => s.src.list().find((a) => a.sessionId === sessionId)!
    expect(placeOf(row('a'))).toEqual({ host: 'herdr', app: 'herdr', appPending: undefined, paneKeys: ['herdr-app:t7'] })
    expect(herdrLines(s.logs)).toEqual(['[observed] herdr · 2 paired'])
    // a moves to t8; b's terminal no longer runs it.
    s.terminals.set(11, 't8').delete(12)
    s.src.placeHerdr()
    expect(s.changes).toHaveBeenCalledTimes(2)
    expect(placeOf(row('a'))).toEqual({ host: 'herdr', app: 'herdr', appPending: undefined, paneKeys: ['herdr-app:t8'] })
    expect(placeOf(row('b'))).toEqual({ host: 'terminal', app: 'terminal', appPending: true, paneKeys: undefined })
    expect(herdrLines(s.logs)).toEqual(['[observed] herdr · 2 paired', '[observed] herdr · 1 paired'])
    // A move kept what the scan gave a: its app comes back, and no stale Herdr pane takes words or a tap.
    s.terminals.delete(11)
    s.src.placeHerdr()
    expect(s.changes).toHaveBeenCalledTimes(3)
    expect(placeOf(row('a'))).toEqual({ host: 'terminal', app: 'vscode', appPending: undefined, paneKeys: undefined })
    expect(herdrLines(s.logs)).toHaveLength(2)
    expect(s.src.capabilities(row('a'))).toMatchObject({ voice: true, focus: false })
    expect(s.src.voiceRefusal(row('a'))).toBe(CLAUDE_PLUGIN_OFF)
    expect(await s.src.focus(row('a'), latestTap)).toBe(false)
    expect(s.actions.canOpen).toHaveBeenLastCalledWith(row('a').id, {})
    expect(await s.src.send(row('a'), 'next')).toEqual({ ok: false, reason: 'a did not answer.' })
    expect(s.actions.hcPrompt).not.toHaveBeenCalled()
  })

  // The scan's maker read put it on tmux's page: a pairing is on Herdr's page, and gives that multiplexer back as it gives
  // back the app.
  it('a session the scan put on tmux\'s page is on Herdr\'s while paired, and on tmux\'s again once not, or at a nested hook', async () => {
    const rows: ProcessName[] = [{ pid: 11, ppid: 90, executable: 'claude' }, { pid: 90, ppid: 80, executable: 'zsh' }, { pid: 80, ppid: 1, executable: 'tmux' }]
    const outer = vi.fn((_hints: Readonly<Record<string, string>>, _pid: number) => new Promise<OuterAnswer>(() => {}))
    const s = paired({
      table: async () => rows, madeBy: async () => new Map([[11, { host: 'tmux', maker: 80, tty: 'ttys010' }]]), nested: async () => ({}), outer,
    })
    found(s, 'a', 11)
    await s.src.scanOpen()
    const a = (): HostAgent => s.src.list()[0]
    expect(a()).toMatchObject({ host: 'tmux', nest: 'tmux', app: 'terminal', appPending: true })
    s.terminals.set(11, 't7')
    s.src.placeHerdr()
    expect(placeOf(a())).toEqual({ host: 'herdr', app: 'herdr', appPending: undefined, paneKeys: ['herdr-app:t7'] })
    expect(a()).not.toHaveProperty('nest')
    expect(pagesOf(a())).toEqual(['herdr'])
    s.terminals.delete(11)
    s.src.placeHerdr()
    expect(a()).toMatchObject({ host: 'tmux', nest: 'tmux', app: 'terminal', appPending: true })
    expect(pagesOf(a())).toEqual(['tmux'])
    // Paired again, then its first hook, nested, from its own process: its hints' app's page and tmux's while that hook's lookup runs.
    s.terminals.set(11, 't7')
    s.src.placeHerdr()
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' } }))
    expect(a()).toMatchObject({ host: 'tmux', nest: 'tmux' })
    expect(pagesOf(a())).toEqual(['iterm', 'tmux'])
  })

  it('a hook heard after the pairing places it by its own hints, and no later placeHerdr pairs it again', async () => {
    const s = paired()
    found(s, 'a', 11)
    s.terminals.set(11, 't7')
    await s.src.scanOpen()
    s.src.ingest(s.ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: { TERM_PROGRAM: 'iTerm.app' } }))
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'iterm', app: 'iterm', appPending: undefined, paneKeys: undefined })
    const changes = s.changes.mock.calls.length
    s.herdrTerminal.mockClear()
    s.src.placeHerdr()
    expect(s.herdrTerminal).not.toHaveBeenCalled()
    expect(s.changes).toHaveBeenCalledTimes(changes)
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'iterm', app: 'iterm', appPending: undefined, paneKeys: undefined })
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: { HC_TERMINAL_ID: 't9', TERM_PROGRAM: 'ghostty' } }))
    expect(s.src.list()[0].paneKeys).toEqual(['herdr-app:t9'])
  })

  // The pairing's Herdr is no hook's: kept while the hook's caller is walked, the session would sit on Herdr's page with
  // no Herdr pane, Herdr's own row of its terminal unfolded beside it.
  it('a hook whose hints name no app keeps the app the scan gave it while its caller is walked, not the pairing\'s', async () => {
    let walked: (apps: ReadonlyMap<number, string>) => void = () => {}
    const apps = vi.fn(async (_pids: readonly number[]): Promise<ReadonlyMap<number, string>> => new Map([[11, 'vscode']]))
    const s = paired({ apps })
    found(s, 'a', 11)
    s.terminals.set(11, 't7')
    await s.src.scanOpen()
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'herdr', app: 'herdr', appPending: undefined, paneKeys: ['herdr-app:t7'] })
    apps.mockImplementationOnce(() => new Promise((resolve) => { walked = resolve }))
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: {} }))
    expect(apps).toHaveBeenLastCalledWith([11])
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'terminal', app: 'vscode', appPending: undefined, paneKeys: undefined })
    walked(new Map())
    await flushed()
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'terminal', app: 'terminal', appPending: undefined, paneKeys: undefined })
  })

  it('a hook heard while the scan\'s reads ran keeps its own place', async () => {
    let answer: (text: string | undefined) => void = () => {}
    const lastAnswer = vi.fn(() => new Promise<string | undefined>((resolve) => { answer = resolve }))
    const s = paired({ lastAnswer })
    found(s, 'a', 11)
    s.terminals.set(11, 't7')
    const scan = s.src.scanOpen()
    await vi.waitFor(() => expect(lastAnswer).toHaveBeenCalled())
    s.src.ingest(s.ev('session-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: { TERM_PROGRAM: 'ghostty' } }))
    answer('Done')
    await scan
    expect(placeOf(s.src.list()[0])).toEqual({ host: 'ghostty', app: 'ghostty', appPending: undefined, paneKeys: undefined })
    expect(s.herdrTerminal).not.toHaveBeenCalled()
    expect(herdrLines(s.logs)).toEqual([])
  })

  it('the herdr line counts only: two paired in one look, and no pid, address or name in any line', async () => {
    const s = paired({ record: async (owner) => (owner.sessionId === 'a' ? { name: 'Tho 7f3a91c2' } : {}) })
    found(s, 'a', 11)
    found(s, 'b', 12)
    s.terminals.set(11, 't7').set(12, 't8')
    await s.src.scanOpen()
    expect(s.logs).toEqual(['[observed] scan · 2 found · 0 app known · 1 named · 2 answered · 0 ms · 0 nested placed', '[observed] herdr · 2 paired'])
    const said = s.logs.join('\n')
    for (const word of ['t7', 't8', '11', '12', ...s.src.list().map((a) => a.name)]) expect(said).not.toMatch(new RegExp(`\\b${word}\\b`))
  })
})

describe('ObservedSource and a Claude app session the scan found (docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md)', () => {
  const CLAUDE_APP = 'com.anthropic.claudefordesktop'
  const LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
  const LOCAL_OTHER = 'local_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  /** Session `a` of pid 11, found open by the scan in `app` (left out, the Claude app; given as undefined, none learnt),
   *  its record giving `record`. */
  const scanned = async (o: {
    app?: string; record?: { name?: string; hostSession?: string }; fakes?: Partial<Fakes>; over?: Partial<ObservedDeps>
  } = {}) => {
    const app = 'app' in o ? o.app : 'claude'
    const record = o.record ?? { hostSession: LOCAL }
    const { actions } = fakeActions(o.fakes)
    const s = setup({ actions, apps: async () => new Map(app ? [[11, app]] : []), record: async () => record, ...o.over })
    s.open.set('a', 'terminal')
    s.owners.set('a', { pid: 11, engine: 'claude', record: '/s/11.json' })
    s.externals.set('a', { cwd: '/x/a' })
    await s.src.scanOpen()
    return { ...s, actions }
  }
  /** Nothing of the Claude app's: no pane a rest shows, and no tap or rest names its session. */
  const noClaude = async (t: Awaited<ReturnType<typeof scanned>>, agent: HostAgent): Promise<void> => {
    expect(t.src.hasPane(agent)).toBe(false)
    await t.src.showPane(agent)
    await t.src.focus(agent, latestTap)
    expect(JSON.stringify(t.actions.open.mock.calls)).not.toContain(LOCAL)
    expect(JSON.stringify(t.actions.claudeShow.mock.calls)).not.toContain(LOCAL)
  }

  it('with the Claude app\'s parents and its record\'s id, it has the Claude pane before any hook', async () => {
    const t = await scanned()
    const [agent] = t.src.list()
    expect(t.src.hasPane(agent)).toBe(true)
    expect(await t.src.showPane(agent)).toBe('ok')
    expect(t.actions.claudeShow.mock.calls).toEqual([[agent.id, LOCAL]])
    expect(await t.src.focus(agent, latestTap)).toBe(true)
    // No hook named its app: its pane's adapter does, so a link that fails still brings the app (open.ts).
    expect(t.actions.open.mock.calls).toEqual([[agent.id, { bundle: CLAUDE_APP, pane: { adapter: 'claude', id: LOCAL } }]])
  })

  it('with the Claude app not in front, no rest is offered and none runs', async () => {
    const t = await scanned({ fakes: { claudeInFront: vi.fn(() => false) } })
    const [agent] = t.src.list()
    expect(t.src.hasPane(agent)).toBe(false)
    expect(await t.src.showPane(agent)).toBe('failed')
    expect(t.actions.claudeShow).not.toHaveBeenCalled()
  })

  it('the record\'s id under a Ghostty parent places nothing', async () => {
    const t = await scanned({ app: 'ghostty' })
    await noClaude(t, t.src.list()[0])
  })

  it('the Claude app\'s parents with no id in the record place nothing', async () => {
    const t = await scanned({ record: { name: 'Tho' } })
    const [agent] = t.src.list()
    expect(agent.name).toBe('Tho')
    await noClaude(t, agent)
  })

  it('an app the scan did not learn places nothing', async () => {
    const t = await scanned({ app: undefined })
    await noClaude(t, t.src.list()[0])
  })

  it('the first hook places it by its own hints: another local_ id wins', async () => {
    const t = await scanned()
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a',
      hostHints: { __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LOCAL_OTHER } }))
    const [agent] = t.src.list()
    expect(await t.src.showPane(agent)).toBe('ok')
    expect(t.actions.claudeShow.mock.calls).toEqual([[agent.id, LOCAL_OTHER]])
  })

  it('a first hook whose hints name no app takes the record\'s pane away', async () => {
    const t = await scanned()
    // The record's pane, until the hook.
    expect(t.src.hasPane(t.src.list()[0])).toBe(true)
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: {} }))
    // The caller's parents answer the Claude app.
    await flushed()
    const [agent] = t.src.list()
    expect(agent.app).toBe('claude')
    await noClaude(t, agent)
  })

  it('a Herdr pairing wins', async () => {
    const t = await scanned({ over: { herdrTerminal: (pid) => (pid === 11 ? 't7' : undefined) } })
    const [agent] = t.src.list()
    expect(agent).toMatchObject({ app: 'herdr', paneKeys: ['herdr-app:t7'] })
    expect(await t.src.focus(agent, latestTap)).toBe(true)
    expect(t.actions.open.mock.calls[0][1].pane).toEqual({ adapter: 'herdr-app', id: 't7' })
    await noClaude(t, agent)
  })

  it('a hook that came while the record was read keeps its own place', async () => {
    let answer: (record: { hostSession?: string }) => void = () => {}
    const record = vi.fn(() => new Promise<{ hostSession?: string }>((resolve) => { answer = resolve }))
    const { actions } = fakeActions()
    const s = setup({ actions, apps: async () => new Map([[11, 'claude']]), record })
    s.open.set('a', 'terminal')
    s.owners.set('a', { pid: 11, engine: 'claude', record: '/s/11.json' })
    s.externals.set('a', { cwd: '/x/a' })
    const scan = s.src.scanOpen()
    await vi.waitFor(() => expect(record).toHaveBeenCalled())
    s.src.ingest(s.ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', hostHints: { TERM_PROGRAM: 'ghostty' } }))
    answer({ hostSession: LOCAL })
    await scan
    expect(s.src.list()).toHaveLength(1)
    await noClaude({ ...s, actions }, s.src.list()[0])
  })

  it('the scan\'s line is unchanged and no line holds the id', async () => {
    const t = await scanned()
    expect(t.logs).toEqual(['[observed] scan · 1 found · 1 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
    expect(t.logs.join('\n')).not.toContain('local_')
  })
})

const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const FAILED: CodexQueueResult = { outcome: 'failed', reason: 'exit 1', ran: 'path' }

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

  it('not queue-able: each lists no voice but Claude Code, and its words never reach the queue', async () => {
    const cases: Array<{ session: Partial<ObservedHookEvent>; ended?: boolean; can?: boolean }> = [
      // Claude Code takes voice with no route: its start is told how to reach it.
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
      expect(src.capabilities(src.list()[0]).voice).toBe(session.engine === 'claude')
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
        expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', false, '/home/u/.codex']])
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
      [cx, 'idle', { ok: false, reason: 'Codex could not take it. Try again.' }, 'no-answer'],
    ]
    for (const [session, state, sent, said] of cases) {
      const { src, actions } = given(session, state)
      actions.codexQueue.send.mockResolvedValue(FAILED)
      expect(await src.send(src.list()[0], 'next')).toEqual(sent)
      expect(actions.orcaSend.mock.calls).toEqual(said === 'orca' ? [[HANDLE, 'next']] : [])
      expect(counted(actions.count)).toEqual(['codex-failed (exit 1 · path)', said])
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
        const refused = engine === 'codex' ? 'Codex could not take it. Try again.' : 'proj did not answer.'
        expect(await src.send(src.list()[0], 'next')).toEqual(herdrSocket ? { ok: true } : { ok: false, reason: refused })
        expect(actions.herdrPrompt.mock.calls).toEqual(herdrSocket ? [['w1:p2', engine, 'next']] : [])
        expect(actions.orcaSend).not.toHaveBeenCalled()
        expect(counted(actions.count)).toEqual([...(engine === 'codex' ? ['codex-failed (exit 1 · path)'] : []), herdrSocket ? 'herdr' : 'no-answer'])
      }
    }
  })

  it('a failure is counted with its reason and the codex that ran; a refused one keeps today\'s sentence', async () => {
    const cases: Array<[CodexQueueResult, string, string]> = [
      [{ outcome: 'failed', reason: 'no binary', ran: 'path' }, 'Codex could not take it. Try again.', 'codex-failed (no binary · path)'],
      [{ outcome: 'failed', reason: 'refused' }, 'proj did not answer.', 'codex-failed (refused)'],
    ]
    for (const [result, reason, count] of cases) {
      const { src, actions } = given(cx)
      actions.codexQueue.send.mockResolvedValue(result)
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason })
      expect(actions.count.mock.calls).toEqual([[count], ['no-answer']])
    }
  })

  // A session in the ChatGPT app has no pane to type into, and an older app's CLI has no queue: updating it is what helps.
  it('an app session whose queue failed is told to update ChatGPT', async () => {
    for (const ran of ['app', 'path'] as const) {
      const { src, actions } = given({ ...cx, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } })
      actions.codexQueue.send.mockResolvedValue({ outcome: 'failed', reason: 'exit 127', ran })
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'Update ChatGPT, then try again.' })
      expect(actions.count.mock.calls).toEqual([[`codex-failed (exit 127 · ${ran})`], ['no-answer']])
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
    expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', false, '/home/u/.codex']])
  })

  // `codex queue` loads the home's config.toml: the home is one of Harness's own lists (devices.ts), and a hook's path
  // only picks among them.
  describe('the home the queue runs under', () => {
    const rolloutIn = (home: string) => `${home}/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl`
    /** A Codex session in Ghostty whose rollout is [transcriptPath], with Harness trusting [homes]. */
    const under = (homes: readonly string[], transcriptPath: string) => {
      const { actions } = fakeActions({ codexHomes: () => trusted(...homes) })
      const t = setup({ actions })
      t.src.ingest(t.ev('session-start', { ...cx, transcriptPath }))
      return { ...t, actions }
    }
    // The daemon's, an adopted one, a linked profile as listed and its real path.
    const HOMES = ['/h/own', '/h/adopted', '/h/linked', '/real/linked']

    it.each(['/h/own', '/h/adopted', '/h/linked', '/real/linked'])('a rollout under %s/sessions queues under that home', async (home) => {
      const { src, actions } = under(HOMES, rolloutIn(home))
      expect(src.capabilities(src.list()[0]).voice).toBe(true)
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
      expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', false, home]])
    })

    it('a rollout in a home only its hook names is not queue-able: no queue run, and no voice with no pane that types', async () => {
      const { src, actions } = under(HOMES, rolloutIn('/h/hooked'))
      expect(src.capabilities(src.list()[0]).voice).toBe(false)
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.codexQueue.send).not.toHaveBeenCalled()
      expect(actions.codexQueue.can).not.toHaveBeenCalled()
    })

    // A home holds a rollout by whole parts of its resolved path.
    it.each([['climbs out of a trusted home by ..', '/h/own/sessions/../../hooked'], ['sits in a look-alike of a trusted home', '/h/own2']])(
      'a rollout that %s is not queue-able', async (_, home) => {
        const { src, actions } = under(HOMES, rolloutIn(home))
        expect(src.capabilities(src.list()[0]).voice).toBe(false)
        expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
        expect(actions.codexQueue.send).not.toHaveBeenCalled()
      })

    // trustedCodexHomes lists the deepest first (lib/codexProfiles.ts): a home inside another's sessions folder is the session's.
    it('of two trusted homes holding the rollout, the first listed is the one it runs under', async () => {
      for (const homes of [['/h/a', '/h/a/sessions/b'], ['/h/a/sessions/b', '/h/a']]) {
        const { src, actions } = under(homes, rolloutIn('/h/a/sessions/b'))
        expect(await src.send(src.list()[0], 'next')).toEqual({ ok: true })
        expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', false, homes[0]]])
      }
    })

    // What codexHomes says counts at once, a home added or dropped: its holds are trustedCodexHomes' (lib/codexProfiles.ts).
    it('the trusted homes are asked again at each look', async () => {
      let homes: readonly string[] = []
      const { actions } = fakeActions({ codexHomes: () => trusted(...homes) })
      const { src, ev } = setup({ actions })
      src.ingest(ev('session-start', { ...cx, transcriptPath: rolloutIn('/h/adopted') }))
      expect(src.capabilities(src.list()[0]).voice).toBe(false)
      homes = ['/h/adopted']
      expect(src.capabilities(src.list()[0]).voice).toBe(true)
      homes = []
      expect(await src.send(src.list()[0], 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(actions.codexQueue.send).not.toHaveBeenCalled()
    })
  })

  it('a text over MAX_TEXT characters is refused before the queue', async () => {
    const { src, actions } = given(cx)
    expect(await src.send(src.list()[0], 'a'.repeat(MAX_TEXT + 1))).toEqual({ ok: false, reason: 'Too long. Say it shorter.' })
    expect(actions.codexQueue.send).not.toHaveBeenCalled()
  })

  // Ten minutes of fast speech is about 13,000 characters, and a carried passage rides with it.
  it('a text of 10,000 or 20,000 characters reaches the mod, Codex\'s queue and an Orca terminal whole', async () => {
    for (const text of ['x'.repeat(10_000), 'x'.repeat(20_000)]) {
      const mod = fakeActions()
      const toMod = setup({ actions: mod.actions })
      mod.ready.add('s1')
      toMod.src.ingest(toMod.ev('turn-stop', { hostHints: inOrca.hostHints }))
      expect(await toMod.src.send(toMod.src.list()[0], text)).toEqual({ ok: true })
      expect(mod.actions.toMod.mock.calls).toEqual([['s1', text]])

      const orca = fakeActions()
      const toOrca = setup({ actions: orca.actions })
      toOrca.src.ingest(toOrca.ev('turn-stop', { hostHints: inOrca.hostHints }))
      expect(await toOrca.src.send(toOrca.src.list()[0], text)).toEqual({ ok: true })
      expect(orca.actions.orcaSend.mock.calls).toEqual([[HANDLE, text]])

      const { src, actions } = given(cx)
      expect(await src.send(src.list()[0], text)).toEqual({ ok: true })
      expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, text, false, '/home/u/.codex']])
    }
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
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.openai.codex', pane }]])
  })

  it('one only the scan found has its thread\'s pane before any hook, and no bundle', async () => {
    const { src, actions } = await scanned()
    const agent = src.list()[0]
    expect(agent).toMatchObject({ app: 'codex', host: 'terminal' })
    expect(agent).not.toHaveProperty('appPending')
    expect(src.capabilities(agent)).toMatchObject({ focus: true })
    expect(await src.focus(agent, latestTap)).toBe(true)
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
      expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', true, '/home/u/.codex']])
      expect(counted(actions.count).at(-1)).toBe('codex')
      expect(ran).not.toHaveBeenCalled()
    }
  })

  // The ChatGPT app's own codex queues into its threads (codexQueue.ts): the queue is told which sessions are the app's.
  it('a Codex app session asks the queue as the app\'s, and a Codex in Ghostty does not', async () => {
    for (const [session, isApp] of [[{ ...inApp, transcriptPath: rollout }, true],
      [{ ...inApp, transcriptPath: rollout, hostHints: { TERM_PROGRAM: 'ghostty' } }, false]] as const) {
      const { src, actions } = hooked(session)
      const agent = src.list()[0]
      src.capabilities(agent)
      expect(await src.send(agent, 'next')).toEqual({ ok: true })
      expect(actions.codexQueue.can.mock.calls.length).toBeGreaterThan(0)
      expect(new Set(actions.codexQueue.can.mock.calls.map(([asked]) => asked))).toEqual(new Set([isApp]))
      expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', isApp, '/home/u/.codex']])
    }
  })

  it('with only the app\'s codex there, an app session lists voice and a Codex in Ghostty does not', () => {
    for (const [session, voice] of [[{ ...inApp, transcriptPath: rollout }, true],
      [{ ...inApp, transcriptPath: rollout, hostHints: { TERM_PROGRAM: 'ghostty' } }, false]] as const) {
      const { src, actions } = hooked(session)
      actions.codexQueue.can.mockImplementation((isApp) => isApp)
      expect(src.capabilities(src.list()[0]).voice).toBe(voice)
    }
  })

  // Its app is learned from its next hook: until then it takes the other codex.
  it('a session whose app is not known yet is not the app\'s', async () => {
    const { src, actions } = await scanned(new Map())
    const agent = src.list()[0]
    expect(src.capabilities(agent)).toMatchObject({ voice: true })
    expect(await src.send(agent, 'next')).toEqual({ ok: true })
    expect(actions.codexQueue.can.mock.calls.length).toBeGreaterThan(0)
    expect(new Set(actions.codexQueue.can.mock.calls.map(([asked]) => asked))).toEqual(new Set([false]))
    expect(actions.codexQueue.send.mock.calls).toEqual([[THREAD, 'next', false, '/home/u/.codex']])
  })

  it('a Codex session in Ghostty has no Codex pane', async () => {
    const { src, actions } = hooked({ ...inApp, hostHints: { TERM_PROGRAM: 'ghostty' } })
    const agent = src.list()[0]
    expect(await src.focus(agent, latestTap)).toBe(true)
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
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.openai.codex' }]])
  })

  it('the pane is the latest event\'s', async () => {
    const { src, ev, actions } = hooked()
    src.ingest(ev('turn-start', { ...inApp, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(src.hasPane(agent)).toBe(false)
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty' }]])
  })
})

// A session the scan found has had no hook to name its caller or its app (VS Code's terminal pane, vscode.ts).
describe('ObservedSource and a session the scan found', () => {
  /** An adapter that places every agent by its process, and the pids it was asked about. */
  const byPid = (bundle?: string) => {
    const pids: (number | undefined)[] = []
    const adapter: HostAdapter = {
      id: 'pid', tap: 'before', ...(bundle ? { bundle } : {}),
      paneOf: (place: Place): Pane | undefined => {
        pids.push(place.pid)
        return place.pid === undefined ? undefined : { adapter: 'pid', id: `p${place.pid}` }
      },
      canFocus: () => true,
      focus: async () => true,
    }
    const { actions } = fakeActions()
    return { actions: { ...actions, adapters: [adapter] }, pids }
  }
  /** A session only the open scan found, its process 100. */
  const scanned = async (bundle?: string) => {
    const { actions, pids } = byPid(bundle)
    const t = setup({ actions })
    t.open.set('s1', 'terminal')
    t.owners.set('s1', { pid: 100, engine: 'claude' })
    t.externals.set('s1', { cwd: '/work/proj' })
    await t.src.scanOpen()
    return { ...t, actions, pids }
  }

  it('a session the scan found is placed by its own pid until a hook names its caller', async () => {
    const { src, ev, pids } = await scanned()
    expect(pids.at(-1)).toBe(100)
    src.ingest(ev('turn-start', { callerPid: 222 }))
    expect(pids.at(-1)).toBe(222)
  })

  it('a tap on a session the scan found takes its pane\'s adapter\'s bundle', async () => {
    const { src, actions } = await scanned('com.example.app')
    const agent = src.list()[0]
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.example.app', pane: { adapter: 'pid', id: 'p100' } }]])
  })

  it('an entry\'s own bundle wins over its pane\'s adapter\'s', async () => {
    const { src, ev, actions } = await scanned('com.example.app')
    src.ingest(ev('turn-start', { callerPid: 222, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    const agent = src.list()[0]
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { bundle: 'com.mitchellh.ghostty', pane: { adapter: 'pid', id: 'p222' } }]])
  })

  it('a pane whose adapter declares no bundle adds none', async () => {
    const { src, actions } = await scanned()
    const agent = src.list()[0]
    expect(await src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls).toEqual([[agent.id, { pane: { adapter: 'pid', id: 'p100' } }]])
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
    expect(s.logs).toContain('[observed] app · not read · Error')
    expect(s.logs.join('\n')).not.toContain('someone')
  })

  // Cursor's terminal says TERM_PROGRAM=vscode too: only a bundle id tells them apart, and Linux has none.
  it('a hook that names VS Code by TERM_PROGRAM alone is placed in the editor its caller\'s parents name', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    expect(s.apps.mock.calls).toEqual([[[100]]])
    await s.walks[0].answer('cursor')
    expect(s.agent('s1').app).toBe('cursor')
  })

  it('a walk that names no app leaves VS Code, as TERM_PROGRAM said; with VS Code\'s bundle id nothing is walked', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { hostHints: { TERM_PROGRAM: 'vscode' } }))
    await s.walks[0]?.answer()
    expect(s.agent('s1').app).toBe('vscode')
    s.src.ingest(s.ev('session-start', { sessionId: 'b', callerPid: 101,
      hostHints: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' } }))
    expect(s.agent('b').app).toBe('vscode')
    expect(s.apps).toHaveBeenCalledTimes(1)
  })

  // Every program started from an Orca terminal keeps its TERM_PROGRAM=Orca unless it sets its own (kitty, the Claude
  // app), and Linux has no bundle id to name it: the caller's parents do.
  it('a hook that names Orca by TERM_PROGRAM alone is placed in the app its caller\'s parents name', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { hostHints: { TERM_PROGRAM: 'Orca' } }))
    expect(s.apps.mock.calls).toEqual([[[100]]])
    await s.walks[0].answer('kitty')
    expect(s.agent('s1').app).toBe('kitty')
  })

  it('a walk that names no app leaves Orca, as TERM_PROGRAM said; with Orca\'s bundle id nothing is walked', async () => {
    const s = walked()
    s.src.ingest(s.ev('session-start', { hostHints: { TERM_PROGRAM: 'Orca' } }))
    await s.walks[0]?.answer()
    expect(s.agent('s1').app).toBe('orca')
    s.src.ingest(s.ev('session-start', { sessionId: 'b', callerPid: 101,
      hostHints: { TERM_PROGRAM: 'Orca', __CFBundleIdentifier: 'com.stablyai.orca' } }))
    expect(s.agent('b').app).toBe('orca')
    expect(s.apps).toHaveBeenCalledTimes(1)
  })

  // Windows' parents name no app (scannedApp.ts scanLearnsApps): a walk there would only hold an Orca agent on Other's
  // page until it answers, as its first turn after the devices started again is followed and counted.
  it('on Windows a hook that names Orca by TERM_PROGRAM alone is Orca\'s at once, walking nothing', () => {
    const apps = vi.fn(async (): Promise<ReadonlyMap<number, string>> => new Map())
    const s = setup({ platform: 'win32', apps })
    s.src.ingest(s.ev('turn-start', { hostHints: { TERM_PROGRAM: 'Orca' } }))
    expect(s.src.list()[0].app).toBe('orca')
    expect(apps).not.toHaveBeenCalled()
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
    const tty = vi.fn(async (_pid: number): Promise<TabTty | undefined> => ({ tty: '/dev/ttys023' }))
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

// `code .` (or `cursor .`) from Terminal: the editor inherits Terminal's bundle id, while its terminals say
// TERM_PROGRAM=vscode. The bundle id won, and the agent sat on Terminal's page, a tap opening Terminal (V11).
describe('ObservedSource and an editor started from Terminal', () => {
  const FROM_TERMINAL = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.apple.Terminal' }

  /** The real VS Code and Cursor adapters on macOS, the caller's parents naming [app]. */
  function editors(app: string) {
    const run = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ code: 0, stdout: '' }))
    const deps: OrcaDeps = { run, onPath: (name) => `/fake/bin/${name}`, exists: () => false, platform: 'darwin' }
    const terminals = { terminalOf: () => undefined, show: () => false, scroll: () => false, pageKeys: () => false as const,
      canType: () => false, type: async () => 'failed' as const }
    const adapters = (['vscode', 'cursor'] as const).map((editor) => createVscodeAdapter(editor, { ...deps, inFront: () => true, terminals }))
    const { actions } = fakeActions()
    const s = setup({ actions: { ...actions, adapters }, apps: async (pids) => new Map(pids.map((pid) => [pid, app])) })
    return { ...s, actions }
  }

  it.each([
    ['VS Code', 'vscode', 'com.microsoft.VSCode'],
    ['Cursor', 'cursor', 'com.todesktop.230313mzl4w4u92'],
  ])('an agent in a terminal of %s started from Terminal is in that editor, at its terminal, and a tap opens that editor', async (_, app, bundle) => {
    const s = editors(app)
    s.src.ingest(s.ev('session-start', { hostHints: FROM_TERMINAL }))
    await flushed()
    const agent = s.src.list()[0]
    expect([agent.host, agent.app]).toEqual(['vscode', app])
    expect(s.src.paneOf(agent.id, app)).toBe('term:100')
    // No window reported its terminal: the tap is the editor's bundle alone, Cursor's for an agent in Cursor.
    expect(await s.src.focus(agent, latestTap)).toBe(true)
    expect(s.actions.open.mock.calls).toEqual([[agent.id, { bundle }]])
  })

  // The extension's tab runs with the editor's own environment, which has Terminal's bundle id and no TERM_PROGRAM.
  it.each([
    ['VS Code', 'vscode', 'com.microsoft.VSCode'],
    ['Cursor', 'cursor', 'com.todesktop.230313mzl4w4u92'],
  ])('a session in the extension\'s tab of %s started from Terminal is in that editor, at its tab, and a tap opens it there', async (_, app, bundle) => {
    const sessionId = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const s = editors(app)
    s.src.ingest(s.ev('session-start', { sessionId,
      hostHints: { __CFBundleIdentifier: 'com.apple.Terminal', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } }))
    await flushed()
    const agent = s.src.list()[0]
    expect(agent.app).toBe(app)
    expect(s.src.paneOf(agent.id, app)).toBe(sessionId)
    expect(await s.src.focus(agent, latestTap)).toBe(true)
    expect(s.actions.open.mock.calls).toEqual([[agent.id, { bundle, pane: { adapter: app, id: sessionId } }]])
  })

  // Off macOS no app inherits a bundle id: on Windows the hook finds it from the process's parents, the Claude app's
  // own word first (notify.mjs lookUpWindowsApp), and a Claude app session can carry an editor's TERM_PROGRAM.
  it.each(['win32', 'linux'] as const)('on %s a bundle id beside TERM_PROGRAM=vscode is kept: a Claude app session stays on the Claude page', async (platform) => {
    const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const CLAUDE_APP = 'com.anthropic.claudefordesktop'
    const { actions } = fakeActions({}, platform)
    const s = setup({ platform, actions })
    s.src.ingest(s.ev('session-start', { hostHints: { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CLAUDE_APP,
      CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_HOST_SESSION_ID: SESSION } }))
    await flushed()
    const agent = s.src.list()[0]
    expect([agent.host, agent.app]).toEqual(['claude', 'claude'])
    expect(s.src.paneOf(agent.id, 'claude')).toBe(SESSION)
    expect(await s.src.focus(agent, latestTap)).toBe(true)
    expect(actions.open.mock.calls[0][1].bundle).toBe(CLAUDE_APP)
  })
})

// Ken's VM, 2026-11-26: after the daemon restarted, Claude Code in VS Code's terminal came back only at its next hook. The
// scan found it, but learnt no app on Windows, so it sat on Other's page with no terminal pane
// (docs/plans/2026-11-26-windows-rescan-after-restart-design.md).
describe('ObservedSource on Windows after a restart', () => {
  const homes: string[] = []
  const platform = process.platform
  // The transcript's head is judged by this machine's rules: a `C:\...` folder is a folder on Windows only.
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('a Claude Code the scan found in VS Code\'s terminal is on VS Code\'s page, known, at its terminal', async () => {
    const SESSION = '8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
    const started = Date.parse('2026-11-26T09:00:00Z')
    // A Claude home of its own: the transcript, and the record the running Claude Code keeps of its pid.
    const home = mkdtempSync(join(tmpdir(), 'observed-windows-'))
    homes.push(home)
    mkdirSync(join(home, 'projects', 'C--work-dial'), { recursive: true })
    writeFileSync(join(home, 'projects', 'C--work-dial', `${SESSION}.jsonl`), `${JSON.stringify({
      type: 'user', sessionId: SESSION, cwd: 'C:\\work\\dial', entrypoint: 'cli', timestamp: '2026-11-26T09:00:01Z',
      message: { role: 'user', content: 'fix the dial scroll' },
    })}\n`)
    mkdirSync(join(home, 'sessions'))
    writeFileSync(join(home, 'sessions', '410.json'), JSON.stringify({ pid: 410, sessionId: SESSION, status: 'idle', startedAt: started + 400 }))
    // VS Code's terminal as the PTY host lists it: VS Code, its pty host, PowerShell and Claude Code, each started after
    // its parent.
    const tree: ProcessRow[] = ([[400, 1, 'Code.exe'], [401, 400, 'Code.exe'], [409, 401, 'pwsh.exe'], [410, 409, 'claude.exe']] as const)
      .map(([pid, parentPid, executable], i) => ({ pid, parentPid, executable, startMarker: `w:${134087000000000000 + i * 10_000}`, args: executable }))
    const providers = [claudeProvider({ projectsDir: join(home, 'projects'), home })]
    const openSessions = new OpenSessions({
      providers,
      view: () => ({
        list: async () => [{ pid: 410, ppid: 409, executable: 'claude.exe', args: 'C:\\Users\\someone\\.local\\bin\\claude.exe', started }],
        openFiles: async () => new Map(), openFilesOf: async () => new Map(), cwds: async () => new Map(), alive: (pid) => pid === 410,
      }),
      // Windows names no terminal (processTtys).
      ttys: async (pids) => new Map(pids.map((pid) => [pid, null])),
      harnessTtys: async () => new Set(),
    })
    const run = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ code: 0, stdout: '' }))
    const terminals = { terminalOf: () => undefined, show: () => false, scroll: () => false, pageKeys: () => false as const,
      canType: () => false, type: async () => 'failed' as const }
    const vscode = createVscodeAdapter('vscode', { run, onPath: (name) => `/fake/bin/${name}`, platform: 'win32', inFront: () => true, terminals })
    // As devices.ts wires the scan on Windows: no look's table, so the walk reads the PTY host's own.
    const s = setup({
      platform: 'win32', openSessions, sessionRows: new SessionRows({ providers, excluded: ['/data/harness'] }),
      actions: { ...fakeActions({}, 'win32').actions, adapters: [vscode] },
      apps: (pids, rows) => learnApps(pids, rows, undefined, 'win32', async () => tree),
    })
    await s.src.scanOpen()
    const agent = s.src.list()[0]
    expect(agent).toMatchObject({ sessionId: SESSION, app: 'vscode' })
    expect(agent).not.toHaveProperty('appPending')
    expect(s.src.paneOf(agent.id, 'vscode')).toBe('term:410')
  })
})

// Found during #4634 (Ken's VM, 2026-11-26): after the daemon restarted, a Codex in VS Code's terminal came back only at
// its next hook, as Windows read no process's open files or folder (docs/plans/2026-11-27-windows-codex-rescan-design.md).
describe('ObservedSource and a Codex on Windows after a restart', () => {
  const homes: string[] = []
  const platform = process.platform
  // The rollout's head is judged by this machine's rules: a `C:\...` folder is a folder on Windows only.
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }) })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  const NPM = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'
  const NATIVE = `${NPM}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  const DIAL = 'C:\\work\\dial'
  const OTHER = 'C:\\work\\other'
  /** A row as the PTY host's table gives it, started at [at] (`w:<FILETIME>`): a child after its parent. */
  const win = (pid: number, ppid: number, at: number, executable: string, args: string = executable) =>
    ({ pid, ppid, executable, args, startMarker: `w:${134087000000000000 + at * 10_000}` })
  type Row = ReturnType<typeof win>
  /** VS Code's terminal: npm's launcher (420) and its native Codex (421). */
  const vscodeTui = (first = 0): Row[] => [win(400, 1, first, 'Code.exe'), win(401, 400, first + 1, 'Code.exe'),
    win(409, 401, first + 2, 'pwsh.exe'), win(420, 409, first + 3, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`),
    win(421, 420, first + 4, NATIVE)]
  /** Codex's daemon, started by the TUI [ppid]. */
  const daemon = (ppid: number, at: number): Row =>
    win(430, ppid, at, NATIVE, `${NATIVE} app-server --listen unix:// --analytics-default-enabled`)
  /** A TUI in Windows Terminal (520, 521), working in another folder. */
  const terminalTui: Row[] = [win(500, 1, 0, 'WindowsTerminal.exe'), win(509, 500, 1, 'pwsh.exe'),
    win(520, 509, 2, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`), win(521, 520, 3, NATIVE)]
  /** The first TUI in Windows Terminal, the session's in VS Code, the daemon the first one's child. */
  const startedInTerminal = (): Row[] => [...terminalTui, ...vscodeTui(4), daemon(521, 9)]
  const startedInTerminalFolders = { 420: DIAL, 421: DIAL, 520: OTHER, 521: OTHER }

  /**
   * The open scan and the served lookup as devices.ts wires them on Windows, over the table [rows] and a Codex home
   * whose one rollout [holder] holds, harness-pty files naming each process's folder from [folders]. Each lookup waits
   * for [before] first.
   */
  function windows(rows: Row[], folders: Record<number, string>, holder: number, before: Promise<void> = Promise.resolve()) {
    const home = mkdtempSync(join(tmpdir(), 'observed-windows-codex-'))
    homes.push(home)
    const day = join(home, 'sessions', '2026', '11', '27')
    mkdirSync(day, { recursive: true })
    const rollout = join(day, `rollout-2026-11-27T09-00-00-${THREAD}.jsonl`)
    writeFileSync(rollout, [
      { timestamp: '2026-11-27T09:00:00Z', type: 'session_meta', payload: { id: THREAD, cwd: DIAL, originator: 'codex-tui', source: 'vscode' } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ].map((line) => `${JSON.stringify(line)}\n`).join(''))
    // What harness-pty files says of each process asked: its start as the table's, its folder, and its open files.
    const files = vi.fn<WindowsFilesRead>(async (pids) => new Map(pids.flatMap((pid) => {
      const row = rows.find((r) => r.pid === pid)
      return row ? [[pid, { startMarker: row.startMarker, ...(folders[pid] ? { cwd: folders[pid] } : {}), files: pid === holder ? [rollout] : [] }] as const] : []
    })))
    const providers = [codexProvider({ home })]
    const openSessions = new OpenSessions({
      providers,
      view: () => processView(undefined, (pid) => rows.some((row) => row.pid === pid), async () => rows, undefined, 'win32', files),
      // Windows names no terminal (processTtys).
      ttys: async (pids) => new Map(pids.map((pid) => [pid, null])),
      harnessTtys: async () => new Set(),
    })
    const tree: ProcessRow[] = rows.map(({ pid, ppid, executable, args, startMarker }) => ({ pid, parentPid: ppid, executable, args, startMarker }))
    const tty = vi.fn(async (_pid: number): Promise<string | undefined> => undefined)
    const lookup: CodexServedDeps = {
      platform: 'win32', processes: async () => rows,
      cwds: (pids) => processCwds(pids, undefined, 'win32', undefined, files),
      tty, apps: (pids, names) => learnApps(pids, names, undefined, 'win32'), folder: async (path) => path,
    }
    const lookups: Promise<unknown>[] = []
    const terminals = { terminalOf: () => undefined, show: () => false, scroll: () => false, pageKeys: () => false as const,
      canType: () => false, type: async () => 'failed' as const }
    const run = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ code: 0, stdout: '' }))
    const s = setup({
      platform: 'win32', openSessions, sessionRows: new SessionRows({ providers, excluded: ['/data/harness'] }),
      actions: { ...fakeActions({}, 'win32').actions, adapters: [
        createVscodeAdapter('vscode', { run, onPath: (name) => `/fake/bin/${name}`, platform: 'win32', inFront: () => true, terminals }),
        createVscodeClientAdapter('vscode', { inFront: () => true, terminals }),
      ] },
      // No look's table, so the walk reads the PTY host's own.
      apps: (pids, names) => learnApps(pids, names, undefined, 'win32', async () => tree),
      served: (asks) => {
        const asked = before.then(() => codexServed(asks, lookup))
        lookups.push(asked)
        return asked
      },
    })
    /** Every lookup asked so far has landed. */
    const settled = async (): Promise<void> => { await Promise.allSettled(lookups); await flushed() }
    /** A hook from the daemon, with the first TUI's Windows Terminal in its environment. */
    const hook = (event: ObservedHookEvent['event']) => s.ev(event, {
      engine: 'codex', sessionId: THREAD, callerPid: 430, cwd: DIAL, transcriptPath: rollout,
      hostHints: { WT_SESSION: '0b5f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e' },
    })
    return { ...s, tty, files, lookups, settled, hook }
  }

  it('the daemon holds the rollout: on VS Code\'s page at its TUI\'s terminal', async () => {
    const t = windows([...vscodeTui(), daemon(421, 5)], { 420: DIAL, 421: DIAL }, 430)
    await t.src.scanOpen()
    expect(t.src.list()).toHaveLength(1)
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ sessionId: THREAD, app: 'vscode' })
    expect(agent).not.toHaveProperty('appPending')
    // npm's launcher is the TUI: its terminal is the one VS Code shows.
    expect(t.src.windowOf(agent.id)).toEqual({ pid: 420, app: 'vscode', outer: true })
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBe('client:420')
    expect(t.src.paneOf(agent.id, 'vscode')).toBeUndefined()
    expect(t.logs[0]).toMatch(/^\[observed\] scan · 1 found · 1 app known · /)
    expect(t.tty).not.toHaveBeenCalled()
  })

  it('the TUI holds it itself: on VS Code\'s page at its terminal', async () => {
    const t = windows(vscodeTui(), { 420: DIAL, 421: DIAL }, 421)
    await t.src.scanOpen()
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ sessionId: THREAD, app: 'vscode' })
    expect(agent).not.toHaveProperty('appPending')
    expect(t.src.paneOf(agent.id, 'vscode')).toBe('term:421')
  })

  // Ken's VM, 2026-11-27 (#4663 step 10): two Codex TUIs in VS Code's terminals in one folder, the daemon restarted. Both
  // sat on Other's page, and each turn's lookup put them there again.
  const secondVscodeTui: Row[] = [win(410, 401, 6, 'pwsh.exe'), win(440, 410, 7, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`),
    win(441, 440, 8, NATIVE)]
  const twoInVscodeFolders = { 420: DIAL, 421: DIAL, 440: DIAL, 441: DIAL }

  it('two TUIs in its folder, both in VS Code: on VS Code\'s page with no tab, and a daemon\'s turn keeps it there', async () => {
    const t = windows([...vscodeTui(), daemon(421, 5), ...secondVscodeTui], twoInVscodeFolders, 430)
    await t.src.scanOpen()
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ sessionId: THREAD, app: 'vscode' })
    expect(agent.appPending).toBeUndefined()
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBeUndefined()
    expect(t.src.paneOf(agent.id, 'vscode')).toBeUndefined()
    expect(t.src.windowOf(agent.id)).toBeUndefined()
    t.src.ingest(t.hook('turn-start'))
    await t.settled()
    expect(t.lookups).toHaveLength(2)
    expect(t.src.list()[0].app).toBe('vscode')
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBeUndefined()
  })

  it('two TUIs in its folder, once one quit: a daemon\'s turn puts it at the one left\'s terminal', async () => {
    const rows = [...vscodeTui(), daemon(421, 5), ...secondVscodeTui]
    const t = windows(rows, twoInVscodeFolders, 430)
    await t.src.scanOpen()
    const { id } = t.src.list()[0]
    rows.splice(rows.findIndex((row) => row.pid === 410), secondVscodeTui.length)
    t.src.ingest(t.hook('turn-start'))
    await t.settled()
    expect(t.src.list()[0].app).toBe('vscode')
    expect(t.src.paneOf(id, 'vscode-tab')).toBe('client:420')
    expect(t.src.windowOf(id)).toEqual({ pid: 420, app: 'vscode', outer: true })
  })

  it('two TUIs in its folder, one in VS Code and one in Windows Terminal: on no app\'s page, never a guess', async () => {
    const t = windows([...vscodeTui(4), daemon(421, 9), ...terminalTui], { 420: DIAL, 421: DIAL, 520: DIAL, 521: DIAL }, 430)
    await t.src.scanOpen()
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ sessionId: THREAD, app: 'terminal' })
    expect(agent.appPending).toBeUndefined()
    t.src.ingest(t.hook('turn-start'))
    await t.settled()
    expect(t.src.list()[0].app).toBe('terminal')
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBeUndefined()
  })

  it('the daemon\'s parent is a TUI in Windows Terminal: VS Code\'s page, never the daemon\'s parents\'', async () => {
    const t = windows(startedInTerminal(), startedInTerminalFolders, 430)
    await t.src.scanOpen()
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ sessionId: THREAD, app: 'vscode' })
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBe('client:420')
  })

  it('the daemon\'s hooks keep it at its client, whatever the first TUI\'s hints say', async () => {
    const t = windows(startedInTerminal(), startedInTerminalFolders, 430)
    await t.src.scanOpen()
    const { id } = t.src.list()[0]
    const apps: string[] = []
    t.src.onChange(() => { apps.push(t.src.list()[0].app) })
    for (const event of ['session-start', 'turn-start', 'turn-stop'] as const) {
      t.src.ingest(t.hook(event))
      await t.settled()
      expect(t.src.list()[0].app).toBe('vscode')
      expect(t.src.paneOf(id, 'vscode-tab')).toBe('client:420')
    }
    // A session's start asks its client again.
    expect(t.lookups).toHaveLength(2)
    expect(apps.length).toBeGreaterThan(0)
    expect(new Set(apps)).toEqual(new Set(['vscode']))
    expect(t.tty).not.toHaveBeenCalled()
  })

  it('a daemon\'s first hook, the scan not run: on no page while asked, then VS Code\'s', async () => {
    let ask!: () => void
    const t = windows(startedInTerminal(), startedInTerminalFolders, 430, new Promise<void>((resolve) => { ask = resolve }))
    t.src.ingest(t.hook('session-start'))
    expect(t.src.list()[0]).toMatchObject({ app: 'terminal', appPending: true })
    ask()
    await t.settled()
    const agent = t.src.list()[0]
    expect(agent.app).toBe('vscode')
    expect(agent.appPending).toBeUndefined()
    expect(t.src.paneOf(agent.id, 'vscode-tab')).toBe('client:420')
  })
})

// A terminal or an editor started from another host's pane keeps that pane's variables, so only the process that made
// the caller's pseudo-terminal says whose pane it is (scannedApp.ts readPtyOwner): words typed into a pane that only holds
// the agent run at whatever that pane shows.
describe('ObservedSource and the host that owns its caller\'s terminal', () => {
  const ZELLIJ = { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 's1', ZELLIJ_PANE_ID: '1' }

  /** A source with Zellij's adapter, whose listing names pane 1 a terminal whose program runs, and tmux's, whose pane's
   *  process is the agent's; each read of a caller's terminal's owner answered by hand, in the order they began. */
  function owned() {
    const reads: Array<{ answer(owner?: string): Promise<void>; fail(): Promise<void> }> = []
    const ptyOwner = vi.fn((_pid: number) => new Promise<string | undefined>((resolve, reject) => {
      reads.push({
        answer: (owner) => { resolve(owner); return flushed() },
        fail: () => { reject(new Error('ps timed out under /Users/someone')); return flushed() },
      })
    }))
    const run = vi.fn(async (_file: string, args: string[], _timeoutMs: number) => ({ code: 0, stdout: args.includes('list-panes')
      ? JSON.stringify([{ id: 1, is_plugin: false, exited: false }]) : args[0] === 'display-message' ? '100|work|\n' : '' }))
    const present = async () => ({ state: 'present' as const })
    const adapters = [
      createZellijAdapter({ run, zellij: present, platform: 'linux' }),
      createTmuxAdapter({ run, tmux: present, processes: async () => [{ pid: 100, ppid: 1, executable: 'claude' }], log: () => {}, front: () => undefined, platform: 'darwin' }),
    ]
    const { actions } = fakeActions()
    const s = setup({ actions: { ...actions, adapters }, ptyOwner })
    const agent = () => s.src.list()[0]
    // Its own Zellij pane: none while that pane only holds it.
    const zellijPane = () => s.src.paneOf(agent().id, 'zellij')
    return { ...s, actions, run, ptyOwner, reads, agent, zellijPane }
  }

  it('until its caller\'s terminal is read, its Zellij pane takes a tap and no words; read as Zellij\'s, it takes them', async () => {
    const s = owned()
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ }))
    expect(s.zellijPane()).toBeUndefined()
    expect(s.src.capabilities(s.agent())).toMatchObject({ voice: true, focus: true })
    expect(s.src.voiceRefusal(s.agent())).toBe(CLAUDE_PLUGIN_OFF)
    s.changes.mockClear()
    await s.reads[0].answer('zellij')
    expect(s.zellijPane()).toBe('s1:1')
    expect(s.src.capabilities(s.agent())).toMatchObject({ voice: true, focus: true })
    expect(s.src.voiceRefusal(s.agent())).toBeUndefined()
    expect(s.changes).toHaveBeenCalledTimes(1)
    expect(await s.src.send(s.agent(), 'next')).toEqual({ ok: true })
    expect(s.run.mock.calls.map(([, args]) => args[3])).toEqual(['list-panes', 'write-chars', 'send-keys'])
  })

  // `code .` run in a Zellij pane: Codex in VS Code's terminal keeps the pane's variables, and VS Code made its terminal.
  it('a terminal started from a pane is read as no host\'s: the pane takes a tap and never words', async () => {
    const s = owned()
    s.src.ingest(s.ev('session-start', { engine: 'codex', hostHints: { ...ZELLIJ, TERM_PROGRAM: 'vscode' } }))
    await s.reads[0].answer(undefined)
    expect(s.zellijPane()).toBeUndefined()
    expect(s.src.capabilities(s.agent())).toMatchObject({ voice: false, focus: true })
    expect(await s.src.send(s.agent(), 'next')).toMatchObject({ ok: false })
    expect(s.run).not.toHaveBeenCalled()
  })

  it('read once per caller: its later events read nothing, another caller is held until read, and a left one\'s answer is dropped', async () => {
    const s = owned()
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ }))
    s.src.ingest(s.ev('turn-start', { hostHints: ZELLIJ }))
    await s.reads[0].answer('zellij')
    s.src.ingest(s.ev('turn-stop', { hostHints: ZELLIJ }))
    expect(s.ptyOwner.mock.calls).toEqual([[100]])
    expect(s.zellijPane()).toBe('s1:1')
    // Resumed in another process, then another before the first answers.
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ, callerPid: 200 }))
    expect(s.zellijPane()).toBeUndefined()
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ, callerPid: 300 }))
    await s.reads[1].answer('zellij')
    expect(s.zellijPane()).toBeUndefined()
    await s.reads[2].answer('zellij')
    expect(s.zellijPane()).toBe('s1:1')
    expect(s.ptyOwner.mock.calls).toEqual([[100], [200], [300]])
  })

  it('a read that fails holds its panes, logs its kind alone, and is read again on a later event after 10 s', async () => {
    const s = owned()
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ }))
    await s.reads[0].fail()
    expect(s.zellijPane()).toBeUndefined()
    expect(s.logs).toContain('[observed] pty · not read · Error')
    expect(s.logs.join('\n')).not.toContain('someone')
    s.src.ingest(s.ev('turn-start', { hostHints: ZELLIJ }))
    expect(s.ptyOwner).toHaveBeenCalledTimes(1)
    s.clock.t += 10_000
    s.src.ingest(s.ev('turn-stop', { hostHints: ZELLIJ }))
    expect(s.ptyOwner).toHaveBeenCalledTimes(2)
    await s.reads[1].answer('zellij')
    expect(s.zellijPane()).toBe('s1:1')
  })

  it('an Orca terminal\'s and a herdr pane\'s caller has its maker read once, as WezTerm\'s', async () => {
    const s = owned()
    const orca = { sessionId: 'orca', hostHints: { ORCA_TERMINAL_HANDLE: HANDLE }, callerPid: 200 }
    const herdr = { sessionId: 'herdr', hostHints: { HERDR_PANE_ID: 'w1:p2' }, callerPid: 300 }
    s.src.ingest(s.ev('session-start', orca))
    s.src.ingest(s.ev('session-start', herdr))
    s.src.ingest(s.ev('turn-start', orca))
    await s.reads[0].answer('orca')
    await s.reads[1].answer('herdr')
    s.src.ingest(s.ev('turn-stop', orca))
    s.src.ingest(s.ev('turn-start', herdr))
    expect(s.ptyOwner.mock.calls).toEqual([[200], [300]])
  })

  // Only WezTerm's, kitty's, Zellij's, Orca's and herdr's panes take words on the terminal their host made alone: reading
  // any other caller's would add a read of the process table to its hook for nothing.
  it('a caller whose hints name no WezTerm, kitty, Zellij, Orca or herdr pane is never read', () => {
    const s = owned()
    const others: Array<Record<string, string>> = [{ TMUX_PANE: '%3' }, { TERM_PROGRAM: 'ghostty' }, {}]
    for (const hostHints of others) s.src.ingest(s.ev('session-start', { hostHints }))
    s.src.ingest(s.ev('session-start', { hostHints: { WEZTERM_PANE: '7' }, callerPid: 200 }))
    s.src.ingest(s.ev('session-start', { hostHints: { KITTY_WINDOW_ID: '5' }, callerPid: 300 }))
    expect(s.ptyOwner.mock.calls).toEqual([[200], [300]])
  })

  // tmux started in a Zellij pane keeps the pane's variables, and Zellij's adapter comes first: a tap there would only
  // focus the pane that shows tmux's client, never select the agent's own tmux pane.
  it('tmux inside a Zellij pane: a tap takes tmux\'s pane, as tmux made its terminal, and no words go to Zellij\'s', async () => {
    const s = owned()
    s.src.ingest(s.ev('session-start', { hostHints: { ...ZELLIJ, TMUX_PANE: '%3' } }))
    await s.reads[0].answer('tmux')
    expect(await s.src.focus(s.agent(), latestTap)).toBe(true)
    expect(s.actions.open.mock.calls.map(([, target]) => target.pane)).toEqual([{ adapter: 'tmux', id: '%3:100' }])
    expect(s.src.voiceRefusal(s.agent())).toBe(CLAUDE_PLUGIN_OFF)
  })

  it('with no read of it (Windows), every pane of a terminal or a multiplexer only holds the agent', () => {
    const { actions } = fakeActions()
    const s = setup({ actions: { ...actions, adapters: [createZellijAdapter({ run: vi.fn(), zellij: async () => ({ state: 'present' }), platform: 'linux' })] } })
    s.src.ingest(s.ev('session-start', { hostHints: ZELLIJ }))
    expect(s.src.paneOf(s.src.list()[0].id, 'zellij')).toBeUndefined()
    expect(s.src.capabilities(s.src.list()[0])).toMatchObject({ voice: true, focus: true })
    expect(s.src.voiceRefusal(s.src.list()[0])).toBe(CLAUDE_PLUGIN_OFF)
  })
})

// A pane its host did not make the agent's terminal for only holds it (Pane.held): a terminal, an editor or a
// multiplexer started there keeps that pane's variables, and the pane shows whatever is in front of it. The rule is the
// source's alone, so these adapters are fakes that name no app.
describe('ObservedSource and a pane that only holds the agent', () => {
  // Hints that ask for the read of the caller's maker; the fakes read none of them.
  const HINTS = { ZELLIJ_PANE_ID: '1' }
  /** Held unless the host [id] made the caller's terminal. */
  const unlessMadeBy = (id: string) => (place: Place) => place.ptyOwner !== id

  /** An adapter [id] whose pane of every place is `<id>1`, held while [held] says so. It taps before its app, shows,
   *  types, and keys its panes `<id>:<pane id>`. */
  function fake(id: string, held: (place: Place) => boolean) {
    const typed = vi.fn(async (_pane: Pane, _text: string, _engine: string): Promise<TypeResult> => true)
    const shown = vi.fn(async (_pane: Pane): Promise<PaneSwitch> => 'ok')
    const adapter: HostAdapter = {
      id, tap: 'before', canFocus: () => true, focus: async () => true, show: shown, type: typed,
      paneOf: (place) => ({ adapter: id, id: `${id}1`, ...(held(place) && { held: true as const }) }),
      paneKey: (pane) => `${id}:${pane.id}`,
    }
    return { adapter, typed, shown }
  }

  /** A source with [adapters] in that order, each read of a caller's maker answered by hand, in the order they began. */
  function holding(adapters: readonly HostAdapter[]) {
    const reads: Array<(owner?: string) => Promise<void>> = []
    const ptyOwner = vi.fn((_pid: number) => new Promise<string | undefined>((resolve) => {
      reads.push((owner) => { resolve(owner); return flushed() })
    }))
    const { actions } = fakeActions()
    const s = setup({ actions: { ...actions, adapters }, ptyOwner })
    const agent = () => s.src.list()[0]
    /** The pane a tap hands the opener now. */
    const tapped = async () => {
      actions.open.mockClear()
      expect(await s.src.focus(agent(), latestTap)).toBe(true)
      return actions.open.mock.calls[0][1].pane
    }
    return { ...s, actions, ptyOwner, reads, agent, tapped }
  }

  it('a tap takes the maker\'s pane, then the first that is not held, and a held one last', async () => {
    const s = holding([fake('h', () => true).adapter, fake('b', () => false).adapter, fake('a', unlessMadeBy('a')).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(await s.tapped()).toEqual({ adapter: 'b', id: 'b1' })
    await s.reads[0]('a')
    expect(await s.tapped()).toEqual({ adapter: 'a', id: 'a1' })

    const held = holding([fake('h', () => true).adapter, fake('a', unlessMadeBy('a')).adapter])
    held.src.ingest(held.ev('session-start', { hostHints: HINTS }))
    await held.reads[0]('x')
    expect(await held.tapped()).toEqual({ adapter: 'h', id: 'h1', held: true })
  })

  it('no words and no rest go to a held pane: the next pane whose app types takes them', async () => {
    const h = fake('h', () => true)
    const b = fake('b', () => false)
    const s = holding([h.adapter, b.adapter])
    s.src.ingest(s.ev('turn-stop', { hostHints: HINTS }))
    expect(await s.src.send(s.agent(), 'next')).toEqual({ ok: true })
    expect(b.typed.mock.calls).toEqual([[{ adapter: 'b', id: 'b1' }, 'next', 'claude', expect.any(Function)]])
    expect(await s.src.showPane(s.agent())).toBe('ok')
    expect(b.shown).toHaveBeenCalledTimes(1)
    expect(h.typed).not.toHaveBeenCalled()
    expect(h.shown).not.toHaveBeenCalled()

    const only = holding([fake('h', () => true).adapter])
    only.src.ingest(only.ev('turn-stop', { hostHints: HINTS }))
    expect(only.src.capabilities(only.agent())).toMatchObject({ voice: true, focus: true })
    expect(only.src.voiceRefusal(only.agent())).toBe(CLAUDE_PLUGIN_OFF)
    expect(only.src.hasPane(only.agent())).toBe(false)
    expect(await only.src.send(only.agent(), 'next')).toMatchObject({ ok: false })
  })

  // The dial's counts tell a refused voice to such an agent as held, by design, from one that failed.
  it('heldOnly: every pane held', () => {
    const s = holding([fake('h', () => true).adapter, fake('g', () => true).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(s.src.heldOnly(s.agent().id)).toBe(true)
  })

  it('heldOnly is false with a pane that types or for an unknown agent', () => {
    const s = holding([fake('h', () => true).adapter, fake('b', () => false).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(s.src.heldOnly(s.agent().id)).toBe(false)
    expect(s.src.heldOnly('observed:unknown')).toBe(false)
    // No pane at all: nothing holds it, and the dial counts it on its page instead.
    const none = holding([])
    none.src.ingest(none.ev('session-start', { hostHints: HINTS }))
    expect(none.src.heldOnly(none.agent().id)).toBe(false)
  })

  // The devices take a held pane for none (paneOf) and place the agent by its folder, as in Neovim's :terminal inside an
  // Orca terminal: the place is where it runs, the held pane only where it was started from.
  it('a held pane gives way to the pane its caller was placed at: a rest and a tap show the placed one, and the agent takes its name', async () => {
    const a = fake('a', () => true)
    const s = holding([a.adapter])
    s.src.ingest(s.ev('turn-stop', { hostHints: HINTS }))
    s.src.setPaneNames('a', new Map([['t3', { title: 'Build', renamed: false }]]), new Map([[s.agent().id, 't3']]))
    expect(s.src.hasPane(s.agent())).toBe(true)
    expect(await s.src.showPane(s.agent())).toBe('ok')
    expect(a.shown.mock.calls.map(([pane]) => pane)).toEqual([{ adapter: 'a', id: 't3' }])
    expect(await s.tapped()).toEqual({ adapter: 'a', id: 't3' })
    expect(s.agent().name).toBe('Build')
  })

  // The devices scope Orca's ring by it: an agent whose terminal is held was started from that terminal's worktree.
  it('shownAt answers the pane a rest and a tap read: its own, else its place, else its held one; none once its session ended', async () => {
    const s = holding([fake('a', unlessMadeBy('a')).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    const id = s.agent().id
    // Held until its maker is read.
    expect(s.src.shownAt(id, 'a')).toBe('a1')
    s.src.setPaneNames('a', new Map(), new Map([[id, 't3']]))
    expect(s.src.shownAt(id, 'a')).toBe('t3')
    await s.reads[0]('a')
    expect(s.src.shownAt(id, 'a')).toBe('a1')
    expect(s.src.shownAt(id, 'b')).toBeUndefined()
    expect(s.src.shownAt('observed:unknown', 'a')).toBeUndefined()
    s.src.ingest(s.ev('session-end', { hostHints: HINTS }))
    expect(s.src.shownAt(id, 'a')).toBeUndefined()
  })

  it('a held pane\'s key folds no source\'s row once the maker is read, and neither paneOf nor byPane finds a held pane', async () => {
    const s = holding([fake('a', unlessMadeBy('a')).adapter, fake('b', () => false).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    await s.reads[0]('x')
    expect(s.agent().paneKeys).toEqual(['b:b1'])
    expect(s.src.paneOf(s.agent().id, 'a')).toBeUndefined()
    expect(s.src.byPane('a', 'a1')).toBeUndefined()
    expect(s.src.paneOf(s.agent().id, 'b')).toBe('b1')
    expect(s.src.byPane('b', 'b1')?.id).toBe(s.agent().id)
    // Resumed on a terminal a's host made: that pane is its own.
    s.src.ingest(s.ev('session-start', { hostHints: HINTS, callerPid: 200 }))
    await s.reads[1]('a')
    expect(s.agent().paneKeys).toEqual(['a:a1', 'b:b1'])
    expect(s.src.paneOf(s.agent().id, 'a')).toBe('a1')
  })

  // A listing source's row of the agent's pane folds into the hooked copy at once, so the list shows one row in the first
  // moments after a hook, before the read lands (docs/plans/2026-11-21-dial-linux-followups-design.md, Decided).
  it('a pane held until its maker is read lists its key as an own pane does, and drops it once the read names another host', async () => {
    const s = holding([fake('a', unlessMadeBy('a')).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(s.agent().paneKeys).toEqual(['a:a1'])
    await s.reads[0]('x')
    expect(s.agent().paneKeys).toBeUndefined()
    // A read that names no host drops it too.
    s.src.ingest(s.ev('session-start', { hostHints: HINTS, callerPid: 200 }))
    expect(s.agent().paneKeys).toEqual(['a:a1'])
    await s.reads[1](undefined)
    expect(s.agent().paneKeys).toBeUndefined()
  })

  it('holds: a pane held until its maker is read holds any asker; once read, only the asker of that agent\'s session; an own pane, an ended agent or another key holds none', async () => {
    const s = holding([fake('a', unlessMadeBy('a')).adapter])
    const same = { engine: 'claude', sessionId: 's1' }
    const other = { engine: 'codex', sessionId: 's9' }
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(s.src.holds('a:a1', same)).toBe(true)
    expect(s.src.holds('a:a1', other)).toBe(true)
    expect(s.src.holds('a:a1', { engine: 'codex' })).toBe(true)
    expect(s.src.holds('a:a2', other)).toBe(false)
    await s.reads[0]('x')
    expect(s.src.holds('a:a1', same)).toBe(true)
    for (const asker of [other, { engine: 'claude' }, { engine: 'claude', sessionId: 's2' }, { engine: 'codex', sessionId: 's1' }]) {
      expect(s.src.holds('a:a1', asker), JSON.stringify(asker)).toBe(false)
    }
    // Its own pane.
    s.src.ingest(s.ev('turn-start', { hostHints: HINTS, callerPid: 200 }))
    await s.reads[1]('a')
    expect(s.src.holds('a:a1', same)).toBe(false)
    expect(s.src.holds('a:a1', other)).toBe(false)
    // Ended.
    s.src.ingest(s.ev('session-start', { hostHints: HINTS, callerPid: 300 }))
    expect(s.src.holds('a:a1', other)).toBe(true)
    s.src.ingest(s.ev('session-end', { hostHints: HINTS, callerPid: 300 }))
    expect(s.src.holds('a:a1', same)).toBe(false)
    expect(s.src.holds('a:a1', other)).toBe(false)
  })

  // Its held pane's key was listed while the read ran: the row of that pane a listing source keeps comes back.
  it('a read that names no host lands as null and places the agent again, telling the change once its held pane\'s key goes', async () => {
    const places: Array<Place['ptyOwner']> = []
    const logs: string[] = []
    // As an adapter says once a caller that its pane only holds the agent, once the read landed.
    const sayHeld = oncePerCaller((line) => { logs.push(line) }, '[device] a · held')
    const s = holding([fake('a', (place) => {
      places.push(place.ptyOwner)
      if (place.ptyOwner !== undefined && place.ptyOwner !== 'a') sayHeld(place.pid)
      return place.ptyOwner !== 'a'
    }).adapter])
    s.src.ingest(s.ev('session-start', { hostHints: HINTS }))
    expect(places).not.toContain(null)
    s.changes.mockClear()
    const placed = places.length
    await s.reads[0](undefined)
    expect(places.slice(placed)).toEqual([null])
    expect(s.agent().paneKeys).toBeUndefined()
    expect(s.changes).toHaveBeenCalledTimes(1)
    expect(logs).toEqual(['[device] a · held'])
    // Its next event places it again on the same caller: said once.
    s.src.ingest(s.ev('turn-start', { hostHints: HINTS }))
    expect(places.at(-1)).toBeNull()
    expect(logs).toEqual(['[device] a · held'])

    // A held pane no listing source keys: nothing listed changed.
    const unkeyed = holding([{ ...fake('a', unlessMadeBy('a')).adapter, paneKey: undefined }])
    unkeyed.src.ingest(unkeyed.ev('session-start', { hostHints: HINTS }))
    unkeyed.changes.mockClear()
    await unkeyed.reads[0](undefined)
    expect(unkeyed.changes).not.toHaveBeenCalled()
  })
})

// VS Code from `code .`, a terminal or an editor started in an Orca terminal or a herdr pane keeps its handle or pane id:
// the real Orca and herdr adapters type by it only once their host made the caller's terminal.
describe('ObservedSource and an Orca terminal or a herdr pane that only holds the agent', () => {
  const ORCA = { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }
  const IN_EDITOR = { TERM_PROGRAM: 'vscode' }

  /** A source with the real Orca and herdr adapters on an inert runner, their lines kept, and after them an editor that
   *  types into the terminal it made; each read of a caller's maker answered by hand, in the order they began. */
  function inOrcaOrHerdr() {
    const reads: Array<{ answer(owner?: string): Promise<void>; fail(): Promise<void> }> = []
    const ptyOwner = vi.fn((_pid: number) => new Promise<string | undefined>((resolve, reject) => {
      reads.push({
        answer: (owner) => { resolve(owner); return flushed() },
        fail: () => { reject(new Error('ps timed out')); return flushed() },
      })
    }))
    const run = vi.fn(async (_file: string, _args: string[], _timeoutMs: number) => ({ code: 0, stdout: '' }))
    const deps: OrcaDeps = { run, onPath: (name) => `/fake/bin/${name}`, exists: () => false, platform: 'darwin' }
    const lines: string[] = []
    const log = (line: string) => { lines.push(line) }
    const herdrPrompt = vi.fn(async (_pane: string, _kind: string, _text: string): Promise<HerdrPrompt> => ({ outcome: 'sent' }))
    const typed = vi.fn(async (_pane: Pane, _text: string, _engine: string): Promise<TypeResult> => true)
    const editor: HostAdapter = { id: 'editor', tap: 'before', canFocus: () => true, focus: async () => true, type: typed,
      paneOf: (place) => (place.hints.TERM_PROGRAM === 'vscode' ? { adapter: 'editor', id: 'e1' } : undefined) }
    const adapters = [
      createHerdrAdapter({ ...deps, log, client: { prompt: herdrPrompt, socketStamp: () => '1:1', binary: () => undefined }, front: () => undefined }),
      createOrcaAdapter(deps, { worktreeOf: () => undefined, log, switching: () => {} }),
      editor,
    ]
    const { actions } = fakeActions()
    const s = setup({ actions: { ...actions, adapters }, ptyOwner })
    const agent = () => s.src.list()[0]
    /** The `orca terminal send`s that ran. */
    const sends = () => run.mock.calls.filter(([, args]) => args[1] === 'send')
    return { ...s, actions, ptyOwner, reads, run, lines, herdrPrompt, typed, agent, sends }
  }

  it('an agent in an editor started from an Orca terminal gets its words in the editor, never through orca terminal send', async () => {
    const s = inOrcaOrHerdr()
    s.src.ingest(s.ev('turn-stop', { hostHints: { ...ORCA, ...IN_EDITOR } }))
    expect(await s.src.send(s.agent(), 'one')).toEqual({ ok: true })
    // VS Code made its terminal: no host's.
    await s.reads[0].answer(undefined)
    expect(await s.src.send(s.agent(), 'two')).toEqual({ ok: true })
    expect(s.typed.mock.calls.map(([pane, text]) => [pane.id, text])).toEqual([['e1', 'one'], ['e1', 'two']])
    expect(await s.src.focus(s.agent(), latestTap)).toBe(true)
    expect(s.actions.open.mock.calls.map(([, target]) => target.pane)).toEqual([{ adapter: 'editor', id: 'e1' }])
    expect(s.sends()).toEqual([])
  })

  it('the same from a herdr pane, never through herdr\'s socket', async () => {
    const s = inOrcaOrHerdr()
    s.src.ingest(s.ev('turn-stop', { hostHints: { HERDR_PANE_ID: 'w1:p2', ...IN_EDITOR } }))
    expect(await s.src.send(s.agent(), 'one')).toEqual({ ok: true })
    await s.reads[0].answer(undefined)
    expect(await s.src.send(s.agent(), 'two')).toEqual({ ok: true })
    expect(s.typed.mock.calls.map(([pane, text]) => [pane.id, text])).toEqual([['e1', 'one'], ['e1', 'two']])
    expect(await s.src.focus(s.agent(), latestTap)).toBe(true)
    expect(s.actions.open.mock.calls.map(([, target]) => target.pane)).toEqual([{ adapter: 'editor', id: 'e1' }])
    expect(s.herdrPrompt).not.toHaveBeenCalled()
  })

  it('a maker read that fails leaves the Orca terminal held, says no held line, and is read again on an event 10 s later', async () => {
    const s = inOrcaOrHerdr()
    s.src.ingest(s.ev('turn-stop', { hostHints: ORCA }))
    await s.reads[0].fail()
    expect(s.src.paneOf(s.agent().id, 'orca')).toBeUndefined()
    expect(s.src.capabilities(s.agent())).toMatchObject({ voice: true, focus: true })
    expect(await s.src.send(s.agent(), 'next')).toMatchObject({ ok: false })
    s.clock.t += 9_999
    s.src.ingest(s.ev('turn-stop', { hostHints: ORCA }))
    expect(s.ptyOwner).toHaveBeenCalledTimes(1)
    s.clock.t += 1
    s.src.ingest(s.ev('turn-stop', { hostHints: ORCA }))
    expect(s.ptyOwner).toHaveBeenCalledTimes(2)
    expect(s.sends()).toEqual([])
    expect(s.lines).toEqual([])
    await s.reads[1].answer('orca')
    expect(s.src.paneOf(s.agent().id, 'orca')).toBe(HANDLE)
    expect(await s.src.send(s.agent(), 'next')).toEqual({ ok: true })
    expect(s.sends()).toHaveLength(1)
    expect(s.lines).toEqual([])
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

  // With no read of its caller's maker, WezTerm's pane only holds it: Orca's terminal takes the words, the rest and the tap.
  it.each([
    ['WezTerm', { WEZTERM_PANE: '7', ORCA_TERMINAL_HANDLE: HANDLE }, HANDLE],
  ])('%s inside an Orca terminal still takes the dial\'s words, a rest and a tap through Orca', async (_, hostHints, tapped) => {
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
    expect(await src.focus(agent, latestTap)).toBe(true)
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
    expect(src.capabilities(agent)).toMatchObject({ voice: true, focus: true })
    expect(src.voiceRefusal(agent)).toBe(herdrSocket ? undefined : CLAUDE_PLUGIN_OFF)
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
    expect(await src.focus(agent, latestTap)).toBe(true)
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
    expect(await src.focus(agent, latestTap)).toBe(true)
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
      expect(src.capabilities(agent), sessionId).toMatchObject({ voice: true, focus: true })
      expect(await src.send(agent, 'next'), sessionId).toEqual({ ok: false, reason: 'proj did not answer.' })
    }
    expect(actions.herdrPrompt).not.toHaveBeenCalled()
    expect(actions.orcaSend).not.toHaveBeenCalled()
    expect(counted(actions.count)).toEqual(['no-answer', 'no-answer'])
  })

  // On Linux no hint names VS Code: the agent's host is the unknown terminal, its app the one its caller runs under.
  it('an agent waiting in an app its hints do not name is waiting in that app, not in Terminal', async () => {
    const typer: HostAdapter = { id: 'typer', tap: 'before', paneOf: () => ({ adapter: 'typer', id: 'p1' }),
      canFocus: () => true, focus: async () => true, canType: () => true, type: async () => true }
    const { src, ev } = setup({ actions: { ...fakeActions({}, 'linux').actions, adapters: [typer] }, apps: async () => new Map([[100, 'vscode']]) })
    src.ingest(ev('session-start'))
    await vi.waitFor(() => expect(src.list()[0]).toMatchObject({ host: 'terminal', app: 'vscode' }))
    src.ingest(ev('needs-input'))
    expect(await src.send(src.list()[0], '1')).toEqual({ ok: false, reason: 'proj is waiting for your answer in VS Code.' })
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

  // The key a listing source knows the same pane by (registry.ts). An ended session keeps it: the registry folds nothing by
  // an ended copy's keys, and finds by them the listing source's live copy that takes its row.
  it('an agent in a herdr pane carries its pane key, ended or not', async () => {
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
    expect(agent('ended')).toMatchObject({ ended: true, paneKeys: ['herdr:w1:p3'] })
    for (const sessionId of ['orca', 'found']) expect(agent(sessionId), sessionId).not.toHaveProperty('paneKeys')
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
    expect(adapter.paneOf).toHaveBeenLastCalledWith({ host: 'terminal', app: 'terminal', hints: both, pid: 100, sessionId: 's1', engine: 'claude',
      cwd: '/work/proj' })
    expect(a.src.capabilities(a.agent)).toMatchObject({ voice: true })
    expect(await a.src.send(a.agent, 'next')).toEqual({ ok: true })
    expect(adapter.type.mock.calls).toEqual([[PANE, 'next', 'claude', expect.any(Function)]])
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
    expect(alone.src.voiceRefusal(alone.agent)).toBe(CLAUDE_PLUGIN_OFF)
    expect(await alone.src.send(alone.agent, 'next')).toEqual({ ok: false, reason: 'proj did not answer.' })

    // A tap hands its pane to the opener, which brings it forward: the source runs none of its own.
    const near = madeUp()
    const tap = first(near, both)
    expect(await tap.src.focus(tap.agent, latestTap)).toBe(true)
    expect(tap.actions.open.mock.calls).toEqual([[tap.agent.id, { pane: PANE }]])
    expect(near.focus).not.toHaveBeenCalled()
    // It cannot bring its pane forward here: Orca's terminal is the first that can.
    near.canFocus.mockReturnValue(false)
    expect(await tap.src.focus(tap.agent, latestTap)).toBe(true)
    expect(tap.actions.open.mock.calls[1]).toEqual([tap.agent.id, { bundle: 'com.stablyai.orca', pane: { adapter: 'orca', id: HANDLE } }])
    expect(near.focus).not.toHaveBeenCalled()

    // It comes after its app: Orca's terminal is the tap's pane, and its own is raised once the app came.
    const late = { ...madeUp(), tap: 'after' as const }
    let opened!: (yes: boolean) => void
    const raised = first(late, both, { open: vi.fn(() => new Promise<boolean>((resolve) => { opened = resolve })) })
    const raising = raised.src.focus(raised.agent, latestTap)
    expect(raised.actions.open.mock.calls).toEqual([[raised.agent.id, { bundle: 'com.stablyai.orca', pane: { adapter: 'orca', id: HANDLE } }]])
    expect(late.focus).not.toHaveBeenCalled()
    opened(true)
    expect(await raising).toBe(true)
    expect(late.focus.mock.calls).toEqual([[PANE]])
    // Its app did not come: nothing is raised.
    const unopened = { ...madeUp(), tap: 'after' as const }
    const closed = first(unopened, both, { open: vi.fn(async () => false) })
    expect(await closed.src.focus(closed.agent, latestTap)).toBe(false)
    expect(unopened.focus).not.toHaveBeenCalled()
    // It cannot show its pane now: the pane a rest would show is Orca's, which comes before its app.
    const unshown = { ...madeUp(), tap: 'after' as const }
    unshown.canShow.mockReturnValue(false)
    const behind = first(unshown, both)
    expect(await behind.src.focus(behind.agent, latestTap)).toBe(true)
    expect(unshown.focus).not.toHaveBeenCalled()
    // It is the pane a rest would show, but it cannot be brought forward here: nothing is raised.
    const stuck = { ...madeUp(), tap: 'after' as const }
    stuck.canFocus.mockReturnValue(false)
    const fixed = first(stuck, both)
    expect(await fixed.src.focus(fixed.agent, latestTap)).toBe(true)
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

  // The ChatGPT page names its threads through the codex pane names (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md, D4).
  it('a hooked ChatGPT thread is called by the codex pane names, and keeps the name at its next hook', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    const inApp = { engine: 'codex' as const, sessionId: THREAD, hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }
    src.ingest(ev('session-start', inApp))
    src.setPaneNames('codex', named([THREAD, 'Fix the build']), none)
    expect(src.list()[0].name).toBe('Fix the build')
    src.ingest(ev('turn-start', inApp))
    expect(src.list()[0].name).toBe('Fix the build')
  })

  it('an empty placed map places no Codex thread at the codex pane: a terminal thread keeps its folder\'s name and its tap', () => {
    const { actions } = fakeActions()
    const { src, ev } = setup({ actions })
    src.ingest(ev('session-start', { engine: 'codex', sessionId: THREAD, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    src.setPaneNames('codex', named([THREAD, 'Fix the build']), none)
    const agent = src.list()[0]
    expect(agent.name).toBe('proj')
    expect(src.shownAt(agent.id, 'codex')).toBeUndefined()
  })

  it('its own title (the hook\'s) and a user record name win over a pane name the person did not set', async () => {
    const { actions } = fakeActions()
    const s = setup({ actions, record: async () => ({ name: 'Mine' }) })
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
    const s = setup({ actions, record: async () => ({ name: 'harness root' }) })
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
    expect(s.src.capabilities(agent)).toMatchObject({ focus: true, voice: true })
    expect(s.src.voiceRefusal(agent)).toBe(CLAUDE_PLUGIN_OFF)
    expect(await s.src.focus(agent, latestTap)).toBe(true)
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

  it('shownAt answers the pane an agent was placed at, in that adapter alone', async () => {
    const s = setup({ actions: fakeActions().actions })
    const id = await scannedIdle(s)
    s.src.setPaneNames('orca', named([HANDLE, 'PM']), new Map([[id, HANDLE]]))
    expect(s.src.shownAt(id, 'orca')).toBe(HANDLE)
    expect(s.src.shownAt(id, 'cmux')).toBeUndefined()
    expect(s.src.shownAt('observed:unknown', 'orca')).toBeUndefined()
    // A place is never one of its panes.
    expect(s.src.paneOf(id, 'orca')).toBeUndefined()
    s.src.setPaneNames('orca', named([HANDLE, 'PM']), none)
    expect(s.src.shownAt(id, 'orca')).toBeUndefined()
  })
})

// An agent in Terminal, iTerm2 or Ghostty has a tab a rest selects, by the tty of its process
// (docs/specs/2026-11-15-dial-terminal-follow.md, "1. A swipe selects the agent's tab").
describe('ObservedSource tabs', () => {
  const TTY = '/dev/ttys023'
  const inTerminal = { hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }

  /** A source whose tty reads the test answers by hand, in the order they began, with a watch's stream open: a tty, with
   *  its process's start when one is given. */
  function tabs(over: Partial<Fakes> = {}, deps: Partial<ObservedDeps> = {}) {
    const reads: Array<{ answer(tty: string | undefined, start?: string): Promise<void>; fail(): Promise<void> }> = []
    const tty = vi.fn((_pid: number) => new Promise<TabTty | undefined>((resolve, reject) => {
      reads.push({
        answer: (answered, start) => {
          resolve(answered === undefined ? undefined : { tty: answered, ...(start === undefined ? {} : { start }) })
          return flushed()
        },
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

  it('tabTty: a live agent\'s tty once read, none before, for an ended session or an unknown id', async () => {
    const t = tabs()
    t.src.ingest(t.ev('session-start', inTerminal))
    const { id } = t.agent()
    expect(t.src.tabTty(id)).toBeUndefined()
    await t.reads[0].answer(TTY)
    expect(t.src.tabTty(id)).toBe(TTY)
    expect(t.src.tabTty('nobody')).toBeUndefined()
    t.src.ingest(t.ev('session-end', inTerminal))
    expect(t.src.tabTty(id)).toBeUndefined()
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
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
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
    expect(t.logs).toEqual(['[observed] tty · not read · Error'])
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
    const bare = setup({ tty: vi.fn(async (): Promise<TabTty> => ({ tty: TTY })) })
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
    const tap = t.src.focus(t.agent(), latestTap)
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
    expect(await t.src.focus(t.agent(), latestTap)).toBe(false)
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  it('an agent that ended, or whose pid changed, while open ran gets no select', async () => {
    for (const meanwhile of [{ event: 'session-end', pid: 100 }, { event: 'turn-start', pid: 101 }] as const) {
      const held = heldOpen()
      const t = tabs({ open: held.open })
      t.src.ingest(t.ev('session-start', inTerminal))
      await t.reads[0].answer(TTY)
      const tap = t.src.focus(t.agent(), latestTap)
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
    const tap = t.src.focus(t.agent(), latestTap)
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
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    t.actions.tabsOpen.mockReturnValue(true)
    expect(await t.src.focus(t.agent('orca'), latestTap)).toBe(true)
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
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open).toHaveBeenCalledTimes(1)
    expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.mitchellh.ghostty')
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
    expect(t.actions.orcaSwitch).not.toHaveBeenCalled()
  })

  describe('the proof of its process', () => {
    const TTY3 = '/dev/ttys003'
    const inIterm = { hostHints: { TERM_PROGRAM: 'iTerm.app' } }
    /** The tabs adapter with a typer that writes its words, waits to be told, then writes their Enter only while the
     *  prompt check holds: each step keeps the pane it was given. */
    const typed = (deps: Partial<ObservedDeps> = {}) => {
      const steps: Array<{ step: 'words' | 'enter'; pane: Pane }> = []
      let atPrompt: (() => boolean) | undefined
      let enter!: () => void
      const type = vi.fn(async (pane: Pane, _text: string, _engine: string, check?: () => boolean): Promise<TypeResult> => {
        atPrompt = check
        steps.push({ step: 'words', pane })
        await new Promise<void>((resolve) => { enter = resolve })
        if (!check?.()) return false
        steps.push({ step: 'enter', pane })
        return true
      })
      const adapter: HostAdapter = { ...createTabsAdapter({ isOpen: () => true, select: () => true }), type }
      const t = tabs({}, { actions: { ...fakeActions().actions, adapters: [adapter] }, ...deps })
      return { ...t, steps, atPrompt: () => atPrompt!(), enter: async () => { enter(); await flushed() } }
    }

    it('an agent in iTerm2 has its tab pane carry the pid its tty was read for, and that process\'s start', async () => {
      const t = typed()
      t.src.ingest(t.ev('session-start', { ...inIterm, callerPid: 4101 }))
      expect(t.tty.mock.calls).toEqual([[4101]])
      await t.reads[0].answer(TTY3, 'ps:1')
      const sent = t.src.send(t.agent(), 'next')
      await flushed()
      expect(t.steps).toEqual([{ step: 'words', pane: { adapter: 'tabs', id: `iterm:${TTY3}`, proof: { pid: 4101, start: 'ps:1' } } }])
      await t.enter()
      expect(await sent).toEqual({ ok: true })
    })

    it('a tty read with no start gives its pane no proof', async () => {
      const t = typed()
      t.src.ingest(t.ev('session-start', { ...inIterm, callerPid: 4101 }))
      await t.reads[0].answer(TTY3)
      void t.src.send(t.agent(), 'next')
      await flushed()
      expect(t.steps).toEqual([{ step: 'words', pane: { adapter: 'tabs', id: `iterm:${TTY3}` } }])
    })

    it('a nested agent\'s tab pane has none: the tab holds its multiplexer\'s client', async () => {
      const outer = vi.fn((hints: Readonly<Record<string, string>>) =>
        (hints.TMUX_PANE ? Promise.resolve<OuterAnswer>({ app: 'iterm', tty: TTY3, pid: 4300 }) : undefined))
      const t = typed({ outer })
      t.src.ingest(t.ev('session-start', { callerPid: 4101, hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' } }))
      await flushed()
      expect(t.tty).not.toHaveBeenCalled()
      void t.src.send(t.agent(), 'next')
      await flushed()
      expect(t.steps).toEqual([{ step: 'words', pane: { adapter: 'tabs', id: `iterm:${TTY3}` } }])
    })

    // The same tab, another process: the person quit the agent and started another there between the words and the Enter.
    it('a hook from another process on the same tty makes the prompt check false: the Enter is not sent', async () => {
      const t = typed()
      t.src.ingest(t.ev('session-start', { ...inIterm, callerPid: 4101 }))
      await t.reads[0].answer(TTY3, 'ps:1')
      const sent = t.src.send(t.agent(), 'next')
      await flushed()
      expect(t.atPrompt()).toBe(true)
      t.src.ingest(t.ev('session-start', { ...inIterm, callerPid: 4102 }))
      await t.reads[1].answer(TTY3, 'ps:2')
      // Its pane has the same id again: only the proof tells the two processes apart.
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBe(`iterm:${TTY3}`)
      expect(t.atPrompt()).toBe(false)
      await t.enter()
      expect(await sent).toEqual({ ok: false, reason: 'proj did not answer.' })
      expect(t.steps.map(({ step }) => step)).toEqual(['words'])
    })
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

// An agent in a tmux pane of the person's is seen in the app holding the tmux client, at that client's tab
// (docs/plans/2026-11-19-dial-tmux-terminal-design.md): the pane's own hints and pty name neither.
describe('ObservedSource outer place', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })
  const CLIENT = { app: 'terminal-app', tty: '/dev/ttys004' }
  /** An event's hints in tmux pane %3, a fresh record each time as each hook sends its own. */
  const inTmux = (more: Record<string, string> = {}) => ({ hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', ...more } })
  const paneAsked = ['tmux', ['display-message', '-p', '-t', '%3', expect.any(String)], expect.any(Number)]
  const selected = ['tmux', ['select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], expect.any(Number)]

  /** A source whose outer places the test answers by hand, in the order they were asked, as tmux's and herdr's lookups
   *  answer an event in their pane, and whose multiplexer each ask's lookup tells by hand once its maker read confirms
   *  it; an event in neither is not nested. A tap's or a rest's fresh ask answers `{}` at once, which changes nothing,
   *  or, [freshByHand], goes to `freshAsks`, answered as `asks` are. A tty read answers at once. */
  function nested(
    over: Partial<Fakes> = {}, adapt = (adapters: readonly HostAdapter[]) => adapters, deps: Partial<ObservedDeps> = {},
    { freshByHand }: { freshByHand?: true } = {},
  ) {
    const asks: Array<{ answer(place: OuterAnswer): Promise<unknown>; made(nest: Nest): Promise<unknown> }> = []
    const freshAsks: Array<(place: OuterAnswer) => Promise<unknown>> = []
    const outer = vi.fn((hints: Readonly<Record<string, string>>, _pid: number, made?: (nest: Nest) => void, opts?: Fresh) => {
      if (!hints.TMUX_PANE && !hints.HERDR_PANE_ID) return undefined
      if (opts?.fresh && !freshByHand) return Promise.resolve<OuterAnswer>({})
      return new Promise<OuterAnswer>((resolve) => {
        const answer = (place: OuterAnswer) => { resolve(place); return vi.advanceTimersByTimeAsync(0) }
        if (opts?.fresh) freshAsks.push(answer)
        else asks.push({ answer, made: (nest) => { made?.(nest); return vi.advanceTimersByTimeAsync(0) } })
      })
    })
    const tty = vi.fn(async (_pid: number): Promise<TabTty | undefined> => ({ tty: '/dev/ttys031' }))
    const { actions, ran } = fakeActions(over)
    const s = setup({ actions: { ...actions, adapters: adapt(actions.adapters) }, tty, outer, ...deps })
    const agent = () => s.src.list()[0]
    return { ...s, actions, ran, outer, asks, freshAsks, tty, agent }
  }

  it('a nested event lands on its outer app, with its client\'s tty and that app\'s bundle', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    expect(t.outer.mock.calls).toEqual([[inTmux().hostHints, 100, expect.any(Function)]])
    expect(t.agent().app).toBe('tmux')
    const told = t.changes.mock.calls.length
    await t.asks[0].answer(CLIENT)
    const { id } = t.agent()
    expect(t.agent().app).toBe('terminal-app')
    expect(t.changes).toHaveBeenCalledTimes(told + 1)
    expect(t.src.byTab('terminal-app', '/dev/ttys004')).toMatchObject({ id })
    expect(t.src.paneOf(id, 'tabs')).toBe('terminal-app:/dev/ttys004')
    expect(t.src.paneOf(id, 'tmux')).toBe('%3:100:terminal-app')
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.apple.Terminal')
    expect(t.tty).not.toHaveBeenCalled()
  })

  // A process under tmux's server owns no window: the one that holds the pane is its client's (the dial-linux spec, 2.2).
  it('windowOf: a nested agent is in its client\'s window, and in its own process\'s once no client holds it', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    const { id } = t.agent()
    expect(t.src.windowOf(id)).toEqual({ pid: 100, app: 'tmux' })
    await t.asks[0].answer({ ...CLIENT, pid: 4300 })
    expect(t.src.windowOf(id)).toEqual({ pid: 4300, app: 'terminal-app', outer: true })
    t.src.ingest(t.ev('turn-start', inTmux()))
    await t.asks[1].answer({})
    expect(t.src.windowOf(id)).toEqual({ pid: 100, app: 'tmux' })
  })

  it('tabTty: a nested agent\'s is its client\'s tty, and none once no client holds it', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    const { id } = t.agent()
    expect(t.src.tabTty(id)).toBeUndefined()
    await t.asks[0].answer(CLIENT)
    expect(t.src.tabTty(id)).toBe('/dev/ttys004')
    t.src.ingest(t.ev('turn-start', inTmux()))
    await t.asks[1].answer({})
    expect(t.src.tabTty(id)).toBeUndefined()
  })

  // A client in a terminal with no page (docs/plans/2026-11-21-dial-linux-followups-design.md, Decided): its window is
  // raised by its process, while the agent stays where its hints put it.
  it('an outer answer with only its client\'s process: no page, tab or pane moves, and the raise gets that process', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    const { id } = t.agent()
    const told = t.changes.mock.calls.length
    await t.asks[0].answer({ pid: 4300 })
    expect(t.agent().app).toBe('tmux')
    expect(t.src.paneOf(id, 'tabs')).toBeUndefined()
    expect(t.src.paneOf(id, 'tmux')).toBe('%3:100')
    expect(t.src.byTab('terminal-app', '/dev/ttys004')).toBeUndefined()
    expect(t.src.windowOf(id)).toEqual({ pid: 4300, app: 'tmux', outer: true })
    expect(t.changes).toHaveBeenCalledTimes(told + 1)
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open.mock.calls).toEqual([[id, { pane: { adapter: 'tmux', id: '%3:100' } }]])
    expect(t.tty).not.toHaveBeenCalled()
    // A later answer of none, or one with a process out of form, keeps no process.
    for (const place of [{}, { pid: 0 }, { pid: 1.5 }]) {
      t.src.ingest(t.ev('turn-start', inTmux()))
      await t.asks.at(-1)!.answer(place)
      expect(t.src.windowOf(id), JSON.stringify(place)).toEqual({ pid: 100, app: 'tmux' })
    }
  })

  it('another caller drops the kept process', async () => {
    for (const [moved, caller] of [[{ callerPid: 101 }, 101], [inTmux({ TMUX_PANE: '%4' }), 100]] as const) {
      const t = nested()
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer({ pid: 4300 })
      const { id } = t.agent()
      expect(t.src.windowOf(id), JSON.stringify(moved)).toEqual({ pid: 4300, app: 'tmux', outer: true })
      t.src.ingest(t.ev('needs-input', { ...inTmux(), ...moved }))
      expect(t.src.windowOf(id), JSON.stringify(moved)).toEqual({ pid: caller, app: 'tmux' })
    }
  })

  // The front report lags an open: a pane that comes after its app and is shown only while that app is in front would be
  // skipped by the tap that brought the app.
  it('a tap on a nested agent raises its after-app pane once the open answered, before the front names that app', async () => {
    let front: string | undefined
    const late: HostAdapter = {
      id: 'after-app', tap: 'after',
      paneOf: (place) => (place.outer ? { adapter: 'after-app', id: 'x' } : undefined),
      canFocus: () => true, canShow: () => front === 'terminal-app',
      show: vi.fn(async (): Promise<PaneSwitch> => 'ok'), focus: vi.fn(async () => true),
    }
    let opened!: (yes: boolean) => void
    const t = nested({ open: vi.fn(() => new Promise<boolean>((resolve) => { opened = resolve })) }, (adapters) => [late, ...adapters])
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    const raising = t.src.focus(t.agent(), latestTap)
    await vi.advanceTimersByTimeAsync(0)
    expect(t.actions.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100:terminal-app' } }]])
    expect(late.focus).not.toHaveBeenCalled()
    opened(true)
    expect(await raising).toBe(true)
    expect(late.focus).toHaveBeenCalledExactlyOnceWith({ adapter: 'after-app', id: 'x' })
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
  })

  // Eval O11 (2026-11-25): Claude Code under tmux inside an Orca terminal. Its tap opened its tmux pane while Orca came
  // forward on whichever tab it showed: the tab it was placed at is in an app that switches before its own open.
  describe('a tap on a nested agent placed at a pane of an app that taps before its own', () => {
    /** A source with two adapters that tap before their apps: `mux`, whose pane m1 is every place's, and `app`, which
     *  holds the agent at a1 when [held], else has none of its own, so a pane there is only where it was [placed]. The
     *  agent is nested once its lookup answers [answer]. */
    function placedApp({ answer = { nest: 'tmux' }, held, placed = true, canOpen = true }:
      { answer?: OuterAnswer; held?: true; placed?: boolean; canOpen?: boolean } = {}) {
      const mux = { id: 'mux', tap: 'before' as const, paneOf: (): Pane | undefined => ({ adapter: 'mux', id: 'm1' }),
        canFocus: () => true, focus: vi.fn(async (_pane: Pane) => true) }
      const app = { id: 'app', tap: 'before' as const,
        paneOf: (): Pane | undefined => (held ? { adapter: 'app', id: 'a1', held: true } : undefined),
        canFocus: () => true, focus: vi.fn(async (_pane: Pane): Promise<boolean | 'refused'> => true) }
      const t = nested({ canOpen: vi.fn((_agentId: string, _target: OpenTarget) => canOpen) }, () => [mux, app])
      return {
        ...t, mux, app,
        async start() {
          t.src.ingest(t.ev('session-start', inTmux()))
          await t.asks[0].answer(answer)
          if (placed) t.src.setPaneNames('app', new Map(), new Map([[t.agent().id, 'tab']]))
        },
      }
    }

    it('switches to its placed pane, then opens its multiplexer\'s pane, with or without its client\'s tab', async () => {
      for (const answer of [{ nest: 'tmux' }, { ...CLIENT, nest: 'tmux' }] as const) {
        const t = placedApp({ answer })
        await t.start()
        expect(t.agent().nest, JSON.stringify(answer)).toBe('tmux')
        expect(await t.src.focus(t.agent(), latestTap), JSON.stringify(answer)).toBe(true)
        expect(t.app.focus.mock.calls, JSON.stringify(answer)).toEqual([[{ adapter: 'app', id: 'tab' }]])
        expect(t.actions.open.mock.calls[0][1].pane, JSON.stringify(answer)).toEqual({ adapter: 'mux', id: 'm1' })
        expect(t.app.focus.mock.invocationCallOrder[0]).toBeLessThan(t.actions.open.mock.invocationCallOrder[0])
        expect(t.mux.focus, JSON.stringify(answer)).not.toHaveBeenCalled()
        expect(t.logs.filter((line) => line.includes('placed')), JSON.stringify(answer)).toEqual([])
      }
    })

    // Failures are seen: the open still brings the app, on the tab it showed, and only this line says why.
    it('a placed pane that did not come still opens, and the log names its adapter alone', async () => {
      const t = placedApp()
      t.app.focus.mockResolvedValueOnce(false)
      await t.start()
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.app.focus).toHaveBeenCalledTimes(1)
      expect(t.actions.open).toHaveBeenCalledTimes(1)
      expect(t.logs.filter((line) => line.includes('placed'))).toEqual(['[observed] open · app · placed pane not shown'])
    })

    it('a placed pane its adapter refused still opens, with no line of its own: the adapter said so', async () => {
      const t = placedApp()
      t.app.focus.mockResolvedValueOnce('refused')
      await t.start()
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open).toHaveBeenCalledTimes(1)
      expect(t.logs.filter((line) => line.includes('placed'))).toEqual([])
    })

    it('an agent in no multiplexer opens alone, as before', async () => {
      const t = placedApp({ answer: {} })
      await t.start()
      expect(t.agent()).not.toHaveProperty('nest')
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open).toHaveBeenCalledTimes(1)
      expect(t.app.focus).not.toHaveBeenCalled()
    })

    it('a held pane is never switched to first', async () => {
      const t = placedApp({ held: true, placed: false })
      await t.start()
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1].pane).toEqual({ adapter: 'mux', id: 'm1' })
      expect(t.app.focus).not.toHaveBeenCalled()
    })

    it('a tap that cannot open switches nothing', async () => {
      const t = placedApp({ canOpen: false })
      await t.start()
      expect(await t.src.focus(t.agent(), latestTap)).toBe(false)
      expect(t.app.focus).not.toHaveBeenCalled()
      expect(t.actions.open).not.toHaveBeenCalled()
    })

    it('a later tap while it switched supersedes it, and nothing opens', async () => {
      const t = placedApp()
      let latest = true
      t.app.focus.mockImplementationOnce(async () => { latest = false; return true })
      await t.start()
      expect(await t.src.focus(t.agent(), () => latest)).toBe('superseded')
      expect(t.app.focus).toHaveBeenCalledTimes(1)
      expect(t.actions.open).not.toHaveBeenCalled()
    })
  })

  it('needs-input and turn-stop keep it, and ask nothing', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    t.src.ingest(t.ev('needs-input', inTmux()))
    t.src.ingest(t.ev('turn-stop', inTmux()))
    expect(t.outer).toHaveBeenCalledTimes(1)
    expect(t.agent().app).toBe('terminal-app')
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys004')
    expect(t.tty).not.toHaveBeenCalled()
  })

  it('turn-start and session-start ask again, keeping the outer place until the answer', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    for (const [i, event] of [[1, 'turn-start'], [2, 'session-start']] as const) {
      t.src.ingest(t.ev(event, inTmux()))
      expect(t.outer).toHaveBeenCalledTimes(i + 1)
      // While it is asked, the agent keeps its page and its tab: the dial does not flicker to tmux's page.
      expect(t.agent().app, event).toBe('terminal-app')
      expect(t.src.byTab('terminal-app', '/dev/ttys004'), event).toMatchObject({ id: t.agent().id })
      expect(t.src.paneOf(t.agent().id, 'tmux'), event).toBe('%3:100:terminal-app')
      await t.asks[i].answer(i === 1 ? CLIENT : {})
    }
    // The person detached: back on tmux's page, with no tab.
    expect(t.agent().app).toBe('tmux')
    expect(t.src.byTab('terminal-app', '/dev/ttys004')).toBeUndefined()
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
    expect(t.src.paneOf(t.agent().id, 'tmux')).toBe('%3:100')
  })

  it('a new caller or a new pane drops it and asks again', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    t.src.ingest(t.ev('needs-input', { ...inTmux(), callerPid: 101 }))
    expect(t.agent().app).toBe('tmux')
    expect(t.src.byTab('terminal-app', '/dev/ttys004')).toBeUndefined()
    expect(t.outer.mock.calls[1]).toEqual([inTmux().hostHints, 101, expect.any(Function)])
    await t.asks[1].answer(CLIENT)
    expect(t.agent().app).toBe('terminal-app')
    t.src.ingest(t.ev('needs-input', { ...inTmux({ TMUX_PANE: '%4' }), callerPid: 101 }))
    expect(t.agent().app).toBe('tmux')
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
    expect(t.outer.mock.calls[2]).toEqual([inTmux({ TMUX_PANE: '%4' }).hostHints, 101, expect.any(Function)])
    expect(t.tty).not.toHaveBeenCalled()
  })

  it('{} falls back to the app the hints name, as today', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux({ __CFBundleIdentifier: 'com.mitchellh.ghostty' })))
    await t.asks[0].answer({})
    expect(t.agent().app).toBe('ghostty')
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.mitchellh.ghostty', pane: { adapter: 'tmux', id: '%3:100' } }]])
  })

  it('an answer for an earlier ask, caller or pane, or after the end, is dropped', async () => {
    // The earlier ask's answer lands after the later one's.
    const late = nested()
    late.src.ingest(late.ev('session-start', inTmux()))
    late.src.ingest(late.ev('turn-start', inTmux()))
    await late.asks[1].answer({})
    await late.asks[0].answer(CLIENT)
    expect(late.agent().app).toBe('tmux')
    expect(late.src.byTab('terminal-app', '/dev/ttys004')).toBeUndefined()

    // It moved to another caller, or another pane, while it was asked.
    for (const moved of [{ callerPid: 101 }, inTmux({ TMUX_PANE: '%4' })]) {
      const t = nested()
      t.src.ingest(t.ev('session-start', inTmux()))
      t.src.ingest(t.ev('needs-input', { ...inTmux(), ...moved }))
      await t.asks[0].answer(CLIENT)
      expect(t.agent().app, JSON.stringify(moved)).toBe('tmux')
      expect(t.src.byTab('terminal-app', '/dev/ttys004'), JSON.stringify(moved)).toBeUndefined()
    }

    // It ended while it was asked.
    const ended = nested()
    ended.src.ingest(ended.ev('session-start', inTmux()))
    ended.src.ingest(ended.ev('session-end', inTmux()))
    await ended.asks[0].answer(CLIENT)
    expect(ended.agent().app).toBe('tmux')
    expect(ended.changes).toHaveBeenCalledTimes(2)
  })

  it('the caller\'s tty is never read, and an old one is cleared at once', async () => {
    const t = nested()
    const inTerminal = { __CFBundleIdentifier: 'com.apple.Terminal' }
    t.src.ingest(t.ev('session-start', { hostHints: { ...inTerminal } }))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.src.byTab('terminal-app', '/dev/ttys031')).toMatchObject({ id: t.agent().id })
    // Its caller read already now names a tmux pane, whose server Terminal started: that pane's pty is no tab.
    t.src.ingest(t.ev('turn-start', inTmux(inTerminal)))
    expect(t.agent().app).toBe('terminal-app')
    expect(t.src.byTab('terminal-app', '/dev/ttys031')).toBeUndefined()
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
    await t.asks[0].answer({})
    expect(t.src.byTab('terminal-app', '/dev/ttys031')).toBeUndefined()
    expect(t.tty.mock.calls).toEqual([[100]])
  })

  // A tmux before 3.2 sets no TERM_PROGRAM: the one its server started with may name no listed app (Hyper), so the
  // caller's parents are walked too, and that walk can answer after the outer place.
  describe('beside a walk of its caller\'s parents', () => {
    /** A source whose walks the test answers by hand, in the order they began. */
    function walked() {
      const walks: Array<(apps: ReadonlyMap<number, string>) => Promise<unknown>> = []
      const apps = vi.fn((_pids: readonly number[]) => new Promise<ReadonlyMap<number, string>>((resolve) => {
        walks.push((found) => { resolve(found); return vi.advanceTimersByTimeAsync(0) })
      }))
      const t = nested({}, undefined, { apps })
      t.src.ingest(t.ev('session-start', inTmux({ TERM_PROGRAM: 'Hyper' })))
      expect(apps).toHaveBeenCalledTimes(1)
      return { ...t, walks }
    }

    it('a walk that answers after its outer place leaves it on that app, at its client\'s tab', async () => {
      const t = walked()
      await t.asks[0].answer(CLIENT)
      expect(t.agent().app).toBe('terminal-app')
      // The walk ends at tmux's server, which no app holds.
      await t.walks[0](new Map())
      expect(t.agent().app).toBe('terminal-app')
      expect(t.src.byTab('terminal-app', '/dev/ttys004')).toMatchObject({ id: t.agent().id })
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys004')
      expect(t.tty).not.toHaveBeenCalled()
    })

    it('a walk that names a tab app before its outer place answers reads no tty', async () => {
      const t = walked()
      // A server kept in a Terminal tab's foreground (`tmux -D`): its walk names Terminal, whose tab is not the pane's pty.
      await t.walks[0](new Map([[100, 'terminal-app']]))
      expect(t.agent().app).toBe('terminal-app')
      expect(t.tty).not.toHaveBeenCalled()
      await t.asks[0].answer({})
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
      expect(t.tty).not.toHaveBeenCalled()
    })

    it('a walk that answers after an outer place of none gives its app, and reads no tty', async () => {
      const t = walked()
      await t.asks[0].answer({})
      await t.walks[0](new Map([[100, 'terminal-app']]))
      expect(t.agent().app).toBe('terminal-app')
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
      expect(t.tty).not.toHaveBeenCalled()
    })

    it('a walk its outer place held back gives its app once a later ask finds none', async () => {
      const t = walked()
      await t.asks[0].answer(CLIENT)
      await t.walks[0](new Map([[100, 'iterm']]))
      expect(t.agent().app).toBe('terminal-app')
      t.src.ingest(t.ev('turn-start', inTmux({ TERM_PROGRAM: 'Hyper' })))
      await t.asks[1].answer({})
      expect(t.agent().app).toBe('iterm')
      // Walked once for its caller.
      expect(t.walks).toHaveLength(1)
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBeUndefined()
      expect(t.tty).not.toHaveBeenCalled()
    })

    it('a caller it moved to during the walk is walked next, and that walk leaves its new outer place', async () => {
      const t = walked()
      t.src.ingest(t.ev('needs-input', { ...inTmux({ TERM_PROGRAM: 'Hyper' }), callerPid: 101 }))
      await t.walks[0](new Map([[100, 'iterm']]))
      expect(t.walks).toHaveLength(2)
      await t.asks[1].answer(CLIENT)
      await t.walks[1](new Map())
      expect(t.agent().app).toBe('terminal-app')
      expect(t.src.byTab('terminal-app', '/dev/ttys004')).toMatchObject({ id: t.agent().id })
      expect(t.tty).not.toHaveBeenCalled()
    })
  })

  it('undefined: nothing changes', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', { hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }))
    expect(t.outer).toHaveBeenCalledTimes(1)
    expect(t.tty.mock.calls).toEqual([[100]])
    await vi.advanceTimersByTimeAsync(0)
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys031')
  })

  it('a rest shows the tab, then the tmux pane', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    expect(t.src.hasPane(t.agent())).toBe(true)
    expect(await t.src.showPane(t.agent())).toBe('ok')
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys004', false]])
    expect(t.ran.mock.calls).toEqual([paneAsked, selected])
    expect(t.actions.tabSelect.mock.invocationCallOrder[0]).toBeLessThan(t.ran.mock.invocationCallOrder[0])
  })

  it.each([
    ['busy', 'ok', 'busy'],
    ['ok', 'busy', 'busy'],
    ['failed', 'ok', 'ok'],
    ['ok', 'failed', 'ok'],
    ['failed', 'failed', 'failed'],
  ] as const)('a rest whose tab says %s and whose tmux pane says %s answers %s', async (tab, pane, said) => {
    const shows = { tabs: vi.fn(async (): Promise<PaneSwitch> => tab), tmux: vi.fn(async (): Promise<PaneSwitch> => pane) }
    const t = nested({}, (adapters) => adapters.map((a) => (a.id === 'tabs' || a.id === 'tmux' ? { ...a, show: shows[a.id] } : a)))
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    expect(await t.src.showPane(t.agent())).toBe(said)
    expect(shows.tabs).toHaveBeenCalledTimes(1)
    expect(shows.tmux).toHaveBeenCalledTimes(1)
  })

  it('a rest while another app is in front shows the tab alone', async () => {
    const t = nested({ tmuxFront: vi.fn((): string | undefined => 'ghostty') })
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    expect(await t.src.showPane(t.agent())).toBe('ok')
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys004', false]])
    expect(t.ran).not.toHaveBeenCalled()
  })

  it('a tap opens the tmux pane and the app, then raises the tab', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    await t.asks[0].answer(CLIENT)
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open.mock.calls).toEqual([[t.agent().id, { bundle: 'com.apple.Terminal', pane: { adapter: 'tmux', id: '%3:100:terminal-app' } }]])
    expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys004', true]])
    expect(t.actions.open.mock.invocationCallOrder[0]).toBeLessThan(t.actions.tabSelect.mock.invocationCallOrder[0])
  })

  // Eval I13 (PM, 2026-11-24): the person detached, attached again from iTerm2's tab 2 and typed nothing, so no hook
  // asked again. A tap and a rest read where the client is now, waiting at most OUTER_FRESH_WAIT_MS.
  describe('a tap or a rest reads its client afresh', () => {
    const TAB_2 = { ...CLIENT, tty: '/dev/ttys005' }
    const late = (logs: readonly string[]) => logs.filter((line) => line === '[observed] outer · late')

    it('I13: a tap opens the tab its client is in now, read afresh with no hook since', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer(CLIENT)
      const tapping = t.src.focus(t.agent(), latestTap)
      expect(t.outer.mock.calls.at(-1)).toEqual([inTmux().hostHints, 100, undefined, { fresh: true }])
      expect(t.actions.open).not.toHaveBeenCalled()
      await t.freshAsks[0](TAB_2)
      expect(await tapping).toBe(true)
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys005')
      expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['terminal-app', '/dev/ttys005', true])
    })

    it('I13: a rest selects the tab its client is in now', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer(CLIENT)
      const resting = t.src.showPane(t.agent())
      expect(t.actions.tabSelect).not.toHaveBeenCalled()
      await t.freshAsks[0](TAB_2)
      expect(await resting).toBe('ok')
      expect(t.actions.tabSelect.mock.calls).toEqual([['terminal-app', '/dev/ttys005', false]])
      expect(t.ran.mock.calls).toEqual([paneAsked, selected])
      expect(t.actions.tabSelect.mock.invocationCallOrder[0]).toBeLessThan(t.ran.mock.invocationCallOrder[0])
    })

    it('a lookup slower than the wait: the tap acts on the old tab at OUTER_FRESH_WAIT_MS, says late once, and the late answer lands', async () => {
      for (const act of ['tap', 'rest'] as const) {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer(CLIENT)
        const acting = act === 'tap' ? t.src.focus(t.agent(), latestTap) : t.src.showPane(t.agent())
        await vi.advanceTimersByTimeAsync(OUTER_FRESH_WAIT_MS - 1)
        expect(t.actions.open, act).not.toHaveBeenCalled()
        expect(t.actions.tabSelect, act).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(await acting, act).toBe(act === 'tap' ? true : 'ok')
        expect(t.actions.open, act).toHaveBeenCalledTimes(act === 'tap' ? 1 : 0)
        expect(t.actions.tabSelect.mock.calls, act).toEqual([['terminal-app', '/dev/ttys004', act === 'tap']])
        expect(late(t.logs), act).toHaveLength(1)
        await t.freshAsks[0](TAB_2)
        expect(t.src.paneOf(t.agent().id, 'tabs'), act).toBe('terminal-app:/dev/ttys005')
        expect(late(t.logs), act).toHaveLength(1)
      }
    })

    // Detached and not attached again: the row keeps its page and its tab, and the tap opens the old app.
    it('a fresh answer with no app and no client\'s process changes nothing', async () => {
      for (const place of [{}, { nest: 'tmux' }, { pid: 0 }] as const) {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer({ ...CLIENT, nest: 'tmux' })
        const told = t.changes.mock.calls.length
        const tapping = t.src.focus(t.agent(), latestTap)
        await t.freshAsks[0](place)
        expect(await tapping, JSON.stringify(place)).toBe(true)
        expect(t.agent().app, JSON.stringify(place)).toBe('terminal-app')
        expect(t.actions.tabSelect.mock.calls, JSON.stringify(place)).toEqual([['terminal-app', '/dev/ttys004', true]])
        expect(t.changes, JSON.stringify(place)).toHaveBeenCalledTimes(told)
      }
    })

    it('a fresh answer with only its client\'s process lands: the raise gets that process (Linux)', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer({ pid: 4300 })
      const { id } = t.agent()
      const tapping = t.src.focus(t.agent(), latestTap)
      await t.freshAsks[0]({ pid: 4500 })
      expect(await tapping).toBe(true)
      expect(t.src.windowOf(id)).toEqual({ pid: 4500, app: 'tmux', outer: true })
    })

    it('a hook\'s ask during a fresh one wins', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer(CLIENT)
      const tapping = t.src.focus(t.agent(), latestTap)
      t.src.ingest(t.ev('turn-start', inTmux()))
      await t.asks[1].answer({ ...CLIENT, tty: '/dev/ttys006' })
      await t.freshAsks[0](TAB_2)
      expect(await tapping).toBe(true)
      expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys006')
      expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['terminal-app', '/dev/ttys006', true])
    })

    it('a tap or rest on an agent in no multiplexer asks no lookup and waits for nothing', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', { hostHints: { __CFBundleIdentifier: 'com.apple.Terminal' } }))
      await vi.advanceTimersByTimeAsync(0)
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(await t.src.showPane(t.agent())).toBe('ok')
      expect(t.outer).toHaveBeenCalledTimes(1)
      expect(late(t.logs)).toEqual([])
    })

    it('a session that ends during the wait opens and shows nothing', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer(CLIENT)
      const tapping = t.src.focus(t.agent(), latestTap)
      const resting = t.src.showPane(t.agent())
      t.src.ingest(t.ev('session-end', inTmux()))
      await t.freshAsks[0](TAB_2)
      expect(await tapping).toBe(false)
      expect(await resting).toBe('failed')
      expect(t.actions.open).not.toHaveBeenCalled()
      expect(t.actions.tabSelect).not.toHaveBeenCalled()
    })

    // A lookup never rejects (OuterLookup), yet one that did, or threw, would leave its landing unsettled: held, it would
    // fail every later tap and rest on the agent, and no fresh ask would run again.
    it('a fresh lookup that rejects or throws: the tap acts on the old tab, says so, and a tap past the second asks again', async () => {
      for (const fail of ['rejects', 'throws'] as const) {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer(CLIENT)
        t.outer.mockImplementationOnce(() => {
          if (fail === 'throws') throw new TypeError('tmux under /Users/someone')
          return Promise.reject(new Error('tmux under /Users/someone'))
        })
        expect(await t.src.focus(t.agent(), latestTap), fail).toBe(true)
        expect(t.actions.tabSelect.mock.calls, fail).toEqual([['terminal-app', '/dev/ttys004', true]])
        expect(t.logs.filter((line) => line.startsWith('[observed] outer')), fail)
          .toEqual([`[observed] outer · lookup not read · ${fail === 'throws' ? 'TypeError' : 'Error'}`])
        expect(t.logs.join('\n'), fail).not.toContain('someone')
        t.clock.t += FRESH_WITHIN_MS
        const again = t.src.focus(t.agent(), latestTap)
        await t.freshAsks[0](TAB_2)
        expect(await again, fail).toBe(true)
        expect(t.actions.tabSelect.mock.calls.at(-1), fail).toEqual(['terminal-app', '/dev/ttys005', true])
      }
    })

    it('a tap and a rest within the second run one fresh lookup an agent', async () => {
      const t = nested({}, undefined, {}, { freshByHand: true })
      t.src.ingest(t.ev('session-start', inTmux()))
      await t.asks[0].answer(CLIENT)
      const fresh = () => t.outer.mock.calls.filter(([, , , opts]) => opts?.fresh).length
      const tapping = t.src.focus(t.agent(), latestTap)
      const resting = t.src.showPane(t.agent())
      expect(fresh()).toBe(1)
      await vi.advanceTimersByTimeAsync(OUTER_FRESH_WAIT_MS)
      expect(await tapping).toBe(true)
      expect(await resting).toBe('ok')
      expect(late(t.logs)).toHaveLength(2)
      await t.freshAsks[0](TAB_2)
      t.clock.t += FRESH_WITHIN_MS - 1
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(fresh()).toBe(1)
      t.clock.t += 1
      const again = t.src.focus(t.agent(), latestTap)
      expect(fresh()).toBe(2)
      await t.freshAsks[1](TAB_2)
      expect(await again).toBe(true)
    })

    // A tap or rest waits up to OUTER_FRESH_WAIT_MS before it acts (PM, 2026-11-24: last action wins): one the person
    // replaced meanwhile would bring forward what they left.
    describe('the last tap or rest wins', () => {
      // The dial's taps on any agent, in turn, as cableHost counts them: each asks whether it is still the latest.
      const taps = () => {
        let n = 0
        return (src: ObservedSource, agent: HostAgent) => { const mine = ++n; return src.focus(agent, () => n === mine) }
      }

      it('two taps during one wait: only the later opens', async () => {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer(CLIENT)
        const tap = taps()
        const first = tap(t.src, t.agent())
        const second = tap(t.src, t.agent())
        expect(t.freshAsks).toHaveLength(1)
        await t.freshAsks[0](TAB_2)
        expect(await first).toBe('superseded')
        expect(await second).toBe(true)
        expect(t.actions.open).toHaveBeenCalledTimes(1)
      })

      it('a tap on a, then on b during a\'s wait: b opens, a does not', async () => {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        t.src.ingest(t.ev('session-start', { sessionId: 's2', callerPid: 200, ...inTmux({ TMUX_PANE: '%4' }) }))
        await t.asks[0].answer(CLIENT)
        await t.asks[1].answer(TAB_2)
        const of = (sessionId: string) => t.src.list().find(({ id }) => id === observedAgentId('claude', sessionId))!
        const tap = taps()
        const tappingA = tap(t.src, of('s1'))
        const tappingB = tap(t.src, of('s2'))
        await t.freshAsks[0](CLIENT)
        expect(await tappingA).toBe('superseded')
        expect(t.actions.open).not.toHaveBeenCalled()
        await t.freshAsks[1](TAB_2)
        expect(await tappingB).toBe(true)
        expect(t.actions.open.mock.calls.map(([id]) => id)).toEqual([of('s2').id])
      })

      // A later tap on another source's agent (a Claude app session, Orca, Harness's own window) is no tap here: only
      // cableHost's count says this one is no longer the latest.
      it('a tap no longer the latest after its wait opens nothing', async () => {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer(CLIENT)
        const tapping = t.src.focus(t.agent(), () => false)
        await t.freshAsks[0](TAB_2)
        expect(await tapping).toBe('superseded')
        expect(t.actions.open).not.toHaveBeenCalled()
      })

      it('a rest that a later rest or tap replaced shows nothing', async () => {
        for (const later of ['rest', 'tap'] as const) {
          const t = nested({}, undefined, {}, { freshByHand: true })
          t.src.ingest(t.ev('session-start', inTmux()))
          await t.asks[0].answer(CLIENT)
          const resting = t.src.showPane(t.agent())
          const replacing = later === 'rest' ? t.src.showPane(t.agent()) : t.src.focus(t.agent(), latestTap)
          await t.freshAsks[0](TAB_2)
          expect(await resting, later).toBe('superseded')
          expect(await replacing, later).toBe(later === 'rest' ? 'ok' : true)
          expect(t.actions.tabSelect.mock.calls, later).toEqual([['terminal-app', '/dev/ttys005', later === 'tap']])
        }
      })

      it('a rest after a tap does not drop the tap', async () => {
        const t = nested({}, undefined, {}, { freshByHand: true })
        t.src.ingest(t.ev('session-start', inTmux()))
        await t.asks[0].answer(CLIENT)
        const tapping = t.src.focus(t.agent(), latestTap)
        const resting = t.src.showPane(t.agent())
        await t.freshAsks[0](TAB_2)
        expect(await tapping).toBe(true)
        expect(await resting).toBe('ok')
        expect(t.actions.open).toHaveBeenCalledTimes(1)
      })
    })
  })

  // Diego, 2026-11-23: an agent in tmux or herdr is on its terminal app's page and that multiplexer's (Diego, 2026-11-26). Only
  // the lookup that confirmed its pane says so (`nest`), never the hints alone.
  it('a hooked agent in tmux has nest and host tmux once its lookup says tmux: with a client\'s app and detached', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux()))
    expect(t.agent()).not.toHaveProperty('nest')
    await t.asks[0].answer({ ...CLIENT, pid: 4300, nest: 'tmux' })
    expect(t.agent()).toMatchObject({ app: 'terminal-app', host: 'tmux', nest: 'tmux' })
    expect(pagesOf(t.agent())).toEqual(['terminal-app', 'tmux'])
    // Asked again at its next turn: it keeps its multiplexer until the answer, which finds the person detached.
    t.src.ingest(t.ev('turn-start', inTmux()))
    expect(t.agent()).toMatchObject({ host: 'tmux', nest: 'tmux' })
    await t.asks[1].answer({ nest: 'tmux' })
    expect(t.agent()).toMatchObject({ app: 'terminal', host: 'tmux', nest: 'tmux' })
    expect(pagesOf(t.agent())).toEqual(['tmux'])
  })

  // A pane inherits the bundle id of the terminal that started tmux's server: a detached agent's hints name iTerm2, which
  // holds no client of it (final review, 2026-11-26).
  it('a nested agent whose lookup landed with no client app is on its multiplexer\'s page alone, never its hints\' app\'s', async () => {
    const hostHints = { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' }
    // Detached, and attached from a terminal with no page.
    for (const answer of [{ nest: 'tmux' }, { pid: 4300, nest: 'tmux' }] as const) {
      const t = nested()
      const label = JSON.stringify(answer)
      t.src.ingest(t.ev('session-start', { hostHints }))
      await t.asks[0].answer(answer)
      expect(pagesOf(t.agent()), label).toEqual(['tmux'])
      // A later hook of the same caller asks nothing anew: the landed answer stands.
      t.src.ingest(t.ev('turn-stop', { hostHints }))
      expect(t.asks, label).toHaveLength(1)
      expect(pagesOf(t.agent()), label).toEqual(['tmux'])
      // Its next turn asks anew: while that runs it stays off iTerm2's page, as an attached one keeps its client's
      // place until the answer (askOuter), and the answer moves it.
      t.src.ingest(t.ev('turn-start', { hostHints }))
      expect(t.asks, label).toHaveLength(2)
      expect(pagesOf(t.agent()), label).toEqual(['tmux'])
      await t.asks[1].answer({ ...CLIENT, nest: 'tmux' })
      expect(pagesOf(t.agent()), label).toEqual(['terminal-app', 'tmux'])
    }
  })

  it('a hooked agent in herdr has nest and host herdr', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', { hostHints: { HERDR_PANE_ID: 'w1:p2' } }))
    await t.asks[0].answer({ app: 'iterm', tty: '/dev/ttys005', pid: 4400, nest: 'herdr' })
    expect(t.agent()).toMatchObject({ app: 'iterm', host: 'herdr', nest: 'herdr' })
    expect(pagesOf(t.agent())).toEqual(['iterm', 'herdr'])
  })

  // herdr's server keeps the environment of the client that started it, and on Windows the hook names the app from the
  // pane's parents, herdr's server: a client attached since from Windows Terminal still had VS Code's bundle id (spec
  // docs/plans/2026-11-25-dial-herdr-windows-app-design.md, "What Windows does today"; decision 4, PM 2026-11-26).
  describe('on Windows, herdr\'s client', () => {
    const STALE = { HERDR_PANE_ID: 'w1:p1', __CFBundleIdentifier: 'com.microsoft.VSCode' }
    const onWindows = () => nested({}, undefined, { platform: 'win32' })

    it('on Windows a herdr client in Windows Terminal: no stale bundle, its window is the terminal\'s', async () => {
      const t = onWindows()
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].made('herdr')
      await t.asks[0].answer({ pid: 100, nest: 'herdr' })
      const { id } = t.agent()
      expect(t.agent().app).toBe('terminal')
      expect(pagesOf(t.agent())).toEqual(['herdr'])
      expect(t.src.windowOf(id)).toEqual({ pid: 100, app: 'terminal', outer: true })
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1]).not.toHaveProperty('bundle')
    })

    it('on Windows the client\'s app replaces the hint\'s', async () => {
      const t = onWindows()
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].answer({ app: 'cursor', pid: 220, nest: 'herdr' })
      expect(t.agent().app).toBe('cursor')
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1].bundle).toBe(APP_BUNDLES.cursor)
    })

    it('on Windows, told herdr before the answer, the stale app is already gone', async () => {
      const t = onWindows()
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].made('herdr')
      expect(t.agent().app).toBe('terminal')
      expect(pagesOf(t.agent())).toEqual(['herdr'])
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1]).not.toHaveProperty('bundle')
    })

    it('on Windows no window: nothing to raise', async () => {
      const t = onWindows()
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].answer({ nest: 'herdr' })
      expect(t.agent().app).toBe('terminal')
      expect(t.src.windowOf(t.agent().id)).not.toHaveProperty('outer')
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1]).not.toHaveProperty('bundle')
    })

    // The server's first client was in Orca: the hint's app would hold an
    // agent attached from Windows Terminal on Orca's page (pagesOf).
    it('a stale Orca hint stays off Orca\'s page', async () => {
      const t = onWindows()
      const hostHints = { HERDR_PANE_ID: 'w1:p1', TERM_PROGRAM: 'Orca', ORCA_TERMINAL_HANDLE: HANDLE, ORCA_AGENT_SESSION_ID: 'x' }
      t.src.ingest(t.ev('session-start', { hostHints }))
      await t.asks[0].answer({ pid: 100, nest: 'herdr' })
      expect(t.agent().app).toBe('terminal')
      expect(pagesOf(t.agent())).toEqual(['herdr'])
    })

    // A terminal started from a herdr pane keeps HERDR_PANE_ID, while herdr did not make its terminal.
    it('outside herdr keeps its own bundle', async () => {
      const t = onWindows()
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].answer({})
      expect(t.agent().app).toBe('vscode')
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.microsoft.VSCode')
    })

    // Decision 2: macOS keeps what it does.
    it('on macOS the same answer keeps the hint\'s bundle', async () => {
      const t = nested({}, undefined, { platform: 'darwin' })
      t.src.ingest(t.ev('session-start', { hostHints: STALE }))
      await t.asks[0].made('herdr')
      await t.asks[0].answer({ pid: 100, nest: 'herdr' })
      expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.microsoft.VSCode')
    })
  })

  // The nearest multiplexer wins: detectHost reads HERDR_PANE_ID first, which a tmux started in a herdr pane inherits.
  it('tmux inside herdr: the hints name both panes and detectHost says herdr, the lookup says tmux: nest and host tmux', async () => {
    const t = nested()
    const both = { hostHints: { HERDR_PANE_ID: 'w1:p1', TMUX_PANE: '%3', TERM_PROGRAM: 'tmux' } }
    t.src.ingest(t.ev('session-start', both))
    expect(t.agent().host).toBe('herdr')
    await t.asks[0].answer({ ...CLIENT, pid: 4300, nest: 'tmux' })
    expect(t.agent()).toMatchObject({ app: 'terminal-app', host: 'tmux', nest: 'tmux' })
    // A later answer that confirms no multiplexer: none, and its host is its hints' again.
    t.src.ingest(t.ev('turn-start', both))
    await t.asks[1].answer({})
    expect(t.agent()).not.toHaveProperty('nest')
    expect(t.agent().host).toBe('herdr')
  })

  it('herdr inside tmux: nest and host herdr', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', { hostHints: { TMUX_PANE: '%3', HERDR_PANE_ID: 'w1:p2' } }))
    await t.asks[0].answer({ app: 'iterm', tty: '/dev/ttys005', pid: 4400, nest: 'herdr' })
    expect(t.agent()).toMatchObject({ app: 'iterm', host: 'herdr', nest: 'herdr' })
  })

  it('code . from a tmux pane: its lookup says no multiplexer: no nest, host as its hints name it, app vscode', async () => {
    const t = nested()
    t.src.ingest(t.ev('session-start', inTmux({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' })))
    await t.asks[0].answer({})
    expect(t.agent()).toMatchObject({ app: 'vscode', host: 'tmux' })
    expect(t.agent()).not.toHaveProperty('nest')
    expect(pagesOf(t.agent())).toEqual(['vscode'])
  })

  // Mac eval IH4 (2026-11-24): a hooked agent in a herdr pane inside iTerm2 sat on iTerm2's page past a 10 s wait while
  // herdr's client steps ran (lsof, ps, the app walk, up to 10 s each). Its lookup tells the multiplexer once its maker
  // read confirms it, and the client's place lands when its steps end.
  it('a hooked agent is on its multiplexer\'s page once its lookup reads that the multiplexer made its terminal, before the client\'s steps end', async () => {
    const cases = [
      [{ HERDR_PANE_ID: 'w1:p2', __CFBundleIdentifier: 'com.googlecode.iterm2' }, 'herdr'],
      [{ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' }, 'tmux'],
    ] as const
    for (const [hostHints, nest] of cases) {
      const t = nested()
      t.src.ingest(t.ev('session-start', { hostHints }))
      // Pending while its lookup runs: iTerm2's page, in front, does not take it.
      expect(t.agent(), nest).toMatchObject({ app: 'iterm', appPending: true })
      expect(t.agent(), nest).not.toHaveProperty('nest')
      const told = t.changes.mock.calls.length
      await t.asks[0].made(nest)
      expect(t.agent(), nest).toMatchObject({ app: 'iterm', host: nest, nest })
      expect(t.agent(), nest).not.toHaveProperty('appPending')
      expect(pagesOf(t.agent()), nest).toEqual(['iterm', nest])
      expect(t.changes, nest).toHaveBeenCalledTimes(told + 1)
      // The client's place lands when its steps end, on the same page.
      await t.asks[0].answer({ app: 'iterm', tty: '/dev/ttys005', pid: 4400, nest })
      expect(t.agent(), nest).toMatchObject({ app: 'iterm', host: nest, nest })
      expect(t.src.paneOf(t.agent().id, 'tabs'), nest).toBe('iterm:/dev/ttys005')
      expect(pagesOf(t.agent()), nest).toEqual(['iterm', nest])
    }
  })

  it('a told multiplexer lands for the latest ask alone, while the session lives, and once', async () => {
    const inHerdr = { hostHints: { HERDR_PANE_ID: 'w1:p2' } }
    // It moved to another caller while its first ask ran: that ask's word lands nothing, the latest's does.
    const t = nested()
    t.src.ingest(t.ev('session-start', inHerdr))
    t.src.ingest(t.ev('needs-input', { ...inHerdr, callerPid: 101 }))
    await t.asks[0].made('herdr')
    expect(t.agent()).not.toHaveProperty('nest')
    expect(t.agent()).toMatchObject({ appPending: true })
    await t.asks[1].made('herdr')
    expect(t.agent()).toMatchObject({ host: 'herdr', nest: 'herdr' })
    // Told again with nothing new: nothing is told.
    const told = t.changes.mock.calls.length
    await t.asks[1].made('herdr')
    expect(t.changes).toHaveBeenCalledTimes(told)
    // Told after its answer landed: the answer's place stands.
    await t.asks[1].answer({ app: 'iterm', tty: '/dev/ttys005', pid: 4400, nest: 'herdr' })
    const landed = t.changes.mock.calls.length
    await t.asks[1].made('herdr')
    expect(t.changes).toHaveBeenCalledTimes(landed)
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('iterm:/dev/ttys005')

    // It ended while it was asked.
    const ended = nested()
    ended.src.ingest(ended.ev('session-start', inHerdr))
    ended.src.ingest(ended.ev('session-end', inHerdr))
    await ended.asks[0].made('herdr')
    expect(ended.agent()).not.toHaveProperty('nest')
  })

  /** Hints in tmux pane %3, and in herdr pane w1:p2, each in iTerm2: an agent that loses its multiplexer lands on
   *  iTerm2's page, so a page check can fail. A fresh record each time. */
  const TMUX_HINTS = (more: Record<string, string> = {}) => inTmux({ __CFBundleIdentifier: 'com.googlecode.iterm2', ...more })
  const HERDR_HINTS = (more: Record<string, string> = {}) => ({ hostHints: { HERDR_PANE_ID: 'w1:p2', TERM_PROGRAM: 'iTerm.app', ...more } })

  // Eval I14 (2026-11-25): a resume's new caller in the same herdr left herdr's ring for its lookup's length, came back
  // at its end, and emptied herdr's page when two ran at once. The last confirmation stands until the new ask answers.
  it.each<[string, { hostHints: Record<string, string> }, Partial<ObservedHookEvent>, Nest]>([
    ['tmux · another caller', TMUX_HINTS(), { callerPid: 101 }, 'tmux'],
    ['tmux · another pane', TMUX_HINTS(), TMUX_HINTS({ TMUX_PANE: '%4' }), 'tmux'],
    ['herdr · another caller', HERDR_HINTS(), { callerPid: 101 }, 'herdr'],
    ['herdr · another pane', HERDR_HINTS(), HERDR_HINTS({ HERDR_PANE_ID: 'w1:p3' }), 'herdr'],
  ])('%s: the multiplexer it was confirmed in stays while the new ask runs, its tab goes at once; that ask\'s answer decides', async (_name, hints, moved, nest) => {
    // Confirmed again: its page and the new client's tab. None (a terminal started from the pane): its hints' app.
    const answers = [[{ ...CLIENT, nest }, ['terminal-app', nest], 'terminal-app:/dev/ttys004'], [{}, ['iterm'], undefined]] as const
    for (const [answer, pages, tab] of answers) {
      const t = nested()
      const label = JSON.stringify(answer)
      t.src.ingest(t.ev('session-start', hints))
      await t.asks[0].answer({ ...CLIENT, nest })
      t.src.ingest(t.ev('needs-input', { ...hints, ...moved }))
      expect(t.asks, label).toHaveLength(2)
      expect(t.agent(), label).toMatchObject({ nest, host: nest })
      expect(t.agent(), label).not.toHaveProperty('appPending')
      expect(pagesOf(t.agent()), label).toEqual(['iterm', nest])
      expect(t.src.paneOf(t.agent().id, 'tabs'), label).toBeUndefined()
      await t.asks[1].answer(answer)
      expect(pagesOf(t.agent()), label).toEqual(pages)
      expect(t.src.paneOf(t.agent().id, 'tabs'), label).toBe(tab)
    }
  })

  it('an earlier ask\'s late answer sets nothing, the multiplexer kept or not', async () => {
    // It moved while its first ask ran, before any confirmed it: that answer lands nothing, the latest's does.
    for (const moved of [{ callerPid: 101 }, inTmux({ TMUX_PANE: '%4' })]) {
      const late = nested()
      late.src.ingest(late.ev('session-start', inTmux()))
      late.src.ingest(late.ev('needs-input', { ...inTmux(), ...moved }))
      await late.asks[0].answer({ ...CLIENT, nest: 'tmux' })
      expect(late.agent(), JSON.stringify(moved)).not.toHaveProperty('nest')
      await late.asks[1].answer({ ...CLIENT, nest: 'tmux' })
      expect(late.agent().nest, JSON.stringify(moved)).toBe('tmux')
    }

    // Confirmed, then moved twice: the middle ask's answer of none lands nothing, the latest's does.
    const t = nested()
    t.src.ingest(t.ev('session-start', TMUX_HINTS()))
    await t.asks[0].answer({ ...CLIENT, nest: 'tmux' })
    t.src.ingest(t.ev('needs-input', { ...TMUX_HINTS(), callerPid: 101 }))
    t.src.ingest(t.ev('needs-input', { ...TMUX_HINTS(), callerPid: 102 }))
    expect(t.asks).toHaveLength(3)
    await t.asks[1].answer({})
    expect(t.agent().nest).toBe('tmux')
    expect(pagesOf(t.agent())).toEqual(['iterm', 'tmux'])
    await t.asks[2].answer({ ...CLIENT, nest: 'tmux' })
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBe('terminal-app:/dev/ttys004')
  })

  // A tmux started in a herdr pane inherits HERDR_PANE_ID, so detectHost says herdr for it: the confirmed multiplexer's
  // own variable decides.
  it('tmux inside herdr: hints with both variables keep the multiplexer it was confirmed in', async () => {
    for (const nest of ['tmux', 'herdr'] as const) {
      const t = nested()
      t.src.ingest(t.ev('session-start', TMUX_HINTS({ HERDR_PANE_ID: 'w1:p1' })))
      await t.asks[0].answer({ ...CLIENT, nest })
      t.src.ingest(t.ev('needs-input', { ...TMUX_HINTS({ HERDR_PANE_ID: 'w1:p1' }), callerPid: 101 }))
      expect(t.agent(), nest).toMatchObject({ nest, host: nest })
      expect(pagesOf(t.agent()), nest).toEqual(['iterm', nest])
    }
  })

  it('it drops at once for hints with no variable of its multiplexer, or with no lookup asked', async () => {
    // Resumed in a Zellij pane in iTerm2: Zellij's lookup is asked, and no tmux variable is there.
    const plain = nested()
    plain.src.ingest(plain.ev('session-start', TMUX_HINTS()))
    await plain.asks[0].answer({ ...CLIENT, nest: 'tmux' })
    plain.outer.mockImplementationOnce(() => new Promise<OuterAnswer>(() => {}))
    const inZellij = { ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'main', ZELLIJ_PANE_ID: '1', TERM_PROGRAM: 'iTerm.app' }
    plain.src.ingest(plain.ev('needs-input', { hostHints: inZellij, callerPid: 101 }))
    expect(plain.outer).toHaveBeenCalledTimes(2)
    expect(plain.agent()).not.toHaveProperty('nest')
    expect(pagesOf(plain.agent())).toEqual(['iterm'])

    // Resumed in herdr: the other multiplexer's variable only.
    const other = nested()
    other.src.ingest(other.ev('session-start', TMUX_HINTS()))
    await other.asks[0].answer({ ...CLIENT, nest: 'tmux' })
    other.src.ingest(other.ev('needs-input', { ...HERDR_HINTS(), callerPid: 101 }))
    expect(other.asks).toHaveLength(2)
    expect(other.agent()).not.toHaveProperty('nest')

    // No lookup asked: no answer would ever confirm it or drop it.
    const unasked = nested()
    unasked.src.ingest(unasked.ev('session-start', HERDR_HINTS()))
    await unasked.asks[0].answer({ ...CLIENT, nest: 'herdr' })
    unasked.outer.mockReturnValueOnce(undefined)
    unasked.src.ingest(unasked.ev('needs-input', { ...HERDR_HINTS(), callerPid: 101 }))
    expect(unasked.agent()).not.toHaveProperty('nest')
  })
})

// Diego, 2026-11-22: after the devices started again, his idle agents in tmux and in herdr inside iTerm2 sat on Other's
// page until each was next hooked. The scan asks each multiplexer's lookup by process (outer.ts NestedLookup).
describe('ObservedSource and a nested session the scan found', () => {
  /** The look's process table: the scan hands it on, and never reads it itself. */
  const ROWS: readonly ProcessName[] = [
    { pid: 100, ppid: 90, executable: 'claude' }, { pid: 90, ppid: 80, executable: 'zsh' }, { pid: 80, ppid: 1, executable: 'tmux' },
  ]
  const IN_TMUX = { host: 'tmux', maker: 80, tty: 'ttys010' }
  const IN_HERDR = { host: 'herdr', maker: 180, tty: 'ttys020' }
  const ITERM = { app: 'iterm', tty: '/dev/ttys004', pid: 4300 }

  /** A source whose look reads one table, whose makers name [made], with the real tabs, tmux and herdr adapters (tmux's
   *  runs recorded), a walk that names no app, and a tty read that answers at once; its nested lookups the test answers
   *  by hand, in the order asked. A tap's or a rest's fresh ask answers `{}` at once, which changes nothing, or,
   *  [freshByHand], goes to `freshAsks`, answered as `asks` are. */
  function scan(
    made: ReadonlyMap<number, Omit<Nested, 'pid' | 'rows'>>, deps: Partial<ObservedDeps> = {}, fakes: Partial<Fakes> = {},
    adapt = (adapters: readonly HostAdapter[]) => adapters, { freshByHand }: { freshByHand?: true } = {},
  ) {
    const table = vi.fn(async () => ROWS)
    const apps = vi.fn(async (_pids: readonly number[], _rows?: readonly ProcessName[]): Promise<ReadonlyMap<number, string>> => new Map())
    const madeBy = vi.fn(async (pids: readonly number[], _rows: readonly ProcessName[]) =>
      new Map(pids.flatMap((pid) => (made.has(pid) ? [[pid, made.get(pid)!] as const] : []))))
    const asks: Array<(place: NestedPlace) => void> = []
    const freshAsks: Array<(place: NestedPlace) => void> = []
    const nested = vi.fn((_found: Nested, opts?: Fresh) => (opts?.fresh && !freshByHand
      ? Promise.resolve<NestedPlace>({})
      : new Promise<NestedPlace>((resolve) => { (opts?.fresh ? freshAsks : asks).push(resolve) })))
    const tty = vi.fn(async (_pid: number): Promise<TabTty | undefined> => ({ tty: '/dev/ttys031' }))
    const { actions, ran } = fakeActions(fakes)
    const s = setup({ actions: { ...actions, adapters: adapt(actions.adapters) }, table, apps, madeBy, nested, tty, ...deps })
    /** A session found open in a terminal, idle, its owner [pid]. */
    const found = (sessionId: string, pid: number): void => {
      s.open.set(sessionId, 'terminal')
      s.owners.set(sessionId, { pid, engine: 'claude' })
      s.externals.set(sessionId, { cwd: `/x/${sessionId}`, transcriptPath: `/t/${sessionId}.jsonl` })
      s.working.set(sessionId, false)
    }
    /** Answers the [i]th lookup once it is asked, and lets its answer land. */
    const answer = async (i: number, place: NestedPlace): Promise<void> => {
      await vi.waitFor(() => expect(asks.length).toBeGreaterThan(i))
      asks[i](place)
      await flushed()
    }
    const agent = (sessionId: string) => s.src.list().find((a) => a.sessionId === sessionId)!
    return { ...s, actions, ran, table, apps, madeBy, nested, freshAsks, tty, found, answer, agent }
  }

  it('the devices start again with a tmux and a herdr agent idle: the scan puts each on its client\'s app with its tab, known, not on Other\'s page', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]))
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await t.answer(1, { app: 'iterm', tty: '/dev/ttys005', pid: 4400 })
    await look
    expect(t.nested.mock.calls).toEqual([[{ ...IN_TMUX, pid: 100, rows: ROWS }], [{ ...IN_HERDR, pid: 200, rows: ROWS }]])
    for (const [sessionId, tty, pid] of [['a', '/dev/ttys004', 4300], ['b', '/dev/ttys005', 4400]] as const) {
      const { id } = t.agent(sessionId)
      expect(t.agent(sessionId)).toMatchObject({ app: 'iterm' })
      expect(t.agent(sessionId)).not.toHaveProperty('appPending')
      expect(t.src.paneOf(id, 'tabs')).toBe(`iterm:${tty}`)
      expect(t.src.windowOf(id)).toEqual({ pid, app: 'iterm', outer: true })
      expect(await t.src.focus(t.agent(sessionId), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls.at(-1)).toEqual([id, { bundle: 'com.googlecode.iterm2' }])
      expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['iterm', tty, true])
    }
    // Their tty is the multiplexer pane's pty, which no tab holds.
    expect(t.tty).not.toHaveBeenCalled()
    expect(t.logs).toEqual(['[observed] scan · 2 found · 0 app known · 0 named · 0 answered · 0 ms · 2 nested placed'])
  })

  it('tabTty: the scan\'s place gives it', async () => {
    const t = scan(new Map([[100, IN_TMUX]]))
    t.found('a', 100)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await look
    expect(t.src.tabTty(t.agent('a').id)).toBe('/dev/ttys004')
  })

  // The devices find a scan-found herdr agent's pane by its shell, which herdr names (devices.ts placeInHerdr).
  it('foundNested: each live agent the scan found in that host\'s pane, no hook told of, with its parents below the host\'s server', async () => {
    const rows: readonly ProcessName[] = [...ROWS, { pid: 200, ppid: 190, executable: 'claude' },
      { pid: 190, ppid: 185, executable: 'bash' }, { pid: 185, ppid: 180, executable: 'zsh' }, { pid: 180, ppid: 1, executable: 'herdr' }]
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]), { table: async () => rows })
    t.found('a', 100)
    t.found('b', 200)
    t.found('c', 300)
    const look = t.src.scanOpen()
    await t.answer(0, {})
    await t.answer(1, {})
    await look
    expect(t.src.foundNested('herdr')).toEqual([{ agentId: t.agent('b').id, parents: [190, 185] }])
    expect(t.src.foundNested('tmux')).toEqual([{ agentId: t.agent('a').id, parents: [90] }])
    t.src.ingest(t.ev('turn-start', { sessionId: 'b', callerPid: 200, hostHints: { HERDR_PANE_ID: 'w1:p2' } }))
    expect(t.src.foundNested('herdr')).toEqual([])
  })

  it('a look reads the table once for its walk, its makers and its lookups', async () => {
    const pids = Array.from({ length: 50 }, (_, i) => 100 + i)
    const t = scan(new Map(pids.map((pid) => [pid, IN_TMUX])))
    for (const pid of pids) t.found(`s${pid}`, pid)
    const look = t.src.scanOpen()
    for (const i of pids.keys()) await t.answer(i, {})
    await look
    expect(t.table).toHaveBeenCalledTimes(1)
    expect(t.apps.mock.calls).toEqual([[pids, ROWS]])
    expect(t.apps.mock.calls[0][1]).toBe(ROWS)
    expect(t.madeBy.mock.calls).toEqual([[pids, ROWS]])
    expect(t.madeBy.mock.calls[0][1]).toBe(ROWS)
    expect(t.nested).toHaveBeenCalledTimes(50)
    for (const [found] of t.nested.mock.calls) expect(found.rows).toBe(ROWS)
  })

  it('a look asks its nested lookups one at a time, once its sessions are listed, and says its line once they settled', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]))
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    await flushed()
    expect(t.nested).toHaveBeenCalledTimes(1)
    expect(t.src.list()).toHaveLength(2)
    expect(t.changes).toHaveBeenCalledTimes(1)
    expect(t.logs).toEqual([])
    await t.answer(0, {})
    expect(t.nested).toHaveBeenCalledTimes(2)
    expect(t.logs).toEqual([])
    await t.answer(1, {})
    await look
    expect(t.logs).toHaveLength(1)
  })

  it('a nested session never has its own tty read, even when the walk named a tab app', async () => {
    // herdr's server is a child of its first client, whose app the walk names: not the one the person uses now.
    const t = scan(new Map([[200, IN_HERDR]]), { apps: async () => new Map([[200, 'terminal-app'], [300, 'ghostty']]) })
    t.found('b', 200)
    t.found('c', 300)
    const look = t.src.scanOpen()
    await t.answer(0, {})
    await look
    expect(t.tty.mock.calls).toEqual([[300]])
    expect(t.src.paneOf(t.agent('b').id, 'tabs')).toBeUndefined()
    expect(t.src.paneOf(t.agent('c').id, 'tabs')).toBe('ghostty:/dev/ttys031')
  })

  it('an answer after a hook, or for a session gone, is dropped; a session hooked before its turn is not asked', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_TMUX]]))
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', callerPid: 100, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    t.src.ingest(t.ev('session-start', { sessionId: 'b', callerPid: 200, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    await t.answer(0, ITERM)
    await look
    expect(t.nested).toHaveBeenCalledTimes(1)
    expect(t.src.list().map((a) => [a.sessionId, a.app])).toEqual([['a', 'ghostty'], ['b', 'ghostty']])
    expect(t.src.windowOf(t.agent('a').id)).toEqual({ pid: 100, app: 'ghostty' })
    expect(t.logs).toEqual(['[observed] scan · 2 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])

    const gone = scan(new Map([[100, IN_TMUX]]))
    gone.found('a', 100)
    const looking = gone.src.scanOpen()
    await vi.waitFor(() => expect(gone.nested).toHaveBeenCalledTimes(1))
    gone.gens.set(100, null)
    await gone.src.tick()
    expect(gone.src.list()).toEqual([])
    const told = gone.changes.mock.calls.length
    await gone.answer(0, ITERM)
    await looking
    expect(gone.src.list()).toEqual([])
    expect(gone.changes).toHaveBeenCalledTimes(told)
    expect(gone.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
  })

  it('an answer that names no app leaves the walk\'s app and appPending as they were, and counts nothing', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]), { apps: async () => new Map([[200, 'terminal-app']]) })
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    const listed = t.src.list()
    await t.answer(0, {})
    await t.answer(1, { tty: '/dev/ttys004', pid: 4300 })
    await look
    expect(t.src.list()).toEqual(listed)
    expect(listed.map((a) => [a.sessionId, a.app, a.appPending])).toEqual([['a', 'terminal', true], ['b', 'terminal-app', undefined]])
    expect(t.changes).toHaveBeenCalledTimes(1)
    expect(t.src.windowOf(t.agent('a').id)).toEqual({ pid: 100, app: 'terminal' })
    expect(t.src.windowOf(t.agent('b').id)).toEqual({ pid: 200, app: 'terminal-app' })
    expect(t.logs).toEqual(['[observed] scan · 2 found · 1 app known · 0 named · 0 answered · 0 ms · 0 nested placed'])
  })

  it('a session madeBy leaves out asks nothing and has its tty read as before, and the look\'s others are still placed', async () => {
    // Its maker's read failed (the process gone between the table and its tty read, or `ps` past its timeout).
    const t = scan(new Map([[200, IN_TMUX]]), { apps: async () => new Map([[100, 'iterm']]) })
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await look
    expect(t.nested.mock.calls).toEqual([[{ ...IN_TMUX, pid: 200, rows: ROWS }]])
    expect(t.tty.mock.calls).toEqual([[100]])
    expect(t.src.paneOf(t.agent('a').id, 'tabs')).toBe('iterm:/dev/ttys031')
    expect(t.src.paneOf(t.agent('b').id, 'tabs')).toBe('iterm:/dev/ttys004')

    // A maker read that rejects counts as none, and says so by its kind alone.
    const failed = scan(new Map(), {
      apps: async () => new Map([[100, 'iterm']]), madeBy: async () => { throw new Error('ps timed out under /Users/someone') },
    })
    failed.found('a', 100)
    await failed.src.scanOpen()
    expect(failed.nested).not.toHaveBeenCalled()
    expect(failed.tty.mock.calls).toEqual([[100]])
    expect(failed.logs).toEqual([
      '[observed] scan · makers not read · Error',
      '[observed] scan · 1 found · 1 app known · 0 named · 0 answered · 0 ms · 0 nested placed',
    ])
  })

  it('a lookup that rejects or throws counts as no place: the look\'s next is still asked, and its line is said', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR], [300, IN_TMUX]]))
    t.nested.mockRejectedValueOnce(new Error('osascript under /Users/someone'))
    t.nested.mockImplementationOnce(() => { throw new TypeError('no pane') })
    t.found('a', 100)
    t.found('b', 200)
    t.found('c', 300)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await look
    expect(t.nested).toHaveBeenCalledTimes(3)
    expect(t.src.list().map((a) => [a.sessionId, a.app, a.appPending])).toEqual([
      ['a', 'terminal', true], ['b', 'terminal', true], ['c', 'iterm', undefined],
    ])
    expect(t.logs).toEqual([
      '[observed] scan · lookup not read · Error',
      '[observed] scan · lookup not read · TypeError',
      '[observed] scan · 3 found · 0 app known · 0 named · 0 answered · 0 ms · 1 nested placed',
    ])
  })

  it('a session paired with a Herdr terminal is not asked', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]), { herdrTerminal: (pid) => (pid === 200 ? 't7' : undefined) })
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await look
    expect(t.nested.mock.calls).toEqual([[{ ...IN_TMUX, pid: 100, rows: ROWS }]])
    expect(t.agent('b')).toMatchObject({ host: 'herdr', app: 'herdr', paneKeys: ['herdr-app:t7'] })
    expect(t.agent('a').app).toBe('iterm')
  })

  it('a table that cannot be read lists every session not known, reads no maker, and says processes not read', async () => {
    const t = scan(new Map([[100, IN_TMUX]]), { table: vi.fn(async () => { throw new Error('ps timed out under /Users/someone') }) })
    t.found('a', 100)
    t.found('b', 200)
    await t.src.scanOpen()
    expect(t.src.list().map((a) => [a.sessionId, a.app, a.appPending])).toEqual([['a', 'terminal', true], ['b', 'terminal', true]])
    expect(t.apps).not.toHaveBeenCalled()
    expect(t.madeBy).not.toHaveBeenCalled()
    expect(t.nested).not.toHaveBeenCalled()
    expect(t.logs).toEqual([
      '[observed] scan · processes not read · Error',
      '[observed] scan · 2 found · 0 app known · 0 named · 0 answered · 0 ms · 0 nested placed',
    ])
    expect(t.logs.join('\n')).not.toContain('someone')
  })

  it('with no table reader the scan asks apps with the pids alone, and no maker', async () => {
    const t = scan(new Map([[100, IN_TMUX]]), { table: undefined })
    t.found('a', 100)
    t.found('b', 200)
    await t.src.scanOpen()
    expect(t.apps.mock.calls).toEqual([[[100, 200]]])
    expect(t.apps.mock.calls[0]).toHaveLength(1)
    expect(t.madeBy).not.toHaveBeenCalled()
    expect(t.nested).not.toHaveBeenCalled()
  })

  it('a scan asked while a look\'s lookups run joins that look', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]))
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    const again = t.src.scanOpen()
    await t.answer(0, ITERM)
    await t.answer(1, {})
    await Promise.all([look, again])
    expect(t.looks()).toBe(1)
    expect(t.nested).toHaveBeenCalledTimes(2)
  })

  it('the line counts the placed and names nothing', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR]]))
    t.found('a', 100)
    t.found('b', 200)
    const look = t.src.scanOpen()
    await t.answer(0, ITERM)
    await t.answer(1, {})
    await look
    expect(t.logs).toEqual(['[observed] scan · 2 found · 0 app known · 0 named · 0 answered · 0 ms · 1 nested placed'])
    for (const word of ['iterm', 'tmux', 'herdr', '4300', '100', '200', '80', 'ttys']) expect(t.logs.join('\n')).not.toContain(word)
  })

  it('the line\'s ms counts its nested lookups after its reads', async () => {
    const t = scan(new Map([[100, IN_TMUX]]), { apps: async () => { t.clock.t += 7; return new Map() } })
    t.found('a', 100)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    t.clock.t += 30
    await t.answer(0, ITERM)
    await look
    expect(t.logs).toEqual(['[observed] scan · 1 found · 0 app known · 0 named · 0 answered · 37 ms · 1 nested placed'])
  })

  // Diego, 2026-11-23: on its multiplexer's page from its listing, so it does not move page when its lookup answers.
  it('a session on a terminal tmux or herdr made has nest and host at its listing, with and without its lookup naming an app; one paired with a Herdr terminal has none', async () => {
    const t = scan(new Map([[100, IN_TMUX], [200, IN_HERDR], [300, IN_HERDR]]), { herdrTerminal: (pid) => (pid === 300 ? 't7' : undefined) })
    t.found('a', 100)
    t.found('b', 200)
    t.found('c', 300)
    const look = t.src.scanOpen()
    await vi.waitFor(() => expect(t.nested).toHaveBeenCalledTimes(1))
    expect(t.agent('a')).toMatchObject({ nest: 'tmux', host: 'tmux' })
    expect(t.agent('b')).toMatchObject({ nest: 'herdr', host: 'herdr' })
    await t.answer(0, ITERM)
    await t.answer(1, {})
    await look
    expect(t.agent('a')).toMatchObject({ app: 'iterm', nest: 'tmux', host: 'tmux' })
    expect(t.agent('b')).toMatchObject({ app: 'terminal', appPending: true, nest: 'herdr', host: 'herdr' })
    expect([pagesOf(t.agent('a')), pagesOf(t.agent('b'))]).toEqual([['iterm', 'tmux'], ['herdr']])
    expect(t.agent('c')).toMatchObject({ app: 'herdr', host: 'herdr' })
    expect(t.agent('c')).not.toHaveProperty('nest')
  })

  it('a Zellij maker gives no nest', async () => {
    const t = scan(new Map([[100, { host: 'zellij', maker: 80, tty: 'ttys010' }]]))
    t.found('a', 100)
    const look = t.src.scanOpen()
    await t.answer(0, { app: 'ghostty', tty: '/dev/ttys004', pid: 4300 })
    await look
    expect(t.agent('a')).toMatchObject({ app: 'ghostty', host: 'terminal' })
    expect(t.agent('a')).not.toHaveProperty('nest')
  })

  // A detached session, a client in a terminal with no page, or a step not read: the scan's lookup names no app, yet its
  // maker read put the agent on its multiplexer's page. Its pane inherited the bundle id of the app its server started in.
  it('the scan\'s lookup named no app: a nested first hook from the process it found keeps nest, host and page while its own lookup runs', async () => {
    const cases = [
      [IN_TMUX, { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' }],
      [IN_HERDR, { HERDR_PANE_ID: 'w1:p2', __CFBundleIdentifier: 'com.googlecode.iterm2' }],
    ] as const
    for (const [made, hostHints] of cases) {
      const outer = vi.fn((_hints: Readonly<Record<string, string>>, _pid: number) => new Promise<OuterAnswer>(() => {}))
      const t = scan(new Map([[100, made]]), { outer })
      t.found('a', 100)
      const look = t.src.scanOpen()
      await t.answer(0, {})
      await look
      expect(t.agent('a'), made.host).toMatchObject({ nest: made.host, host: made.host })
      t.src.ingest(t.ev('turn-start', { sessionId: 'a', hostHints }))
      expect(outer.mock.calls, made.host).toEqual([[hostHints, 100, expect.any(Function)]])
      expect(t.agent('a'), made.host).toMatchObject({ nest: made.host, host: made.host })
      expect(pagesOf(t.agent('a')), made.host).toEqual(['iterm', made.host])
    }
  })

  // Eval I14's resume after the devices started again: the maker read confirmed the multiplexer, and the first hook comes
  // from a new process in another pane of it, its hints naming iTerm2. Its tab goes at once (askOuter); its multiplexer
  // stays while that hook's own lookup runs, so it does not leave the multiplexer's ring, and that lookup's answer decides.
  it('a nested first hook from another process in the same multiplexer keeps the multiplexer the maker read confirmed until its own lookup answers', async () => {
    const cases = [
      [IN_TMUX, { TMUX_PANE: '%5', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' }],
      [IN_HERDR, { HERDR_PANE_ID: 'w1:p3', __CFBundleIdentifier: 'com.googlecode.iterm2' }],
    ] as const
    for (const [made, hostHints] of cases) {
      const asks: Array<(place: OuterAnswer) => void> = []
      const outer = vi.fn((_hints: Readonly<Record<string, string>>, _pid: number) =>
        new Promise<OuterAnswer>((resolve) => { asks.push(resolve) }))
      const t = scan(new Map([[100, made]]), { outer })
      t.found('a', 100)
      const look = t.src.scanOpen()
      await t.answer(0, ITERM)
      await look
      const { id } = t.agent('a')
      t.src.ingest(t.ev('session-start', { sessionId: 'a', hostHints, callerPid: 101 }))
      expect(outer.mock.calls, made.host).toEqual([[hostHints, 101, expect.any(Function)]])
      expect(t.agent('a'), made.host).toMatchObject({ nest: made.host, host: made.host, app: 'iterm' })
      expect(pagesOf(t.agent('a')), made.host).toEqual(['iterm', made.host])
      expect(t.src.paneOf(id, 'tabs'), made.host).toBeUndefined()
      // Its new terminal is no pane of it (a terminal started from the pane): its hints' app.
      asks[0]({})
      await flushed()
      expect(t.agent('a'), made.host).not.toHaveProperty('nest')
      expect(pagesOf(t.agent('a')), made.host).toEqual(['iterm'])
    }
  })

  // Pending, it would count for no page: its first turn's prompt follow to its multiplexer's page would find none there.
  it('the scan\'s lookup named no app: a nested first hook from the process it found is no longer pending, as the maker read confirmed its page', async () => {
    const outer = vi.fn((_hints: Readonly<Record<string, string>>, _pid: number) => new Promise<OuterAnswer>(() => {}))
    const t = scan(new Map([[100, IN_TMUX]]), { outer })
    t.found('a', 100)
    const look = t.src.scanOpen()
    await t.answer(0, {})
    await look
    expect(t.agent('a')).toMatchObject({ appPending: true, nest: 'tmux' })
    t.src.ingest(t.ev('turn-start', { sessionId: 'a', hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' } }))
    expect(t.agent('a')).toMatchObject({ app: 'iterm', nest: 'tmux' })
    expect(t.agent('a')).not.toHaveProperty('appPending')
  })

  describe('its placed tmux pane, and its first hook', () => {
    /** The pane tmux's lookup by process names for `a`: tmux's pane id, the agent's process and its client's app. */
    const PANE = { adapter: 'tmux', id: '%3:100:iterm' }
    const paneChecked = ['tmux', ['display-message', '-p', '-t', '%3', expect.any(String)], expect.any(Number)]
    const selected = ['tmux', ['select-window', '-t', '%3', ';', 'select-pane', '-t', '%3'], expect.any(Number)]
    /** A hook's hints in tmux pane [pane], a fresh record each time as each hook sends its own. */
    const inTmux = (pane = '%3') => ({ hostHints: { TMUX_PANE: pane, TERM_PROGRAM: 'tmux' } })

    /** Session `a`, idle in tmux pane %3, as the scan placed it: on iTerm2's page, at its client's tab, with its pane,
     *  iTerm2 in front. Its hooks' own outer lookups the test answers by hand, in the order asked, as tmux's and herdr's
     *  answer an event in their pane; an event in neither is not nested. A tap's or a rest's fresh ask of them answers
     *  `{}` at once, which changes nothing; its fresh nested ask is answered as [fresh] says (scan). */
    async function placed(
      fakes: Partial<Fakes> = {}, adapt?: (adapters: readonly HostAdapter[]) => readonly HostAdapter[], fresh: { freshByHand?: true } = {},
    ) {
      const hookAsks: Array<(place: OuterAnswer) => Promise<void>> = []
      const outer = vi.fn((hints: Readonly<Record<string, string>>, _pid: number, _made?: (nest: Nest) => void, opts?: Fresh) => {
        if (!hints.TMUX_PANE && !hints.HERDR_PANE_ID) return undefined
        if (opts?.fresh) return Promise.resolve<OuterAnswer>({})
        return new Promise<OuterAnswer>((resolve) => {
          hookAsks.push(async (place) => { resolve(place); await flushed() })
        })
      })
      const t = scan(new Map([[100, IN_TMUX]]), { outer }, { tmuxFront: () => 'iterm', ...fakes }, adapt, fresh)
      t.found('a', 100)
      const look = t.src.scanOpen()
      await t.answer(0, { ...ITERM, pane: PANE })
      await look
      return { ...t, outer, hookAsks, id: t.agent('a').id, a: () => t.agent('a') }
    }

    it('a rest with its app in front shows its tab, then selects its tmux pane', async () => {
      const t = await placed()
      expect(await t.src.showPane(t.a())).toBe('ok')
      expect(t.actions.tabSelect.mock.calls).toEqual([['iterm', '/dev/ttys004', false]])
      expect(t.ran.mock.calls).toEqual([paneChecked, selected])
      expect(t.actions.tabSelect.mock.invocationCallOrder[0]).toBeLessThan(t.ran.mock.invocationCallOrder[0])
      // A place, never its own pane: the devices' paths that read paneOf (the focus watch, the scroll) see none.
      expect(t.src.paneOf(t.id, 'tmux')).toBeUndefined()
      expect(t.a()).not.toHaveProperty('paneKeys')
    })

    it('a tap selects its tmux pane, then brings iTerm2 forward and raises its tab', async () => {
      let adapters: readonly HostAdapter[] = []
      // As the opener taps a pane that comes before its app (open.ts): the pane's own focus, then the app.
      const open = vi.fn(async (_agentId: string, target: OpenTarget) =>
        !target.pane || (await adapters.find((a) => a.id === target.pane!.adapter)!.focus(target.pane)) === true)
      const t = await placed({ open }, (all) => (adapters = all))
      expect(await t.src.focus(t.a(), latestTap)).toBe(true)
      expect(open.mock.calls).toEqual([[t.id, { bundle: 'com.googlecode.iterm2', pane: PANE }]])
      expect(t.ran.mock.calls).toEqual([paneChecked, selected])
      expect(t.actions.tabSelect.mock.calls).toEqual([['iterm', '/dev/ttys004', true]])
      expect(t.ran.mock.invocationCallOrder.at(-1)).toBeLessThan(t.actions.tabSelect.mock.invocationCallOrder[0])
    })

    // A place is a guess: shown wrong, it costs a look, while words typed there would run at another's prompt.
    it('a placed pane takes no words: tmux\'s, and herdr\'s placed by its listing', async () => {
      // tmux's adapter types nowhere: given a way to here, it would take the words if the source took a place for a pane.
      const typed = vi.fn(async (_pane: Pane, _text: string, _engine: string): Promise<TypeResult> => true)
      const t = await placed({}, (adapters) => adapters.map((a) => (a.id === 'tmux' ? { ...a, type: typed } : a)))
      t.found('b', 200)
      t.madeBy.mockResolvedValueOnce(new Map([[200, IN_HERDR]]))
      const look = t.src.scanOpen()
      await t.answer(1, { app: 'iterm', tty: '/dev/ttys005', pid: 4400 })
      await look
      const b = t.agent('b')
      t.src.setPaneNames('herdr', new Map(), new Map([[b.id, 'w1:p2:iterm']]))
      // Each place is where a tap goes.
      expect(t.src.shownAt(t.id, 'tmux')).toBe('%3:100:iterm')
      expect(t.src.shownAt(b.id, 'herdr')).toBe('w1:p2:iterm')
      for (const agent of [t.a(), b]) {
        expect(t.src.voiceRefusal(agent), agent.sessionId).toBe(CLAUDE_PLUGIN_OFF)
        expect(await t.src.send(agent, 'hello'), agent.sessionId).toMatchObject({ ok: false })
      }
      expect(typed).not.toHaveBeenCalled()
      expect(t.actions.herdrPrompt).not.toHaveBeenCalled()
    })

    // herdr's row of a pane with no session folds into the scan's copy by that key (registry.ts): one row, not two.
    it('a pane its listing placed it at carries that pane\'s key, and is still none of its own; the scan\'s lookup place carries none', async () => {
      const t = await placed()
      t.found('b', 200)
      t.madeBy.mockResolvedValueOnce(new Map([[200, IN_HERDR]]))
      const look = t.src.scanOpen()
      await t.answer(1, { app: 'iterm', tty: '/dev/ttys005', pid: 4400 })
      await look
      const { id } = t.agent('b')
      expect(t.agent('b')).not.toHaveProperty('paneKeys')
      t.src.setPaneNames('herdr', new Map(), new Map([[id, 'w1:p2:iterm']]))
      expect(t.agent('b').paneKeys).toEqual(['herdr:w1:p2'])
      expect(t.src.paneOf(id, 'herdr')).toBeUndefined()
      expect(t.src.byPane('herdr', 'w1:p2')).toBeUndefined()
      expect(t.a()).not.toHaveProperty('paneKeys')
      // The place gone, its key goes with it.
      t.src.setPaneNames('herdr', new Map(), new Map())
      expect(t.agent('b')).not.toHaveProperty('paneKeys')
    })

    it('the first hook after a scan\'s place keeps it on its app\'s page and tab until the hook\'s own answer lands, and that answer wins', async () => {
      const t = await placed()
      t.src.ingest(t.ev('session-start', { sessionId: 'a', ...inTmux() }))
      expect(t.outer.mock.calls).toEqual([[inTmux().hostHints, 100, expect.any(Function)]])
      // While it is asked, the row stays where the scan put it: the dial does not flicker to tmux's page.
      expect(t.a().app).toBe('iterm')
      expect(t.src.paneOf(t.id, 'tabs')).toBe('iterm:/dev/ttys004')
      expect(t.src.byTab('iterm', '/dev/ttys004')).toMatchObject({ id: t.id })
      expect(t.src.windowOf(t.id)).toEqual({ pid: 4300, app: 'iterm', outer: true })
      await t.hookAsks[0]({ app: 'terminal-app', tty: '/dev/ttys006', pid: 4500 })
      expect(t.a().app).toBe('terminal-app')
      expect(t.src.paneOf(t.id, 'tabs')).toBe('terminal-app:/dev/ttys006')
      expect(t.src.paneOf(t.id, 'tmux')).toBe('%3:100:terminal-app')
      expect(t.src.windowOf(t.id)).toEqual({ pid: 4500, app: 'terminal-app', outer: true })
      // From here it is a hooked agent: another caller drops its place at once, as for any.
      t.src.ingest(t.ev('needs-input', { sessionId: 'a', ...inTmux(), callerPid: 101 }))
      expect(t.a().app).toBe('tmux')
      expect(t.tty).not.toHaveBeenCalled()
    })

    it('a nested first hook from another process drops the scan\'s tab and client at once', async () => {
      const t = await placed()
      // Resumed in another tmux pane, its old SessionEnd missed: the scan's place was the old process's.
      t.src.ingest(t.ev('session-start', { sessionId: 'a', ...inTmux('%5'), callerPid: 101 }))
      expect(t.outer.mock.calls).toEqual([[inTmux('%5').hostHints, 101, expect.any(Function)]])
      expect(t.a().app).toBe('tmux')
      expect(t.src.paneOf(t.id, 'tabs')).toBeUndefined()
      expect(t.src.byTab('iterm', '/dev/ttys004')).toBeUndefined()
      expect(t.src.windowOf(t.id)).toEqual({ pid: 101, app: 'tmux' })
    })

    it('a first hook that is not nested drops the scan\'s place at once', async () => {
      const t = await placed()
      expect(await t.src.focus(t.a(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls.at(-1)).toEqual([t.id, { bundle: 'com.googlecode.iterm2', pane: PANE }])
      // The session resumed in a plain Ghostty tab, which no multiplexer made.
      t.src.ingest(t.ev('turn-start', { sessionId: 'a', hostHints: { TERM_PROGRAM: 'ghostty' } }))
      expect(t.a().app).toBe('ghostty')
      expect(t.src.byTab('iterm', '/dev/ttys004')).toBeUndefined()
      expect(t.src.windowOf(t.id)).toEqual({ pid: 100, app: 'ghostty' })
      await flushed()
      expect(t.tty.mock.calls).toEqual([[100]])
      expect(t.src.paneOf(t.id, 'tabs')).toBe('ghostty:/dev/ttys031')
      expect(t.src.shownAt(t.id, 'tmux')).toBeUndefined()
      expect(await t.src.focus(t.a(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls.at(-1)).toEqual([t.id, { bundle: 'com.mitchellh.ghostty' }])
    })

    it('a hook\'s own answer of none drops the scan\'s place', async () => {
      const t = await placed()
      t.src.ingest(t.ev('session-start', { sessionId: 'a', ...inTmux() }))
      expect(t.a().app).toBe('iterm')
      await t.hookAsks[0]({})
      // The person detached: on tmux's page, as the hook's hints say, with no tab.
      expect(t.a().app).toBe('tmux')
      expect(t.src.paneOf(t.id, 'tabs')).toBeUndefined()
      expect(t.src.byTab('iterm', '/dev/ttys004')).toBeUndefined()
      expect(t.src.paneOf(t.id, 'tmux')).toBe('%3:100')
      expect(t.src.windowOf(t.id)).toEqual({ pid: 100, app: 'tmux' })
    })

    it('a nested first hook in no tmux pane takes the placed pane away', async () => {
      const t = await placed()
      expect(t.src.shownAt(t.id, 'tmux')).toBe('%3:100:iterm')
      // Resumed in a herdr pane: still nested, its lookup runs, and tmux's pane is no longer where it is.
      t.src.ingest(t.ev('session-start', { sessionId: 'a', hostHints: { HERDR_PANE_ID: 'w1:p2' }, callerPid: 101 }))
      expect(t.outer.mock.calls).toEqual([[{ HERDR_PANE_ID: 'w1:p2' }, 101, expect.any(Function)]])
      expect(t.src.shownAt(t.id, 'tmux')).toBeUndefined()
      await t.hookAsks[0](ITERM)
      expect(t.src.shownAt(t.id, 'tmux')).toBeUndefined()
    })

    it('the first hook\'s own tmux pane is shown and tapped, not the scan\'s', async () => {
      const t = await placed()
      expect(t.src.shownAt(t.id, 'tmux')).toBe('%3:100:iterm')
      t.src.ingest(t.ev('turn-start', { sessionId: 'a', ...inTmux('%4') }))
      await t.hookAsks[0](ITERM)
      expect(t.src.paneOf(t.id, 'tmux')).toBe('%4:100:iterm')
      expect(t.src.shownAt(t.id, 'tmux')).toBe('%4:100:iterm')
      expect(await t.src.focus(t.a(), latestTap)).toBe(true)
      expect(t.actions.open.mock.calls.at(-1)).toEqual([t.id, { bundle: 'com.googlecode.iterm2', pane: { adapter: 'tmux', id: '%4:100:iterm' } }])
    })

    it('its first nested hook from its own process keeps nest until the hook\'s answer, then the answer\'s', async () => {
      // Its hints name a herdr pane too, which detectHost reads first: only nest keeps it tmux's meanwhile.
      const both = { hostHints: { TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', HERDR_PANE_ID: 'w1:p1' } }
      for (const [answer, nest, host] of [[{ ...ITERM, nest: 'tmux' }, 'tmux', 'tmux'], [{}, undefined, 'herdr']] as const) {
        const t = await placed()
        t.src.ingest(t.ev('session-start', { sessionId: 'a', ...both }))
        expect(t.a(), JSON.stringify(answer)).toMatchObject({ app: 'iterm', nest: 'tmux', host: 'tmux' })
        await t.hookAsks[0](answer)
        expect([t.a().nest, t.a().host], JSON.stringify(answer)).toEqual([nest, host])
      }
    })

    // Review Focus 3: resumed in a plain tab, it is no longer in tmux, and its page is its app's at once.
    it('a first hook that is not nested drops nest at once: host and page from its hints', async () => {
      const t = await placed()
      expect(t.a()).toMatchObject({ nest: 'tmux', host: 'tmux' })
      t.src.ingest(t.ev('turn-start', { sessionId: 'a', hostHints: { TERM_PROGRAM: 'ghostty' } }))
      expect(t.a()).not.toHaveProperty('nest')
      expect(t.a()).toMatchObject({ app: 'ghostty', host: 'ghostty' })
      expect(pagesOf(t.a())).toEqual(['ghostty'])
    })

    // Eval I13 for an agent the scan placed (PM, 2026-11-24): no hook since the devices started again, so nothing asks
    // again after the person attached from iTerm2's tab 2. A tap and a rest ask its lookup by process afresh, over a
    // table read now: the look's holds no client started since. The wait runs out only when a test says (fake timers).
    describe('a tap or a rest reads its client afresh', () => {
      beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
      afterEach(() => { vi.useRealTimers() })
      const TAB_2 = { ...ITERM, tty: '/dev/ttys005', pane: PANE }
      /** The table read at the tap: tab 2's iTerm2 session started since the look. */
      const NOW_ROWS: readonly ProcessName[] = [...ROWS, { pid: 4400, ppid: 1, executable: 'login' }]

      it('I13 for an agent the scan placed: re-attached in tab 2 with no hook, a tap reads a fresh table and opens tab 2', async () => {
        const t = await placed({}, undefined, { freshByHand: true })
        t.table.mockResolvedValueOnce(NOW_ROWS)
        const tapping = t.src.focus(t.a(), latestTap)
        await flushed()
        expect(t.table).toHaveBeenCalledTimes(2)
        expect(t.nested.mock.calls.at(-1)).toEqual([{ ...IN_TMUX, pid: 100, rows: NOW_ROWS }, { fresh: true }])
        expect(t.nested.mock.calls.at(-1)![0].rows).toBe(NOW_ROWS)
        expect(t.actions.open).not.toHaveBeenCalled()
        expect(t.freshAsks).toHaveLength(1)
        t.freshAsks[0](TAB_2)
        expect(await tapping).toBe(true)
        expect(t.src.paneOf(t.id, 'tabs')).toBe('iterm:/dev/ttys005')
        expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['iterm', '/dev/ttys005', true])
      })

      it('I13 for an agent the scan placed: a rest selects tab 2, then its tmux pane', async () => {
        const t = await placed({}, undefined, { freshByHand: true })
        const resting = t.src.showPane(t.a())
        await flushed()
        expect(t.actions.tabSelect).not.toHaveBeenCalled()
        expect(t.freshAsks).toHaveLength(1)
        t.freshAsks[0](TAB_2)
        expect(await resting).toBe('ok')
        expect(t.actions.tabSelect.mock.calls).toEqual([['iterm', '/dev/ttys005', false]])
        expect(t.ran.mock.calls).toEqual([paneChecked, selected])
      })

      it('placed by its maker alone (the scan\'s lookup named no app), a fresh answer that names iTerm2 places it there', async () => {
        const t = scan(new Map([[100, IN_TMUX]]), {}, { tmuxFront: () => 'iterm' }, undefined, { freshByHand: true })
        t.found('a', 100)
        const look = t.src.scanOpen()
        await t.answer(0, {})
        await look
        const { id } = t.agent('a')
        expect(t.agent('a')).toMatchObject({ nest: 'tmux', host: 'tmux' })
        const tapping = t.src.focus(t.agent('a'), latestTap)
        await flushed()
        expect(t.freshAsks).toHaveLength(1)
        t.freshAsks[0]({ ...ITERM, pane: PANE })
        expect(await tapping).toBe(true)
        expect(t.agent('a')).toMatchObject({ app: 'iterm', nest: 'tmux' })
        expect(t.agent('a')).not.toHaveProperty('appPending')
        expect(t.src.shownAt(id, 'tmux')).toBe('%3:100:iterm')
        expect(t.src.paneOf(id, 'tabs')).toBe('iterm:/dev/ttys004')
        expect(t.actions.open.mock.calls).toEqual([[id, { bundle: 'com.googlecode.iterm2', pane: PANE }]])
      })

      // Its lookup is asked the same host, process, tty and maker at a tap as at the scan, so one with no answer for it
      // then (a tty out of its platform's form) has none at a tap either: no table is read for it, and nothing waited for.
      it('a lookup with no answer for it at the scan: a tap and a rest read no table and wait for nothing', async () => {
        const nested = vi.fn((_found: Nested, _opts?: Fresh): Promise<NestedPlace> | undefined => undefined)
        const t = scan(new Map([[100, IN_TMUX]]), { nested }, { tmuxFront: () => 'iterm' })
        t.found('a', 100)
        await t.src.scanOpen()
        expect(t.agent('a')).toMatchObject({ nest: 'tmux', host: 'tmux' })
        await t.src.focus(t.agent('a'), latestTap)
        await t.src.showPane(t.agent('a'))
        expect(t.table).toHaveBeenCalledTimes(1)
        expect(nested).toHaveBeenCalledTimes(1)
      })

      it('a fresh table that cannot be read changes nothing, said once', async () => {
        const t = await placed({}, undefined, { freshByHand: true })
        t.table.mockRejectedValueOnce(new Error('ps timed out under /Users/someone'))
        expect(await t.src.focus(t.a(), latestTap)).toBe(true)
        expect(t.table).toHaveBeenCalledTimes(2)
        expect(t.nested).toHaveBeenCalledTimes(1)
        expect(t.actions.tabSelect.mock.calls).toEqual([['iterm', '/dev/ttys004', true]])
        expect(t.logs.filter((line) => line.startsWith('[observed] outer'))).toEqual(['[observed] outer · processes not read · Error'])
        expect(t.logs.join('\n')).not.toContain('someone')
      })

      it('a fresh lookup that rejects or throws changes nothing, said once, and a tap past the second asks again', async () => {
        for (const fail of ['rejects', 'throws'] as const) {
          const t = await placed({}, undefined, { freshByHand: true })
          t.nested.mockImplementationOnce(() => {
            if (fail === 'throws') throw new TypeError('no pane under /Users/someone')
            return Promise.reject(new Error('osascript under /Users/someone'))
          })
          expect(await t.src.focus(t.a(), latestTap), fail).toBe(true)
          expect(t.actions.tabSelect.mock.calls, fail).toEqual([['iterm', '/dev/ttys004', true]])
          expect(t.logs.filter((line) => line.startsWith('[observed] outer')), fail)
            .toEqual([`[observed] outer · lookup not read · ${fail === 'throws' ? 'TypeError' : 'Error'}`])
          expect(t.logs.join('\n'), fail).not.toContain('someone')
          t.clock.t += FRESH_WITHIN_MS
          const again = t.src.focus(t.a(), latestTap)
          await flushed()
          expect(t.freshAsks, fail).toHaveLength(1)
          t.freshAsks[0](TAB_2)
          expect(await again, fail).toBe(true)
          expect(t.actions.tabSelect.mock.calls.at(-1), fail).toEqual(['iterm', '/dev/ttys005', true])
        }
      })

      // Detached and not attached again, or a client in a terminal with no page: the row keeps its page and its tab.
      it('a fresh answer with no app changes nothing', async () => {
        for (const place of [{}, { tty: '/dev/ttys005', pid: 4500 }] as const) {
          const t = await placed({}, undefined, { freshByHand: true })
          const told = t.changes.mock.calls.length
          const tapping = t.src.focus(t.a(), latestTap)
          await flushed()
          expect(t.freshAsks, JSON.stringify(place)).toHaveLength(1)
          t.freshAsks[0](place)
          expect(await tapping, JSON.stringify(place)).toBe(true)
          expect(t.a().app, JSON.stringify(place)).toBe('iterm')
          expect(t.src.paneOf(t.id, 'tabs'), JSON.stringify(place)).toBe('iterm:/dev/ttys004')
          expect(t.src.windowOf(t.id), JSON.stringify(place)).toEqual({ pid: 4300, app: 'iterm', outer: true })
          expect(t.actions.tabSelect.mock.calls, JSON.stringify(place)).toEqual([['iterm', '/dev/ttys004', true]])
          expect(t.changes, JSON.stringify(place)).toHaveBeenCalledTimes(told)
        }
      })

      it('a hook during the fresh ask wins, and a later tap asks the hooked way', async () => {
        const t = await placed({}, undefined, { freshByHand: true })
        const tapping = t.src.focus(t.a(), latestTap)
        await flushed()
        expect(t.freshAsks).toHaveLength(1)
        t.src.ingest(t.ev('session-start', { sessionId: 'a', ...inTmux() }))
        await t.hookAsks[0]({ app: 'terminal-app', tty: '/dev/ttys006', pid: 4500 })
        t.freshAsks[0](TAB_2)
        expect(await tapping).toBe(true)
        expect(t.a().app).toBe('terminal-app')
        expect(t.src.paneOf(t.id, 'tabs')).toBe('terminal-app:/dev/ttys006')
        expect(t.actions.tabSelect.mock.calls.at(-1)).toEqual(['terminal-app', '/dev/ttys006', true])
        t.clock.t += FRESH_WITHIN_MS
        expect(await t.src.focus(t.a(), latestTap)).toBe(true)
        expect(t.outer.mock.calls.at(-1)).toEqual([inTmux().hostHints, 100, undefined, { fresh: true }])
        expect(t.nested).toHaveBeenCalledTimes(2)
        expect(t.table).toHaveBeenCalledTimes(2)
      })
    })
  })
})

// Codex 0.167+ runs a `codex` typed in a terminal as a client of its daemon, which runs every hook with the first TUI's
// environment and no terminal: its hints, its tty and its parents are another tab's (Diego, CLI 0.6.90, 2026-11-26).
describe('ObservedSource and a Codex session its own server runs', () => {
  const CLIENT = { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 }
  /** The hints of the first TUI's iTerm2 tab, which the daemon's environment keeps and every hook of its carries. */
  const ITERM2 = { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: 'com.googlecode.iterm2', TERM_SESSION_ID: 'w0t0p0:5B1C' }

  /** A source whose served lookups the test answers by hand, in the order they were asked, and a Codex hook from the
   *  daemon (900) with iTerm2's hints. */
  function served(over: Partial<Fakes> = {}, deps: Partial<ObservedDeps> = {}) {
    const asks: Array<{ answer(answers: readonly (Served | undefined)[]): Promise<void>; fail(): Promise<void> }> = []
    const lookup = vi.fn((_asks: readonly ServedAsk[]) => new Promise<readonly (Served | undefined)[]>((resolve, reject) => {
      asks.push({ answer: (answers) => { resolve(answers); return flushed() }, fail: () => { reject(new Error('ps failed')); return flushed() } })
    }))
    const tty = vi.fn(async (_pid: number): Promise<TabTty | undefined> => ({ tty: '/dev/ttys031' }))
    const { actions } = fakeActions(over)
    const s = setup({ actions, tty, served: lookup, ...deps })
    const agent = () => s.src.list()[0]
    const codex = (event: ObservedHookEvent['event'], more: Partial<ObservedHookEvent> = {}) => s.ev(event, {
      engine: 'codex', sessionId: THREAD, callerPid: 900, hostHints: { ...ITERM2 },
      transcriptPath: `/home/u/.codex/sessions/2026/11/26/rollout-2026-11-26T09-00-00-${THREAD}.jsonl`, ...more,
    })
    return { ...s, actions, lookup, asks, tty, agent, codex }
  }

  it('a hook from its daemon is on no page while its client is asked, then on its client\'s, with that TUI\'s tab', async () => {
    const t = served()
    const apps: string[] = []
    t.src.onChange(() => { apps.push(t.agent().app) })
    t.src.ingest(t.codex('session-start'))
    expect(t.lookup.mock.calls).toEqual([[[{ pid: 900, cwd: '/work/proj' }]]])
    expect(t.agent()).toMatchObject({ app: 'terminal', appPending: true })
    await t.asks[0].answer([{ client: CLIENT }])
    const { id } = t.agent()
    expect(t.agent().app).toBe('terminal-app')
    expect(t.agent().appPending).toBeUndefined()
    expect(pagesOf(t.agent())).toEqual(['terminal-app'])
    expect(t.src.tabTty(id)).toBe('/dev/ttys005')
    expect(t.src.paneOf(id, 'tabs')).toBe('terminal-app:/dev/ttys005')
    expect(t.src.windowOf(id)).toEqual({ pid: 500, app: 'terminal-app', outer: true })
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    expect(t.actions.open.mock.calls[0][1].bundle).toBe('com.apple.Terminal')
    // The daemon's own tty is none, and never read.
    expect(t.tty).not.toHaveBeenCalled()
    expect(apps).not.toContain('iterm')
  })

  it('no pane of its hints or its caller takes its words: a place learnt by its folder only shows it', async () => {
    const t = served({ codexQueue: { can: vi.fn(() => false), send: vi.fn() } })
    // The first TUI ran in tmux, and the session's own TUI runs in VS Code's terminal.
    t.src.ingest(t.codex('session-start', { hostHints: { ...ITERM2, TMUX_PANE: '%3' } }))
    expect(t.src.paneOf(t.agent().id, 'tmux')).toBeUndefined()
    await t.asks[0].answer([{ client: { app: 'vscode', tty: '/dev/ttys005', pid: 500 } }])
    const { id } = t.agent()
    expect(t.agent().app).toBe('vscode')
    for (const adapter of ['tmux', 'vscode', 'tabs']) expect(t.src.paneOf(id, adapter)).toBeUndefined()
    expect(t.src.capabilities(t.agent()).voice).toBe(false)
  })

  // A tab takes words only at a pane whose proof names the process whose tty it is (tabsType.ts). A daemon's session is
  // placed by its folder, never by a process of its own: a tty and start read for the TUI that ran it before the daemon
  // did prove nothing of the tab it is shown at now.
  it('a session its daemon runs, shown at a Ghostty TUI\'s tab, gives no adapter a process or a proof, and no tab takes its words', async () => {
    const TAB = '/dev/ttys005'
    const places: Place[] = []
    const send = vi.fn<TabsLine['send']>()
    const line: TabsLine = { writable: () => true, ready: async () => true, send, ended: new AbortController().signal }
    const tabs = createTabsAdapter({ isOpen: () => true, select: () => true })
    const adapter: HostAdapter = {
      ...tabs,
      ...tabsTyping({ line: () => line, shared: () => false, process: async () => undefined, readers: async () => undefined,
        processes: async () => [], after: (ms, run) => { const timer = setTimeout(run, ms); return () => { clearTimeout(timer) } } }),
      paneOf: (place) => { places.push(place); return tabs.paneOf(place) },
    }
    const { actions } = fakeActions({ codexQueue: { can: vi.fn(() => false), send: vi.fn() } })
    const t = served({}, { actions: { ...actions, adapters: [adapter] },
      tty: vi.fn(async (_pid: number): Promise<TabTty> => ({ tty: TAB, start: 'ps:1' })) })
    // Its own TUI in Ghostty ran it first, as no daemon's client: that process's tty and start were read.
    t.src.ingest(t.codex('session-start', { callerPid: 600, hostHints: { TERM_PROGRAM: 'ghostty' } }))
    await t.asks[0].answer([undefined])
    expect(places.at(-1)).toMatchObject({ pid: 600, proof: { pid: 600, start: 'ps:1' } })
    expect(t.src.capabilities(t.agent()).voice).toBe(true)
    // Resumed under the daemon, and shown at the Ghostty TUI working in its folder, on that same tab.
    t.src.ingest(t.codex('session-start'))
    await t.asks[1].answer([{ client: { app: 'ghostty', tty: TAB, pid: 500 } }])
    expect(t.src.paneOf(t.agent().id, 'tabs')).toBe(`ghostty:${TAB}`)
    expect(places.at(-1)?.pid).toBeUndefined()
    expect(places.at(-1)?.proof).toBeUndefined()
    expect(t.src.capabilities(t.agent()).voice).toBe(false)
    expect(await t.src.send(t.agent(), 'next')).toMatchObject({ ok: false })
    expect(send).not.toHaveBeenCalled()
  })

  it('a caller that is no server is placed by its hints once the lookup says so, and is not asked again', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    expect(t.agent().app).toBe('terminal')
    await t.asks[0].answer([undefined])
    expect(t.agent().app).toBe('iterm')
    expect(t.agent().appPending).toBeUndefined()
    expect(t.tty.mock.calls).toEqual([[900]])
    t.src.ingest(t.codex('turn-start', { hostHints: { TERM_PROGRAM: 'ghostty' } }))
    expect(t.agent().app).toBe('ghostty')
    expect(t.lookup).toHaveBeenCalledTimes(1)
  })

  it('asks again at a session\'s start, and at a turn\'s while no client is known, keeping its place until the answer', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: CLIENT }])
    const { id } = t.agent()
    t.src.ingest(t.codex('turn-start'))
    t.src.ingest(t.codex('turn-stop'))
    expect(t.lookup).toHaveBeenCalledTimes(1)
    // Resumed in another TUI, in another folder.
    t.src.ingest(t.codex('session-start', { cwd: '/work/two' }))
    expect(t.lookup.mock.calls[1]).toEqual([[{ pid: 900, cwd: '/work/two' }]])
    expect(t.agent().app).toBe('terminal-app')
    await t.asks[1].answer([{}])
    expect(t.agent().app).toBe('terminal')
    expect(t.agent().appPending).toBeUndefined()
    expect(t.src.tabTty(id)).toBeUndefined()
    // The daemon's window is none of the session's.
    expect(t.src.windowOf(id)).toBeUndefined()
    t.src.ingest(t.codex('turn-start', { cwd: '/work/two' }))
    expect(t.lookup).toHaveBeenCalledTimes(3)
    await t.asks[2].answer([{ client: CLIENT }])
    expect(t.agent().app).toBe('terminal-app')
  })

  it('at its client\'s app with no tab, a tap brings that app forward, and each turn\'s start asks again until a tab is known', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    // Two TUIs in its folder, both in Terminal: the app is certain, the tab is not.
    await t.asks[0].answer([{ client: { app: 'terminal-app' } }])
    const { id } = t.agent()
    expect(t.agent().app).toBe('terminal-app')
    expect(t.src.tabTty(id)).toBeUndefined()
    expect(t.src.windowOf(id)).toBeUndefined()
    expect(await t.src.focus(t.agent(), latestTap)).toBe(true)
    // The app alone: no pane of either TUI is raised.
    expect(t.actions.open.mock.calls[0][1]).toEqual({ bundle: 'com.apple.Terminal' })
    expect(t.src.paneOf(id, 'tabs')).toBeUndefined()
    // Its words go by Codex's queue, never into a tab.
    expect(await t.src.send(t.agent(), 'next')).toEqual({ ok: true })
    expect(t.actions.codexQueue.send).toHaveBeenCalledTimes(1)
    expect(t.actions.tabSelect).not.toHaveBeenCalled()
    t.src.ingest(t.codex('turn-start'))
    expect(t.lookup).toHaveBeenCalledTimes(2)
    expect(t.agent().app).toBe('terminal-app')
    // One of them quit: the one left is the client.
    await t.asks[1].answer([{ client: CLIENT }])
    expect(t.src.tabTty(id)).toBe('/dev/ttys005')
    expect(t.src.windowOf(id)).toEqual({ pid: 500, app: 'terminal-app', outer: true })
    t.src.ingest(t.codex('turn-start'))
    expect(t.lookup).toHaveBeenCalledTimes(2)
  })

  it('at its client\'s app with no tab, it leaves that app at the next tick once one of its TUIs exited, as either may have been its client', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: { app: 'terminal-app' }, clients: [500, 501] }])
    // Both run: the app is still certain.
    await t.src.tick()
    expect(t.agent().app).toBe('terminal-app')
    // One quit, the daemon runs on: had it been the session's, the session is in no app now.
    t.gens.set(501, null)
    await t.src.tick()
    expect(t.src.list()).toHaveLength(1)
    expect(t.agent().app).toBe('terminal')
    expect(t.agent().appPending).toBeUndefined()
    // Its next turn asks again, which finds the one left if it is its own.
    t.src.ingest(t.codex('turn-start'))
    expect(t.lookup).toHaveBeenCalledTimes(2)
  })

  it('a session whose client exited leaves that tab at the next tick, which holds a shell now: on no page until asked again', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: CLIENT }])
    const { id } = t.agent()
    // Its TUI quit; the daemon runs on, and holds the session.
    t.gens.set(500, null)
    await t.src.tick()
    expect(t.src.list()).toHaveLength(1)
    expect(t.agent().app).toBe('terminal')
    expect(t.agent().appPending).toBeUndefined()
    expect(t.src.tabTty(id)).toBeUndefined()
    expect(t.src.paneOf(id, 'tabs')).toBeUndefined()
    expect(t.src.byTab('terminal-app', '/dev/ttys005')).toBeUndefined()
    expect(t.src.windowOf(id)).toBeUndefined()
    t.src.ingest(t.codex('turn-start'))
    expect(t.lookup).toHaveBeenCalledTimes(2)
  })

  it('a client found while the tick read its table stays: that table is older than it', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: CLIENT }])
    let read!: () => void
    t.procs.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { read = resolve })
      return [{ pid: 900, generation: 'g900' }]
    })
    const ticked = t.src.tick()
    // Resumed meanwhile in a TUI in iTerm2, started after the table was read.
    t.src.ingest(t.codex('session-start'))
    await t.asks[1].answer([{ client: { app: 'iterm', tty: '/dev/ttys009', pid: 600 } }])
    read()
    await ticked
    expect(t.agent().app).toBe('iterm')
    expect(t.src.tabTty(t.agent().id)).toBe('/dev/ttys009')
  })

  it('only the latest ask lands: another caller drops the place at once', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: CLIENT }])
    t.src.ingest(t.codex('session-start', { callerPid: 901 }))
    expect(t.agent()).toMatchObject({ app: 'terminal', appPending: true })
    t.src.ingest(t.codex('session-start', { callerPid: 902 }))
    await t.asks[1].answer([{ client: CLIENT }])
    expect(t.agent()).toMatchObject({ app: 'terminal', appPending: true })
    await t.asks[2].answer([{ client: { app: 'ghostty', tty: '/dev/ttys007', pid: 501 } }])
    expect(t.agent().app).toBe('ghostty')
  })

  it('Claude Code\'s hooks are placed by their hints at once, with no lookup', () => {
    const t = served()
    t.src.ingest(t.ev('session-start', { hostHints: { ...ITERM2 } }))
    expect(t.agent().app).toBe('iterm')
    expect(t.lookup).not.toHaveBeenCalled()
  })

  it('a place its lookup lands names it as a hook\'s own does: a ChatGPT thread by its name there', async () => {
    const t = served()
    t.src.setPaneNames('codex', new Map([[THREAD, { title: 'Fix the build', renamed: false }]]), new Map())
    // The app's own server is no daemon (codexServed.ts): its hints place it once the lookup says so.
    const inApp = { hostHints: { __CFBundleIdentifier: 'com.openai.codex' } }
    t.src.ingest(t.codex('session-start', inApp))
    expect(t.agent().name).toBe('proj')
    await t.asks[0].answer([undefined])
    expect(t.agent()).toMatchObject({ app: 'codex', name: 'Fix the build' })
  })

  it('a lookup that fails places nothing by the hints: no page and no pane until its next hook asks again, and says only its kind', async () => {
    const t = served({ codexQueue: { can: vi.fn(() => false), send: vi.fn() } })
    // The daemon's hints may be the first TUI's tmux pane, another session's prompt.
    t.src.ingest(t.codex('session-start', { hostHints: { ...ITERM2, TMUX_PANE: '%3' } }))
    await t.asks[0].fail()
    const { id } = t.agent()
    expect(t.agent()).toMatchObject({ app: 'terminal', appPending: true })
    expect(t.src.paneOf(id, 'tmux')).toBeUndefined()
    expect(t.src.capabilities(t.agent()).voice).toBe(false)
    expect(t.logs).toContain('[observed] served · not read · Error')
    t.src.ingest(t.codex('turn-start', { hostHints: { ...ITERM2, TMUX_PANE: '%3' } }))
    expect(t.lookup).toHaveBeenCalledTimes(2)
    await t.asks[1].answer([{ client: CLIENT }])
    expect(t.agent().app).toBe('terminal-app')
  })

  it('a server\'s ask that fails keeps its client\'s place: an unread machine is never no server', async () => {
    const t = served()
    t.src.ingest(t.codex('session-start'))
    await t.asks[0].answer([{ client: CLIENT }])
    const { id } = t.agent()
    t.src.ingest(t.codex('session-start'))
    await t.asks[1].fail()
    expect(t.agent().app).toBe('terminal-app')
    expect(t.src.tabTty(id)).toBe('/dev/ttys005')
    expect(t.tty).not.toHaveBeenCalled()
  })

  /** A Codex session the open scan finds held by [pid], on no terminal unless [tty] says, in /work/app. */
  const foundCodex = (t: ReturnType<typeof served>, sessionId: string, pid: number, tty: string | null = null): void => {
    t.open.set(sessionId, 'app')
    t.owners.set(sessionId, { pid, engine: 'codex', tty })
    t.externals.set(sessionId, { cwd: '/work/app', transcriptPath: `/home/u/.codex/sessions/2026/11/26/rollout-${sessionId}.jsonl` })
  }

  it('the scan places a session a Codex server holds by its client, never by the server\'s parents', async () => {
    // The daemon is still the child of the first TUI, in iTerm2: its parents name iTerm2.
    const t = served({}, { apps: async () => new Map([[900, 'iterm']]) })
    foundCodex(t, THREAD, 900)
    const scanned = t.src.scanOpen()
    await vi.waitFor(() => { expect(t.asks).toHaveLength(1) })
    expect(t.lookup.mock.calls).toEqual([[[{ pid: 900, cwd: '/work/app' }]]])
    await t.asks[0].answer([{ client: CLIENT }])
    await scanned
    const agent = t.src.list()[0]
    expect(agent).toMatchObject({ app: 'terminal-app' })
    expect(agent.appPending).toBeUndefined()
    expect(t.src.tabTty(agent.id)).toBe('/dev/ttys005')
    expect(t.src.paneOf(agent.id, 'tabs')).toBe('terminal-app:/dev/ttys005')
    expect(t.src.windowOf(agent.id)).toEqual({ pid: 500, app: 'terminal-app', outer: true })
    expect(t.tty).not.toHaveBeenCalled()
    expect(t.logs[0]).toMatch(/^\[observed\] scan · 1 found · 1 app known · /)
  })

  it('the scan asks only for Codex sessions on no terminal, all in one ask, and places the others as before', async () => {
    const t = served({}, { apps: async () => new Map([[11, 'ghostty'], [12, 'ghostty']]) })
    foundCodex(t, THREAD, 900)
    foundCodex(t, 'b', 901)
    foundCodex(t, 'tui', 12, '/dev/ttys003')
    t.open.set('cc', 'terminal')
    t.owners.set('cc', { pid: 11, engine: 'claude' })
    t.externals.set('cc', { cwd: '/work/app', transcriptPath: '/t/cc.jsonl' })
    const scanned = t.src.scanOpen()
    await vi.waitFor(() => { expect(t.asks).toHaveLength(1) })
    expect(t.lookup.mock.calls).toEqual([[[{ pid: 900, cwd: '/work/app' }, { pid: 901, cwd: '/work/app' }]]])
    // The second's caller is no server: it is placed as before.
    await t.asks[0].answer([{}, undefined])
    await scanned
    const bySession = (sessionId: string) => t.src.list().find((a) => a.sessionId === sessionId)!
    expect(bySession(THREAD).app).toBe('terminal')
    expect(bySession(THREAD).appPending).toBeUndefined()
    expect(t.src.windowOf(bySession(THREAD).id)).toBeUndefined()
    expect(bySession('b')).toMatchObject({ app: 'terminal', appPending: true })
    expect(bySession('tui').app).toBe('ghostty')
    expect(bySession('cc').app).toBe('ghostty')
  })

  it('the scan keeps what it learnt of a Codex session no daemon holds: the first hook from its holder is placed at once, never off its page', async () => {
    const t = served({}, { apps: async () => new Map([[12, 'iterm'], [901, 'iterm']]) })
    // One on a terminal, which the daemon never is, and one on none that the lookup says no daemon holds.
    foundCodex(t, 'tui', 12, '/dev/ttys003')
    foundCodex(t, 'b', 901)
    const scanned = t.src.scanOpen()
    await vi.waitFor(() => { expect(t.asks).toHaveLength(1) })
    await t.asks[0].answer([undefined])
    await scanned
    const bySession = (sessionId: string) => t.src.list().find((a) => a.sessionId === sessionId)!
    const apps: string[] = []
    t.src.onChange(() => { apps.push(bySession('tui').app) })
    // Its first hook is a prompt typed in its tab: devices.ts followPrompt reads its app as the hook lands.
    t.src.ingest(t.codex('turn-start', { sessionId: 'tui', callerPid: 12 }))
    expect(bySession('tui').app).toBe('iterm')
    t.src.ingest(t.codex('turn-start', { sessionId: 'b', callerPid: 901 }))
    expect(bySession('b').app).toBe('iterm')
    expect(apps).not.toContain('terminal')
    expect(t.lookup).toHaveBeenCalledTimes(1)
  })

  it('a scan whose lookup fails leaves a Codex session on no terminal on no page, never at its holder\'s parents\' app', async () => {
    // The daemon is still the child of the first TUI, in iTerm2: its parents name iTerm2.
    const t = served({}, { apps: async () => new Map([[900, 'iterm']]) })
    foundCodex(t, THREAD, 900)
    const scanned = t.src.scanOpen()
    await vi.waitFor(() => { expect(t.asks).toHaveLength(1) })
    await t.asks[0].fail()
    await scanned
    expect(t.agent()).toMatchObject({ app: 'terminal', appPending: true })
    expect(t.logs).toContain('[observed] scan · served not read · Error')
    // Its first hook asks again.
    t.src.ingest(t.codex('turn-start', { cwd: '/work/app' }))
    expect(t.lookup).toHaveBeenCalledTimes(2)
  })

  it('the first hook from the server the scan found it held keeps its place: asked again only at a start', async () => {
    const t = served()
    foundCodex(t, THREAD, 900)
    const scanned = t.src.scanOpen()
    await vi.waitFor(() => { expect(t.asks).toHaveLength(1) })
    await t.asks[0].answer([{ client: CLIENT }])
    await scanned
    const apps: string[] = []
    t.src.onChange(() => { apps.push(t.agent().app) })
    t.src.ingest(t.codex('turn-start', { cwd: '/work/app' }))
    t.src.ingest(t.codex('turn-stop', { cwd: '/work/app' }))
    expect(t.lookup).toHaveBeenCalledTimes(1)
    expect(apps).toEqual(['terminal-app', 'terminal-app'])
    expect(t.src.tabTty(t.agent().id)).toBe('/dev/ttys005')
    t.src.ingest(t.codex('session-start', { cwd: '/work/app' }))
    expect(t.lookup).toHaveBeenCalledTimes(2)
    expect(t.agent().app).toBe('terminal-app')
  })

  it('Diego\'s Codex in Terminal: the scan and every hook put it on Terminal\'s page at its TUI\'s tab, never iTerm2\'s, with no pane to type into', async () => {
    // Codex 0.172 in Terminal on ttys005, a client of the daemon under launchd, which holds the rollout; another TUI in
    // iTerm2 works in another folder, and the daemon's environment, which every hook carries, is the iTerm2 tab's that
    // started it, inside tmux.
    const HOME = '/Users/someone'
    const DAEMON = `${HOME}/.codex/packages/app-server-daemon/current/bin/codex`
    const row = (pid: number, ppid: number, command: string, args: string = command): RunningProcess =>
      ({ pid, ppid, executable: command.slice(0, 16), commandPath: command, args })
    const rows = [
      row(10, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'), row(11, 10, 'login'), row(12, 11, '-zsh'),
      row(500, 12, '/opt/homebrew/bin/codex', 'codex'),
      row(20, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'), row(21, 20, '-zsh'), row(600, 21, '/opt/homebrew/bin/codex', 'codex'),
      row(900, 1, DAEMON, `${DAEMON} app-server --remote-control --listen unix:// --analytics-default-enabled --managed-daemon`),
    ]
    const places: Record<number, { tty: string; cwd: string }> = {
      500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/other' },
    }
    const bundles: Record<string, string> = {
      '/System/Applications/Utilities/Terminal.app': 'com.apple.Terminal', '/Applications/iTerm.app': 'com.googlecode.iterm2',
    }
    const walk = (pids: readonly number[], names: readonly ProcessName[] = rows) => scannedApps(pids, {
      platform: 'darwin', roots: appRoots(HOME), processes: async () => names, bundleId: async (bundle) => bundles[bundle], home: HOME,
    })
    const lookup: CodexServedDeps = {
      platform: 'darwin', processes: async () => rows,
      cwds: async (pids) => new Map(pids.flatMap((pid) => (places[pid] ? [[pid, places[pid].cwd] as const] : []))),
      tty: async (pid) => places[pid]?.tty, apps: walk, folder: async (path) => path,
    }
    const { actions } = fakeActions({ codexQueue: { can: vi.fn(() => false), send: vi.fn() } })
    const tty = vi.fn(async (_pid: number): Promise<TabTty | undefined> => undefined)
    const s = setup({ actions, tty, apps: (pids) => walk(pids), served: (asks) => codexServed(asks, lookup) })
    const apps: string[] = []
    s.src.onChange(() => { apps.push(s.src.list()[0].app) })
    s.open.set(THREAD, 'app')
    s.owners.set(THREAD, { pid: 900, engine: 'codex' })
    s.externals.set(THREAD, { cwd: '/work/app', transcriptPath: `/home/u/.codex/sessions/2026/11/26/rollout-${THREAD}.jsonl` })
    await s.src.scanOpen()
    const { id } = s.src.list()[0]
    const onTerminal = (): void => {
      const agent = s.src.list()[0]
      expect(pagesOf(agent)).toEqual(['terminal-app'])
      expect(s.src.tabTty(id)).toBe('/dev/ttys005')
      expect(s.src.paneOf(id, 'tabs')).toBe('terminal-app:/dev/ttys005')
      for (const adapter of ['tmux', 'vscode', 'orca', 'herdr', 'wezterm']) expect(s.src.paneOf(id, adapter)).toBeUndefined()
      expect(s.src.capabilities(agent).voice).toBe(false)
    }
    onTerminal()
    expect(s.logs[0]).toMatch(/^\[observed\] scan · 1 found · 1 app known · /)
    const hints = { TERM_PROGRAM: 'iTerm.app', __CFBundleIdentifier: 'com.googlecode.iterm2', TERM_SESSION_ID: 'w0t0p0:5B1C', TMUX_PANE: '%3' }
    for (const event of ['session-start', 'turn-start', 'turn-stop'] as const) {
      s.src.ingest(s.ev(event, { engine: 'codex', sessionId: THREAD, callerPid: 900, cwd: '/work/app', hostHints: hints }))
      await flushed()
      onTerminal()
    }
    expect(apps.length).toBeGreaterThan(0)
    expect(apps).not.toContain('iterm')
    expect(tty).not.toHaveBeenCalled()
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
      [undefined, ['turn-stop'], withHandle.hostHints, 'x'.repeat(MAX_TEXT + 1), 'too-long'],
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

  it('transcriptOf is the path the agent\'s latest hook gave, kept when a later hook gives none, and none for an agent it does not list', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { transcriptPath: '/o/home/projects/-work-proj/s0.jsonl' }))
    src.ingest(ev('turn-start', { transcriptPath: '/o/home/projects/-work-proj/s1.jsonl' }))
    src.ingest(ev('turn-stop'))
    expect(src.transcriptOf(src.list()[0].id)).toBe('/o/home/projects/-work-proj/s1.jsonl')
    expect(src.transcriptOf(observedAgentId('claude', 'unknown'))).toBeUndefined()
  })

  it('startedIn is the folder of the first hook that gave one, kept when a later hook names another, and none for an agent it does not list', () => {
    const { src, ev } = setup()
    src.ingest(ev('session-start', { cwd: undefined }))
    src.ingest(ev('turn-start'))
    // Its Bash moved into a folder below: Claude Code still reads the project's settings from where it started.
    src.ingest(ev('turn-stop', { cwd: '/work/proj/packages/web' }))
    expect(src.list()[0].cwd).toBe('/work/proj/packages/web')
    expect(src.startedIn(src.list()[0].id)).toBe('/work/proj')
    expect(src.startedIn(observedAgentId('claude', 'unknown'))).toBeUndefined()
  })

  it('startedIn of a session the scan found is the folder its row gave, kept when its hooks name another', async () => {
    const { src, open, owners, externals, ev } = setup()
    open.set('s1', 'terminal')
    owners.set('s1', { pid: 100, engine: 'claude' })
    externals.set('s1', { cwd: '/work/proj', transcriptPath: '/t/s1.jsonl' })
    await src.scanOpen()
    src.ingest(ev('turn-start', { cwd: '/work/proj/packages/web' }))
    expect(src.startedIn(src.list()[0].id)).toBe('/work/proj')
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

// Codex runs its PermissionRequest hook before it reads the session's "don't ask again" answers, and nothing it sends
// says the person gave one: only the first ask of a command in a session rings (harness-pm, 2026-11-27).
describe('ObservedSource and an ask Codex repeats in a session', () => {
  const asked = (over: Partial<ObservedAsked> = {}): ObservedAsked => ({
    engine: 'codex', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'npm test', ...over,
  })
  /** Whether the ask, made while its session's turn runs, turned it needs-you and was heard. */
  const rings = (s: ReturnType<typeof setup>, ask: ObservedAsked): boolean => {
    s.src.ingest(s.ev('turn-start', { engine: ask.engine, sessionId: ask.sessionId }))
    s.changes.mockClear()
    s.src.ingest(ask)
    const state = s.src.list().find((a) => a.id === observedAgentId(ask.engine, ask.sessionId))?.state
    return state === 'needs-you' && s.changes.mock.calls.length === 1
  }

  it('rings its first ask, and not the same tool and line again in that session, which changes and logs nothing', () => {
    const log = vi.fn()
    const s = setup({ log })
    expect(rings(s, asked())).toBe(true)
    s.src.ingest(s.ev('turn-start', { engine: 'codex' }))
    log.mockClear()
    expect(rings(s, asked())).toBe(false)
    expect(s.src.list()[0].state).toBe('working')
    expect(s.src.waitingOn(s.src.list()[0].id)).toBeUndefined()
    expect(log).not.toHaveBeenCalled()
  })

  it('rings another line, another tool, and the same line in another session', () => {
    const s = setup()
    expect(rings(s, asked())).toBe(true)
    expect(rings(s, asked({ summary: 'npm run build' }))).toBe(true)
    expect(rings(s, asked({ tool: 'apply_patch' }))).toBe(true)
    expect(rings(s, asked({ sessionId: 's2' }))).toBe(true)
  })

  it('keeps 64 asks a session: the 65th forgets the oldest, which rings again', () => {
    const s = setup()
    for (let i = 0; i <= 64; i++) expect(rings(s, asked({ summary: `step ${i}` }))).toBe(true)
    expect(rings(s, asked({ summary: 'step 64' }))).toBe(false)
    expect(rings(s, asked({ summary: 'step 1' }))).toBe(false)
    expect(rings(s, asked({ summary: 'step 0' }))).toBe(true)
  })

  it('rings every repeat of a question form, which no answer stops Codex asking', () => {
    const s = setup()
    const form = asked({ tool: 'request_user_input', summary: 'Which database?' })
    expect(rings(s, form)).toBe(true)
    expect(rings(s, form)).toBe(true)
  })

  it('forgets a session\'s asks at its end: resumed, the same ask rings again', () => {
    const s = setup()
    expect(rings(s, asked())).toBe(true)
    s.src.ingest(s.ev('session-end', { engine: 'codex' }))
    s.src.ingest(s.ev('session-start', { engine: 'codex' }))
    expect(rings(s, asked())).toBe(true)
  })

  it('forgets a session\'s asks once it leaves the list: heard of again, the same ask rings again', async () => {
    const s = setup()
    expect(rings(s, asked())).toBe(true)
    s.gens.set(100, null)
    await s.src.tick()
    expect(s.src.list()).toEqual([])
    s.src.ingest(s.ev('session-start', { engine: 'codex', callerPid: 200 }))
    expect(rings(s, asked())).toBe(true)
  })

  it('rings every repeat of Claude Code\'s, which asks only when its dialog opens', () => {
    const s = setup()
    expect(rings(s, asked({ engine: 'claude' }))).toBe(true)
    expect(rings(s, asked({ engine: 'claude' }))).toBe(true)
  })
})

describe('ObservedSource and the Orca sessions its hooks named', () => {
  it('maps each Orca session id a hook named to its session, keeps an ended copy, and skips a session that named none', () => {
    const { src, ev } = setup()
    expect(src.orcaSessions()).toEqual(new Map())
    src.ingest(ev('session-start', { sessionId: 's1', hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' } }))
    src.ingest(ev('session-start', { engine: 'codex', sessionId: 't2', callerPid: 101, hostHints: { ORCA_AGENT_SESSION_ID: 'orca-2' } }))
    src.ingest(ev('session-start', { sessionId: 's3', callerPid: 102, hostHints: { ORCA_TERMINAL_HANDLE: 'term_x' } }))
    src.ingest(ev('session-start', { sessionId: 's4', callerPid: 103, hostHints: { ORCA_AGENT_SESSION_ID: '' } }))
    const both = new Map([['orca-1', { engine: 'claude', sessionId: 's1' }], ['orca-2', { engine: 'codex', sessionId: 't2' }]])
    expect(src.orcaSessions()).toEqual(both)
    // Its end comes from the same process, with the same hints: Orca still holds the chat, so its row keeps this id.
    src.ingest(ev('session-end', { sessionId: 's1', hostHints: { ORCA_AGENT_SESSION_ID: 'orca-1' } }))
    expect(src.list().find(({ sessionId }) => sessionId === 's1')?.ended).toBe(true)
    expect(src.orcaSessions()).toEqual(both)
  })

  it('cuts an answer on a code point, as a card keeps it', () => {
    expect(cutAnswer('short')).toBe('short')
    const cut = cutAnswer('🙂'.repeat(500))
    expect(cut.endsWith('…')).toBe(true)
    expect(Array.from(cut).every((char) => char === '🙂' || char === '…')).toBe(true)
  })
})

describe('oncePerCaller', () => {
  it('says its line once per caller, and forgets the oldest past 64 callers', () => {
    const logs: string[] = []
    const say = oncePerCaller((line) => { logs.push(line) }, '[device] a · held')
    say(1)
    say(1)
    say(2)
    expect(logs).toEqual(['[device] a · held', '[device] a · held'])
    for (let pid = 3; pid <= 65; pid++) say(pid)
    logs.length = 0
    say(2)
    say(65)
    expect(logs).toEqual([])
    say(1)
    expect(logs).toEqual(['[device] a · held'])
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
