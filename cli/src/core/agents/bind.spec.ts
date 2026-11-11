import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transcriptOf, processSessionOf } from '../../engines/identities.js'
import { loadEngine } from '../../engines/inProcess.js'
import { continuationOf } from '../../engines/sessionFiles.js'
import { env } from '../../config/env.js'
import { isRecentlyDeleted } from '../../lib/deletedSessions.js'
import { openclawSessionDb, openclawStateDir } from '../../lib/openclawStore.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { findLiveSession, findResumedTranscript } from '../../lib/sessionRepair.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { TerminalAgentReconciler } from '../../lib/terminalAgentReconciler.js'
import { createBinding, statBirthMs, type BindDeps, type RegisteredMeta } from './bind.js'

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
  const deps: BindDeps = {
    registry: {
      inheritName: vi.fn(),
      unbindSession: vi.fn(() => true),
      byAgent: vi.fn((agentId: string) => byAgent.get(agentId) ?? vi.mocked(deps.registry.register).mock.results.at(-1)?.value?.entry),
      byProcess: vi.fn(() => undefined),
      register: vi.fn(() => null),
      setIdentityHold: vi.fn((id: string, reason?: string) => {
        const row = byAgent.get(id) ?? vi.mocked(deps.registry.byProcess).mock.results.at(-1)?.value
        if (!row || row.identityHold === reason) return false
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
    } as unknown as BindDeps['registry'],
    mirror: { inheritSummary: vi.fn() },
    forgetSession: vi.fn(),
    clients: { send: vi.fn() },
    attachSession: vi.fn(async () => true),
    announceSession: vi.fn(),
    stoppedAgents: { save: vi.fn(), finishResume: vi.fn(), get: vi.fn(() => null) },
    syncRecapPool: vi.fn(),
    input: { forget: vi.fn() },
    deviceInput: { forget: vi.fn() },
    homes: { copilot: '/copilot', grok: '/grok', agy: '/agy' },
    capturePane: vi.fn(async () => null),
    openclawPaneRead: vi.fn(),
    openclawPaneDue: vi.fn(() => true),
    openclawStateDir: vi.fn(async () => null),
    ...over,
  }
  return { deps, byAgent, bySession, binding: createBinding(deps) }
}

function registered(run: ReturnType<typeof setup>, entry: RegisteredSession, meta: RegisteredMeta): Promise<void> {
  run.byAgent.set(entry.agentId, entry)
  return run.binding.handleRegistered(entry, meta)
}

describe('binding a registered session to its agent', () => {
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
    expect(warn).toHaveBeenCalledWith('[agent] a1 could not settle who owns s1: stopped store unreadable')
    expect(warn).toHaveBeenCalledWith('[agent] a1 could not settle who owns s1: plain')
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
    expect(error).toHaveBeenCalledWith('[agent] a1 could not save the record it resumes from: ENOSPC: no space left on device')
    expect(run.deps.stoppedAgents.finishResume).toHaveBeenCalledWith('a1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session_synced' }))
    vi.mocked(run.deps.stoppedAgents.save).mockImplementationOnce(() => { throw 'disk gone' })
    await registered(run, entry, meta({ isNew: true }))
    expect(error).toHaveBeenLastCalledWith('[agent] a1 could not save the record it resumes from: disk gone')
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
    expect(run.deps.registry.unbindSession).not.toHaveBeenCalled()
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
    expect(run.deps.registry.unbindSession).toHaveBeenCalledWith('s1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.syncRecapPool).toHaveBeenCalled()
  })

  it('keeps the verified conversation when a native exit beats its pending startup attach', async () => {
    let finish!: (attached: boolean) => void
    const run = setup({ attachSession: vi.fn(() => new Promise<boolean>(resolve => { finish = resolve })) })
    const entry = agent({ processIdentity: { pid: 42, startMarker: '2026-10-06T10:00:00Z', executable: 'claude' } })
    const pending = registered(run, entry, meta({ isNew: true, hookEvent: 'SessionStart' }))
    await vi.waitFor(() => expect(run.deps.attachSession).toHaveBeenCalled())
    finish(false)
    await pending
    expect(run.deps.registry.unbindSession).not.toHaveBeenCalled()
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
    expect(run.deps.registry.unbindSession).not.toHaveBeenCalled()
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    // An agent nothing owns is unbound as before.
    await registered(run, agent({ agentId: 'a2', sessionId: 's2' }), meta())
    expect(run.deps.registry.unbindSession).toHaveBeenCalledWith('s2')
  })

  it('hands a rebound agent its name and recap, and lets the stale session go', async () => {
    const run = setup()
    await registered(run, agent({ sessionId: 's2' }), meta({ rebound: 's1' }))
    expect(run.deps.registry.inheritName).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.mirror.inheritSummary).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.forgetSession).toHaveBeenCalledWith('s1', { force: true, keepAgent: true })
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    let done = false
    void run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' })).then(() => { done = true })
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 1000 })
    expect(run.deps.registry.register).toHaveBeenCalledOnce()
    expect(run.deps.attachSession).toHaveBeenCalledOnce()
  })

  it.each([new Error('saved header is incomplete'), 'saved header is incomplete'])(
    'keeps a saved binding visibly held until its own evidence recovers: %s', async error => {
      const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'previous hold' })
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      vi.mocked(run.deps.registry.revalidateBinding).mockImplementationOnce(() => { throw error })
        .mockImplementationOnce(() => { throw error })
      await run.binding.bindObservedAgent(observed())
      await run.binding.bindObservedAgent(observed())
      expect(row).toMatchObject({ sessionId: 's1', transcriptPath: '/t/s1.jsonl', identityHold: 'saved header is incomplete' })
      expect(run.deps.announceSession).toHaveBeenCalledOnce()
      expect(continuationOf).not.toHaveBeenCalled()
      expect(run.deps.registry.unbindSession).not.toHaveBeenCalled()
      expect(run.deps.stoppedAgents.save).not.toHaveBeenCalled()
      await run.binding.bindObservedAgent(observed())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(continuationOf).toHaveBeenCalledOnce()
    })

  it('does not follow a saved binding removed while its retry commits', async () => {
    const run = setup(), row = agent({ transcriptPath: '/t/s1.jsonl', identityHold: 'unavailable' })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(run.deps.registry.revalidateBinding).mockReturnValue(null)
    await run.binding.bindObservedAgent(observed())
    expect(run.deps.announceSession).not.toHaveBeenCalled()
    expect(continuationOf).not.toHaveBeenCalled()
  })

  it.each(['repaired', 'same', 'absent'] as const)('updates transcript attachment after a held binding is conclusively %s', async outcome => {
    const run = setup(), row = agent({ transcriptPath: '/t/child.jsonl', identityHold: 'unavailable' })
    run.byAgent.set(row.agentId, row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    vi.mocked(run.deps.registry.revalidateBinding).mockImplementation(() => {
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    expect(run.deps.attachSession).toHaveBeenCalledOnce()
  })

  it.each([new Error('identity read limit'), 'identity read limit'])('holds only the unreadable native identity and finishes the discovery/readiness pass: %s', async error => {
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
      expect(console.log).toHaveBeenCalledWith('[discovery] held binding held · identity read limit')
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
        expect(console.log).toHaveBeenCalledWith('[discovery] held binding held · native evidence unavailable')
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

  it.each([new Error('reader unavailable'), 'reader unavailable'])('contains an optional attachment failure after binding', async error => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = setup({ attachSession: vi.fn(async () => { throw error }) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '' }))
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent(), ...meta({ isNew: true }) } as never)
    await run.binding.bindObservedAgent(observed({ resumeSessionId: 'resumed' }))
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[agent] a1 transcript attachment is unavailable: reader unavailable'))
    expect(run.deps.registry.register).toHaveBeenCalledOnce()
    expect(run.deps.registry.unbindSession).not.toHaveBeenCalled()
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
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('process conversation changed during transcript lookup'))
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
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: rotated, ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(processSessionOf).toHaveBeenLastCalledWith('copilot', '/copilot', 42)
      expect(transcriptOf).toHaveBeenLastCalledWith('copilot', '/copilot', 's2')
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 's2', transcriptPath: '/t/copilot.jsonl', source: 'copilot-resume' })
      expect(run.deps.attachSession).toHaveBeenCalledWith(rotated, true, false, false)
      // Not new to the registry, or no transcript yet: registered as it is, attached by its hook later.
      vi.mocked(transcriptOf).mockResolvedValueOnce(null)
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: rotated, ...meta() } as never)
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
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: agent({ sessionId: 's2' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed())
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ engine: 'claude', sessionId: 's2', source: 'claude-continuation', hookEvent: 'ClaudeContinuation' })
      expect(continuationOf).toHaveBeenCalledWith('claude', '/t/s1.jsonl')
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
      vi.mocked(run.deps.registry.register).mockReturnValueOnce(null)
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
      vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent({ sessionId: 'r' }), ...meta({ isNew: true }) } as never)
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
      vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent({ sessionId: 'found' }), ...meta({ isNew: true }) } as never)
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
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: agent({ sessionId: 'same' }), ...meta() } as never)
      await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
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

  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  it('binds an openclaw pane to main from its footer, and remembers the state folder its TUI holds', async () => {
    const run = setup({ capturePane: vi.fn(async () => screen('screen-two-panes-main-a')), openclawStateDir: vi.fn(async () => '/h/.openclaw-work') })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane())
    const bound = pane({ sessionId: 'agent:main:main' })
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: bound, ...meta({ isNew: true }) } as never)
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: pane({ sessionId: 'agent:main:plain' }), ...meta({ isNew: true }) } as never)
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: moved, ...meta({ isNew: true, rebound: 'agent:main:reset' }) } as never)
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: pane({ sessionId: 'agent:main:main' }), ...meta({ isNew: true }) } as never)
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
    vi.mocked(run.deps.registry.register).mockReturnValue({ entry: pane({ sessionId: 'agent:main:other' }), ...meta({ isNew: true }) } as never)
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
      await run.binding.bindObservedAgent(tui())
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

  it.each([new Error('reader unavailable'), 'reader unavailable'])('a stream that cannot attach once the state clears is logged, and the state still goes', async (error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let shown = screen('screen-no-gateway-attached')
    const run = setup({ capturePane: vi.fn(async () => shown), attachSession: vi.fn(async () => { throw error }) })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    shown = screen('screen-no-gateway-reconnected')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[agent] a1 transcript attachment is unavailable: reader unavailable'))
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
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    shown = screen('screen-no-gateway-reconnected')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    expect(run.deps.attachSession).not.toHaveBeenCalled()
    expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 'agent:main:plain', source: 'openclaw-footer' })
  })

  it('an overlay that hides the footer keeps the no-Gateway state until a footer shows again', async () => {
    // Autocomplete draws its list under the composer, so the footer is not the last thing on screen for a pass.
    const noGateway = screen('screen-no-gateway-attached')
    let shown = noGateway
    const run = setup({ capturePane: vi.fn(async () => shown) })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
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

  it('tells the bound session\'s stream on each pass whether its pane reads idle and whether the Gateway dropped', async () => {
    let shown = screen('screen-abort-running')
    const run = setup({ capturePane: vi.fn(async () => shown) })
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(pane({ sessionId: 'agent:main:abort' }))
    await run.binding.bindObservedAgent(tui())
    shown = screen('screen-abort')
    await run.binding.bindObservedAgent(tui())
    // A pass that reads no Gateway is told too, while its state is said on the agent.
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
})
