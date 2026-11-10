import { describe, expect, it, vi } from 'vitest'
import type { SwarmAgentDeps } from '../../core/api.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSwarmAgents } from './agents.js'

const row = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app' }) as RegisteredSession
const NO_MEMBERS = { leads: () => new Set<string>(), harnesses: () => new Set<string>() }
const deps = (over: Partial<SwarmAgentDeps> = {}): SwarmAgentDeps => ({
  byAgent: (agentId: string) => (agentId === 'live' ? row('live') : undefined),
  stoppedIds: () => ['stopped'],
  ...over,
})

describe('the Swarm\'s agents, as the core lets it close and reopen them', () => {
  it('closes only the original Swarm-started native session and treats an absent session as gone', async () => {
    const request = { agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', expiresAt: Date.now() + 120_000, createdAt: new Date(1000).toISOString() }
    const session = { ...row('worker'), sessionId: 'native', registeredAt: 1000, startedBy: 'agent' as const }
    const byAgent = vi.fn(() => session as RegisteredSession | undefined)
    const closeAgent = vi.fn(async () => ({ closed: true as const }))
    const creationStatus = vi.fn(async () => ({ creationId: request.creationId, state: 'created' as const, agentId: 'worker' }))
    const swarm = createSwarmAgents({ ...deps({ byAgent, closeAgent, creationStatus }), members: NO_MEMBERS })
    expect(await swarm.closeSwarm(request)).toEqual({ closed: true })
    expect(closeAgent).toHaveBeenCalledWith({ agentId: 'worker', sessionId: 'native', createdAt: request.createdAt, mode: 'now', onlyIfOriginalLaunch: true, expiresAt: request.expiresAt })
    closeAgent.mockClear()
    byAgent.mockReturnValue({ ...session, startedBy: undefined })
    expect(await swarm.closeSwarm(request)).toMatchObject({ error: 'NOT_SWARM_STARTED' })
    byAgent.mockReturnValue({ ...session, registeredAt: 2000 })
    expect(await swarm.closeSwarm(request)).toMatchObject({ error: 'AGENT_CHANGED' })
    byAgent.mockReturnValue({ ...session, sessionId: 'replacement' })
    expect(await swarm.closeSwarm(request)).toMatchObject({ error: 'AGENT_CHANGED' })
    byAgent.mockReturnValue(session)
    creationStatus.mockResolvedValueOnce({ creationId: request.creationId, state: 'created', agentId: 'other' })
    expect(await swarm.closeSwarm(request)).toMatchObject({ error: 'NOT_SWARM_STARTED' })
    expect(closeAgent).not.toHaveBeenCalled()
    const withoutCreation = createSwarmAgents({ ...deps({ byAgent, closeAgent }), members: NO_MEMBERS })
    expect(await withoutCreation.closeSwarm(request)).toEqual({ error: 'NOT_SWARM_STARTED' })
    const noLifecycle = createSwarmAgents({ ...deps({ byAgent, creationStatus }), members: NO_MEMBERS })
    expect(await noLifecycle.closeSwarm(request)).toEqual({ error: 'UNSUPPORTED' })
    for (const partial of [{ agentId: 'worker' }, { ...request, creationId: '' }, { ...request, sessionId: undefined }, { ...request, createdAt: undefined }]) {
      expect(await swarm.closeSwarm(partial)).toEqual({ error: 'NOT_SWARM_STARTED' })
    }
    byAgent.mockReturnValue(undefined)
    expect(await swarm.closeSwarm({ agentId: 'worker' })).toEqual({ closed: true })
  })

  // A machine restart stops Swarm sessions; reopened, each keeps its harness, conversation and registeredAt but is marked
  // resume-only. On 2026-10-23 such a worker could no longer be stopped by the Swarm ("not started by the Swarm").
  it('closes a Swarm session reopened on its own conversation, and refuses one whose conversation changed during the lookup', async () => {
    const request = { agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', expiresAt: Date.now() + 120_000, createdAt: new Date(1000).toISOString() }
    const session = { ...row('worker'), sessionId: 'native', registeredAt: 1000, startedBy: 'agent' as const, resumeOnly: true as const }
    const closeAgent = vi.fn(async () => ({ closed: true as const }))
    const creationStatus = vi.fn(async () => ({ creationId: request.creationId, state: 'created' as const, agentId: 'worker' }))
    const swarm = createSwarmAgents({ ...deps({ byAgent: () => session, closeAgent, creationStatus }), members: NO_MEMBERS })
    expect(await swarm.closeSwarm(request)).toEqual({ closed: true })
    expect(closeAgent).toHaveBeenCalledOnce()
    closeAgent.mockClear()
    creationStatus.mockImplementationOnce(async () => {
      session.sessionId = 'personal-resume'
      return { creationId: request.creationId, state: 'created' as const, agentId: 'worker' }
    })
    expect(await swarm.closeSwarm(request)).toEqual({ error: 'AGENT_CHANGED' })
    expect(closeAgent).not.toHaveBeenCalled()
  })

  // The Super Tab host keeps a Swarm Lead alive and closes the sessions its backend ends (owner, 2026-10-23). The core
  // decides what a service may do: reopen only a stopped Lead the host's retention names, close only a member it names.
  it('reopens only a stopped Swarm Lead, and says a live one is up', async () => {
    const resumeAgent = vi.fn(async () => ({ ok: true as const }))
    const leads = vi.fn(() => new Set(['stopped', 'live']))
    const swarm = createSwarmAgents({ ...deps({ resumeAgent }), members: { leads, harnesses: () => new Set() } })
    expect(await swarm.keepLeadAlive('stopped')).toEqual({ ok: true })
    expect(resumeAgent).toHaveBeenCalledWith('stopped')
    expect(await swarm.keepLeadAlive('live')).toEqual({ ok: true })
    leads.mockReturnValue(new Set(['live']))
    expect(await swarm.keepLeadAlive('stopped')).toEqual({ ok: false, error: 'NOT_A_LEAD', detail: 'Only a stopped Product Manager of a Swarm project is reopened.' })
    leads.mockReturnValue(new Set(['gone']))
    expect(await swarm.keepLeadAlive('gone')).toMatchObject({ ok: false, error: 'NOT_A_LEAD' })
    expect(resumeAgent).toHaveBeenCalledTimes(1)
    leads.mockReturnValue(new Set(['stopped']))
    resumeAgent.mockResolvedValueOnce({ ok: false, error: 'AGENT_BUSY', detail: 'busy' } as never)
    expect(await swarm.keepLeadAlive('stopped')).toEqual({ ok: false, error: 'AGENT_BUSY', detail: 'busy' })
    resumeAgent.mockResolvedValueOnce({ ok: false, error: 'RESUME_FAILED' } as never)
    expect(await swarm.keepLeadAlive('stopped')).toEqual({ ok: false, error: 'RESUME_FAILED' })
    expect(await createSwarmAgents({ ...deps(), members: { leads, harnesses: () => new Set() } }).keepLeadAlive('stopped')).toEqual({ ok: false, error: 'UNSUPPORTED' })
  })

  it('closes now only a Super Tab member the host retains, and treats an absent one as closed', async () => {
    const closeAgent = vi.fn(async () => ({ closed: true as const }))
    const byAgent = (id: string) => id === 'live' ? { ...row('live'), registeredAt: 1000 } : undefined
    const harnesses = vi.fn(() => new Set(['live']))
    const swarm = createSwarmAgents({ ...deps({ byAgent, closeAgent }), members: { leads: () => new Set(), harnesses } })
    expect(await swarm.closeMember('live')).toEqual({ closed: true })
    expect(closeAgent).toHaveBeenCalledWith({ agentId: 'live', sessionId: 's-live', createdAt: new Date(1000).toISOString(), mode: 'now' })
    expect(await swarm.closeMember('absent')).toEqual({ closed: true })
    harnesses.mockReturnValue(new Set())
    expect(await swarm.closeMember('live')).toEqual({ error: 'NOT_A_MEMBER' })
    harnesses.mockImplementation(() => { throw new Error('Super Tab retention is unreadable.') })
    expect(await swarm.closeMember('live')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(closeAgent).toHaveBeenCalledTimes(1)
    expect(await createSwarmAgents({ ...deps({ byAgent }), members: { leads: () => new Set(), harnesses: () => new Set(['live']) } }).closeMember('live')).toEqual({ error: 'UNSUPPORTED' })
  })

  // The review of #1635: an agent removed before its host wrote a roster naming it is no member there; the exact receipt of
  // the Swarm's start proves it is the Swarm's own to close, and a receipt naming another harness proves nothing.
  it('closes a member the retention does not name only when its start receipt names it', async () => {
    const closeAgent = vi.fn(async () => ({ closed: true as const }))
    const creationStatus = vi.fn(async (creationId: string) => ({ creationId, state: 'created' as const, agentId: 'live' }))
    const byAgent = (id: string) => id === 'live' ? { ...row('live'), registeredAt: 1000 } : undefined
    const swarm = createSwarmAgents({ ...deps({ byAgent, closeAgent, creationStatus }), members: NO_MEMBERS })
    expect(await swarm.closeMember('live')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(await swarm.closeMember('live', 'super-start')).toEqual({ closed: true })
    expect(creationStatus).toHaveBeenCalledWith('super-start')
    creationStatus.mockResolvedValueOnce({ creationId: 'super-start', state: 'created', agentId: 'another' })
    expect(await swarm.closeMember('live', 'super-start')).toEqual({ error: 'NOT_A_MEMBER' })
    creationStatus.mockResolvedValueOnce(null as never)
    expect(await swarm.closeMember('live', 'super-start')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(await createSwarmAgents({ ...deps({ byAgent, closeAgent }), members: NO_MEMBERS }).closeMember('live', 'super-start')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(closeAgent).toHaveBeenCalledTimes(1)
  })

  it('refuses missing or expired close leases, including expiry during the creation lookup', async () => {
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const request = { agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(1000).toISOString(), expiresAt: 1100 }
      const closeAgent = vi.fn(async () => ({ closed: true as const }))
      const session = { ...row('worker'), sessionId: 'native', registeredAt: 1000, startedBy: 'agent' as const }
      const creationStatus = vi.fn(async () => { now = 1200; return { creationId: request.creationId, state: 'created' as const, agentId: 'worker' } })
      const swarm = createSwarmAgents({ ...deps({ byAgent: () => session, closeAgent, creationStatus }), members: NO_MEMBERS })
      for (const expiresAt of [undefined, NaN, 999]) expect(await swarm.closeSwarm({ ...request, expiresAt })).toEqual({ error: 'STOP_LEASE_EXPIRED' })
      expect(await swarm.closeSwarm(request)).toEqual({ error: 'STOP_LEASE_EXPIRED' })
      expect(closeAgent).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
})
