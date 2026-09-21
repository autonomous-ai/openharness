import { describe, expect, it, vi } from 'vitest'
import { resumeStoppedAgent } from './resumeStoppedAgent.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import type { RegisteredSession } from './registry.js'

const saved = { agentId: 'saved-agent', sessionId: 'original-conversation', engine: 'codex', cwd: '/work', codexHome: '/profile', permissionMode: 'plan' } as RegisteredSession
function fixture() {
  return {
    live: vi.fn((): RegisteredSession | undefined => undefined),
    saved: vi.fn(() => saved),
    current: vi.fn(() => true),
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
