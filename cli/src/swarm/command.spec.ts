import { describe, expect, it, vi } from 'vitest'
import { swarmCommand, SWARM_USAGE } from './command.js'

const session = { machineId: 'm1' } as never
const headers = { authorization: 'Bearer x' }
const parts = (over: Record<string, unknown> = {}) => ({
  tabId: 't1', format: 2, serverTime: Date.now(), lastChangedAt: Date.now() - 3000,
  head: { data: { id: 't1', name: 'autonomous-harness', ownerId: 'u1', paused: false } },
  members: [{ data: { id: 'u1', email: 'owner@x.io', role: 'owner' } }],
  machines: [{ data: { machineId: 'm1', name: 'gridtest', contributorId: 'u1', engines: [{ engine: 'claude' }],
    observation: { receivedAt: Date.now() - 2000, sessionKind: 'team' } } }],
  agents: [{ data: { id: 'a1', name: 'Lead', machineId: 'm1', configuration: { engine: 'claude' }, leadOf: 'p1' } }],
  groups: [{ data: { id: 'lead', title: 'autonomous-harness', leadId: 'a1' } }],
  starts: [
    { data: { id: 's1', harnessId: 'h1', request: { name: 'builder one', conversationId: 'lead', machineId: 'm1' }, requestedAt: Date.now() - 1000 } },
    { data: { id: 's2', error: 'Its machine could not prepare or launch it.', request: { name: 'builder two', conversationId: 'lead', machineId: 'm1' }, requestedAt: Date.now() - 4000 } },
  ],
  ...over,
})

function setup(routes: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const out: string[] = [], errors: string[] = []
  const get = vi.fn(async (path: string) => routes[path] ?? {})
  const deps = { out: (line: string) => out.push(line), err: (line: string) => errors.push(line),
    auth: async () => ({ session, headers }), get, ...over }
  return { deps, out, errors, get }
}

const routes = {
  '/api/super-tabs/list': { tabs: [{ id: 't1', name: 'autonomous-harness' }] },
  '/api/super-tabs/t1/parts': parts(),
}

describe('harness swarm', () => {
  it('lists Swarms with their people, machines and work', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['list'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    expect(text).toContain('SWARM')
    expect(text).toContain('autonomous-harness')
    expect(text).toContain('1 agent, 1 failed')
  })

  it('shows one Swarm: people, machines, work, lead, updated', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['status'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    expect(text).toContain('autonomous-harness')
    expect(text).toContain('people      1')
    expect(text).toContain('machines    1')
    expect(text).toContain('work        1 running, 0 pending, 1 failed')
    expect(text).toContain('lead        Lead on gridtest (team account)')
  })

  it('lists machines with owner, engines, agents and state, and never draws icons', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['machines'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    expect(text).toContain('MACHINE')
    expect(text).toContain('gridtest (team account)')
    expect(text).toContain('owner@x.io')
    expect(text).toContain('live')
    expect(text).not.toContain('·')
  })

  it('lists agents with their machine and engine', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['agents'], f.deps)).toBe(0)
    expect(f.out.join('\n')).toContain('Lead')
    expect(f.out.join('\n')).toContain('claude')
  })

  it('lists starts and says why one failed', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['starts'], f.deps)).toBe(0)
    const text = f.out.join('\n')
    expect(text).toContain('builder one')
    expect(text).toContain('running')
    expect(text).toContain('failed: Its machine could not prepare or launch it.')
    expect(text).toContain('Why it failed')
  })

  it('names one Swarm with --tab, and prints help without a verb', async () => {
    const f = setup(routes)
    expect(await swarmCommand(['status', '--tab', 't1'], f.deps)).toBe(0)
    expect(f.get).toHaveBeenCalledWith('/api/super-tabs/t1/parts', headers)
    expect(await swarmCommand([], f.deps)).toBe(0)
    expect(f.out.join('\n')).toContain('Usage: harness swarm')
    expect(SWARM_USAGE).toContain('starts')
  })

  it('says there is no Swarm instead of failing', async () => {
    const f = setup({ '/api/super-tabs/list': { tabs: [] } })
    expect(await swarmCommand(['status'], f.deps)).toBe(0)
    expect(f.out.join('\n')).toContain('No Swarm on this account yet.')
  })

  it('reports a refused read as one plain line', async () => {
    const f = setup({}, { get: async () => { throw new Error('You are not a member of this Swarm.') } })
    expect(await swarmCommand(['status', '--tab', 't1'], f.deps)).toBe(1)
    expect(f.errors.join('\n')).toContain('error: You are not a member of this Swarm.')
  })
})
