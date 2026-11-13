import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Daemon } from '../agentClient/daemon.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { withOwnAgents } from './ownAgents.js'
import { retainContributions, retentionFile } from './retention.js'

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const row = (agentId: string, extra: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/work/app', registeredAt: 1000, ...extra }) as RegisteredSession

/** A data folder whose host keeps `lead` as a Product Manager and `member` as a member, a core that sees [live], and the
 *  daemon line its requests go through, answering each with [answer]. */
function setup(live: Record<string, RegisteredSession> = {}, answer = (_type: string, _payload: Record<string, unknown>): Record<string, unknown> => ({ closed: true })) {
  const dataDir = mkdtempSync(join(tmpdir(), 'own-agents-')); roots.push(dataDir)
  retainContributions(dataDir, 'machine', [
    { tabId: 'tab', lead: true, agent: { harnessId: 'lead', machineId: 'machine' } },
    { tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine' } }])
  const stopped = vi.fn(async (_id: string) => false), gone = vi.fn(async (_id: string) => false)
  const creationStatus = vi.fn(async (creationId: string) => ({ creationId, state: 'created' as const, agentId: 'worker' }))
  const core = fakeCore({ dataDir, agents: { byAgent: (id: string) => live[id], stopped, gone, creationStatus },
    daemon: { command: 'harness', port: 18999, machineId: () => 'machine', autonomousEnv: 'prod' } })
  const requests: Array<[string, Record<string, unknown>]> = [], close = vi.fn()
  const open = vi.fn(async (): Promise<Daemon> => ({ machineId: 'machine', close,
    request: async (type, payload = {}) => { requests.push([type, payload]); return answer(type, payload) } }))
  return { dataDir, core: withOwnAgents(core, open), open, requests, close, stopped, gone, creationStatus }
}

describe('the Swarm\'s closes and reopens of its own agents, in its own process', () => {
  const request = { agentId: 'worker', creationId: 'super-original-creation', sessionId: 'native', createdAt: new Date(1000).toISOString() }
  const worker = row('worker', { sessionId: 'native', startedBy: 'agent' })

  // anh Dee, 2026-11-13: an experiment never touches the core. These were the core's own (superTabs/inCore/agents.ts); the
  // Swarm checks them here now and asks the core as any client does, as this computer's owner's tool.
  it('closes only the original Swarm-started session, through the core\'s own close of that conversation', async () => {
    const t = setup({ worker })
    const leased = { ...request, expiresAt: Date.now() + 120_000 }
    expect(await t.core.agents.closeSwarm!(leased)).toEqual({ closed: true })
    expect(t.requests).toEqual([['agent_close', { agentId: 'worker', sessionId: 'native', createdAt: request.createdAt, mode: 'now' }]])
    expect(t.open).toHaveBeenCalledWith({ dataDir: t.dataDir, port: 18999, machineId: 'machine' })
    expect(t.close).toHaveBeenCalledOnce()
    // Started by a person, started again since, or another conversation now: refused, and nothing asked of the core.
    for (const [session, error] of [[{ ...worker, startedBy: undefined }, 'NOT_SWARM_STARTED'], [{ ...worker, registeredAt: 2000 }, 'AGENT_CHANGED'],
      [{ ...worker, sessionId: 'replacement' }, 'AGENT_CHANGED']] as const) {
      expect(await setup({ worker: session as RegisteredSession }).core.agents.closeSwarm!(leased)).toEqual({ error })
    }
    for (const partial of [{ ...leased, creationId: '' }, { ...leased, sessionId: undefined }, { ...leased, createdAt: undefined }]) {
      expect(await t.core.agents.closeSwarm!(partial)).toEqual({ error: 'NOT_SWARM_STARTED' })
    }
    // Its creation receipt names another harness, or there is none to read.
    t.creationStatus.mockResolvedValueOnce({ creationId: request.creationId, state: 'created', agentId: 'other' })
    expect(await t.core.agents.closeSwarm!(leased)).toEqual({ error: 'NOT_SWARM_STARTED' })
    expect(await withOwnAgents(fakeCore({ dataDir: t.dataDir, agents: { byAgent: () => worker } }), t.open).agents.closeSwarm!(leased))
      .toEqual({ error: 'NOT_SWARM_STARTED' })
    expect(t.requests).toHaveLength(1)
  })

  it('says what the core\'s close answered, and that the core could not be reached', async () => {
    const leased = { ...request, expiresAt: Date.now() + 120_000 }
    const changed = setup({ worker }, () => ({ error: 'AGENT_CHANGED', detail: 'It changed while closing.' }))
    expect(await changed.core.agents.closeSwarm!(leased)).toEqual({ error: 'AGENT_CHANGED', detail: 'It changed while closing.' })
    const bare = setup({ worker }, () => ({}))
    expect(await bare.core.agents.closeSwarm!(leased)).toEqual({ error: 'CLOSE_FAILED' })
    const down = setup({ worker })
    down.open.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    expect(await down.core.agents.closeSwarm!(leased)).toEqual({ error: 'CORE_UNREACHABLE', detail: 'connect ECONNREFUSED' })
    const thrown = setup({ worker }, () => { throw 'gone' })
    expect(await thrown.core.agents.closeSwarm!(leased)).toEqual({ error: 'CORE_UNREACHABLE', detail: 'gone' })
    expect(thrown.close).toHaveBeenCalledOnce()
  })

  it('refuses missing or expired close leases, including expiry during the creation lookup', async () => {
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const t = setup({ worker })
      for (const expiresAt of [undefined, NaN, 999]) expect(await t.core.agents.closeSwarm!({ ...request, expiresAt })).toEqual({ error: 'STOP_LEASE_EXPIRED' })
      t.creationStatus.mockImplementationOnce(async creationId => { now = 1200; return { creationId, state: 'created', agentId: 'worker' } })
      expect(await t.core.agents.closeSwarm!({ ...request, expiresAt: 1100 })).toEqual({ error: 'STOP_LEASE_EXPIRED' })
      expect(t.requests).toEqual([])
    } finally { clock.mockRestore() }
  })

  // What this process holds of the live agents can lag behind the core: one it does not see is closed only once the core
  // says it ended, and tried again otherwise, never taken as refused for good.
  it('takes an agent it does not see as closed only once the core says it stopped or is gone', async () => {
    const t = setup()
    expect(await t.core.agents.closeSwarm!({ agentId: 'worker' })).toEqual({ error: 'UNCONFIRMED', detail: 'The core did not say it ended.' })
    t.stopped.mockResolvedValueOnce(true)
    expect(await t.core.agents.closeSwarm!({ agentId: 'worker' })).toEqual({ closed: true })
    t.gone.mockResolvedValueOnce(true)
    expect(await t.core.agents.closeMember!('worker')).toEqual({ closed: true })
    expect(await withOwnAgents(fakeCore({ dataDir: t.dataDir }), t.open).agents.closeMember!('nobody')).toMatchObject({ error: 'UNCONFIRMED' })
    expect(t.requests).toEqual([])
  })

  // The owner, 2026-10-23: the Lead of an active project stays alive. The core no longer refuses to stop one; the host
  // reopens it, and only a stopped one its retention keeps as a Lead.
  it('reopens only a stopped Product Manager its retention keeps, and says a live one is up', async () => {
    const t = setup({ live: row('live') }, (type) => type === 'agent_resume' ? { agent: { id: 'lead' }, resumed: true } : {})
    t.stopped.mockImplementation(async id => id === 'lead' || id === 'member')
    expect(await t.core.agents.keepLeadAlive!('lead')).toEqual({ ok: true })
    expect(t.requests).toEqual([['agent_resume', { agentId: 'lead' }]])
    expect(await t.core.agents.keepLeadAlive!('live')).toEqual({ ok: true })
    const refused = { ok: false, error: 'NOT_A_LEAD', detail: 'Only a stopped Product Manager of a Swarm project is reopened.' }
    expect(await t.core.agents.keepLeadAlive!('member')).toEqual(refused)
    t.stopped.mockResolvedValueOnce(false)
    expect(await t.core.agents.keepLeadAlive!('lead')).toEqual(refused)
    // A retention nobody can read names no Lead.
    writeFileSync(retentionFile(t.dataDir), '{')
    expect(await t.core.agents.keepLeadAlive!('lead')).toEqual(refused)
    expect(t.requests).toHaveLength(1)
  })

  it('says why a reopen failed, and that the core could not be reached', async () => {
    const busy = setup({}, () => ({ error: 'AGENT_BUSY', detail: 'busy' }))
    busy.stopped.mockResolvedValue(true)
    expect(await busy.core.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'AGENT_BUSY', detail: 'busy' })
    const down = setup()
    down.stopped.mockResolvedValue(true)
    down.open.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    expect(await down.core.agents.keepLeadAlive!('lead')).toEqual({ ok: false, error: 'CORE_UNREACHABLE', detail: 'connect ECONNREFUSED' })
  })

  it('closes now only a member its retention keeps, or one its own start receipt names', async () => {
    const t = setup({ member: row('member'), worker: row('worker') })
    expect(await t.core.agents.closeMember!('member')).toEqual({ closed: true })
    expect(t.requests).toEqual([['agent_close', { agentId: 'member', sessionId: 's-member', createdAt: new Date(1000).toISOString(), mode: 'now' }]])
    // The review of #1635: removed before its host wrote a roster naming it, its start receipt proves it the Swarm's own.
    expect(await t.core.agents.closeMember!('worker')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(await t.core.agents.closeMember!('worker', 'super-start')).toEqual({ closed: true })
    expect(t.creationStatus).toHaveBeenCalledWith('super-start')
    t.creationStatus.mockResolvedValueOnce({ creationId: 'super-start', state: 'created', agentId: 'another' })
    expect(await t.core.agents.closeMember!('worker', 'super-start')).toEqual({ error: 'NOT_A_MEMBER' })
    // A retention nobody can read names no member.
    writeFileSync(retentionFile(t.dataDir), '{')
    expect(await t.core.agents.closeMember!('member')).toEqual({ error: 'NOT_A_MEMBER' })
    expect(t.requests).toHaveLength(2)
  })

  it('keeps everything else the core offers as it is', () => {
    const t = setup()
    expect(t.core.dataDir).toBe(t.dataDir)
    expect(t.core.daemon.port).toBe(18999)
    expect(t.core.agents.stopped).toBe(t.stopped)
  })
})
