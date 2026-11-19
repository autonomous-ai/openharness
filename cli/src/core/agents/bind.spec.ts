import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcriptOf, processSessionOf } from '../../engines/identities.js'
import { loadEngine } from '../../engines/inProcess.js'
import { HERMES_SANDBOX_HOLD } from '../../engines/hermes/contract.js'
import { OPENCLAW_STATES } from '../../engines/openclaw/contract.js'
import { OTHER_ENGINE_STATES } from '../../engines/otherEngines.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import { OpenclawLive } from '../../engines/openclaw/live.js'
import { continuationOf } from '../../engines/sessionFiles.js'
import { env } from '../../config/env.js'
import { isRecentlyDeleted } from '../../lib/deletedSessions.js'
import { openclawSessionDb, openclawStateDir } from '../../lib/openclawStore.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { findLiveSession, findResumedTranscript } from '../../lib/sessionRepair.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { AttachTracker } from '../../lib/attachTracker.js'
import { paneReadIdentity } from '../transcripts/readIdentity.js'
import { createBinding, statBirthMs, type BindDeps, type RegisteredMeta } from './bind.js'
import { createInput } from '../input.js'
import type { TerminalActionResult } from '../../lib/terminalTypes.js'
import { readInlineScreen } from '../../testing/inlineScreen.js'
import { inlineSubmission } from '../../testing/inlineSubmission.js'

vi.mock('../../engines/identities.js', () => ({ transcriptOf: vi.fn(), processSessionOf: vi.fn() }))
vi.mock('../../engines/cursor/contract.js', async (real) => ({ ...await real<object>(), cursorDataDir: () => '/cursor' }))
// The optional loader may be unavailable; identity must still be usable.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})
vi.mock('../../lib/deletedSessions.js', () => ({ isRecentlyDeleted: vi.fn(() => false) }))
vi.mock('../../engines/sessionFiles.js', () => ({ continuationOf: vi.fn(async () => null) }))
vi.mock('../../lib/sessionRepair.js', () => ({
  findLiveSession: vi.fn(async () => null),
  findResumedTranscript: vi.fn(async () => '/t/resumed.jsonl'),
}))

const dirs: string[] = []

/** Every engine lookup back to its default answer, calls forgotten, before each test. */
function resetLookups() {
  vi.mocked(transcriptOf).mockReset().mockImplementation(async engine => `/t/${engine}.jsonl`)
  vi.mocked(processSessionOf).mockReset().mockResolvedValue(null)
  vi.mocked(loadEngine).mockClear()
  vi.mocked(isRecentlyDeleted).mockReset().mockReturnValue(false)
  vi.mocked(continuationOf).mockReset().mockResolvedValue(null)
  vi.mocked(findLiveSession).mockReset().mockResolvedValue(null)
  vi.mocked(findResumedTranscript).mockReset().mockResolvedValue('/t/resumed.jsonl')
}
beforeEach(resetLookups)

const agent = (over: Partial<RegisteredSession> = {}): RegisteredSession =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', registeredAt: 0, ...over }) as RegisteredSession
const meta = (over: Partial<RegisteredMeta> = {}): RegisteredMeta => ({ isNew: false, evicted: null, rebound: null, ...over })

function setup(over: Partial<BindDeps> = {}) {
  const byAgent = new Map<string, RegisteredSession>()
  const bySession = new Map<string, RegisteredSession>()
  let revision = 0
  const deps: BindDeps = {
    registry: {
      inheritName: vi.fn(),
      confirmSessionUnbound: vi.fn(async (id: string) => { const row = byAgent.get(id)!; row.sessionId = ''; return { state: 'confirmed', entry: structuredClone(row) } }),
      byAgent: vi.fn((agentId: string) => {
        const settled = vi.mocked(deps.registry.register).mock.settledResults.at(-1)
        return byAgent.get(agentId) ?? (settled?.type === 'fulfilled' ? settled.value?.entry : undefined)
      }),
      byProcess: vi.fn(() => undefined),
      register: vi.fn(() => null),
      setIdentityHold: vi.fn((id: string, reason?: string) => {
        const row = byAgent.get(id) ?? vi.mocked(deps.registry.byProcess).mock.results.at(-1)?.value
        if (!row || row.identityHold === reason) return false
        // As the registry does (registry.ts `setIdentityHold`): every change to a hold raises the row's revision.
        row.evidenceRevision = ++revision
        if (reason) row.identityHold = reason
        else delete row.identityHold
        return true
      }),
      revalidateBinding: vi.fn((id: string) => {
        const row = byAgent.get(id) ?? vi.mocked(deps.registry.byProcess).mock.results.at(-1)?.value
        if (row) delete row.identityHold
        return row ?? null
      }),
      has: vi.fn(() => false),
      bySession: vi.fn((sessionId: string) => bySession.get(sessionId)),
      setOpenclawStateDir: vi.fn(() => true),
      afterTransaction: vi.fn(async (run: () => unknown) => run()),
      takeFirstTask: vi.fn(),
      setLaunch: vi.fn((id: string, launch: RegisteredSession['launch']) => {
        const row = byAgent.get(id) ?? vi.mocked(deps.registry.byProcess).mock.results.at(-1)?.value
        if (row) row.launch = launch
        return row ?? null
      }),
    } as unknown as BindDeps['registry'],
    mirror: { inheritSummary: vi.fn() },
    forgetSession: vi.fn(),
    clients: { send: vi.fn() },
    attachSession: vi.fn(async () => true),
    announceSession: vi.fn(),
    stoppedAgents: { save: vi.fn(), finishResume: vi.fn(), get: vi.fn(() => null) },
    syncRecapPool: vi.fn(),
    input: { forget: vi.fn(), awaitingConfirmation: vi.fn(() => false), firstTaskWaiting: vi.fn(() => false), typeCommand: vi.fn(async () => true), expectFirstTask: vi.fn() },
    submitFirstTask: vi.fn(),
    deviceInput: { forget: vi.fn() },
    homes: { copilot: '/copilot', grok: '/grok', agy: '/agy' },
    capturePane: vi.fn(async () => null),
    openclawPaneRead: vi.fn(),
    openclawPaneDue: vi.fn(() => true),
    openclawStateDir: vi.fn(async () => null),
    followsLive: vi.fn(() => false),
    ...over,
  }
  return { deps, byAgent, bySession, binding: createBinding(deps) }
}

function registered(run: ReturnType<typeof setup>, entry: RegisteredSession, meta: RegisteredMeta): Promise<void> {
  run.byAgent.set(entry.agentId, entry)
  return run.binding.handleRegistered(entry, meta)
}

describe('binding a registered session to its agent', () => {
  it.each(['rebound', 'evicted', 'orphaned'] as const)('stops attachment when %s cleanup replaces the selected binding', async phase => {
    const run = setup(), entry = agent()
    vi.mocked(run.deps.forgetSession).mockImplementationOnce(async () => { run.byAgent.set('a1', agent({ sessionId: 'replacement' })) })
    await registered(run, entry, meta(phase === 'rebound' ? { rebound: 'old' } : phase === 'evicted' ? { evicted: 'old' }
      : { orphaned: { agentId: 'old' } as RegisteredSession }))
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(run.deps.clients.send).not.toHaveBeenCalled()
  })

  it.each(['same', 'changing', 'replaced', 'not-published', 'empty', 'receipt changed'] as const)(
    'only announces a failed attach unbind with confirmed current authority: %s', async change => {
      let changing = false
      const run = setup(), entry = agent()
      run.binding.whileChanging(() => changing)
      vi.mocked(run.deps.attachSession).mockResolvedValue(false)
      const publish = vi.mocked(run.deps.registry.confirmSessionUnbound).getMockImplementation()!
      vi.mocked(run.deps.registry.confirmSessionUnbound).mockImplementation(async (id, session, authority) => {
        vi.mocked(run.deps.announceSession).mockClear()
        expect(authority?.current?.()).toBe(true)
        if (change === 'changing') changing = true
        if (change === 'replaced') run.byAgent.set('a1', agent({ sessionId: 'replacement' }))
        if (change === 'changing' || change === 'replaced') {
          expect(authority?.current?.()).toBe(false)
          return { state: 'not-published' }
        }
        if (change === 'not-published') return { state: 'not-published' }
        if (change === 'empty') return { state: 'confirmed', entry: null }
        const result = await publish(id, session, authority)
        if (change === 'receipt changed') run.byAgent.set('a1', agent({ sessionId: 'replacement' }))
        return result
      })
      await registered(run, entry, meta())
      expect(run.deps.announceSession).toHaveBeenCalledTimes(change === 'same' ? 1 : 0)
    })
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('attaches a new session, archives it as the agent\'s, names it and tells the app', async () => {
    const run = setup()
    const entry = agent({ boundAt: Date.parse('2026-10-04T10:00:00Z') })
    run.byAgent.set('a1', entry)
    await registered(run, entry, meta({ isNew: true }))
    expect(run.deps.attachSession).toHaveBeenCalledWith(entry, true, false, false)
    expect(run.deps.stoppedAgents.save).toHaveBeenCalledWith(entry)
    expect(run.deps.syncRecapPool).toHaveBeenCalled()
    expect(run.deps.registry.inheritName).toHaveBeenCalledWith('a1', 's1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.clients.send).toHaveBeenCalledWith({
      type: 'session_synced',
      payload: { sessionId: 's1', agentId: 'a1', title: expect.any(String), createdAt: '2026-10-04T10:00:00.000Z' },
    })
  })

  // A conversation new to this harness takes it from any stopped harness it came from (conversationOwners.ts).
  it('settles who owns a newly bound conversation, and only a newly bound one; a failure never stops the bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const owners = { settle: vi.fn(() => []) }
    const run = setup({ owners })
    const entry = agent({ boundAt: Date.parse('2026-10-04T10:00:00Z') })
    await registered(run, entry, meta({ isNew: true }))
    expect(owners.settle).toHaveBeenCalledWith(['claude\u0000\u0000\u0000s1'])
    await registered(run, entry, meta({ isNew: false }))
    expect(owners.settle).toHaveBeenCalledTimes(1)
    owners.settle.mockImplementationOnce(() => { throw new Error('stopped store unreadable') })
    await registered(run, entry, meta({ isNew: true }))
    owners.settle.mockImplementationOnce(() => { throw 'plain' })
    await registered(run, entry, meta({ isNew: true }))
    expect(warn).toHaveBeenCalledWith('[agent] a1 could not settle who owns s1: Error')
    expect(warn).toHaveBeenCalledWith('[agent] a1 could not settle who owns s1: string')
    // Each new binding is still announced after a failed settle (the one that was not new announces nothing).
    expect(run.deps.announceSession).toHaveBeenCalledTimes(3)
  })

  it('still tells the app of a binding when the record it resumes from cannot be saved, as on a full disk', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = setup()
    const entry = agent({ boundAt: Date.parse('2026-10-04T10:00:00Z'), resumeOnly: true })
    run.byAgent.set('a1', entry)
    vi.mocked(run.deps.stoppedAgents.save).mockImplementationOnce(() => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) })
    await registered(run, entry, meta({ isNew: true }))
    expect(error).toHaveBeenCalledWith('[agent] a1 could not save the record it resumes from: ENOSPC')
    expect(run.deps.stoppedAgents.finishResume).toHaveBeenCalledWith('a1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_synced' }))
    vi.mocked(run.deps.stoppedAgents.save).mockImplementationOnce(() => { throw 'disk gone' })
    await registered(run, entry, meta({ isNew: true }))
    expect(error).toHaveBeenLastCalledWith('[agent] a1 could not save the record it resumes from: string')
  })

  it('completes a resumed binding while its optional attachment stays pending', async () => {
    const run = setup({ attachSession: vi.fn(() => new Promise<boolean>(() => {})) })
    const entry = agent({ resumeOnly: true })
    void registered(run, entry, meta({ isNew: true }))
    expect(run.deps.stoppedAgents.save).toHaveBeenCalledWith(entry)
    expect(run.deps.stoppedAgents.finishResume).toHaveBeenCalledWith('a1')
    expect(run.deps.registry.inheritName).toHaveBeenCalledWith('a1', 's1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_synced' }))
    expect(run.deps.attachSession).toHaveBeenCalledOnce()
  })

  it.each([true, false])('ignores a superseded attachment completing with %s', async attached => {
    let finish!: (attached: boolean) => void
    const run = setup({ attachSession: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })) })
    const first = agent()
    const pending = registered(run, first, meta({ isNew: true }))
    vi.mocked(run.deps.attachSession).mockResolvedValueOnce(true)
    // Mutate the row as the real registry does while the first attachment is still reading.
    first.sessionId = 's2'
    await registered(run, first, meta({ isNew: true }))
    vi.mocked(run.deps.clients.send).mockClear()
    vi.mocked(run.deps.announceSession).mockClear()
    vi.mocked(run.deps.stoppedAgents.save).mockClear()
    vi.mocked(run.deps.registry.inheritName).mockClear()
    finish(attached); await pending
    expect(run.deps.clients.send).not.toHaveBeenCalled()
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
    expect(run.deps.registry.inheritName).not.toHaveBeenCalled()
    expect(run.deps.registry.confirmSessionUnbound).not.toHaveBeenCalled()
  })

  it('does not start an optional reader if the binding changes during the transcript birth read', async () => {
    const run = setup()
    const home = mkdtempSync(join(tmpdir(), 'binding-stat-')); dirs.push(home)
    const path = join(home, 'transcript.jsonl'); writeFileSync(path, '{}\n')
    const entry = agent({ transcriptPath: path })
    const pending = registered(run, entry, meta({ isNew: true }))
    entry.sessionId = 'replacement'
    await pending
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    expect(run.deps.clients.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: 'session_synced', payload: expect.objectContaining({ sessionId: 's1' }),
    }))
  })

  it('stops after the attach for a session it already had, and finishes a resume it was waiting for', async () => {
    const run = setup()
    const entry = agent({ resumeOnly: true } as Partial<RegisteredSession>)
    run.byAgent.set('a1', entry)
    await registered(run, entry, meta())
    expect(run.deps.stoppedAgents.finishResume).toHaveBeenCalledWith('a1')
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    // Bound elsewhere by the time the attach finished: not this agent's session to archive.
    run.byAgent.set('a1', agent({ sessionId: 'other' }))
    vi.mocked(run.deps.stoppedAgents.save).mockClear()
    await run.binding.handleRegistered(agent(), meta())
    expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
  })

  it('unbinds a session whose pane is gone and re-announces its agent', async () => {
    const run = setup({ attachSession: vi.fn(async () => false) })
    const entry = agent()
    await registered(run, entry, meta({ isNew: true }))
    expect(run.deps.registry.confirmSessionUnbound).toHaveBeenCalledWith('a1', 's1', expect.any(Object))
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.syncRecapPool).toHaveBeenCalled()
  })

  it('keeps an attach-failure unbind announcement behind its durable publication', async () => {
    const run = setup({ attachSession: vi.fn(async () => false) }), entry = agent()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(done => { release = done }), publishing = new Promise<void>(done => { entered = done })
    Object.assign(run.deps.registry, { confirmSessionUnbound: vi.fn(async () => {
      entered(); await held
      entry.sessionId = ''
      return { state: 'confirmed', entry: structuredClone(entry) }
    }) })
    const pending = registered(run, entry, meta())
    try {
      expect(await Promise.race([publishing.then(() => 'publishing'), pending.then(() => 'finished')])).toBe('publishing')
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    } finally { release(); await pending }
    expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: '' }))
  })

  it('keeps the verified conversation when a native exit beats its pending startup attach', async () => {
    let finish!: (attached: boolean) => void
    const run = setup({ attachSession: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })) })
    const entry = agent({ processIdentity: { pid: 42, startMarker: '2026-10-06T10:00:00Z', executable: 'claude' } })
    const pending = registered(run, entry, meta({ isNew: true, hookEvent: 'SessionStart' }))
    await vi.waitFor(() => expect(run.deps.attachSession).toHaveBeenCalled())
    finish(false)
    await pending
    expect(run.deps.registry.confirmSessionUnbound).not.toHaveBeenCalled()
    expect(entry.sessionId).toBe('s1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.stoppedAgents.save).toHaveBeenCalledWith(entry)
    expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_synced' }))
  })

  it('keeps the binding of an agent a stop or a restart owns: its pane reads as gone only because of it', async () => {
    // The old engine's late SessionStart, registered as a stop or a restart ended that engine. Unbound,
    // the stop gave up with its engine already signalled, and a queued restart found nothing to resume.
    const run = setup({ attachSession: vi.fn(async () => false) })
    const changing = vi.fn((agentId: string) => agentId === 'a1')
    run.binding.whileChanging(changing)
    const entry = agent()
    await registered(run, entry, meta())
    expect(changing).toHaveBeenCalledWith('a1')
    expect(run.deps.registry.confirmSessionUnbound).not.toHaveBeenCalled()
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    // An agent nothing owns is unbound as before.
    await registered(run, agent({ agentId: 'a2', sessionId: 's2' }), meta())
    expect(run.deps.registry.confirmSessionUnbound).toHaveBeenCalledWith('a2', 's2', expect.any(Object))
  })

  it('hands a rebound agent its name and recap, and lets the stale session go', async () => {
    const run = setup()
    await registered(run, agent({ sessionId: 's2' }), meta({ rebound: 's1' }))
    expect(run.deps.registry.inheritName).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.mirror.inheritSummary).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.forgetSession).toHaveBeenCalledWith('s1', { force: true, keepAgent: true, agentId: 'a1' })
    expect(run.deps.clients.send).toHaveBeenCalledWith({ type: 'session_reset', payload: { staleSessionId: 's1' } })
  })

  it('forgets an evicted session and an agent the bind emptied out', async () => {
    const run = setup()
    await registered(run, agent(), meta({ evicted: 's0', orphaned: { agentId: 'a0', sessionId: 's0' } }))
    expect(vi.mocked(run.deps.forgetSession).mock.calls).toEqual([
      ['s0', { force: true }],
      ['a0', { force: true, agentId: 'a0' }],
    ])
  })

  it('gives a fork the recap of its source once its own session reports in', async () => {
    const run = setup()
    run.binding.pendingForkInherit.set('a1', 'source-s')
    await registered(run, agent({ sessionId: '' }), meta())
    expect(run.deps.mirror.inheritSummary).not.toHaveBeenCalled()
    await registered(run, agent(), meta())
    expect(run.deps.mirror.inheritSummary).toHaveBeenCalledWith('source-s', 's1')
    expect(run.binding.pendingForkInherit.has('a1')).toBe(false)
  })

  it('resets on a SessionStart, except for engines that announce one turn more than once', async () => {
    const run = setup()
    for (const engine of ['claude', 'cursor', 'agy', 'copilot']) {
      await registered(run, agent({ engine } as Partial<RegisteredSession>), meta({ hookEvent: 'SessionStart' }))
    }
    expect(vi.mocked(run.deps.attachSession).mock.calls.map((call) => [call[0].engine, call[1], call[2]])).toEqual([
      ['claude', true, false], ['cursor', false, true], ['agy', false, false], ['copilot', false, false],
    ])
  })

  it('replays a transcript born after its agent from the start, judged by the file\'s birth', async () => {
    const run = setup()
    const dir = mkdtempSync(join(tmpdir(), 'core-bind-'))
    dirs.push(dir)
    const born = join(dir, 'session.jsonl')
    writeFileSync(born, '{}\n')
    await registered(run, agent({ transcriptPath: born, registeredAt: Date.now() - 60_000 }), meta())
    await registered(run, agent({ transcriptPath: join(dir, 'missing.jsonl'), registeredAt: Date.now() - 60_000 }), meta())
    expect(vi.mocked(run.deps.attachSession).mock.calls.map((call) => call[3])).toEqual([true, false])
  })

  it('never replays the conversation a resume put back, and judges a new session in that agent like any other', async () => {
    const run = setup()
    const dir = mkdtempSync(join(tmpdir(), 'core-bind-'))
    dirs.push(dir)
    const born = join(dir, 'session.jsonl')
    writeFileSync(born, '{}\n')
    // A resume keeps the row's original registeredAt, so the transcript reads as born after its agent.
    const resumed = agent({ transcriptPath: born, registeredAt: Date.now() - 60_000, resumeOnly: true } as Partial<RegisteredSession>)
    vi.mocked(run.deps.stoppedAgents.get).mockReturnValue(agent({ sessionId: 's1' }))
    await registered(run, resumed, meta())
    expect(run.deps.stoppedAgents.get).toHaveBeenCalledWith('a1')
    // `/clear` after the resume: a session the stopped record does not hold.
    await registered(run, { ...resumed, sessionId: 's2' }, meta())
    // A resumed row with no stopped record left to compare against.
    vi.mocked(run.deps.stoppedAgents.get).mockReturnValue(null)
    await registered(run, resumed, meta())
    expect(vi.mocked(run.deps.attachSession).mock.calls.map((call) => call[3])).toEqual([false, true, true])
  })
})

describe('binding a running process to its session', () => {
  const observed = (over: Partial<DiscoveredTerminalAgent> = {}): DiscoveredTerminalAgent => ({
    engine: 'claude',
    cwd: '/work',
    runtimes: [],
    primaryRuntimeKey: 'tmux:%0',
    processIdentity: { pid: 42, startMarker: '2026-10-04T10:00:00Z' },
    ...over,
  }) as DiscoveredTerminalAgent

  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('ignores a process no agent runs, and a resume still launching', async () => {
    const run = setup()
    await run.binding.bindObservedAgent(observed())
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ resumeOnly: true, launch: { state: 'starting' } } as Partial<RegisteredSession>))
    await run.binding.bindObservedAgent(observed())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it('does not wait for optional transcript attachment before completing binding', async () => {
    const run = setup({ attachSession: vi.fn(() => new Promise<boolean>(() => {})) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    let done = false
    void run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' })).then(() => { done = true })
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 1000 })
    expect(run.deps.registry.register).toHaveBeenCalledOnce()
    expect(run.deps.attachSession).toHaveBeenCalledOnce()
  })

  it.each([new Error('saved header is incomplete'), 'saved header is incomplete'])(
    'keeps a saved binding visibly held until its own evidence recovers: %s', async error => {
      const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'previous hold' })
      run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      vi.mocked(run.deps.registry.revalidateBinding).mockImplementationOnce(() => { throw error })
        .mockImplementationOnce(() => { throw error })
      await run.binding.bindObservedAgent(observed())
      await run.binding.bindObservedAgent(observed())
      expect(row).toMatchObject({ sessionId: 's1', transcriptPath: '/t/s1.jsonl', identityHold: 'saved header is incomplete' })
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      expect(continuationOf).not.toHaveBeenCalled()
      expect(run.deps.registry.confirmSessionUnbound).not.toHaveBeenCalled()
      expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
      await run.binding.bindObservedAgent(observed())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(continuationOf).toHaveBeenCalledOnce()
    })

  it('does not follow a saved binding removed while its retry commits', async () => {
    const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'unavailable' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(run.deps.registry.revalidateBinding).mockResolvedValue(null)
    await run.binding.bindObservedAgent(observed())
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(continuationOf).not.toHaveBeenCalled()
  })

  it.each(['cleanup', 'rejected preparation'] as const)('does not announce an old revalidation after %s changes its owner', async phase => {
    const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'unavailable' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    if (phase === 'cleanup') {
      vi.mocked(run.deps.registry.revalidateBinding).mockImplementationOnce(async () => {
        row.sessionId = ''; delete row.identityHold; return structuredClone(row)
      })
      vi.mocked(run.deps.forgetSession).mockImplementationOnce(async () => { run.byAgent.set('a1', agent({ sessionId: 'replacement' })) })
    } else vi.mocked(run.deps.registry.revalidateBinding).mockImplementationOnce(async () => {
      run.byAgent.set('a1', agent({ sessionId: 'replacement' }))
      throw new Error('preparation revoked')
    })
    await run.binding.bindObservedAgent(observed())
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(run.deps.registry.setIdentityHold).not.toHaveBeenCalled()
  })

  it.each(['repaired', 'same', 'absent'] as const)('updates transcript attachment after a held binding is conclusively %s', async outcome => {
    const run = setup(), row = agent({ transcriptPath: '/t/child.jsonl', identityHold: 'unavailable' })
    run.byAgent.set(row.agentId, row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(run.deps.registry.revalidateBinding).mockImplementation(async () => {
      Object.assign(row, { sessionId: outcome === 'absent' ? '' : 's1', transcriptPath: outcome === 'absent' ? null : outcome === 'same' ? row.transcriptPath : '/t/parent.jsonl' })
      delete row.identityHold
      return row
    })
    await run.binding.bindObservedAgent(observed())
    if (outcome === 'absent') {
      expect(run.deps.forgetSession).toHaveBeenCalledWith('s1', { force: true, keepAgent: true, agentId: 'a1' })
      expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
    } else {
      await vi.waitFor(() => expect(run.deps.attachSession).toHaveBeenCalledWith(row, true, false, false))
      expect(run.deps.forgetSession).not.toHaveBeenCalled()
    }
    expect(run.deps.announceSession).toHaveBeenCalledWith(row)
  })

  it.each(Object.values(OTHER_ENGINE_STATES))('leaves the other engines\' reader hold to its reader, pass after pass, and goes on with the pass: %s', async hold => {
    const run = setup({ followsLive: vi.fn((sessionId: string) => sessionId === 's1') })
    const row = agent({ engine: 'copilot', transcriptPath: '/t/s1.jsonl', identityHold: hold })
    run.byAgent.set(row.agentId, row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
    await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
    expect(run.deps.registry.revalidateBinding).not.toHaveBeenCalled()
    expect(run.deps.registry.setIdentityHold).not.toHaveBeenCalled()
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    expect(run.deps.forgetSession).not.toHaveBeenCalled()
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(row).toMatchObject({ sessionId: 's1', transcriptPath: '/t/s1.jsonl', identityHold: hold })
    expect(processSessionOf).toHaveBeenCalledTimes(2)
  })

  // #4362: a reader that gave up on a session takes it up on no later connection, or on none that may come.
  it.each(Object.values(OTHER_ENGINE_STATES))('revalidates a reader hold once its reader holds no stream for the session: %s', async hold => {
    const run = setup({ followsLive: vi.fn(() => false) })
    const row = agent({ engine: 'copilot', transcriptPath: '/t/s1.jsonl', identityHold: hold })
    run.byAgent.set(row.agentId, row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
    expect(run.deps.registry.revalidateBinding).toHaveBeenCalledWith('a1', { current: expect.any(Function) })
    expect(run.deps.followsLive).toHaveBeenCalledWith('s1')
    expect(row).not.toHaveProperty('identityHold')
    await vi.waitFor(() => expect(run.deps.attachSession).toHaveBeenCalledWith(row, true, false, false))
    expect(run.deps.announceSession).toHaveBeenCalledWith(row)
  })

  it.each(['changing', 'deleted'] as const)('does not retry a binding whose process is %s', async state => {
    const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'unavailable' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    if (state === 'changing') run.binding.whileChanging(() => true)
    else vi.mocked(isRecentlyDeleted).mockReturnValue(true)
    await run.binding.bindObservedAgent(observed())
    expect(run.deps.registry.revalidateBinding).not.toHaveBeenCalled()
    expect(continuationOf).not.toHaveBeenCalled()
  })

  it('contains a registration failure, keeps the reason, and retries an unbound process', async () => {
    const run = setup(), row = agent({ sessionId: '', identityHold: 'waiting for first transcript' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(run.deps.registry.register).mockImplementationOnce(() => { throw new Error('binding evidence changed') })
    await run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    expect(row).toMatchObject({ sessionId: '', identityHold: 'binding evidence changed' })
    expect(run.deps.registry.revalidateBinding).not.toHaveBeenCalled()
    expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    expect(run.deps.attachSession).toHaveBeenCalledOnce()
  })

  it.each([[new Error('identity read limit'), 'Error'], ['identity read limit', 'string']])('holds only the unreadable native identity and finishes the discovery/readiness pass: %s', async (error, kind) => {
    const run = setup()
    const rows = [agent({ engine: 'muse', agentId: 'held', sessionId: '', runtimes: [], active: true,
      processIdentity: { pid: 42, executable: 'muse', startMarker: '2026-10-09T00:00:00Z' } }),
    agent({ engine: 'codex', agentId: 'next', sessionId: '', runtimes: [], active: true,
      processIdentity: { pid: 43, executable: 'codex', startMarker: '2026-10-09T00:00:00Z' } })]
    for (const row of rows) run.byAgent.set(row.agentId, row)
    vi.mocked(run.deps.registry.byProcess).mockImplementation(engine => rows.find(row => row.engine === engine))
    vi.mocked(findLiveSession).mockImplementation(async engine => {
      if (engine === 'muse') throw error
      return { sessionId: 'found', transcriptPath: '/t/found.jsonl' }
    })
    vi.mocked(run.deps.registry.register).mockImplementation(request => {
      Object.assign(rows[1]!, { sessionId: request.sessionId, transcriptPath: request.transcriptPath })
      return { entry: rows[1]!, ...meta({ isNew: true }) } as never
    })
    const onProbeStatus = vi.fn(), onRemoved = vi.fn(), onDormant = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => rows, backends: [], backendOrder: ['tmux'], onProbeStatus, onRemoved, onDormant,
      onDiscovered: run.binding.bindObservedAgent, onObserved: run.binding.bindObservedAgent,
      probe: async () => ({ processTableAvailable: true, targets: [], ambiguousPlacements: new Set(),
        agents: rows.map(row => observed({ engine: row.engine, processIdentity: row.processIdentity! })) }),
    })
    try {
      await expect(reconciler.start(60_000)).resolves.toBeUndefined()
      expect(rows[0]!.sessionId).toBe('')
      expect(rows[1]!.sessionId).toBe('found')
      expect(run.deps.registry.register).toHaveBeenCalledOnce()
      expect(run.deps.stoppedAgents.save).toHaveBeenCalledExactlyOnceWith(rows[1])
      expect(onRemoved).not.toHaveBeenCalled(); expect(onDormant).not.toHaveBeenCalled()
      expect(onProbeStatus).toHaveBeenCalledWith({ ready: true, error: null })
      expect(console.log).toHaveBeenCalledWith(`[discovery] held binding held · ${kind}`)
    } finally { reconciler.stop() }
  })

  it.each(['copilot-process', 'copilot-transcript', 'continuation', 'cursor-resume', 'grok-resume',
    'agy-resume', 'copilot-resume', 'claude-resume', 'codex-resume'] as const)(
    'isolates %s failure from readiness and retries the same live binding', async kind => {
      const run = setup()
      const engine = kind === 'continuation' ? 'claude' : kind.split('-')[0] as DiscoveredTerminalAgent['engine']
      const alreadyBound = kind === 'continuation' || kind === 'copilot-process' || kind === 'copilot-transcript'
      const rows = [agent({ engine, agentId: 'held', sessionId: alreadyBound ? 'previous' : '',
        transcriptPath: alreadyBound ? '/t/previous.jsonl' : undefined, runtimes: [], active: true,
        processIdentity: { pid: 42, executable: engine, startMarker: '2026-10-09T00:00:00Z' } }),
      agent({ engine: 'codex', agentId: 'next', sessionId: '', runtimes: [], active: true,
        processIdentity: { pid: 43, executable: 'codex', startMarker: '2026-10-09T00:00:00Z' } })]
      for (const row of rows) run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockImplementation((_, identity) => rows.find(row => row.processIdentity?.pid === identity.pid))
      vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'sibling', transcriptPath: '/t/sibling.jsonl' })
      vi.mocked(processSessionOf).mockResolvedValue('resumed')
      const failure = new Error('native evidence unavailable')
      if (kind === 'copilot-process') vi.mocked(processSessionOf).mockRejectedValueOnce(failure)
      else if (kind === 'continuation') vi.mocked(continuationOf).mockRejectedValueOnce(failure)
      else if (kind === 'claude-resume' || kind === 'codex-resume') vi.mocked(findResumedTranscript).mockRejectedValueOnce(failure)
      else vi.mocked(transcriptOf).mockRejectedValueOnce(failure)
      vi.mocked(run.deps.registry.register).mockImplementation(request => {
        const entry = rows.find(row => row.processIdentity?.pid === request.processIdentity?.pid)!
        Object.assign(entry, { sessionId: request.sessionId, transcriptPath: request.transcriptPath })
        return { entry, ...meta({ isNew: true }) } as never
      })
      const held = observed({ engine, processIdentity: rows[0]!.processIdentity!, resumeSessionId: alreadyBound ? null : 'resumed' })
      const onProbeStatus = vi.fn(), onRemoved = vi.fn(), onDormant = vi.fn()
      const reconciler = new TerminalAgentReconciler({
        current: () => rows, backends: [], backendOrder: ['tmux'], onProbeStatus, onRemoved, onDormant,
        onDiscovered: run.binding.bindObservedAgent, onObserved: run.binding.bindObservedAgent,
        probe: async () => ({ processTableAvailable: true, targets: [], ambiguousPlacements: new Set(),
          agents: [held, observed({ engine: 'codex', processIdentity: rows[1]!.processIdentity! })] }),
      })
      try {
        await expect(reconciler.start(60_000)).resolves.toBeUndefined()
        expect(rows[0]!.sessionId).toBe(alreadyBound ? 'previous' : '')
        expect(rows[1]!.sessionId).toBe('sibling')
        expect(onProbeStatus).toHaveBeenCalledWith({ ready: true, error: null })
        expect(onRemoved).not.toHaveBeenCalled(); expect(onDormant).not.toHaveBeenCalled()
        expect(run.deps.stoppedAgents.save).toHaveBeenCalledExactlyOnceWith(rows[1])
        expect(console.log).toHaveBeenCalledWith('[discovery] held binding held · Error')
        vi.mocked(continuationOf).mockResolvedValue({ sessionId: 'resumed', transcriptPath: '/t/resumed.jsonl' })
        await run.binding.bindObservedAgent(held)
        expect(rows[0]!.sessionId).toBe('resumed')
      } finally { reconciler.stop() }
    })

  it('discards a rejected native read after the session has changed ownership', async () => {
    const run = setup(), row = agent({ sessionId: '' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    let reject!: (error: Error) => void
    vi.mocked(findResumedTranscript).mockReturnValueOnce(new Promise((_, no) => { reject = no }))
    const pending = run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    row.sessionId = 'replacement'; reject(new Error('obsolete lookup failed')); await pending
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([[new Error('reader unavailable'), 'Error'], ['reader unavailable', 'string']])('contains an optional attachment failure after binding', async (error, kind) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = setup({ attachSession: vi.fn(async () => { throw error }) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`[agent] a1 transcript attachment is unavailable: ${kind}`))
    expect(run.deps.registry.register).toHaveBeenCalledOnce()
    expect(run.deps.registry.confirmSessionUnbound).not.toHaveBeenCalled()
  })

  it.each(['binding', 'process', 'stop', 'changing'] as const)('discards a delayed lookup after %s changed its authority', async change => {
    const run = setup()
    const entry = agent({ sessionId: '', processIdentity: { pid: 42, startMarker: '2026-10-04T10:00:00Z', executable: 'cursor' } })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(entry)
    let answer!: (path: string | null) => void
    vi.mocked(transcriptOf).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const pending = run.binding.bindObservedAgent(observed({ engine: 'cursor', resumeSessionId: 'resumed' }))
    if (change === 'binding') entry.sessionId = 'newer'
    if (change === 'process') vi.mocked(run.deps.registry.byProcess).mockReturnValue(undefined)
    if (change === 'stop') vi.mocked(isRecentlyDeleted).mockImplementation(id => id === entry.agentId)
    if (change === 'changing') run.binding.whileChanging(() => true)
    answer('/fixture/transcript.jsonl'); await pending
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it.each(['newer owner', 'target stopped'] as const)('rechecks the target after resume evidence waits: %s', async change => {
    const run = setup()
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
    let answer!: (path: string | null) => void
    vi.mocked(transcriptOf).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const pending = run.binding.bindObservedAgent(observed({ engine: 'cursor', resumeSessionId: 'r' }))
    if (change === 'newer owner') run.bySession.set('r', agent({ agentId: 'newer', processIdentity: {
      pid: 43, startMarker: '2026-10-04T11:00:00Z', executable: 'cursor',
    } }))
    else vi.mocked(isRecentlyDeleted).mockImplementation(id => id === 'r')
    answer('/fixture/transcript.jsonl'); await pending
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it.each(['copilot', 'claude'] as const)('rejects a delayed %s continuation after the receiving binding changes', async engine => {
    const run = setup()
    const entry = agent({ engine, transcriptPath: '/t/s1.jsonl' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(entry)
    let answer!: () => void
    if (engine === 'copilot') vi.mocked(processSessionOf).mockResolvedValue('s2').mockReturnValueOnce(new Promise(resolve => { answer = () => resolve('s2') }))
    else vi.mocked(continuationOf).mockReturnValueOnce(new Promise(resolve => { answer = () => resolve({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' }) }))
    const pending = run.binding.bindObservedAgent(observed({ engine }))
    entry.sessionId = 'newer'
    answer(); await pending
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it('does not take a Copilot resume target that was stopped during its transcript lookup', async () => {
    const run = setup()
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ engine: 'copilot' }))
    vi.mocked(processSessionOf).mockResolvedValue('s2')
    let answer!: (path: string | null) => void
    vi.mocked(transcriptOf).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
    const pending = run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
    vi.mocked(isRecentlyDeleted).mockImplementation(id => id === 's2')
    answer('/fixture/transcript.jsonl'); await pending
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it.each(['s3', null])('holds a Copilot conversation changed to %s during transcript lookup', async next => {
    const run = setup(), row = agent({ engine: 'copilot' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(processSessionOf).mockResolvedValueOnce('s2').mockResolvedValueOnce(next)
    await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    expect(row.sessionId).toBe('s1')
    // The hold keeps the words; the log names the kind alone.
    expect(run.deps.registry.setIdentityHold).toHaveBeenCalledWith('a1', expect.stringContaining('process conversation changed during transcript lookup'))
    expect(console.log).toHaveBeenCalledWith('[discovery] a1 binding held · IdentityReadUnavailable IDENTITY_UNAVAILABLE')
  })

  describe('an agent that already has a session', () => {
    it('follows Copilot to the session it /resumed into, and only to a new one', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ engine: 'copilot' } as Partial<RegisteredSession>))
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      vi.mocked(processSessionOf).mockResolvedValueOnce('s1')
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      vi.mocked(processSessionOf).mockResolvedValueOnce('deleted')
      vi.mocked(isRecentlyDeleted).mockImplementation(id => id === 'deleted')
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      vi.mocked(processSessionOf).mockResolvedValue('s2')
      const rotated = agent({ engine: 'copilot', sessionId: 's2' } as Partial<RegisteredSession>)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: rotated, ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(processSessionOf).toHaveBeenLastCalledWith('copilot', '/copilot', 42)
      expect(transcriptOf).toHaveBeenLastCalledWith('copilot', '/copilot', 's2')
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 's2', transcriptPath: '/t/copilot.jsonl', source: 'copilot-resume' })
      expect(run.deps.attachSession).toHaveBeenCalledWith(rotated, true, false, false)
      // Not new to the registry, or no transcript yet: registered as it is, attached by its hook later.
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: rotated, ...meta() } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(vi.mocked(run.deps.registry.register).mock.calls[1][0]).toMatchObject({ transcriptPath: undefined })
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    })

    it('follows Claude Code to the file its transcript rolled over to, when that is new', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ transcriptPath: '/t/s1.jsonl' }))
      await run.binding.bindObservedAgent(observed())
      for (const continuation of [{ sessionId: 's1' }, { sessionId: 'known' }, { sessionId: 'deleted' }]) {
        vi.mocked(continuationOf).mockResolvedValueOnce({ ...continuation, transcriptPath: '/t/x.jsonl' } as never)
      }
      vi.mocked(run.deps.registry.has).mockImplementation((sessionId: string) => sessionId === 'known')
      vi.mocked(isRecentlyDeleted).mockImplementation((sessionId?: string) => sessionId === 'deleted')
      for (let i = 0; i < 3; i++) await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      vi.mocked(continuationOf).mockResolvedValue({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' } as never)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: agent({ sessionId: 's2' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed())
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ engine: 'claude', sessionId: 's2', source: 'claude-continuation', hookEvent: 'ClaudeContinuation' })
      expect(continuationOf).toHaveBeenCalledWith('claude', '/t/s1.jsonl')
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce(null)
      await run.binding.bindObservedAgent(observed())
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    })

    it('leaves any other engine, or Claude Code without a transcript, as it is', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValueOnce(agent({ engine: 'pi' } as Partial<RegisteredSession>)).mockReturnValueOnce(agent())
      await run.binding.bindObservedAgent(observed({ engine: 'pi' }))
      await run.binding.bindObservedAgent(observed())
      expect(continuationOf).not.toHaveBeenCalled()
    })
  })

  describe('a resume named on the command line', () => {
    it('finds each engine\'s transcript where that engine keeps it', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      const expected: Record<string, string | undefined> = {
        cursor: '/t/cursor.jsonl', grok: '/t/grok.jsonl', agy: '/t/agy.jsonl', copilot: '/t/copilot.jsonl',
        claude: '/t/resumed.jsonl', codex: '/t/resumed.jsonl', pi: undefined,
      }
      for (const engine of Object.keys(expected)) {
        await run.binding.bindObservedAgent(observed({ engine, resumeSessionId: `${engine}-resumed` } as Partial<DiscoveredTerminalAgent>))
      }
      expect(vi.mocked(run.deps.registry.register).mock.calls.map(([input]) => [input.engine, input.transcriptPath, input.source, input.hookEvent])).toEqual(
        Object.entries(expected).map(([engine, path]) => [engine, path, 'terminal-resume', 'TerminalResumeDiscovery']),
      )
      expect(transcriptOf).toHaveBeenCalledWith('cursor', '/cursor', 'cursor-resumed', '/work')
      expect(transcriptOf).toHaveBeenCalledWith('grok', '/grok', 'grok-resumed', '/work')
      expect(transcriptOf).toHaveBeenCalledWith('agy', '/agy', 'agy-resumed', '/work')
      expect(findResumedTranscript).toHaveBeenCalledWith('codex', 'codex-resumed', { codexHome: undefined })
    })

    it('binds and follows Copilot resume while the optional loader cannot answer', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      vi.mocked(loadEngine).mockImplementation(() => new Promise(() => {}))
      try {
        for (const engine of ['cursor', 'grok', 'agy', 'copilot']) {
          await run.binding.bindObservedAgent(observed({ engine, resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
        }
        expect(vi.mocked(run.deps.registry.register).mock.calls.map(([input]) => [input.engine, input.transcriptPath])).toEqual(['cursor', 'grok', 'agy', 'copilot'].map(engine => [engine, `/t/${engine}.jsonl`]))
        // Copilot can also switch conversation while optional interpretation is unavailable.
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ engine: 'copilot' } as Partial<RegisteredSession>))
        vi.mocked(processSessionOf).mockResolvedValue('s2')
        await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
        expect(run.deps.registry.register).toHaveBeenCalledTimes(5)
        expect(loadEngine).not.toHaveBeenCalled()
      } finally { vi.mocked(loadEngine).mockReset() }
      // Claude Code and Codex find theirs with no engine code loaded.
      vi.mocked(loadEngine).mockClear()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      for (const engine of ['claude', 'codex']) {
        await run.binding.bindObservedAgent(observed({ engine, resumeSessionId: `${engine}-resumed` } as Partial<DiscoveredTerminalAgent>))
      }
      expect(loadEngine).not.toHaveBeenCalled()
    })

    it('needs a transcript for the engines whose sessions are files, and skips a deleted session', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '', codexHome: '/codex' } as Partial<RegisteredSession>))
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      vi.mocked(findResumedTranscript).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      for (const engine of ['cursor', 'grok', 'claude', 'codex']) {
        await run.binding.bindObservedAgent(observed({ engine, resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      }
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      await run.binding.bindObservedAgent(observed({ engine: 'agy', resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      await run.binding.bindObservedAgent(observed({ engine: 'copilot', resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      vi.mocked(isRecentlyDeleted).mockReturnValueOnce(true)
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'gone' } as Partial<DiscoveredTerminalAgent>))
      // agy and Copilot can bind before their file exists; the others cannot.
      expect(vi.mocked(run.deps.registry.register).mock.calls.map(([input]) => input.engine)).toEqual(['agy', 'copilot'])
      expect(findResumedTranscript).toHaveBeenCalledWith('codex', 'r', { codexHome: '/codex' })
    })

    it('gives a resumed session to the newer process, never to an older one or one whose start is unknown', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      // The holder started after this process (10:00), or this process's start cannot be read: it stays.
      run.bySession.set('r', agent({ agentId: 'newer', processIdentity: { pid: 1, startMarker: '2026-10-04T11:00:00Z' } } as Partial<RegisteredSession>))
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r', processIdentity: { pid: 42, startMarker: 'not a time' } } as Partial<DiscoveredTerminalAgent>))
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      // A holder that started earlier, one whose start is unknown, or this very agent: the session moves.
      run.bySession.set('r', agent({ agentId: 'older', processIdentity: { pid: 1, startMarker: '2026-10-04T09:00:00Z' } } as Partial<RegisteredSession>))
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      run.bySession.set('r', agent({ agentId: 'older' }))
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      run.bySession.set('r', agent({ agentId: 'a1' }))
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      expect(run.deps.registry.register).toHaveBeenCalledTimes(3)
    })

    it('moves a session from the agent that had it, telling everything that held it for that agent', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      const previous = agent({ agentId: 'old', processIdentity: { pid: 1, startMarker: '2026-10-04T09:00:00Z' } } as Partial<RegisteredSession>)
      run.bySession.set('r', previous)
      vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: agent({ sessionId: 'r' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      expect(run.deps.input.forget).toHaveBeenCalledWith('old')
      expect(run.deps.deviceInput.forget).toHaveBeenCalledWith('old')
      expect(run.deps.announceSession).toHaveBeenCalledWith(previous)
      expect(run.deps.attachSession).toHaveBeenCalled()
    })
  })

  describe('a repair', () => {
    it('keeps a stopped parent out of an unbound fork\'s fallback discovery', async () => {
      const owners = { settle: vi.fn(() => []) }, run = setup({ owners })
      const parent = agent({ agentId: 'parent-agent', sessionId: 'parent', active: false })
      const fork = agent({ sessionId: '', forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: parent.sessionId } })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(fork)
      vi.mocked(run.deps.stoppedAgents.get).mockReturnValue(parent)
      vi.mocked(findLiveSession).mockImplementation(async (_engine, _cwd, _start, options) =>
        options?.excludedSessionId === parent.sessionId ? null : { sessionId: parent.sessionId, transcriptPath: '/parent' })
      await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
      expect(owners.settle).not.toHaveBeenCalled()
      expect(fork.sessionId).toBe('')
    })

    it.each(['rebound', 'stopped'] as const)('does not publish native Codex evidence after its owner was %s', async change => {
      const run = setup(), entry = agent({ engine: 'codex', sessionId: '' }), seen = observed({ engine: 'codex' })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(entry)
      let answer!: (value: { sessionId: string; transcriptPath: string }) => void
      vi.mocked(findLiveSession).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
      const pending = run.binding.bindObservedAgent(seen)
      expect(findLiveSession).toHaveBeenCalledWith('codex', '/work', expect.any(Number), expect.objectContaining({ expectedProcess: seen.processIdentity }))
      if (change === 'rebound') entry.sessionId = 'replacement'
      else vi.mocked(run.deps.registry.byProcess).mockReturnValue(undefined)
      answer({ sessionId: 'native', transcriptPath: '/fixture/rollout.jsonl' }); await pending
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      expect(run.deps.attachSession).not.toHaveBeenCalled()
    })

    it('looks for the session a new process opened, sweeping eagerly, then once a minute', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(Date.parse('2026-10-04T10:00:00Z'))
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
      for (let sweep = 0; sweep < 30; sweep++) await run.binding.bindObservedAgent(observed())
      expect(findLiveSession).toHaveBeenCalledTimes(24)
      vi.advanceTimersByTime(60_000)
      await run.binding.bindObservedAgent(observed())
      expect(findLiveSession).toHaveBeenCalledTimes(25)
      expect(findLiveSession).toHaveBeenLastCalledWith('claude', '/work', Date.parse('2026-10-04T10:00:00Z'), { bornOnly: true, pid: 42, codexHome: undefined, hermesHome: undefined, expectedProcess: observed().processIdentity })
    })

    it('binds what it finds, with the Hermes home it was found in, and starts the count over', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '', codexHome: '/codex', hermesHome: '/hermes' } as Partial<RegisteredSession>))
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found', transcriptPath: '/t/found.jsonl', hermesHome: '/hermes' } as never)
      vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: agent({ sessionId: 'found' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
      expect(findLiveSession).toHaveBeenCalledWith('hermes', '/work', expect.any(Number), expect.objectContaining({ hermesHome: '/hermes' }))
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({
        sessionId: 'found', transcriptPath: '/t/found.jsonl', hermesHome: '/hermes', source: 'process-repair', hookEvent: 'ProcessRepair',
      })
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found2', transcriptPath: '/t/found2.jsonl' } as never)
      await run.binding.bindObservedAgent(observed())
      expect(vi.mocked(run.deps.registry.register).mock.calls[1][0]).not.toHaveProperty('hermesHome')
      expect(run.deps.attachSession).toHaveBeenCalledTimes(2)
    })

    it('finds nothing to bind for an unknown start, nothing found, or a session taken or deleted', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '', agentId: 'repair' }))
      await run.binding.bindObservedAgent(observed({ processIdentity: { pid: 42, startMarker: 'unknown' } } as Partial<DiscoveredTerminalAgent>))
      expect(findLiveSession).not.toHaveBeenCalled()
      await run.binding.bindObservedAgent(observed())
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'taken' } as never).mockResolvedValueOnce({ sessionId: 'deleted' } as never)
      vi.mocked(run.deps.registry.has).mockImplementation((sessionId: string) => sessionId === 'taken')
      vi.mocked(isRecentlyDeleted).mockImplementation((sessionId?: string) => sessionId === 'deleted')
      await run.binding.bindObservedAgent(observed())
      await run.binding.bindObservedAgent(observed())
      // Registered but not new: nothing more to do.
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'same' } as never)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: agent({ sessionId: 'same' }), ...meta() } as never)
      await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
    })
  })

  describe('a Hermes followed from its terminal record', () => {
    const follow = vi.fn<NonNullable<BindDeps['hermesTerminal']>['follow']>()
    const fellBack = vi.fn<NonNullable<BindDeps['hermesTerminal']>['fellBack']>()
    const hermes = (over: Partial<DiscoveredTerminalAgent> = {}) => observed({ engine: 'hermes', ...over })
    /** A binding with the record's judgment, and the Hermes row its pane holds. */
    const withRecord = (row: Partial<RegisteredSession> = {}) => {
      const run = setup({ hermesTerminal: { follow, fellBack } })
      const entry = agent({ engine: 'hermes', sessionId: '', ...row })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(entry)
      vi.mocked(run.deps.registry.register).mockImplementation(input => ({ entry: agent({ engine: 'hermes', sessionId: input.sessionId }), ...meta({ isNew: true }) }) as never)
      return { run, entry }
    }
    const said = (): string[] => vi.mocked(console.log).mock.calls.map(([line]) => String(line))
    beforeEach(() => { follow.mockReset().mockResolvedValue('none'); fellBack.mockReset() })

    it('holds a Hermes whose sandbox it cannot see, once, and asks nothing', async () => {
      const { run, entry } = withRecord()
      await run.binding.bindObservedAgent(hermes({ sandbox: 'unseen' }))
      await run.binding.bindObservedAgent(hermes({ sandbox: 'unseen' }))
      expect(run.deps.registry.setIdentityHold).toHaveBeenCalledWith('a1', HERMES_SANDBOX_HOLD)
      expect(entry.identityHold).toBe(HERMES_SANDBOX_HOLD)
      expect(run.deps.announceSession).toHaveBeenCalledExactlyOnceWith(entry)
      expect(said()).toEqual([`[discovery] a1 binding held · ${HERMES_SANDBOX_HOLD}`])
      expect(follow).not.toHaveBeenCalled()
      expect(findLiveSession).not.toHaveBeenCalled()
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    it('lets the hold go when the sandbox is seen again, and binds on the next pass', async () => {
      const { run, entry } = withRecord({ identityHold: HERMES_SANDBOX_HOLD })
      await run.binding.bindObservedAgent(hermes({ sandbox: { cwd: '/work' } }))
      expect(entry).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledExactlyOnceWith(entry)
      expect(follow).not.toHaveBeenCalled()
      follow.mockResolvedValue({ sessionId: 'S' })
      await run.binding.bindObservedAgent(hermes({ sandbox: { cwd: '/work' } }))
      expect(follow).toHaveBeenCalledWith(entry, expect.objectContaining({ sandboxed: true }), expect.anything())
      expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'S', source: 'hermes-terminal' }), { current: expect.any(Function) })
    })

    it('binds an unbound Hermes to the session its record names, without the repair', async () => {
      const { run, entry } = withRecord()
      follow.mockResolvedValue({ sessionId: 'S', hermesHome: '/data/agents/a1/.hermes' })
      const seen = hermes({ cwd: '/data/work/p1' })
      await run.binding.bindObservedAgent(seen)
      expect(follow).toHaveBeenCalledExactlyOnceWith(entry, { ...seen, sandboxed: false },
        { current: expect.any(Function), mayClaim: expect.any(Function), hold: expect.any(Function) })
      expect(findLiveSession).not.toHaveBeenCalled()
      expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ engine: 'hermes', sessionId: 'S', hermesHome: '/data/agents/a1/.hermes',
        cwd: '/data/work/p1', source: 'hermes-terminal', hookEvent: 'HermesTerminal', runtimes: seen.runtimes,
        primaryRuntimeKey: seen.primaryRuntimeKey, processIdentity: seen.processIdentity }), { current: expect.any(Function) })
      expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).not.toHaveProperty('hermesHomeDerived')
      expect(run.deps.attachSession).toHaveBeenCalledOnce()
      expect(said()).toEqual(['[discovery] bound hermes session S via tmux:%0'])
      expect(fellBack).not.toHaveBeenCalled()
    })

    it('marks the home it binds with when Harness worked that home out', async () => {
      const { run } = withRecord()
      follow.mockResolvedValue({ sessionId: 'S', hermesHome: '/data/agents/a1/.hermes' })
      await run.binding.bindObservedAgent(hermes({ hermesHomeDerived: true }))
      expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ hermesHome: '/data/agents/a1/.hermes', hermesHomeDerived: true }), { current: expect.any(Function) })
      // No home given: no mark of its own.
      follow.mockResolvedValue({ sessionId: 'T' })
      await run.binding.bindObservedAgent(hermes({ hermesHomeDerived: true }))
      expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).not.toHaveProperty('hermesHome')
      expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).not.toHaveProperty('hermesHomeDerived')
    })

    it('tells the agent the session was taken from', async () => {
      const { run } = withRecord()
      const previous = agent({ agentId: 'old', engine: 'hermes', sessionId: 'S', processIdentity: { pid: 1, startMarker: '2026-10-04T09:00:00Z' } } as Partial<RegisteredSession>)
      run.bySession.set('S', previous)
      follow.mockResolvedValue({ sessionId: 'S' })
      await run.binding.bindObservedAgent(hermes())
      expect(run.deps.input.forget).toHaveBeenCalledWith('old')
      expect(run.deps.deviceInput.forget).toHaveBeenCalledWith('old')
      expect(run.deps.announceSession).toHaveBeenCalledWith(previous)
    })

    it('switches a bound Hermes through the rotation, and attaches the new session', async () => {
      const { run } = withRecord({ sessionId: 'old' })
      follow.mockResolvedValue({ sessionId: 'S' })
      const seen = hermes()
      await run.binding.bindObservedAgent(seen)
      expect(said()).toEqual(['[discovery] a1 switched hermes session old → S'])
      expect(run.deps.registry.register).toHaveBeenCalledExactlyOnceWith({ engine: 'hermes', sessionId: 'S', cwd: '/work', source: 'hermes-terminal',
        runtimes: seen.runtimes, primaryRuntimeKey: seen.primaryRuntimeKey, processIdentity: seen.processIdentity, hookEvent: 'HermesTerminal' }, { current: expect.any(Function) })
      expect(run.deps.attachSession).toHaveBeenCalledOnce()
      expect(findLiveSession).not.toHaveBeenCalled()
      // A rotation the registry refused attaches nothing more; one that was not new is followed as a hook's re-register is.
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce(null)
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).toHaveBeenCalledOnce()
      const kept = agent({ engine: 'hermes', sessionId: 'S' })
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: kept, ...meta() } as never)
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).toHaveBeenCalledTimes(2)
      expect(run.deps.attachSession).toHaveBeenLastCalledWith(kept, false, false, false)
      // Neither is said to be a switch: a refused one is tried again in the repair's rhythm.
      expect(said()).toEqual(['[discovery] a1 switched hermes session old → S'])
    })

    it('confirms a resumed Hermes without a switch, and follows the binding it confirmed', async () => {
      const { run } = withRecord({ sessionId: 'S', resumeOnly: true, lastHookAt: 0 })
      const confirmed = agent({ engine: 'hermes', sessionId: 'S' })
      vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: confirmed, ...meta() } as never)
      follow.mockResolvedValue({ sessionId: 'S' })
      await run.binding.bindObservedAgent(hermes())
      expect(run.deps.registry.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'S', source: 'hermes-terminal', hookEvent: 'HermesTerminal' }), { current: expect.any(Function) })
      expect(said()).toEqual([])
      // The confirmation binds the row (`boundAt`), so the attach the resume started gave up on it (attach.ts).
      expect(run.deps.attachSession).toHaveBeenCalledExactlyOnceWith(confirmed, false, false, false)
    })

    it.each([["the resume's, of the row before it", true], ["a hook's, of the row it confirmed", false]] as const)(
      'reads a confirmed Hermes resume once, while an attach still reads: %s', async (_reading, resumed) => {
        const { run, entry } = withRecord({ sessionId: 'S', resumeOnly: true, lastHookAt: 0, boundAt: null })
        const confirmed = agent({ ...entry, boundAt: 1, lastHookAt: 1 })
        // Two attaches of one session as attach.ts runs them: one read at a time (lib/attachTracker.ts), a plain attach
        // of the same binding joining the read in flight, and a read whose binding moved on meanwhile giving it up.
        const tracker = new AttachTracker<string>()
        const reads: string[] = []
        let finish!: () => void
        const held = new Promise<void>(resolve => { finish = resolve })
        vi.mocked(run.deps.attachSession).mockImplementation((session, reset = false) => {
          const identity = paneReadIdentity(session)
          return tracker.attach(session, reset, async () => {
            reads.push(identity)
            await held
            return paneReadIdentity(run.deps.registry.byAgent(session.agentId)) === identity
          }, identity)
        })
        if (resumed) void run.deps.attachSession(entry)
        vi.mocked(run.deps.registry.register).mockImplementation(async () => {
          run.byAgent.set(entry.agentId, confirmed)
          // A hook's re-register of the same binding, attaching it as the commit lands.
          if (!resumed) void run.deps.attachSession(confirmed)
          return { entry: confirmed, ...meta() } as never
        })
        follow.mockResolvedValue({ sessionId: 'S' })
        await run.binding.bindObservedAgent(hermes())
        expect(run.deps.attachSession).toHaveBeenCalledTimes(2)
        expect(run.deps.attachSession).toHaveBeenLastCalledWith(confirmed, false, false, false)
        expect(reads).toHaveLength(1)
        finish()
        const attached = await Promise.all(vi.mocked(run.deps.attachSession).mock.results.map(result => result.value))
        expect(attached).toEqual(resumed ? [false, true] : [true, true])
        expect(reads).toEqual([...resumed ? [paneReadIdentity(entry)] : [], paneReadIdentity(confirmed)])
      },
    )

    it('does nothing while a record waits', async () => {
      for (const sessionId of ['', 'old']) {
        const { run } = withRecord({ sessionId })
        follow.mockResolvedValue('wait')
        await run.binding.bindObservedAgent(hermes())
        expect(run.deps.registry.register).not.toHaveBeenCalled()
      }
      expect(findLiveSession).not.toHaveBeenCalled()
    })

    it('drops what it was told when the pane changed hands meanwhile', async () => {
      const { run } = withRecord()
      follow.mockImplementation(async () => {
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ agentId: 'other', engine: 'hermes', sessionId: '', cwd: '/elsewhere' }))
        return { sessionId: 'S' }
      })
      await run.binding.bindObservedAgent(hermes())
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      expect(findLiveSession).not.toHaveBeenCalled()
    })

    it('falls back to the repair with the folder the sandbox names, binds the daemon\'s path of it, and says so once', async () => {
      const { run } = withRecord()
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found' } as never)
      await run.binding.bindObservedAgent(hermes({ cwd: '/data/work/p1', sandbox: { cwd: '/work' } }))
      expect(findLiveSession).toHaveBeenCalledWith('hermes', '/work', expect.any(Number), expect.anything())
      expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/data/work/p1', source: 'process-repair' }), { current: expect.any(Function) })
      expect(fellBack).toHaveBeenCalledExactlyOnceWith('a1')
      // Found nothing, or bound nothing new: nothing said.
      await run.binding.bindObservedAgent(hermes())
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'again' } as never)
      vi.mocked(run.deps.registry.register).mockResolvedValueOnce({ entry: agent({ engine: 'hermes', sessionId: 'again' }), ...meta() } as never)
      await run.binding.bindObservedAgent(hermes())
      expect(fellBack).toHaveBeenCalledOnce()
    })

    it('leaves the other engines and a binding with no hermesTerminal as they were', async () => {
      const { run } = withRecord({ engine: 'claude' })
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found', transcriptPath: '/t/found.jsonl' } as never)
      await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).toHaveBeenCalledWith(expect.objectContaining({ engine: 'claude', source: 'process-repair' }), { current: expect.any(Function) })
      expect(follow).not.toHaveBeenCalled()
      expect(fellBack).not.toHaveBeenCalled()
      // A Hermes in a sandbox it cannot see, with no record's judgment, is left to the repair as before.
      const plain = setup()
      vi.mocked(plain.deps.registry.byProcess).mockReturnValue(agent({ engine: 'hermes', sessionId: '' }))
      await plain.binding.bindObservedAgent(hermes({ sandbox: 'unseen' }))
      expect(plain.deps.registry.setIdentityHold).not.toHaveBeenCalled()
      expect(findLiveSession).toHaveBeenLastCalledWith('hermes', '/work', expect.any(Number), expect.anything())
    })
  })

  // A Codex started in a folder it does not trust stops at its trust question with no conversation. Its first process
  // read failed while the npm wrapper was still starting its native child, and nothing let that hold go: `harness wait`
  // waited out its two minutes instead of saying the agent needs the person (e2e/agentClient.e2e.ts, CLI end to end
  // runs 43670913136 shard 5 and 43503224991).
  describe('a hold a failed native read set', () => {
    const unsettled = new Error('a native child changed during inspection')
    const codex = (over: Partial<DiscoveredTerminalAgent> = {}) => observed({ engine: 'codex', ...over })
    /** An agent as the registry holds it: found by its process and by its id. Unbound unless told otherwise. */
    const inRegistry = (run: ReturnType<typeof setup>, over: Partial<RegisteredSession> = {}): RegisteredSession => {
      const row = agent({ engine: 'codex', sessionId: '', ...over })
      run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      return row
    }
    /** Several unbound Codex agents, each found by its own process. */
    const several = (run: ReturnType<typeof setup>, ids: string[]) => {
      const rows = ids.map((agentId, at) => agent({ engine: 'codex', agentId, sessionId: '',
        processIdentity: { pid: 1000 + at, startMarker: '2026-10-04T10:00:00Z', executable: 'codex' } }))
      for (const row of rows) run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockImplementation((_, identity) => rows.find(row => row.processIdentity?.pid === identity.pid))
      return { rows, pass: (at: number) => run.binding.bindObservedAgent(codex({ processIdentity: rows[at]!.processIdentity! })) }
    }
    const said = (): string[] => vi.mocked(console.log).mock.calls.map(([line]) => String(line))

    it('is let go by the next pass that reads completely and finds nothing, and set again by a read that fails again', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(run.deps.announceSession).toHaveBeenLastCalledWith(row)
      expect(said()).toEqual([
        '[discovery] a1 binding held · Error',
        '[discovery] a1 binding released · its native evidence was read completely',
      ])
      // Nothing more is said while its reads go on completing.
      await run.binding.bindObservedAgent(codex())
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      // A read that fails again is a new hold, let go the same way: each change announced once.
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(4)
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    // A hold only the person can clear lasts hours: a line on every 5 s pass buried the log (12 lines a minute).
    it('logs a hold once, and again only when its words change or it comes back after a release', async () => {
      const run = setup()
      inRegistry(run)
      const incomplete = new IdentityReadUnavailable('', 'This Harness install is incomplete. Reinstall Harness.')
      vi.mocked(findLiveSession).mockRejectedValueOnce(incomplete).mockRejectedValueOnce(incomplete).mockRejectedValueOnce(incomplete)
        .mockRejectedValueOnce(unsettled).mockResolvedValueOnce(null).mockRejectedValueOnce(incomplete)
      for (let pass = 0; pass < 6; pass++) await run.binding.bindObservedAgent(codex())
      // The log names the hold's kind; its words are on the row (setIdentityHold), which clients are sent.
      expect(said()).toEqual([
        '[discovery] a1 binding held · IdentityReadUnavailable IDENTITY_UNAVAILABLE',
        '[discovery] a1 binding held · Error',
        '[discovery] a1 binding released · its native evidence was read completely',
        '[discovery] a1 binding held · IdentityReadUnavailable IDENTITY_UNAVAILABLE',
      ])
    })

    it('is let go when the resume lookup that failed completes and finds no transcript', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findResumedTranscript).mockRejectedValueOnce(unsettled).mockResolvedValue(null)
      await run.binding.bindObservedAgent(codex({ resumeSessionId: 'resumed' }))
      expect(row.identityHold).toBe('a native child changed during inspection')
      await run.binding.bindObservedAgent(codex({ resumeSessionId: 'resumed' }))
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    // An agent bound or woken while held never had its stream attached (discovery.ts skips a held agent as it wakes):
    // let go without it, its pane would work while the apps and devices showed nothing.
    it('attaches the stream of an agent let go with a conversation: once, after the hold is gone, and without waiting for it', async () => {
      const heldAtAttach: unknown[] = []
      // An attach reads the agent's whole history: this one never answers, and the pass ends all the same.
      const run = setup({ attachSession: vi.fn((session: RegisteredSession) => { heldAtAttach.push(session.identityHold); return new Promise<boolean>(() => {}) }) })
      const row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
      await run.binding.bindObservedAgent(seen)
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).toHaveBeenCalledWith(row)
      // A row still held attaches nothing (transcripts/attach.ts): the hold was gone when the attach began.
      expect(heldAtAttach).toEqual([undefined])
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    })

    it('attaches nothing for an agent let go with no conversation', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.attachSession).not.toHaveBeenCalled()
    })

    it.each([[new Error('reader unavailable'), 'Error'], ['reader unavailable', 'string']])('logs a stream that cannot attach, and the agent stays let go: %s', async (error, kind) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup({ attachSession: vi.fn(async () => { throw error }) })
      const row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      await run.binding.bindObservedAgent(seen)
      expect(said().at(-1)).toBe('[discovery] a1 binding released · its native evidence was read completely')
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`[agent] a1 transcript attachment is unavailable: ${kind}`))
      expect(log).toHaveBeenCalledTimes(1)
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
    })

    it('stays through a pass that read nothing: the repair in its slow rhythm', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(Date.parse('2026-10-04T10:00:00Z'))
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValue(unsettled)
      for (let sweep = 0; sweep < 24; sweep++) await run.binding.bindObservedAgent(codex())
      // The read would complete now, but the repair asks once a minute from here.
      vi.mocked(findLiveSession).mockResolvedValue(null)
      await run.binding.bindObservedAgent(codex())
      expect(findLiveSession).toHaveBeenCalledTimes(24)
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
    })

    it('stays through a pass with one read that completes and one that fails', async () => {
      const run = setup(), row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled).mockResolvedValue('s2')
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('a native child changed during inspection')
      vi.mocked(transcriptOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      expect(processSessionOf).toHaveBeenCalledTimes(2)
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
      // Both complete: let go.
      await run.binding.bindObservedAgent(seen)
      expect(row).not.toHaveProperty('identityHold')
    })

    it('leaves a hold a refused register set, also once a read fails with the same words', async () => {
      const run = setup(), row = inRegistry(run), seen = codex({ resumeSessionId: 'resumed' })
      vi.mocked(run.deps.registry.register).mockImplementationOnce(() => { throw new Error('binding evidence changed') })
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      vi.mocked(findResumedTranscript).mockResolvedValue(null)
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      // The same words from a failed read change nothing on the row: the hold is still the register's.
      vi.mocked(findResumedTranscript).mockRejectedValueOnce(new Error('binding evidence changed'))
      await run.binding.bindObservedAgent(seen)
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    // A lookup and the register's own check of the transcript read it with the same scan (engines/kit/identityScan.ts),
    // so they fail in the same words: the register that refuses changes nothing on the row, and still says to hold.
    it('stays through a pass whose reads complete and whose register is refused in the same words', async () => {
      const run = setup(), row = inRegistry(run), seen = codex({ resumeSessionId: 'resumed' })
      const changed = new Error('the native record changed during the read')
      vi.mocked(findResumedTranscript).mockRejectedValueOnce(changed)
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('the native record changed during the read')
      vi.mocked(run.deps.registry.register).mockImplementationOnce(() => { throw changed })
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('the native record changed during the read')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      expect(said().at(-1)).toBe('[discovery] a1 binding held · Error')
      // Nothing refuses on the next pass: let go.
      await run.binding.bindObservedAgent(seen)
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
    })

    it.each([
      ['hermes', HERMES_SANDBOX_HOLD],
      ['codex', 'Waiting for native evidence after a concurrent binding write.'],
    ] as const)('leaves a hold the binding did not set: %s, %s', async (engine, reason) => {
      const run = setup(), row = inRegistry(run, { engine, identityHold: reason })
      await run.binding.bindObservedAgent(observed({ engine }))
      expect(findLiveSession).toHaveBeenCalledOnce()
      expect(row.identityHold).toBe(reason)
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })

    it('leaves a hold Hermes\'s own follower set', async () => {
      const follow = vi.fn<NonNullable<BindDeps['hermesTerminal']>['follow']>(async (_agent, _observed, pass) => {
        pass.hold(new Error('its store could not be read'))
        return 'none'
      })
      const run = setup({ hermesTerminal: { follow, fellBack: vi.fn() } }), row = inRegistry(run, { engine: 'hermes' })
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
      expect(row.identityHold).toBe('its store could not be read')
      follow.mockResolvedValue('none')
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
      expect(findLiveSession).toHaveBeenCalledOnce()
      expect(row.identityHold).toBe('its store could not be read')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    it.each(['another reason', 'the same words, set again'] as const)('leaves a hold another path changed since: %s', async change => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      const recorded = row.evidenceRevision
      if (change === 'another reason') run.deps.registry.setIdentityHold('a1', 'This OpenClaw version is not supported yet.')
      else {
        run.deps.registry.setIdentityHold('a1', undefined)
        run.deps.registry.setIdentityHold('a1', 'a native child changed during inspection')
      }
      const changed = row.identityHold
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe(changed)
      expect(row.evidenceRevision).not.toBe(recorded)
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      // What was remembered went with that pass: not even the row as it was then is let go now.
      Object.assign(row, { identityHold: 'a native child changed during inspection', evidenceRevision: recorded })
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
    })

    it('forgets an agent the registry no longer has, when the next hold is remembered', async () => {
      const run = setup(), { rows, pass } = several(run, ['gone', 'stays'])
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled).mockRejectedValueOnce(unsettled)
      await pass(0)
      run.byAgent.delete('gone')
      await pass(1)
      // Back under its id with the very row it had: nothing is remembered of it, so nothing is let go.
      run.byAgent.set('gone', rows[0]!)
      await pass(0)
      await pass(1)
      expect(rows[0]!.identityHold).toBe('a native child changed during inspection')
      expect(rows[1]).not.toHaveProperty('identityHold')
    })

    it('remembers 256 holds at most: one more starts over, and the holds before it stay as they were', async () => {
      const run = setup(), { rows, pass } = several(run, Array.from({ length: 257 }, (_, at) => `agent-${at}`))
      vi.mocked(findLiveSession).mockRejectedValue(unsettled)
      for (let at = 0; at < 257; at++) await pass(at)
      vi.mocked(findLiveSession).mockResolvedValue(null)
      await pass(0)
      await pass(256)
      expect(rows[0]!.identityHold).toBe('a native child changed during inspection')
      expect(rows[256]).not.toHaveProperty('identityHold')
    })

    it.each(['changing', 'deleted', 'process', 'binding'] as const)('stays when the agent changed during the pass: %s', async change => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      let answer!: (found: null) => void
      vi.mocked(findLiveSession).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
      const pending = run.binding.bindObservedAgent(codex())
      if (change === 'changing') run.binding.whileChanging(() => true)
      if (change === 'deleted') vi.mocked(isRecentlyDeleted).mockImplementation(id => id === row.agentId)
      if (change === 'process') vi.mocked(run.deps.registry.byProcess).mockReturnValue(undefined)
      if (change === 'binding') row.cwd = '/elsewhere'
      answer(null); await pending
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    // A read that fails while the agent is changing sets nothing, and still read nothing completely: a change over by the
    // end of the pass does not make it one that lets go.
    it('stays through a pass whose read failed while the agent was changing, the change over before the pass ended', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      // The change is seen once, by the hold the failed read asks for.
      let changing = false
      run.binding.whileChanging(() => { const seen = changing; changing = false; return seen })
      vi.mocked(findLiveSession).mockImplementationOnce(async () => { changing = true; throw new Error('another failure') })
      await run.binding.bindObservedAgent(codex())
      expect(changing).toBe(false)
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    // Core rule 6: a read that began before the hold cannot undo it.
    it('stays when the pass that read completely began before the hold was set', async () => {
      const run = setup(), row = inRegistry(run)
      let answer!: (found: null) => void
      vi.mocked(findLiveSession).mockReturnValueOnce(new Promise(resolve => { answer = resolve })).mockRejectedValueOnce(unsettled)
      const earlier = run.binding.bindObservedAgent(codex())
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      answer(null); await earlier
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })
  })
})

describe('a transcript\'s birth time', () => {
  const at = (birthtimeMs: number, ctimeMs: number, mtimeMs: number) => async () => ({ birthtimeMs, ctimeMs, mtimeMs })

  it('is its birth time, else its change time, else its write time, and 0 when unreadable or not a time', async () => {
    expect(await statBirthMs('/t', at(3, 2, 1))).toBe(3)
    expect(await statBirthMs('/t', at(0, 2, 1))).toBe(2)
    expect(await statBirthMs('/t', at(0, 0, 1))).toBe(1)
    expect(await statBirthMs('/t', at(Number.POSITIVE_INFINITY, 0, 0))).toBe(0)
    expect(await statBirthMs('/t', at(0, 0, Number.NaN))).toBe(0)
    expect(await statBirthMs('/t', async () => { throw new Error('ENOENT') })).toBe(0)
  })
})

describe('binding an OpenClaw pane, read from its screen', () => {
  const OPENCLAW_FIXTURES = join(import.meta.dirname, '../../engines/openclaw/__fixtures__')
  const screen = (name: string): string => readFileSync(join(OPENCLAW_FIXTURES, `${name}.txt`), 'utf8')
  const tui = (over: Partial<DiscoveredTerminalAgent> = {}): DiscoveredTerminalAgent => ({
    engine: 'openclaw', cwd: '/work/proj', runtimes: [], primaryRuntimeKey: 'tmux:%1',
    processIdentity: { pid: 7714, startMarker: '2026-11-10T07:40:00Z' }, ...over,
  }) as DiscoveredTerminalAgent
  const pane = (over: Partial<RegisteredSession> = {}) => agent({ engine: 'openclaw', sessionId: '', ...over } as Partial<RegisteredSession>)
  /** Two passes over the pane 10 s apart: a Gateway gone holds its agent only once it has been gone that long. */
  const lasting = async (run: ReturnType<typeof setup>) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    await run.binding.bindObservedAgent(tui())
    vi.setSystemTime(Date.now() + 10_000)
    await run.binding.bindObservedAgent(tui())
  }

  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('binds an openclaw pane to main from its footer, and remembers the state folder its TUI holds', async () => {
    const run = setup({ capturePane: vi.fn(async () => screen('screen-two-panes-main-a')), openclawStateDir: vi.fn(async () => '/h/.openclaw-work') })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    const bound = pane({ sessionId: 'agent:main:main' })
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: bound, ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(tui())
    // `main` existed long before this TUI started, and is bound all the same: no repair by birth time.
    expect(findLiveSession).not.toHaveBeenCalled()
    expect(run.deps.capturePane).toHaveBeenCalledWith('a1')
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({
      engine: 'openclaw', sessionId: 'agent:main:main', cwd: '/work/proj', source: 'openclaw-footer', hookEvent: 'OpenclawFooter',
    })
    await vi.waitFor(() => expect(run.deps.attachSession).toHaveBeenCalledWith(bound, true, false, false))
    // A `--profile` TUI's store is not the default one: where it is, once this TUI is gone.
    expect(run.deps.openclawStateDir).toHaveBeenCalledWith(7714)
    expect(run.deps.registry.setOpenclawStateDir).toHaveBeenCalledWith('a1', '/h/.openclaw-work')
  })

  it('a second pane on the same key stays unbound and the first keeps it', async () => {
    const run = setup({ capturePane: vi.fn(async () => screen('screen-two-panes-main-b')) })
    const first = pane({ agentId: 'a0', sessionId: 'agent:main:main', processIdentity: { pid: 7700, startMarker: '2026-11-10T07:39:00Z' } } as Partial<RegisteredSession>)
    run.bySession.set('agent:main:main', first)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    // What a repair by folder would answer: the key is in the store, whoever holds it.
    vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'agent:main:main' })
    // Started after the first: for another engine that is a resume taking the conversation over.
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    expect(run.deps.input.forget).not.toHaveBeenCalled()
  })

  it('a remote Gateway title gives the remote state, held until a local title shows again', async () => {
    let shown = screen('screen-remote')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    const row = pane()
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    expect(row.identityHold).toBe('This OpenClaw runs on another machine.')
    expect(run.deps.announceSession).toHaveBeenCalledWith(row)
    // The title scrolled off a long conversation: nothing says it is local now, so the state stays.
    shown = screen('screen-remote').split('\n').slice(3).join('\n')
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('This OpenClaw runs on another machine.')
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    // The same pane reconnected to this machine's Gateway: the state goes, and the key is bound.
    shown = screen('screen-plain')
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: pane({ sessionId: 'agent:main:plain' }), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:plain' })
  })

  it('follows the pane to the key /new moved it to, and the new key becomes the agent\'s session', async () => {
    let shown = screen('screen-reset')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:reset' }))
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    shown = screen('screen-reset-new')
    const moved = pane({ sessionId: 'agent:main:tui-652cc362-2631-416e-bf1c-6ac369311a20' })
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: moved, ...meta({ isNew: true, rebound: 'agent:main:reset' }) } as never)
    await run.binding.bindObservedAgent(tui())
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({
      sessionId: 'agent:main:tui-652cc362-2631-416e-bf1c-6ac369311a20', source: 'openclaw-new', hookEvent: 'OpenclawNew',
    })
  })

  it('leaves a pane that shows no TUI, or one it could not read, as it is', async () => {
    const run = setup({ capturePane: vi.fn(async () => screen('screen-no-token').replace(/Missing gateway auth token\./, '')) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    vi.mocked(findLiveSession).mockResolvedValue({ sessionId: 'agent:main:main' })
    await run.binding.bindObservedAgent(tui())
    vi.mocked(run.deps.capturePane).mockResolvedValueOnce(null)
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it('binds a long session whose title scrolled off, by its footer', async () => {
    // The 80-column pane on main, scrolled one line further: its title and its session line are gone, its footer wraps.
    const long = screen('screen-two-panes-main-b').split('\n').slice(1).join('\n')
    expect(long).not.toContain('agent:main:main')
    const run = setup({ capturePane: vi.fn(async () => long) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: pane({ sessionId: 'agent:main:main' }), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(tui())
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:main' })
  })

  it('an answer that prints the session line never moves the pane', async () => {
    const said = screen('screen-plain').replace(' connected | idle', ' session agent:main:elsewhere\n connected | idle')
    const run = setup({ capturePane: vi.fn(async () => said) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain' }))
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.register).not.toHaveBeenCalled()
  })

  it('a TUI restarted in the same pane binds its own session, never the one the old TUI left on screen', async () => {
    // The first TUI exited; the person started another one in the same shell, which has not drawn yet.
    let shown = `${screen('screen-plain').trimEnd()}\n$ openclaw tui --session other\n`
    const run = setup({ capturePane: vi.fn(async () => shown) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    await run.binding.bindObservedAgent(tui({ processIdentity: { pid: 7800, startMarker: '2026-11-10T08:00:00Z', executable: 'openclaw' } }))
    expect(run.deps.registry.register).not.toHaveBeenCalled()
    // Drawn: its own key, bound as a new binding, so nothing renames it after the old agent.
    shown += ` openclaw tui - ws://127.0.0.1:18789 - agent main - session other\n connected | idle\n agent main | session other | m/m | deliver:off | tokens ?\n${'─'.repeat(40)}\n\n${'─'.repeat(40)}\n`
    vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: pane({ sessionId: 'agent:main:other' }), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(tui({ processIdentity: { pid: 7800, startMarker: '2026-11-10T08:00:00Z', executable: 'openclaw' } }))
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:other', source: 'openclaw-footer' })
  })

  it('no Gateway and no token are said on the agent while the screen shows them, and cleared once it does not', async () => {
    for (const [name, said] of [
      ['screen-no-gateway-attached', 'OpenClaw Gateway is not running. Start it with openclaw gateway.'],
      ['screen-no-token', 'OpenClaw has no Gateway token. Run openclaw onboard.'],
    ] as const) {
      let shown = screen(name)
      const run = setup({ capturePane: vi.fn(async () => shown) })
      const row = pane({ sessionId: 'agent:main:plain' })
      run.byAgent.set('a1', row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      await lasting(run)
      expect(row.identityHold, name).toBe(said)
      expect(run.deps.announceSession, name).toHaveBeenCalledWith(row)
      expect(run.deps.registry.register, name).not.toHaveBeenCalled()
      // The Gateway is back and the TUI reconnected by itself: the state goes, and the stream attaches if it had not.
      shown = screen('screen-no-gateway-reconnected')
      await run.binding.bindObservedAgent(tui())
      expect(row, name).not.toHaveProperty('identityHold')
      expect(run.deps.attachSession, name).toHaveBeenCalledWith(row)
    }
  })

  it.each([[new Error('reader unavailable'), 'Error'], ['reader unavailable', 'string']])('a stream that cannot attach once the state clears is logged, and the state still goes', async (error, kind) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shown = screen('screen-no-gateway-attached')
    const run = setup({ capturePane: vi.fn(async () => shown), attachSession: vi.fn(async () => { throw error }) })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await lasting(run)
    shown = screen('screen-no-gateway-reconnected')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(`[agent] a1 transcript attachment is unavailable: ${kind}`))
  })

  it('a state the registry no longer holds is not announced cleared again', async () => {
    // The pass read its row before another pass cleared the same state.
    const run = setup({ capturePane: vi.fn(async () => screen('screen-no-gateway-reconnected')) })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue({ ...row, identityHold: 'OpenClaw Gateway is not running. Start it with openclaw gateway.' })
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.registry.setIdentityHold).toHaveBeenCalledWith('a1', undefined)
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(run.deps.attachSession).not.toHaveBeenCalled()
  })

  it('a pane not bound yet clears its state with no stream to attach, then binds by its footer', async () => {
    let shown = screen('screen-no-gateway-attached')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    const row = pane()
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await lasting(run)
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    shown = screen('screen-no-gateway-reconnected')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    expect(vi.mocked(run.deps.registry.register).mock.calls.at(-1)![0]).toMatchObject({ sessionId: 'agent:main:plain', source: 'openclaw-footer' })
  })

  it('an overlay that hides the footer keeps the no-Gateway state until a footer shows again', async () => {
    // Autocomplete draws its list under the composer, so the footer is not the last thing on screen for a pass.
    const noGateway = screen('screen-no-gateway-attached')
    let shown = noGateway
    const run = setup({ capturePane: vi.fn(async () => shown) })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await lasting(run)
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    shown = `${noGateway.trimEnd()}\n /help  Show help\n /new  Start a new session\n`
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    shown = noGateway
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    shown = screen('screen-no-gateway-reconnected')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
  })

  it('never takes over a hold another reason set', async () => {
    const run = setup({ capturePane: vi.fn(async () => screen('screen-no-gateway')) })
    const row = pane({ sessionId: 'agent:main:plain', identityHold: 'This OpenClaw version is not supported yet.' } as Partial<RegisteredSession>)
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('This OpenClaw version is not supported yet.')
    vi.mocked(run.deps.capturePane).mockResolvedValue(screen('screen-plain'))
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('This OpenClaw version is not supported yet.')
  })

  // Its own screen states are its to clear (above); a capture that failed is the binding's, and nothing let it go.
  it('a hold a failed capture set goes once the pane is read again', async () => {
    const capturePane = vi.fn<BindDeps['capturePane']>().mockRejectedValueOnce(new Error('the pane could not be captured'))
      .mockResolvedValue(screen('screen-plain'))
    const run = setup({ capturePane })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('the pane could not be captured')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenLastCalledWith('[discovery] a1 binding released · its native evidence was read completely')
    // Bound while held, its stream was never attached: let go, it is, as when the screen's own state clears.
    expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    expect(run.deps.attachSession).toHaveBeenCalledWith(row)
  })

  // A capture that answers null read nothing (the pane cannot be read), so it proves nothing (PM, 2026-11-15); nor does
  // one that answers an empty screen, which the pass reads no further either.
  it.each([null, ''])('a hold a failed capture set stays when the next capture reads nothing: %j', async (shown) => {
    const capturePane = vi.fn<BindDeps['capturePane']>().mockRejectedValueOnce(new Error('the pane could not be captured'))
      .mockResolvedValue(shown)
    const run = setup({ capturePane })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('the pane could not be captured')
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('the pane could not be captured')
    expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    expect(console.log).not.toHaveBeenCalledWith('[discovery] a1 binding released · its native evidence was read completely')
    expect(run.deps.attachSession).not.toHaveBeenCalled()
  })

  it('a hold a failed capture set gives way to the screen\'s own state: let go on one pass, No Gateway said once it lasts', async () => {
    const capturePane = vi.fn<BindDeps['capturePane']>().mockRejectedValueOnce(new Error('the pane could not be captured'))
      .mockResolvedValue(screen('screen-no-gateway-attached'))
    const run = setup({ capturePane })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    vi.useFakeTimers({ toFake: ['Date'] })
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    vi.setSystemTime(Date.now() + 10_000)
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    expect(run.deps.announceSession).toHaveBeenCalledTimes(3)
    expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
  })

  it('tells the bound session\'s stream on each pass whether its pane reads idle and whether the Gateway dropped', async () => {
    let shown = screen('screen-abort-running')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:abort' }))
    await run.binding.bindObservedAgent(tui())
    shown = screen('screen-abort')
    await run.binding.bindObservedAgent(tui())
    // A pass that reads the Gateway gone is told too.
    shown = screen('screen-no-gateway').replace(/session no-gateway/g, 'session abort')
    await run.binding.bindObservedAgent(tui())
    shown = screen('screen-no-gateway-reconnected').replace(/session plain/g, 'session abort')
    await run.binding.bindObservedAgent(tui())
    expect(vi.mocked(run.deps.openclawPaneRead).mock.calls.map(([session, reading]) => [session, reading])).toEqual([
      ['agent:main:abort', { ready: false, gatewayLost: false, running: true }],
      ['agent:main:abort', { ready: true, gatewayLost: false, running: false }],
      ['agent:main:abort', { ready: false, gatewayLost: true, running: false }],
      ['agent:main:abort', { ready: true, gatewayLost: true, running: false }],
    ])
  })

  // A run with no session in the store for 30 s is a store the Gateway does not write (engines/openclaw/live.ts).
  it('tells the stream when the pane reads a run in progress', async () => {
    let shown = screen('screen-abort-running')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:abort' }))
    await run.binding.bindObservedAgent(tui())
    // `connecting` is the TUI still reaching its Gateway: no run yet.
    shown = shown.replace('running •', 'connecting •')
    await run.binding.bindObservedAgent(tui())
    expect(vi.mocked(run.deps.openclawPaneRead).mock.calls.map(([, reading]) => reading)).toEqual([
      { ready: false, gatewayLost: false, running: true },
      { ready: false, gatewayLost: false, running: false },
    ])
  })

  // The bind pass's captures, and the footer poll's beside them, were most of what one bound idle pane cost (E2E 2026-11-10).
  it('reads a bound pane only when its stream says it may show something new, and hands that one capture to the model chip', async () => {
    const shown = screen('screen-plain')
    const run = setup({ capturePane: vi.fn(async () => shown), openclawPaneDue: vi.fn(() => false) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain' }))
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.openclawPaneDue).toHaveBeenCalledWith('agent:main:plain')
    expect(run.deps.capturePane).not.toHaveBeenCalled()
    expect(run.deps.openclawPaneRead).not.toHaveBeenCalled()
    vi.mocked(run.deps.openclawPaneDue).mockReturnValue(true)
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.capturePane).toHaveBeenCalledOnce()
    expect(run.deps.openclawPaneRead).toHaveBeenCalledWith('agent:main:plain', { ready: true, gatewayLost: false, running: false }, shown)
    // A pane not bound yet is read on every pass: its footer is how it is bound.
    vi.mocked(run.deps.openclawPaneDue).mockReturnValue(false)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    await run.binding.bindObservedAgent(tui())
    expect(run.deps.capturePane).toHaveBeenCalledTimes(2)
  })

  // Found end to end (2026-11-11): a store the Gateway does not write never changes and opens no turn, so the pass before
  // a message was typed left the pane quiet for 30 s, the run it started was first read that late, and the store hold
  // came about 70 s into the run.
  it('a pane awaiting a typed message\'s confirmation is read on every pass: the store hold comes 30 s into its run', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const folder = mkdtempSync(join(tmpdir(), 'openclaw-bind-'))
    // The TUI's store as the lamp's was: no file, as the Gateway writes another folder's.
    const onSessionMissing = vi.fn()
    const stream = new OpenclawLive({
      db: join(folder, 'openclaw-agent.sqlite'), key: 'agent:main:plain', pollMs: 1_000, onEvents: vi.fn(), onFatal: vi.fn(), onSessionMissing,
    })
    let shown = screen('screen-plain')
    const row = pane({ sessionId: 'agent:main:plain' })
    const rows = (id: string) => id === 'a1' || id === 'agent:main:plain' ? row : undefined
    const done: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
    const typed: string[] = []
    const inputs = createInput({
      readScreen: readInlineScreen,
      submission: inlineSubmission,
      resolve: rows,
      byAgent: rows,
      terminal: {
        captureTerminal: vi.fn(async () => shown),
        validateTerminal: vi.fn(async () => true),
        submitTerminalAction: vi.fn(async (_id: string, text: string) => { typed.push(text); return done }),
        keyTerminalAction: vi.fn(async () => done),
        pinTerminalControl: vi.fn(() => () => {}),
      },
      deliveries: { settled: vi.fn(), canWrite: vi.fn(() => true) },
      device: () => undefined,
      clients: { send: vi.fn(), sendCommander: vi.fn() },
      agentIdFor: (sessionId) => rows(sessionId)?.agentId ?? sessionId,
      openTurn: async () => [],
      emit: vi.fn(),
    })
    const run = setup({
      capturePane: vi.fn(async () => shown),
      input: inputs.input,
      openclawPaneRead: vi.fn((_sessionId: string, reading: Parameters<OpenclawLive['paneRead']>[0]) => { stream.paneRead(reading); return true }),
      openclawPaneDue: vi.fn(() => stream.paneDue()),
    })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    try {
      await stream.start()
      const start = Date.now()
      /** A bind pass `seconds` after the first. */
      const pass = async (seconds: number) => {
        await vi.advanceTimersByTimeAsync(start + seconds * 1_000 - Date.now())
        await run.binding.bindObservedAgent(tui())
      }
      await pass(0)
      // Idle, with nothing typed: not read again within half a minute.
      await pass(5)
      expect(run.deps.capturePane).toHaveBeenCalledOnce()
      inputs.submitAgent('a1', 'Run sleep 120')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(typed).toEqual(['Run sleep 120'])
      shown = screen('screen-abort-running').replace(/abort/g, 'plain')
      // The message awaits its user row, which this store never shows: the pass reads the pane, and the run on it.
      await pass(10)
      expect(run.deps.capturePane).toHaveBeenCalledTimes(2)
      expect(run.deps.openclawPaneRead).toHaveBeenLastCalledWith('agent:main:plain', { ready: false, gatewayLost: false, running: true }, shown)
      for (let seconds = 15; seconds < 40; seconds += 5) await pass(seconds)
      expect(onSessionMissing).not.toHaveBeenCalled()
      await pass(40)
      expect(onSessionMissing).toHaveBeenCalledOnce()
    } finally {
      stream.stop()
      inputs.input.forget('a1')
      rmSync(folder, { recursive: true, force: true })
      vi.useRealTimers()
    }
  })

  it('finds the state folder from the TUI\'s open database (fake /proc and lsof)', async () => {
    const fixture = (name: string) => readFileSync(join(OPENCLAW_FIXTURES, name), 'utf8')
    // What Linux's /proc/<pid>/fd and macOS's lsof name, as recorded.
    const linux = [...fixture('ps-linux.txt').split('# Gateway')[0].matchAll(/-> (\S+)/g)].map((match) => match[1])
    const darwin = [...fixture('ps-darwin.txt').split('# Gateway')[0].matchAll(/^\S+ REG (\S+)$/gm)].map((match) => match[1].replace('<scratch>', '/scratch'))
    expect(await openclawStateDir(7714, async () => linux)).toBe('/root/.openclaw')
    expect(await openclawStateDir(28234, async () => darwin)).toBe('/scratch/state')
    // Windows reads no open files: OpenClaw's own default.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await openclawStateDir(9001, async () => { throw new Error('no lsof') })).toBeNull()
    expect(await openclawStateDir(9002, async () => ['/tmp/other.sqlite'])).toBeNull()
    // A TUI that exited: the folder it held when bound, else OpenClaw's default.
    const exited = async () => []
    expect(await openclawSessionDb('agent:main:plain', { pid: 9004, stateDir: '/h/.openclaw-work' }, exited))
      .toBe(join('/h/.openclaw-work', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    // The pid outlived its TUI and now names another TUI's store: the folder remembered at bind is the session's.
    const reused = async () => ['/h/.openclaw-other/state/openclaw.sqlite']
    expect(await openclawSessionDb('agent:main:plain', { pid: 9005, stateDir: '/h/.openclaw-work' }, reused))
      .toBe(join('/h/.openclaw-work', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    expect(await openclawSessionDb('agent:main:plain', { pid: 0 }, exited))
      .toBe(join(env.OPENCLAW_STATE_DIR, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    // The agent's database, and the folder openclaw.json moves it to.
    const state = mkdtempSync(join(tmpdir(), 'openclaw-state-'))
    dirs.push(state)
    const held = async () => [join(state, 'state', 'openclaw.sqlite')]
    expect(await openclawSessionDb('agent:main:plain', { pid: 9003 }, held)).toBe(join(state, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    writeFileSync(join(state, 'openclaw.json'), JSON.stringify({ agents: { entries: { work: { agentDir: '/moved/work' } } } }))
    expect(await openclawSessionDb('agent:work:x', { pid: 9003 }, held)).toBe('/moved/work/openclaw-agent.sqlite')
    expect(await openclawSessionDb('not-a-key', { pid: 9003 }, held)).toBeNull()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // OpenClaw takes its first task typed, not in argv: the bind pass that reads the pane hands it to the session input.
  // Found reproducing a lasting outage (2026-11-19): the TUI redraws `gateway disconnected: <error>` at each try to
  // reconnect and a bare `disconnected | idle` or `startup failed | idle` between, so the hold went and came back every
  // few seconds; and a drop it reconnected from by itself held the agent on the first pass.
  describe('its Gateway hold', () => {
    const START = Date.parse('2026-11-19T10:00:00Z')
    const NO_GATEWAY = OPENCLAW_STATES.noGateway
    /** The pane on `agent:main:plain`, its status line saying `line`. */
    const status = (line: string) => screen('screen-plain').replace(' connected | idle', ` ${line}`)
    const LOST = status('gateway disconnected: connect ECONNREFUSED 127.0.0.1:18789 | idle')
    let shown = ''
    let run: ReturnType<typeof setup>
    let row: RegisteredSession
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      run = setup({ capturePane: vi.fn(async () => shown) })
      row = pane({ sessionId: 'agent:main:plain' })
      run.byAgent.set('a1', row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    })
    /** What the agent says after each pass, for each `[second, screen]`: the pane shows that screen that many seconds in. */
    const passes = async (...reads: [number, string][]): Promise<(string | undefined)[]> => {
      const said: (string | undefined)[] = []
      for (const [second, at] of reads) {
        vi.setSystemTime(START + second * 1_000)
        shown = at
        await run.binding.bindObservedAgent(tui())
        said.push(row.identityHold)
      }
      return said
    }
    const logged = () => vi.mocked(console.log).mock.calls.flat().map(String)

    it('holds once the Gateway has been gone 10 s, and says so once', async () => {
      expect(await passes([0, LOST], [5, LOST], [10, LOST], [15, LOST])).toEqual([undefined, undefined, NO_GATEWAY, NO_GATEWAY])
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      expect(logged()).toEqual([`[discovery] a1 openclaw · ${NO_GATEWAY}`])
    })

    it('holds through the outage: the lines between its tries, a start and a run neither clear it nor count it again', async () => {
      expect(await passes(
        [0, LOST], [4, status('disconnected | idle')], [10, LOST],
        [12, status('disconnected | idle')], [14, status('startup failed | idle')], [16, status('connecting | idle')],
        [18, status('⠋ sending • 0s | connected')], [20, LOST],
      )).toEqual([undefined, undefined, NO_GATEWAY, NO_GATEWAY, NO_GATEWAY, NO_GATEWAY, NO_GATEWAY, NO_GATEWAY])
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      expect(logged()).not.toContain('[discovery] a1 openclaw · working again')
    })

    it.each([
      ['a connected line', status('connected | idle')],
      ['a connected line under a history that did not load', screen('screen-history-failed')],
    ])('%s clears it and forgets the outage: a drop 2 s later holds 10 s after it began', async (_, connected) => {
      expect(await passes([0, LOST], [10, LOST], [20, connected], [22, LOST], [31, LOST], [32, LOST]))
        .toEqual([undefined, NO_GATEWAY, undefined, undefined, undefined, NO_GATEWAY])
      expect(logged()).toContain('[discovery] a1 openclaw · working again')
    })

    it('a drop the TUI reconnects from within 10 s never holds', async () => {
      const back = status('gateway reconnected | idle')
      expect(await passes([0, LOST], [4, LOST], [5, back], [30, back])).toEqual([undefined, undefined, undefined, undefined])
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })

    // Found on a slow machine (2026-11-19): a cold Gateway answers `gateway starting` for over a minute, between bare
    // `disconnected` lines, and the agent was held throughout while the Gateway was running.
    it('a Gateway that answers it is starting clears it and starts the 10 s again', async () => {
      const starting = screen('screen-gateway-starting')
      expect(await passes([0, LOST], [10, LOST], [12, starting], [16, LOST], [25, LOST], [26, LOST]))
        .toEqual([undefined, NO_GATEWAY, undefined, undefined, undefined, NO_GATEWAY])
      expect(logged()).toContain('[discovery] a1 openclaw · working again')
    })

    it('a start up that reads disconnected neither holds nor clears it', async () => {
      const disconnected = screen('screen-starting-up-disconnected')
      expect(await passes([0, disconnected], [20, disconnected])).toEqual([undefined, undefined])
      expect(await passes([30, LOST], [40, LOST], [42, disconnected])).toEqual([undefined, NO_GATEWAY, NO_GATEWAY])
    })

    it('a reconnect between two drops starts the 10 s again', async () => {
      expect(await passes([0, LOST], [4, status('gateway reconnected | idle')], [6, LOST], [15, LOST], [16, LOST]))
        .toEqual([undefined, undefined, undefined, undefined, NO_GATEWAY])
    })

    it.each([
      ['a remote TUI', screen('screen-remote'), OPENCLAW_STATES.remote],
      ['no token', screen('screen-no-token'), OPENCLAW_STATES.noToken],
      ['a local stop', status('local runtime stopped: boom | idle').replace('ws://127.0.0.1:18789', 'local embedded'), "OpenClaw's local run stopped: boom"],
    ])('%s holds at its first read, as before', async (_, at, said) => {
      expect(await passes([0, at])).toEqual([said])
    })

    it('remembers 256 outages at most: one more starts them over, so a hold comes late, never early', async () => {
      await passes([0, LOST])
      for (let i = 0; i < 256; i++) {
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ agentId: `b${i}`, sessionId: 'agent:main:plain' }))
        await run.binding.bindObservedAgent(tui())
      }
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      expect(await passes([10, LOST], [19, LOST], [20, LOST])).toEqual([undefined, undefined, NO_GATEWAY])
    })
  })

  describe('its first task', () => {
    const TASK = 'Fix the parser'
    const ready = screen('screen-plain')
    const running = screen('screen-abort-running').replace(/abort/g, 'plain')
    /** The pane bound to `agent:main:plain` with its first task on the row, its stream attached. */
    const handing = (shown: () => string, over: Partial<BindDeps> = {}) => {
      const run = setup({ capturePane: vi.fn(async () => shown()), openclawPaneRead: vi.fn(() => true), ...over })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain', firstTask: TASK }))
      return run
    }

    it('a first task is handed over on the first pass that reads the pane ready', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalled())
      // The person's own message to the agent, where its confirmation arrives (core/turns/funnel.ts): no delivery id.
      expect(vi.mocked(run.deps.submitFirstTask).mock.calls).toEqual([['a1', TASK]])
      expect(run.deps.registry.afterTransaction).toHaveBeenCalledOnce()
      expect(run.deps.registry.takeFirstTask).toHaveBeenCalledWith('a1')
      expect(vi.mocked(run.deps.registry.takeFirstTask).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(run.deps.submitFirstTask).mock.invocationCallOrder[0])
      expect(console.log).toHaveBeenCalledWith('[agent] a1 first task handed over')
      // The task is the person's words: never in a log line.
      const said = [...vi.mocked(console.log).mock.calls, ...error.mock.calls].flat().map(String)
      expect(said.filter((line) => line.includes(TASK))).toEqual([])
    })

    // Found end to end (e2e/openclawShow.e2e.ts rows 3 and 6): between the row letting the task go and its paste, the
    // agent read idle with no ask. Expected by the input first, it reads starting from the one or the other throughout.
    it('the input expects the first task before its row lets it go', async () => {
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalled())
      expect(vi.mocked(run.deps.input.expectFirstTask).mock.calls).toEqual([['a1']])
      expect(vi.mocked(run.deps.input.expectFirstTask).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(run.deps.registry.takeFirstTask).mock.invocationCallOrder[0])
    })

    it('not while the pane reads no Gateway or a run, before a stream is attached, or unbound', async () => {
      const noGateway = screen('screen-no-gateway').replace(/session no-gateway/g, 'session plain')
      for (const [name, shown, over] of [
        ['no Gateway', noGateway, {}],
        ['a run', running, {}],
        ['no stream', ready, { openclawPaneRead: vi.fn(() => false) }],
      ] as const) {
        const run = handing(() => shown, over)
        await run.binding.bindObservedAgent(tui())
        expect(run.deps.capturePane, name).toHaveBeenCalled()
        // The pane shows the bound key: nothing else kept the task back.
        expect(run.deps.registry.register, name).not.toHaveBeenCalled()
        expect(run.deps.registry.takeFirstTask, name).not.toHaveBeenCalled()
      }
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ firstTask: TASK }))
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.register).toHaveBeenCalled()
      expect(run.deps.registry.takeFirstTask).not.toHaveBeenCalled()
    })

    it('ready, busy, ready hands it over once', async () => {
      let shown = ready
      const run = handing(() => shown)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValueOnce(TASK).mockResolvedValue(null)
      await run.binding.bindObservedAgent(tui())
      shown = running
      await run.binding.bindObservedAgent(tui())
      shown = ready
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(run.deps.registry.takeFirstTask).toHaveBeenCalledTimes(2))
      expect(run.deps.submitFirstTask).toHaveBeenCalledOnce()
    })

    it('a row whose task was handed over before a restart types nothing', async () => {
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain' }))
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.openclawPaneRead).toHaveBeenCalled()
      expect(run.deps.registry.afterTransaction).not.toHaveBeenCalled()
      expect(run.deps.submitFirstTask).not.toHaveBeenCalled()
    })

    it.each([[new Error('disk full'), 'Error'], ['disk full', 'string']])('a registry that cannot save keeps the task and types nothing', async (failure, kind) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.takeFirstTask).mockImplementation(() => { throw failure })
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith(`[agent] a1 first task kept · ${kind}`))
      expect(run.deps.submitFirstTask).not.toHaveBeenCalled()
    })

    // Taken off the row already, it is not put back (at most once), but its failure is named rather than left to the
    // daemon's last-resort unhandled-rejection line.
    it('a submit that throws is said', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = handing(() => ready, { submitFirstTask: vi.fn(() => { throw new Error('pane gone') }) })
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[agent] a1 first task not typed · Error'))
    })

    // The reconcile pass holds registry saves back until it commits (core/main.ts): a removal not yet saved is undone
    // by a daemon that stops, and the next one would type the task again.
    it('the removal waits for the reconcile pass to commit', async () => {
      let commit = () => {}
      const run = handing(() => ready)
      vi.mocked(run.deps.registry.afterTransaction).mockImplementation(((action: () => unknown) =>
        new Promise((resolve) => { commit = () => resolve(action()) })) as never)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.afterTransaction).toHaveBeenCalledOnce()
      expect(run.deps.registry.takeFirstTask).not.toHaveBeenCalled()
      expect(run.deps.submitFirstTask).not.toHaveBeenCalled()
      commit()
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
    })

    it('a pane that moved to another key binds it, and hands the task to that session once its stream is up', async () => {
      // `/new` before the task was typed: the pane shows a session the agent is not bound to yet.
      const other = ready.replace(/session plain/g, 'session other')
      const run = handing(() => other)
      vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: pane({ sessionId: 'agent:main:other', firstTask: TASK }), ...meta({ isNew: true }) } as never)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:other', source: 'openclaw-new' })
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
      // To the session the pane moved to, never the one the row had.
      expect(run.deps.openclawPaneRead).toHaveBeenLastCalledWith('agent:main:other', { ready: true, gatewayLost: false, running: false }, other)
      expect(run.deps.registry.takeFirstTask).toHaveBeenCalledOnce()
    })

    // Reproduction (2026-11-19): one pass cleared the hold, the next bound the session, the one after typed the task.
    describe('in the pass that can', () => {
      /** The stream of `agent:main:plain` comes up with the attach a pass starts. */
      const streaming = (over: Partial<RegisteredSession> = {}) => {
        let attached = false
        const run = handing(() => ready, {
          attachSession: vi.fn(async () => { attached = true; return true }),
          openclawPaneRead: vi.fn(() => attached),
        })
        const row = pane({ sessionId: 'agent:main:plain', firstTask: TASK, ...over })
        run.byAgent.set('a1', row)
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
        vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
        return { run, row }
      }

      it('the pass that binds the session hands the task over once its stream is up', async () => {
        const { run } = streaming({ sessionId: '' })
        run.byAgent.clear()
        vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: pane({ sessionId: 'agent:main:plain', firstTask: TASK }), ...meta({ isNew: true }) } as never)
        await run.binding.bindObservedAgent(tui())
        await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
        expect(run.deps.openclawPaneRead).toHaveBeenLastCalledWith('agent:main:plain', { ready: true, gatewayLost: false, running: false }, ready)
        expect(run.deps.capturePane).toHaveBeenCalledTimes(2)
      })

      it('the pass that clears a Gateway hold hands the task over once the stream it attaches is up', async () => {
        const { run, row } = streaming({ identityHold: OPENCLAW_STATES.noGateway })
        await run.binding.bindObservedAgent(tui())
        expect(row).not.toHaveProperty('identityHold')
        await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
        expect(run.deps.registry.takeFirstTask).toHaveBeenCalledOnce()
      })

      // The release changed the row, so a pass that then reads this TUI's folder for the first time ends there.
      it('a stream up already: the pass that clears the hold hands the task over all the same, once', async () => {
        const run = handing(() => ready)
        const row = pane({ sessionId: 'agent:main:plain', firstTask: TASK, identityHold: OPENCLAW_STATES.noGateway })
        run.byAgent.set('a1', row)
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
        // As the registry does: the task comes off the row once.
        vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValueOnce(TASK).mockResolvedValue(null)
        await run.binding.bindObservedAgent(tui())
        await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
        expect(run.deps.openclawStateDir).toHaveBeenCalledWith(7714)
        expect(run.deps.submitFirstTask).toHaveBeenCalledOnce()
      })

      it('a pane that cannot be read once the stream is up keeps the task for a later pass', async () => {
        const { run } = streaming({ identityHold: OPENCLAW_STATES.noGateway })
        vi.mocked(run.deps.capturePane).mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('pane gone'))
        await run.binding.bindObservedAgent(tui())
        await vi.waitFor(() => expect(run.deps.capturePane).toHaveBeenCalledTimes(2))
        await new Promise((settle) => setImmediate(settle))
        expect(run.deps.registry.afterTransaction).not.toHaveBeenCalled()
      })
    })

    // Found end to end: handed over under the session key, the task was typed and taken, but its turn is confirmed under
    // the agent (core/turns/funnel.ts), so Enter was pressed again at 10 s and 20 s and it was failed at 30 s.
    it('a first task handed over is confirmed when the turn starts for its agent', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const row = pane({ sessionId: 'agent:main:plain' })
      const rows = (id: string) => id === 'a1' || id === 'agent:main:plain' ? row : undefined
      const done: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
      const typed: string[] = [], keys: string[] = []
      const clients = { send: vi.fn(), sendCommander: vi.fn() }
      const inputs = createInput({
        readScreen: readInlineScreen,
        submission: inlineSubmission,
        resolve: rows,
        byAgent: rows,
        terminal: {
          captureTerminal: vi.fn(async () => ready),
          validateTerminal: vi.fn(async () => true),
          submitTerminalAction: vi.fn(async (_id: string, text: string) => { typed.push(text); return done }),
          keyTerminalAction: vi.fn(async (_id: string, key: string) => { keys.push(key); return done }),
          pinTerminalControl: vi.fn(() => () => {}),
        },
        deliveries: { settled: vi.fn(), canWrite: vi.fn(() => true) },
        device: () => undefined,
        clients,
        agentIdFor: (sessionId) => rows(sessionId)?.agentId ?? sessionId,
        openTurn: async () => [],
        emit: vi.fn(),
      })
      const run = handing(() => ready, { input: inputs.input, submitFirstTask: inputs.submitFirstTask })
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      await run.binding.bindObservedAgent(tui())
      await vi.advanceTimersByTimeAsync(1_000)
      expect(typed).toEqual([TASK])
      // OpenClaw's store shows the turn: the funnel confirms it under the agent its session is bound to.
      inputs.input.onTurnStarted('a1', TASK)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(keys).toEqual([])
      expect(clients.send).not.toHaveBeenCalled()
      inputs.input.forget('a1')
      vi.useRealTimers()
    })
  })

  // OpenClaw draws a ready status line over a history that did not load, and refuses every message until a load
  // succeeds; `/session <key>` loads it again (reproduction: history timed out on a loaded Gateway, the task was lost).
  describe('its history not loaded', () => {
    const START = Date.parse('2026-11-19T10:00:00Z')
    const TASK = 'Fix the parser'
    const failed = screen('screen-history-failed')
    const SESSION = ['a1', '/session agent:main:plain']
    let run: ReturnType<typeof setup>
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      run = setup({ capturePane: vi.fn(async () => failed), openclawPaneRead: vi.fn(() => true) })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain', firstTask: TASK }))
    })
    /** A pass `second`s in, the pane showing `shown`. */
    const pass = async (second: number, shown = failed) => {
      vi.setSystemTime(START + second * 1_000)
      vi.mocked(run.deps.capturePane).mockResolvedValue(shown)
      await run.binding.bindObservedAgent(tui())
    }
    const typed = () => vi.mocked(run.deps.input.typeCommand).mock.calls
    const logged = () => vi.mocked(console.log).mock.calls.flat().map(String)
    const tries = (...counts: number[]) => counts.map((n) => `[discovery] a1 openclaw · history not loaded · /session ${n}/5`)

    it('types /session into its empty box, at most once every 20 s and 5 times, and hands no task over', async () => {
      for (const second of [0, 5, 19, 20, 40, 60, 80, 100, 120]) await pass(second)
      expect(typed()).toEqual([SESSION, SESSION, SESSION, SESSION, SESSION])
      // The key is the person's conversation: never in a log line.
      expect(logged()).toEqual(tries(1, 2, 3, 4, 5))
      expect(run.deps.registry.afterTransaction).not.toHaveBeenCalled()
      expect(run.deps.submitFirstTask).not.toHaveBeenCalled()
    })

    it('a pass that reads anything else starts the count again', async () => {
      for (const second of [0, 20, 40, 60, 80]) await pass(second)
      await pass(85, screen('screen-plain'))
      await pass(86)
      expect(typed()).toHaveLength(6)
      expect(logged().at(-1)).toBe(tries(1)[0])
    })

    it('types nothing into a box that holds text: the person\'s, or a message OpenClaw refused', async () => {
      for (const second of [0, 20, 40]) await pass(second, screen('screen-history-refused'))
      expect(typed()).toEqual([])
      await pass(41)
      expect(typed()).toEqual([SESSION])
    })

    it('loads the session the footer shows, and types nothing when the screen names none', async () => {
      // The person moved the pane with /new: the row still names the session it had.
      await pass(0, failed.replace(/session plain/g, 'session other'))
      // A title that names another session than the footer: the screen names none.
      await pass(20, failed.replace('session plain', 'session other'))
      expect(typed()).toEqual([['a1', '/session agent:main:other']])
    })

    it('a /session the pane is not free for is tried on the next pass, and counted once typed', async () => {
      vi.mocked(run.deps.input.typeCommand).mockResolvedValueOnce(false)
      await pass(0)
      expect(logged()).toEqual([])
      for (const second of [5, 20, 25]) await pass(second)
      expect(typed()).toHaveLength(3)
      expect(logged()).toEqual(tries(1, 2))
    })

    it('remembers 256 panes at most: one more starts them over', async () => {
      await pass(0)
      for (let i = 0; i < 256; i++) {
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ agentId: `b${i}`, sessionId: 'agent:main:plain' }))
        await run.binding.bindObservedAgent(tui())
      }
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain', firstTask: TASK }))
      await pass(5)
      expect(typed().filter(([id]) => id === 'a1')).toHaveLength(2)
    })
  })

  // The task waits for a TUI that can send it, but not for ever: 3 minutes from its TUI's start that it was not held.
  describe('its first task\'s bound', () => {
    const START = Date.parse('2026-11-19T10:00:00Z')
    const TASK = 'Fix the parser'
    const FAILED = { state: 'failed', error: 'FIRST_TASK_NOT_TAKEN', detail: 'OpenClaw did not take the first task. Close it and start it again.' }
    const starting = screen('screen-starting-up')
    const ready = screen('screen-plain')
    const LOST = ready.replace(' connected | idle', ' gateway disconnected: connect ECONNREFUSED 127.0.0.1:18789 | idle')
    let run: ReturnType<typeof setup>
    let row: RegisteredSession
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      run = setup({ capturePane: vi.fn(async () => starting) })
      row = pane({ sessionId: 'agent:main:plain', firstTask: TASK, registeredAt: START })
      run.byAgent.set('a1', row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    })
    /** A pass `second`s after START, the pane showing `shown`, its TUI started at `tuiAt`: whether the launch failed. */
    const pass = async (second: number, shown = starting, tuiAt = START): Promise<boolean> => {
      vi.setSystemTime(START + second * 1_000)
      vi.mocked(run.deps.capturePane).mockResolvedValue(shown)
      await run.binding.bindObservedAgent(tui({ processIdentity: { pid: 7714, startMarker: new Date(tuiAt).toISOString(), executable: 'openclaw' } }))
      return row.launch?.state === 'failed'
    }
    const logged = () => vi.mocked(console.log).mock.calls.flat().map(String)

    it('a task still on the row 3 minutes after its TUI started fails the launch, comes off the row, and is never typed', async () => {
      vi.mocked(run.deps.openclawPaneRead).mockReturnValue(true)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      expect(await pass(0)).toBe(false)
      expect(await pass(179)).toBe(false)
      vi.mocked(run.deps.capturePane).mockClear()
      // A pane that would take it now is not read: nothing is typed after the bound.
      expect(await pass(180, ready)).toBe(true)
      expect(row.launch).toEqual(FAILED)
      expect(run.deps.registry.setLaunch).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(run.deps.registry.takeFirstTask).toHaveBeenCalledWith('a1'))
      expect(run.deps.registry.afterTransaction).toHaveBeenCalledOnce()
      expect(run.deps.input.forget).toHaveBeenCalledWith('a1')
      expect(run.deps.announceSession).toHaveBeenCalledWith(row)
      expect(logged()).toEqual(['[agent] a1 first task not taken · FIRST_TASK_NOT_TAKEN'])
      expect(run.deps.capturePane).not.toHaveBeenCalled()
      expect(run.deps.submitFirstTask).not.toHaveBeenCalled()
    })

    it('a task typed and not confirmed by the bound is let go, and the launch fails the same', async () => {
      delete row.firstTask
      vi.mocked(run.deps.input.firstTaskWaiting).mockReturnValue(true)
      expect(await pass(0)).toBe(false)
      expect(run.deps.input.firstTaskWaiting).toHaveBeenCalledWith('a1')
      expect(await pass(180)).toBe(true)
      expect(run.deps.input.forget).toHaveBeenCalledWith('a1')
      expect(row.launch).toEqual(FAILED)
    })

    it('a task confirmed is never failed', async () => {
      delete row.firstTask
      vi.mocked(run.deps.input.firstTaskWaiting).mockReturnValue(true)
      await pass(0)
      // Its user row came: neither on the row nor awaited.
      vi.mocked(run.deps.input.firstTaskWaiting).mockReturnValue(false)
      expect(await pass(60)).toBe(false)
      expect(await pass(3_600)).toBe(false)
      expect(run.deps.registry.setLaunch).not.toHaveBeenCalled()
    })

    // A resume keeps the row's `registeredAt`, so the row's own time would fail a resumed task at once.
    it('a resumed row counts from its TUI\'s start, not from when it was registered or first seen', async () => {
      row.registeredAt = START - 3_600_000
      // Seen waiting under a TUI stopped before its bound, then resumed in a new one 10 minutes later.
      expect(await pass(0)).toBe(false)
      expect(await pass(605, starting, START + 600_000)).toBe(false)
      expect(await pass(779, starting, START + 600_000)).toBe(false)
      expect(await pass(780, starting, START + 600_000)).toBe(true)
    })

    it('a TUI start that cannot be read counts from the row\'s registration or the first pass', async () => {
      const unread = tui({ processIdentity: { pid: 7714, startMarker: 'unknown', executable: 'openclaw' } })
      vi.setSystemTime(START + 60_000)
      await run.binding.bindObservedAgent(unread)
      vi.setSystemTime(START + 239_000)
      await run.binding.bindObservedAgent(unread)
      expect(row.launch).toBeUndefined()
      vi.setSystemTime(START + 240_000)
      await run.binding.bindObservedAgent(unread)
      expect(row.launch).toEqual(FAILED)
    })

    it('a daemon restarted over a TUI that started 10 minutes ago counts from its own first pass', async () => {
      expect(await pass(600)).toBe(false)
      expect(await pass(779)).toBe(false)
      expect(await pass(780)).toBe(true)
    })

    it('held through 5 minutes it is never failed, and the pass that clears the hold types the task', async () => {
      let attached = false
      vi.mocked(run.deps.attachSession).mockImplementation(async () => { attached = true; return true })
      vi.mocked(run.deps.openclawPaneRead).mockImplementation(() => attached)
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue(TASK)
      expect(await pass(0, LOST)).toBe(false)
      expect(await pass(10, LOST)).toBe(false)
      expect(row.identityHold).toBe(OPENCLAW_STATES.noGateway)
      for (let second = 15; second < 310; second += 30) expect(await pass(second, LOST)).toBe(false)
      expect(await pass(310, ready)).toBe(false)
      expect(row).not.toHaveProperty('identityHold')
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalledWith('a1', TASK))
      expect(run.deps.registry.setLaunch).not.toHaveBeenCalled()
    })

    it('held 2 minutes in the middle, the bound comes 2 minutes later', async () => {
      expect(await pass(0)).toBe(false)
      await pass(60, LOST)
      // Held from here: the Gateway gone 10 s.
      await pass(70, LOST)
      await pass(75, LOST)
      await pass(190, ready)
      expect(row).not.toHaveProperty('identityHold')
      await pass(195)
      // 4 min 59 s since the start, 2 min 59 s of it not held.
      expect(await pass(299)).toBe(false)
      expect(await pass(301)).toBe(true)
    })

    it('a held row is never failed, however long; let go, it has what is left of its 3 minutes', async () => {
      await pass(0, LOST)
      await pass(10, LOST)
      for (const second of [15, 3_600, 7_200]) expect(await pass(second, LOST)).toBe(false)
      await pass(7_205, ready)
      expect(await pass(7_210)).toBe(false)
      expect(await pass(7_374)).toBe(false)
      expect(await pass(7_375)).toBe(true)
    })

    it('remembers 256 waits at most: one more starts them over, so a launch fails late, never early', async () => {
      await pass(0)
      for (let i = 0; i < 256; i++) {
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ agentId: `b${i}`, sessionId: 'agent:main:plain', firstTask: TASK, registeredAt: START }))
        await run.binding.bindObservedAgent(tui())
      }
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      expect(await pass(180)).toBe(false)
      expect(await pass(359)).toBe(false)
      expect(await pass(360)).toBe(true)
    })
  })

  // A restart resumes the same key, so the pass never binds it again: the TUI process, not the key, says when the
  // folder its agent's store is read from may have changed.
  describe('its state folder', () => {
    /** A pane bound to `agent:main:plain`, showing it ready, whose TUI holds `folder`. */
    const bound = (folder: string | null, row: Partial<RegisteredSession> = {}) => {
      const run = setup({ capturePane: vi.fn(async () => screen('screen-plain')), openclawPaneRead: vi.fn(() => true), openclawStateDir: vi.fn(async () => folder) })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain', ...row }))
      return run
    }

    it('a relaunched TUI that holds another state folder: the row takes it and the session is read again', async () => {
      const run = bound('/new', { firstTask: 'Fix the parser', openclawStateDir: '/h/.openclaw' })
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.openclawStateDir).toHaveBeenCalledWith(7714)
      expect(run.deps.registry.setOpenclawStateDir).toHaveBeenCalledWith('a1', '/new')
      expect(vi.mocked(run.deps.forgetSession).mock.calls).toEqual([['agent:main:plain', { force: true, keepAgent: true, agentId: 'a1' }]])
      expect(console.log).toHaveBeenCalledWith('[discovery] a1 openclaw · state folder changed')
      // The task waits for the session read from the new folder: the next pass binds it again, then hands it over.
      expect(run.deps.registry.afterTransaction).not.toHaveBeenCalled()
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    // A row with no folder saved (its TUI's open files could not be read at bind) had its stream find the store from
    // those same open files at attach (lib/openclawStore.ts). Let go and bound again after a daemon restart, it dropped
    // a message awaiting confirmation and started a run in progress over, to read the store it already read.
    it('the first read of a TUI whose row kept no folder records it, and the session stays', async () => {
      const run = bound('/h/.openclaw')
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.setOpenclawStateDir).toHaveBeenCalledWith('a1', '/h/.openclaw')
      expect(run.deps.forgetSession).not.toHaveBeenCalled()
      // Relaunched since, its stream's store is the one the TUI before it named: the new folder is read again.
      vi.mocked(run.deps.openclawStateDir).mockResolvedValue('/new')
      await run.binding.bindObservedAgent(tui({ processIdentity: { pid: 7715, startMarker: '2026-11-10T09:00:00Z', executable: 'openclaw' } }))
      expect(vi.mocked(run.deps.forgetSession).mock.calls).toEqual([['agent:main:plain', { force: true, keepAgent: true, agentId: 'a1' }]])
    })

    it('the folder is read once per TUI process', async () => {
      const run = bound('/h/.openclaw')
      vi.mocked(run.deps.registry.setOpenclawStateDir).mockReturnValue(false)
      await run.binding.bindObservedAgent(tui())
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.openclawStateDir).toHaveBeenCalledOnce()
      const relaunched = tui({ processIdentity: { pid: 7714, startMarker: '2026-11-10T09:00:00Z', executable: 'openclaw' } })
      await run.binding.bindObservedAgent(relaunched)
      expect(run.deps.openclawStateDir).toHaveBeenCalledTimes(2)
      // What it remembers is bounded: the 256th agent starts it over, at the cost of one more read for each.
      for (let i = 0; i < 256; i++) {
        vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ agentId: `b${i}`, sessionId: 'agent:main:plain' }))
        await run.binding.bindObservedAgent(tui())
      }
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:plain' }))
      await run.binding.bindObservedAgent(relaunched)
      expect(run.deps.openclawStateDir).toHaveBeenCalledTimes(2 + 256 + 1)
      expect(run.deps.forgetSession).not.toHaveBeenCalled()
    })

    it('the same folder, or open files that cannot be read, change nothing', async () => {
      const same = bound('/h/.openclaw')
      vi.mocked(same.deps.registry.setOpenclawStateDir).mockReturnValue(false)
      await same.binding.bindObservedAgent(tui())
      expect(same.deps.registry.setOpenclawStateDir).toHaveBeenCalledWith('a1', '/h/.openclaw')
      expect(same.deps.forgetSession).not.toHaveBeenCalled()
      const unreadable = bound(null)
      await unreadable.binding.bindObservedAgent(tui())
      expect(unreadable.deps.openclawStateDir).toHaveBeenCalledWith(7714)
      expect(unreadable.deps.registry.setOpenclawStateDir).not.toHaveBeenCalled()
      expect(unreadable.deps.forgetSession).not.toHaveBeenCalled()
      // A stop or restart that took the agent while its open files were read owns it: the read changes nothing.
      const stopped = bound(null)
      vi.mocked(stopped.deps.openclawStateDir).mockImplementation(async () => {
        stopped.binding.whileChanging((agentId) => agentId === 'a1')
        return '/new'
      })
      await stopped.binding.bindObservedAgent(tui())
      expect(stopped.deps.registry.setOpenclawStateDir).not.toHaveBeenCalled()
      expect(stopped.deps.forgetSession).not.toHaveBeenCalled()
    })
  })

  // `openclaw tui --local`: its runtime in the TUI, on the folder Harness was given, with no Gateway and no URL.
  describe('a local run', () => {
    const FOLDER = '/run/skill-1'
    const local = (status: string) => screen('screen-plain')
      .replace('openclaw tui - ws://127.0.0.1:18789 - ', 'openclaw tui - local embedded - ').replace(' connected | idle', ` ${status}`)
    /** A local row bound to `agent:main:plain`, its pane showing `shown()`. */
    const running = (shown: () => string, row: Partial<RegisteredSession> = {}) => {
      const run = setup({ capturePane: vi.fn(async () => shown()), openclawPaneRead: vi.fn(() => true), openclawStateDir: vi.fn(async () => '/h/.openclaw') })
      const entry = pane({ sessionId: 'agent:main:plain', openclawLocal: FOLDER, openclawStateDir: FOLDER, active: true, ...row } as Partial<RegisteredSession>)
      run.byAgent.set('a1', entry)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(entry)
      return run
    }
    const logged = () => vi.mocked(console.log).mock.calls.flat().map(String)

    it('a local run\'s first task is typed once its pane reads local ready', async () => {
      const run = running(() => local('local ready | idle'), { firstTask: 'Fix the parser' })
      vi.mocked(run.deps.registry.takeFirstTask).mockResolvedValue('Fix the parser')
      await run.binding.bindObservedAgent(tui())
      await vi.waitFor(() => expect(run.deps.submitFirstTask).toHaveBeenCalled())
      expect(vi.mocked(run.deps.submitFirstTask).mock.calls).toEqual([['a1', 'Fix the parser']])
    })

    it('a local run that stopped says so with its reason, keeps it under the later footer, and logs no reason', async () => {
      let shown = local('local runtime stopped: boom | idle')
      const run = running(() => shown)
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.byAgent('a1')!.identityHold).toBe("OpenClaw's local run stopped: boom")
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      shown = local('local stopped | idle')
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.byAgent('a1')!.identityHold).toBe("OpenClaw's local run stopped: boom")
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      expect(logged()).toEqual(["[discovery] a1 openclaw · OpenClaw's local run stopped"])
      // Held, not closed: the caller or the person closes it.
      expect(run.deps.registry.byAgent('a1')).toMatchObject({ active: true })
      expect(run.deps.forgetSession).not.toHaveBeenCalled()
    })

    it('a stopped local run first seen under its later footer says it stopped, with no reason', async () => {
      const run = running(() => local('local stopped | idle'))
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.byAgent('a1')!.identityHold).toBe("OpenClaw's local run stopped.")
      // A Gateway hold the pane said before is the pass's own: the stop replaces it.
      const held = running(() => local('local stopped | idle'), { identityHold: OPENCLAW_STATES.noGateway })
      await held.binding.bindObservedAgent(tui())
      expect(held.deps.registry.byAgent('a1')!.identityHold).toBe("OpenClaw's local run stopped.")
    })

    it('the hold goes when the pane reads local ready again', async () => {
      let shown = local('local runtime stopped | idle')
      const run = running(() => shown)
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.byAgent('a1')!.identityHold).toBe("OpenClaw's local run stopped.")
      shown = local('local ready | idle')
      await run.binding.bindObservedAgent(tui())
      expect(run.deps.registry.byAgent('a1')).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(console.log).toHaveBeenCalledWith('[discovery] a1 openclaw · working again')
    })

    it('the Gateway states never hold a local row', async () => {
      for (const name of ['screen-no-gateway', 'screen-no-token', 'screen-remote']) {
        const run = running(() => screen(name))
        await run.binding.bindObservedAgent(tui())
        expect(run.deps.registry.byAgent('a1'), name).not.toHaveProperty('identityHold')
        expect(run.deps.announceSession, name).not.toHaveBeenCalled()
      }
    })

    it('a local row\'s folder is never read off its TUI nor replaced', async () => {
      let shown = local('local ready | idle')
      const run = running(() => shown, { sessionId: '' })
      const bound = pane({ sessionId: 'agent:main:plain', openclawLocal: FOLDER, openclawStateDir: FOLDER } as Partial<RegisteredSession>)
      vi.mocked(run.deps.registry.register).mockResolvedValue({ entry: bound, ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(tui())
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:plain', source: 'openclaw-footer' })
      // A pass under a new TUI process, the row bound.
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(bound)
      shown = local('local ready | idle')
      await run.binding.bindObservedAgent(tui({ processIdentity: { pid: 7715, startMarker: '2026-11-10T09:00:00Z', executable: 'openclaw' } }))
      expect(run.deps.openclawStateDir).not.toHaveBeenCalled()
      expect(run.deps.registry.setOpenclawStateDir).not.toHaveBeenCalled()
      expect(run.deps.forgetSession).not.toHaveBeenCalled()
      expect(bound.openclawStateDir).toBe(FOLDER)
    })
  })
})
