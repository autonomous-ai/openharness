import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findAgyTranscript } from '../../engines/agy/session.js'
import { copilotSessionForPid, findCopilotTranscript } from '../../engines/copilot/session.js'
import { findCursorTranscript } from '../../engines/cursor/discovery.js'
import { findGrokTranscript } from '../../engines/grok/session.js'
import { isRecentlyDeleted } from '../../lib/deletedSessions.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { claudeContinuation, findLiveSession, findResumedTranscript } from '../../lib/sessionRepair.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { createBinding, statBirthMs, type BindDeps, type RegisteredMeta } from './bind.js'

vi.mock('../../engines/agy/session.js', () => ({ findAgyTranscript: vi.fn(async () => '/t/agy.jsonl') }))
vi.mock('../../engines/copilot/session.js', () => ({ copilotSessionForPid: vi.fn(async () => null), findCopilotTranscript: vi.fn(async () => '/t/copilot.jsonl') }))
vi.mock('../../engines/cursor/discovery.js', async (real) => ({ ...await real<object>(), findCursorTranscript: vi.fn(async () => '/t/cursor.jsonl') }))
vi.mock('../../engines/cursor/home.js', async (real) => ({ ...await real<object>(), cursorDataDir: () => '/cursor' }))
vi.mock('../../engines/grok/session.js', () => ({ findGrokTranscript: vi.fn(async () => '/t/grok.jsonl') }))
vi.mock('../../lib/deletedSessions.js', () => ({ isRecentlyDeleted: vi.fn(() => false) }))
vi.mock('../../lib/sessionRepair.js', () => ({
  claudeContinuation: vi.fn(async () => null),
  findLiveSession: vi.fn(async () => null),
  findResumedTranscript: vi.fn(async () => '/t/resumed.jsonl'),
}))

const dirs: string[] = []

/** Every engine lookup back to its default answer, calls forgotten, before each test. */
function resetLookups() {
  vi.mocked(findAgyTranscript).mockReset().mockResolvedValue('/t/agy.jsonl')
  vi.mocked(copilotSessionForPid).mockReset().mockResolvedValue(null)
  vi.mocked(findCopilotTranscript).mockReset().mockResolvedValue('/t/copilot.jsonl')
  vi.mocked(findCursorTranscript).mockReset().mockResolvedValue('/t/cursor.jsonl')
  vi.mocked(findGrokTranscript).mockReset().mockResolvedValue('/t/grok.jsonl')
  vi.mocked(isRecentlyDeleted).mockReset().mockReturnValue(false)
  vi.mocked(claudeContinuation).mockReset().mockResolvedValue(null)
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
      byAgent: vi.fn((agentId: string) => byAgent.get(agentId)),
      byProcess: vi.fn(() => undefined),
      register: vi.fn(() => null),
      has: vi.fn(() => false),
      bySession: vi.fn((sessionId: string) => bySession.get(sessionId)),
    } as unknown as BindDeps['registry'],
    mirror: { inheritSummary: vi.fn() },
    forgetSession: vi.fn(),
    clients: { send: vi.fn() },
    attachSession: vi.fn(async () => true),
    announceSession: vi.fn(),
    stoppedAgents: { save: vi.fn(), finishResume: vi.fn(), get: vi.fn(() => null) },
    syncRecapPool: vi.fn(),
    teams: { forget: vi.fn() },
    input: { forget: vi.fn() },
    deviceInput: { forget: vi.fn() },
    homes: { copilot: '/copilot', grok: '/grok', agy: '/agy' },
    ...over,
  }
  return { deps, byAgent, bySession, binding: createBinding(deps) }
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
    await run.binding.handleRegistered(entry, meta({ isNew: true }))
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

  it('stops after the attach for a session it already had, and finishes a resume it was waiting for', async () => {
    const run = setup()
    const entry = agent({ resumeOnly: true } as Partial<RegisteredSession>)
    run.byAgent.set('a1', entry)
    await run.binding.handleRegistered(entry, meta())
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
    await run.binding.handleRegistered(entry, meta({ isNew: true }))
    expect(run.deps.registry.unbindSession).toHaveBeenCalledWith('s1')
    expect(run.deps.announceSession).toHaveBeenCalledWith(entry)
    expect(run.deps.syncRecapPool).not.toHaveBeenCalled()
  })

  it('hands a rebound agent its name and recap, and lets the stale session go', async () => {
    const run = setup()
    await run.binding.handleRegistered(agent({ sessionId: 's2' }), meta({ rebound: 's1' }))
    expect(run.deps.registry.inheritName).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.mirror.inheritSummary).toHaveBeenCalledWith('s1', 's2')
    expect(run.deps.forgetSession).toHaveBeenCalledWith('s1', { force: true, keepAgent: true })
    expect(run.deps.clients.send).toHaveBeenCalledWith({ type: 'session_reset', payload: { staleSessionId: 's1' } })
  })

  it('forgets an evicted session and an agent the bind emptied out', async () => {
    const run = setup()
    await run.binding.handleRegistered(agent(), meta({ evicted: 's0', orphaned: { agentId: 'a0', sessionId: 's0' } }))
    expect(vi.mocked(run.deps.forgetSession).mock.calls).toEqual([
      ['s0', { force: true }],
      ['a0', { force: true, agentId: 'a0' }],
    ])
  })

  it('gives a fork the recap of its source once its own session reports in', async () => {
    const run = setup()
    run.binding.pendingForkInherit.set('a1', 'source-s')
    await run.binding.handleRegistered(agent({ sessionId: '' }), meta())
    expect(run.deps.mirror.inheritSummary).not.toHaveBeenCalled()
    await run.binding.handleRegistered(agent(), meta())
    expect(run.deps.mirror.inheritSummary).toHaveBeenCalledWith('source-s', 's1')
    expect(run.binding.pendingForkInherit.has('a1')).toBe(false)
  })

  it('resets on a SessionStart, except for engines that announce one turn more than once', async () => {
    const run = setup()
    for (const engine of ['claude', 'cursor', 'agy', 'copilot']) {
      await run.binding.handleRegistered(agent({ engine } as Partial<RegisteredSession>), meta({ hookEvent: 'SessionStart' }))
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
    await run.binding.handleRegistered(agent({ transcriptPath: born, registeredAt: Date.now() - 60_000 }), meta())
    await run.binding.handleRegistered(agent({ transcriptPath: join(dir, 'missing.jsonl'), registeredAt: Date.now() - 60_000 }), meta())
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
    await run.binding.handleRegistered(resumed, meta())
    expect(run.deps.stoppedAgents.get).toHaveBeenCalledWith('a1')
    // `/clear` after the resume: a session the stopped record does not hold.
    await run.binding.handleRegistered({ ...resumed, sessionId: 's2' }, meta())
    // A resumed row with no stopped record left to compare against.
    vi.mocked(run.deps.stoppedAgents.get).mockReturnValue(null)
    await run.binding.handleRegistered(resumed, meta())
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

  describe('an agent that already has a session', () => {
    it('follows Copilot to the session it /resumed into, and only to a new one', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ engine: 'copilot' } as Partial<RegisteredSession>))
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      vi.mocked(copilotSessionForPid).mockResolvedValueOnce('s1')
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      vi.mocked(copilotSessionForPid).mockResolvedValueOnce('deleted')
      vi.mocked(isRecentlyDeleted).mockReturnValueOnce(true)
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      vi.mocked(copilotSessionForPid).mockResolvedValue('s2')
      const rotated = agent({ engine: 'copilot', sessionId: 's2' } as Partial<RegisteredSession>)
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: rotated, ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'copilot' }))
      expect(copilotSessionForPid).toHaveBeenLastCalledWith('/copilot', 42)
      expect(findCopilotTranscript).toHaveBeenLastCalledWith('/copilot', 's2')
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 's2', transcriptPath: '/t/copilot.jsonl', source: 'copilot-resume' })
      expect(run.deps.attachSession).toHaveBeenCalledWith(rotated, true, false, false)
      // Not new to the registry, or no transcript yet: registered as it is, attached by its hook later.
      vi.mocked(findCopilotTranscript).mockResolvedValueOnce(null)
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
        vi.mocked(claudeContinuation).mockResolvedValueOnce({ ...continuation, transcriptPath: '/t/x.jsonl' } as never)
      }
      vi.mocked(run.deps.registry.has).mockImplementation((sessionId: string) => sessionId === 'known')
      vi.mocked(isRecentlyDeleted).mockImplementation((sessionId?: string) => sessionId === 'deleted')
      for (let i = 0; i < 3; i++) await run.binding.bindObservedAgent(observed())
      expect(run.deps.registry.register).not.toHaveBeenCalled()
      vi.mocked(claudeContinuation).mockResolvedValue({ sessionId: 's2', transcriptPath: '/t/s2.jsonl' } as never)
      vi.mocked(run.deps.registry.register).mockReturnValueOnce({ entry: agent({ sessionId: 's2' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed())
      expect(vi.mocked(run.deps.registry.register).mock.calls[0][0]).toMatchObject({ sessionId: 's2', source: 'claude-continuation' })
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
      expect(claudeContinuation).not.toHaveBeenCalled()
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
      expect(findCursorTranscript).toHaveBeenCalledWith('/cursor', 'cursor-resumed')
      expect(findGrokTranscript).toHaveBeenCalledWith('/grok', '/work', 'grok-resumed')
      expect(findAgyTranscript).toHaveBeenCalledWith('/agy', 'agy-resumed')
      expect(findResumedTranscript).toHaveBeenCalledWith('codex', 'codex-resumed', { codexHome: undefined })
    })

    it('needs a transcript for the engines whose sessions are files, and skips a deleted session', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '', codexHome: '/codex' } as Partial<RegisteredSession>))
      vi.mocked(findCursorTranscript).mockResolvedValueOnce(null)
      vi.mocked(findGrokTranscript).mockResolvedValueOnce(null)
      vi.mocked(findResumedTranscript).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      for (const engine of ['cursor', 'grok', 'claude', 'codex']) {
        await run.binding.bindObservedAgent(observed({ engine, resumeSessionId: 'r' } as Partial<DiscoveredTerminalAgent>))
      }
      vi.mocked(findAgyTranscript).mockResolvedValueOnce(null)
      vi.mocked(findCopilotTranscript).mockResolvedValueOnce(null)
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
      expect(run.deps.teams.forget).toHaveBeenCalledWith('old')
      expect(run.deps.input.forget).toHaveBeenCalledWith('old')
      expect(run.deps.deviceInput.forget).toHaveBeenCalledWith('old')
      expect(run.deps.announceSession).toHaveBeenCalledWith(previous)
      expect(run.deps.attachSession).toHaveBeenCalled()
    })
  })

  describe('a repair', () => {
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
      expect(findLiveSession).toHaveBeenLastCalledWith('claude', '/work', Date.parse('2026-10-04T10:00:00Z'), { bornOnly: true, pid: 42, codexHome: undefined })
    })

    it('binds what it finds, with the Hermes home it was found in, and starts the count over', async () => {
      const run = setup()
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(agent({ sessionId: '', codexHome: '/codex' } as Partial<RegisteredSession>))
      vi.mocked(findLiveSession).mockResolvedValueOnce({ sessionId: 'found', transcriptPath: '/t/found.jsonl', hermesHome: '/hermes' } as never)
      vi.mocked(run.deps.registry.register).mockReturnValue({ entry: agent({ sessionId: 'found' }), ...meta({ isNew: true }) } as never)
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
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
