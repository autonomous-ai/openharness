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

  it.each([
    // No id recorded to reopen, and an engine with no resume argv at all: both still come back —
    // same pane, same folder — as a new conversation, launched without a resume id.
    { ...saved, sessionId: '' },
    { ...saved, engine: 'devin' as const },
  ])('resumes without a conversation rather than refusing the harness', async entry => {
    const deps = fixture()
    deps.saved.mockReturnValue(entry)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true })
    expect(deps.launch).toHaveBeenCalledExactlyOnceWith(entry, undefined)
  })

  it('reopens the conversation of an engine that keeps one, whatever its vendor', async () => {
    const deps = fixture()
    const entry = { ...saved, engine: 'opencode' as const }
    deps.saved.mockReturnValue(entry)
    await expect(resumeStoppedAgent(deps)).resolves.toMatchObject({ ok: true })
    expect(deps.launch).toHaveBeenCalledExactlyOnceWith(entry, 'original-conversation')
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
  function readiness(engine: RegisteredSession['engine'] = saved.engine) {
    let now = 0
    let row: RegisteredSession = { ...saved, engine, processIdentity: process, lastHookAt: 0, launch: { state: 'starting' } }
    return {
      current: vi.fn(() => true),
      session: () => row,
      process: vi.fn(async (): Promise<typeof process | null> => process),
      pane: vi.fn(async (): Promise<{ dead: boolean; engineExit?: number } | null> => ({ dead: false })),
      sleep: vi.fn(async (ms: number) => { now += ms }),
      now: () => now,
      budgetMs: 1000,
      set: (next: Partial<RegisteredSession>) => { row = { ...row, ...next } },
    }
  }
  // The fixture row is a resume mid-flight: no hook has arrived (`lastHookAt: 0`) and the launch
  // still reads `starting`. codex used to be held to its SessionStart here and would spin to the
  // budget; a hook that is dropped, or an engine already running that will never send another, then
  // cost the person the whole harness (openharness#189).
  it('confirms a resume off its own live engine process, hook or no hook', async () => {
    const deps = readiness()
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({
      ok: true,
      resumed: true,
      session: { sessionId: saved.sessionId },
    })
    expect(deps.sleep).not.toHaveBeenCalled()
  })
  // The one state the budget still exists for: the pane is up and nothing this row would recognise
  // is running in it.
  it('waits out the budget only when nothing recognisable is running in the pane', async () => {
    const deps = readiness()
    deps.process.mockResolvedValue(null)
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_UNCONFIRMED' })
    expect(deps.sleep).toHaveBeenCalled()
  })
  it('accepts a live process for an engine that has no startup hook to send', async () => {
    // muse never hooks; copilot/pi/amp hook on the first turn. Waiting for one only converts a
    // working resume into the whole budget of "Starting", then RESUME_UNCONFIRMED.
    const deps = readiness('muse')
    const hookless = { ...saved, engine: 'muse' as const }
    await expect(waitForResumedAgent(hookless, deps)).resolves.toMatchObject({
      ok: true,
      resumed: true,
      session: { sessionId: saved.sessionId },
    })
    expect(deps.sleep).not.toHaveBeenCalled()
  })

  it('still reports a hookless engine whose pane died', async () => {
    const deps = readiness('muse')
    deps.pane.mockResolvedValue({ dead: true })
    await expect(waitForResumedAgent({ ...saved, engine: 'muse' as const }, deps))
      .resolves.toMatchObject({ ok: false, error: 'RESUME_FAILED' })
  })

  it('says a resume with no conversation to reopen is a fresh one', async () => {
    // devin hooks at launch like the rest, so it is confirmed the strict way — but it has no resume
    // argv, so what came back is a new conversation and `resumed` says so rather than lying.
    const deps = readiness('devin')
    deps.set({ lastHookAt: 100, launch: { state: 'ready' } })
    await expect(waitForResumedAgent({ ...saved, engine: 'devin' as const }, deps))
      .resolves.toMatchObject({ ok: true, resumed: false })
  })

  it.each([null, { dead: true }, { dead: false, engineExit: 1 }])('reports early exit without a fresh fallback: %s', async pane => {
    const deps = readiness()
    deps.pane.mockResolvedValue(pane)
    await expect(waitForResumedAgent(saved, deps)).resolves.toMatchObject({ ok: false, error: 'RESUME_FAILED' })
  })
  // A row whose bound conversation is no longer the one being resumed is still refused — that check
  // is on the row, ahead of any proof, and is what `registry.register`'s mismatch guard feeds.
  it('still refuses a row that reports another conversation', async () => {
    const deps = readiness()
    deps.set({ sessionId: 'fresh-conversation' })
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
    // `different start` is a row whose recorded identity is stale, not a pane with nothing in it:
    // the engine process is there, which is the proof, and discovery re-reads the identity anyway.
    expect(result.ok).toBe(mode === 'missing launch' || mode === 'different start')
  })
  it('uses the production clock and timeout defaults', async () => {
    expect(await waitForResumedAgent(saved, { current: () => false, session: () => undefined, process: async () => null, pane: async () => null, sleep: async () => {} })).toMatchObject({ error: 'AGENT_CHANGED' })
  })
})
