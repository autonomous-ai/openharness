import { describe, expect, it, vi } from 'vitest'
import { resumeStoppedAgent, waitForResumedAgent } from './resumeStoppedAgent.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import type { RuntimeCheck } from './tmux.js'
import type { RegisteredSession } from './registry.js'

const saved = { agentId: 'saved-agent', sessionId: 'original-conversation', engine: 'codex', cwd: '/work', codexHome: '/profile', permissionMode: 'plan' } as RegisteredSession
function fixture() {
  return {
    live: vi.fn((): RegisteredSession | undefined => undefined),
    saved: vi.fn(() => saved),
    current: vi.fn(() => true),
    checkLive: vi.fn(async (): Promise<RuntimeCheck> => ({ state: 'alive' })),
    retain: vi.fn(async (_entry: RegisteredSession) => {}),
    waitForReady: vi.fn(async () => ({ ok: true as const, session: saved, resumed: true })),
    canLaunch: vi.fn(async () => true),
    launch: vi.fn(async () => ({ ok: true as const, session: saved, resumed: true })),
  }
}

describe('Enter resumes stopped work', () => {
  it('attaches an already live harness without launching or stopping it', async () => {
    const deps = fixture()
    deps.live.mockReturnValue(saved)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true, session: saved })
    expect(deps.launch).not.toHaveBeenCalled()
    expect(deps.canLaunch).not.toHaveBeenCalled()
  })

  it('passes the original conversation and complete launch profile directly to launch', async () => {
    const deps = fixture()
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true, resumed: true })
    expect(deps.launch).toHaveBeenCalledExactlyOnceWith(saved, 'original-conversation')
  })

  it.each([{ ...saved, sessionId: '' }, { ...saved, engine: 'devin' as const }])('refuses unavailable resume without opening a fresh conversation', async entry => {
    const deps = fixture()
    deps.saved.mockReturnValue(entry)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_UNAVAILABLE' })
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('does not launch while the old process is still alive or unverified', async () => {
    const deps = fixture()
    deps.canLaunch.mockResolvedValue(false)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: false, error: 'AGENT_BUSY' })
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('does not launch after Stop cancels a pending resume', async () => {
    const deps = fixture()
    deps.current.mockReturnValue(false)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('joins repeated Enter requests and never falls back after a launch failure', async () => {
    const deps = fixture()
    const launch = vi.fn(async () => ({ ok: false as const, error: 'RESUME_FAILED' }))
    const coordinator = new AgentRestartCoordinator()
    const run = () => coordinator.run(saved.agentId, current => resumeStoppedAgent({ ...deps, current, launch }))
    const first = run()
    expect(run()).toBe(first)
    await expect(first).resolves.toEqual({ ok: false, error: 'RESUME_FAILED' })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(saved, 'original-conversation')
  })

  it('reattaches if another client resumes while the old process is being checked', async () => {
    const deps = fixture()
    deps.canLaunch.mockImplementation(async () => { deps.live.mockReturnValue(saved); return true })
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true, session: saved })
    expect(deps.launch).not.toHaveBeenCalled()
  })
})


describe('resume runtime verification', () => {
  it.each(['unknown', 'gone'] as const)('never calls a %s registry row a successful attachment', async state => {
    const deps = fixture()
    deps.live.mockReturnValue(saved)
    deps.checkLive.mockResolvedValue({ state, reason: 'fixture' })
    deps.retain.mockImplementation(async () => { deps.live.mockReturnValue(undefined) })
    const result = await resumeStoppedAgent(deps)
    if (state === 'gone') {
      expect(result.ok).toBe(true)
      expect(deps.retain).toHaveBeenCalledWith(saved)
      expect(deps.launch).toHaveBeenCalledTimes(1)
    } else {
      expect(result).toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
      expect(deps.retain).not.toHaveBeenCalled()
      expect(deps.launch).not.toHaveBeenCalled()
    }
  })

  it('preserves a same-ID shell separately and resumes the archived engine', async () => {
    const deps = fixture()
    const shell = { ...saved, engine: 'terminal' as const, sessionId: '' }
    deps.live.mockReturnValue(shell)
    deps.retain.mockImplementation(async () => { deps.live.mockReturnValue(undefined) })
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true })
    expect(deps.checkLive).not.toHaveBeenCalled()
    expect(deps.retain).toHaveBeenCalledWith(shell)
    expect(deps.launch).toHaveBeenCalledWith(saved, saved.sessionId)
  })

  it('waits for a pending native resume instead of calling pane allocation success', async () => {
    const deps = fixture()
    const pending = { ...saved, resumeOnly: true as const, launch: { state: 'starting' as const } }
    deps.live.mockReturnValue(pending)
    await resumeStoppedAgent(deps)
    expect(deps.waitForReady).toHaveBeenCalledWith(pending)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('refuses a restart while another client is resuming the same agent', async () => {
    const jobs = new AgentRestartCoordinator()
    let finish!: (value: any) => void
    const pending = jobs.run(saved.agentId, () => new Promise(resolve => { finish = resolve }), 'resume')
    await Promise.resolve()
    const restart = vi.fn()
    await expect(jobs.run(saved.agentId, restart)).resolves.toMatchObject({ ok: false, error: 'AGENT_BUSY' })
    expect(restart).not.toHaveBeenCalled()
    jobs.cancel(saved.agentId)
    finish({ ok: true, session: saved, resumed: true })
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  })
})

describe('exact conversation readiness', () => {
  const process = { pid: 42, startMarker: 'new-process', executable: 'codex' }
  function readiness() {
    let now = 0
    let row: RegisteredSession = { ...saved, processIdentity: process, lastHookAt: 0, launch: { state: 'starting' } }
    return {
      current: vi.fn(() => true),
      session: () => row,
      process: vi.fn(async () => process),
      pane: vi.fn(async (): Promise<{ dead: boolean; engineExit?: number } | null> => ({ dead: false })),
      sleep: vi.fn(async (ms: number) => { now += ms }),
      now: () => now,
      budgetMs: 1000,
      set: (next: Partial<RegisteredSession>) => { row = { ...row, ...next } },
    }
  }
  it('does not treat a visible process or saved session binding as readiness', async () => {
    const deps = readiness()
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
    expect(deps.sleep).toHaveBeenCalled()
  })
  it('waits for the matching startup hook from the newly observed process', async () => {
    const deps = readiness()
    deps.sleep.mockImplementation(async () => { deps.set({ lastHookAt: 100, launch: { state: 'ready' } }) })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: true, session: { sessionId: saved.sessionId } })
    expect(deps.process).toHaveBeenCalledTimes(2)
  })
  it.each([null, { dead: true }, { dead: false, engineExit: 1 }])('reports early exit without a fresh fallback: %s', async pane => {
    const deps = readiness()
    deps.pane.mockResolvedValue(pane)
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_FAILED' })
  })
  it('does not accept a startup hook for another process or conversation', async () => {
    const deps = readiness()
    deps.set({ lastHookAt: 100, launch: { state: 'ready' }, processIdentity: { ...process, pid: 99 } })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
    deps.set({ sessionId: 'fresh-conversation', processIdentity: process })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  })
  it('does not report success if the process exits between readiness probes', async () => {
    const deps = readiness()
    deps.set({ lastHookAt: 100, launch: { state: 'ready' } })
    deps.pane.mockResolvedValue({ dead: false, engineExit: 1 })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_FAILED' })
  })
  it('checks Stop cancellation after async probes', async () => {
    const deps = readiness()
    deps.set({ lastHookAt: 100, launch: { state: 'ready' } })
    deps.process.mockImplementation(async () => { deps.current.mockReturnValue(false); return process })
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  })
})

describe('resume refusal and readiness edge cases', () => {
  it('reports a missing saved identity', async () => {
    const deps = fixture(); deps.saved.mockReturnValue(null as any)
    expect(await resumeStoppedAgent(deps)).toMatchObject({ error: 'AGENT_NOT_FOUND' })
  })
  it('opens a shell without a conversation id', async () => {
    const deps = fixture(); const shell = { ...saved, engine: 'terminal' as const, sessionId: '' }; deps.saved.mockReturnValue(shell)
    expect(await resumeStoppedAgent(deps)).toMatchObject({ ok: true }); expect(deps.launch).toHaveBeenCalledWith(shell, undefined)
  })
  it.each(['during check', 'row replacement', 'during retain', 'during launch check'] as const)('does not launch after %s', async when => {
    const deps = fixture()
    if (when === 'during launch check') deps.canLaunch.mockImplementation(async () => { deps.current.mockReturnValue(false); return true })
    else {
      deps.live.mockReturnValue(saved)
      deps.checkLive.mockImplementation(async () => {
        if (when === 'during check') deps.current.mockReturnValue(false)
        if (when === 'row replacement') deps.live.mockReturnValue({ ...saved })
        return { state: 'gone', reason: 'fixture' }
      })
      deps.retain.mockImplementation(async () => { deps.current.mockReturnValue(false) })
    }
    expect(await resumeStoppedAgent(deps)).toMatchObject({ error: 'AGENT_CHANGED' }); expect(deps.launch).not.toHaveBeenCalled()
  })
  it('asks a live but unconfirmed process for confirmation again instead of repeating the verdict', async () => {
    const deps = fixture()
    const existing: RegisteredSession = { ...saved, resumeOnly: true, launch: { state: 'failed', error: 'RESUME_UNCONFIRMED' } }
    deps.live.mockReturnValue(existing)
    expect(await resumeStoppedAgent(deps)).toMatchObject({ ok: true, resumed: true })
    expect(deps.waitForReady).toHaveBeenCalledWith(existing)
    expect(deps.launch).not.toHaveBeenCalled(); expect(deps.retain).not.toHaveBeenCalled()
  })
  it('does not call a live process that reported another conversation ready', async () => {
    const deps = fixture(); deps.live.mockReturnValue({ ...saved, resumeOnly: true, launch: { state: 'failed', error: 'RESUME_SESSION_MISMATCH' } })
    expect(await resumeStoppedAgent(deps)).toMatchObject({ error: 'RESUME_UNCONFIRMED' })
    expect(deps.waitForReady).not.toHaveBeenCalled(); expect(deps.launch).not.toHaveBeenCalled()
  })
  it.each(['cancelled', 'removed', 'failed', 'different engine', 'no process', 'different start', 'missing launch'] as const)('handles readiness: %s', async mode => {
    const process = { pid: 4, startMarker: 'now', executable: 'codex' }
    let row: RegisteredSession | undefined = { ...saved, processIdentity: process, lastHookAt: 1, launch: { state: 'ready' } }
    if (mode === 'removed') row = undefined
    if (mode === 'failed') row!.launch = { state: 'failed', error: 'RESUME_SESSION_MISMATCH', detail: 'fixture' }
    if (mode === 'different engine') row!.engine = 'claude'
    if (mode === 'different start') row!.processIdentity = { ...process, startMarker: 'old' }
    if (mode === 'missing launch') row!.launch = undefined
    let time = 0
    const result = await waitForResumedAgent(saved, {
      current: () => mode !== 'cancelled', session: () => row,
      process: async () => mode === 'no process' ? null : process, pane: async () => ({ dead: false }),
      sleep: async ms => { time += ms }, now: () => time, budgetMs: 250,
    })
    expect(result.ok).toBe(mode === 'missing launch')
  })
  it('uses the production clock and timeout defaults', async () => {
    expect(await waitForResumedAgent(saved, { current: () => false, session: () => undefined, process: async () => null, pane: async () => null, sleep: async () => {} })).toMatchObject({ error: 'AGENT_CHANGED' })
  })
})
