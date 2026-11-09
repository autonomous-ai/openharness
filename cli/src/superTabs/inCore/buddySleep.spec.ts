import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CloseAgentService, type CloseAgentServiceDeps } from '../../lib/closeAgentService.js'
import { registry } from '../../lib/registry.js'
import { createSwarmAgents } from './agents.js'
import * as retention from '../retention.js'
import * as team from '../teamDaemon.js'

let dir: string, close: CloseAgentService
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buddy-native-close-'))
  vi.spyOn(team, 'isTeamDaemon').mockReturnValue(false)
})
afterEach(() => {
  close?.dispose()
  for (const row of registry.list()) registry.removeAgent(row.agentId)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

// Keep the real Swarm authority, retention, close guard and idle recheck together. Faking closeMember hid the native
// refusal in #3824: the host correctly asked to sleep, but the ordinary Buddy close guard always kept it running.
function fixture(options: { phase?: 'activity' | 'checkpoint' | 'stop'; revoke?: 'wake' | 'corrupt' | 'switch'; activity?: 'working' | 'unknown' } = {}) {
  const row = registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%88' }], cwd: dir })!
  Object.assign(row, { sessionId: 'kept-conversation', startedBy: 'agent' })
  const hostRow = (agent: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ tabId: 'tab', active: true, buddySleepManaged: true,
    agent: { harnessId: row.agentId, machineId: 'machine', buddyOf: { personId: 'person', generation: 'g' }, asleep: { since: 1 }, ...agent }, ...extra })
  const roster = (agent: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => retention.retainContributions(dir, 'machine', [hostRow(agent, extra)])
  roster()
  const revoke = (phase: string) => {
    if (options.phase !== phase) return
    if (options.revoke === 'corrupt') writeFileSync(retention.retentionFile(dir), '{')
    else if (options.revoke === 'switch') roster({ switchRequest: { id: 'switch', engine: 'codex', requestedBy: 'person' } })
    else roster({ asleep: undefined })
  }
  const deps: CloseAgentServiceDeps = { registry,
    buddyProtected: id => retention.mayBeBuddy(dir, id),
    activity: async () => { revoke('activity'); return options.activity ?? 'idle' },
    checkpoint: async () => { revoke('checkpoint') },
    changed: () => {},
    stop: async (id, options) => {
      await options.checkpoint?.(row, 'before')
      await options.beforeStop?.(row)
      revoke('stop')
      if (options.current?.() === false) throw new Error('close authority revoked')
      registry.removeAgent(id)
    } }
  close = new CloseAgentService(deps)
  const purge = vi.fn(async () => ({ ok: true }))
  const swarm = createSwarmAgents({ byAgent: id => registry.byAgent(id), stoppedIds: () => [], closeAgent: request => close.request(request),
    members: { harnesses: () => retention.retainedHarnesses(dir), leads: () => retention.retainedLeads(dir),
      sleepingBuddies: () => retention.retainedSleepingBuddies(dir) }, purgeEnded: purge })
  return { row, roster, swarm, purge }
}

it('sleeps a server-managed idle Buddy through the real close guard, without deleting its conversation', async () => {
  const f = fixture()
  expect(await f.swarm.closeMember(f.row.agentId)).toEqual({ closed: true })
  expect(registry.byAgent(f.row.agentId)).toBeUndefined()
  expect(f.purge).not.toHaveBeenCalled()
})

it.each(['working', 'unknown'] as const)('preserves a Buddy whose last native activity is %s', async activity => {
  const f = fixture({ activity })
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: 'SESSION_NOT_IDLE' })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})

it.each(['activity', 'checkpoint', 'stop'] as const)('a newer awake roster revokes sleep during %s', async phase => {
  const f = fixture({ phase, revoke: 'wake' })
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: expect.any(String) })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})

it('an unreadable retention revokes sleep after the checkpoint', async () => {
  const f = fixture({ phase: 'checkpoint', revoke: 'corrupt' })
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: expect.any(String) })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})

it.each([
  ['awake', { asleep: undefined }, {}],
  ['thread', { buddySession: { thread: 'root' } }, {}],
  ['engine request', { switchRequest: { id: 'switch', engine: 'codex', requestedBy: 'person' } }, {}],
  ['landed switch', { switchLanded: { id: 'switch', requestedBy: 'person' } }, {}],
  ['model request', { modelRequest: { id: 'request' } }, {}],
  ['Team session', { teamAccount: true }, {}],
  ['unmanaged', {}, { buddySleepManaged: undefined }],
  ['stopping', {}, { stopRequested: true }],
] as const)('keeps a protected %s Buddy running', async (_name, agent, extra) => {
  const f = fixture()
  f.roster(agent, extra)
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: 'BUDDY_PROTECTED' })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})

it('never sleeps a Buddy on a Team daemon or grants a normal window close the sleep permit', async () => {
  const f = fixture()
  const request = { agentId: f.row.agentId, sessionId: f.row.sessionId, createdAt: new Date(f.row.registeredAt).toISOString(), mode: 'idle' as const }
  expect(await close.request(request)).toMatchObject({ error: 'BUDDY_PROTECTED' })
  vi.mocked(team.isTeamDaemon).mockReturnValue(true)
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: 'BUDDY_PROTECTED' })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})

it.each(['activity', 'checkpoint', 'stop'] as const)('an engine switch revokes an in-flight sleep during %s', async phase => {
  const f = fixture({ phase, revoke: 'switch' })
  expect(await f.swarm.closeMember(f.row.agentId)).toMatchObject({ error: expect.any(String) })
  expect(registry.byAgent(f.row.agentId)).toBe(f.row)
})
