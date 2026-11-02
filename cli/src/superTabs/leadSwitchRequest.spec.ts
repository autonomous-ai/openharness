import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Daemon } from '../agentClient/daemon.js'
import { fakeCore } from '../testing/fakeCore.js'
import { LeadSwitchRequests, type SwitchRow } from './leadSwitchRequest.js'

const request = { id: 'sw1', engine: 'claude', profileId: 'p1' }
const row = (over: Record<string, unknown> = {}): SwitchRow => ({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h1', switchRequest: request, ...over } })

function setup(options: { claim?: boolean; home?: string | null; team?: boolean; refuse?: string; live?: boolean; resultStale?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lead-switch-'))
  const calls: Array<[string, Record<string, unknown>]> = []
  const posted: Array<Record<string, unknown>> = []
  let live = options.live ?? true
  const backend = vi.fn(async (_method: string, _path: string, body: unknown) => {
    const command = (body as { command: Record<string, unknown> }).command
    posted.push(command)
    if (command.type === 'agent.switchClaim' && options.claim === false) return { status: 403, body: { success: false, error: { code: 'STALE_SWITCH', message: 'no' } } }
    if (command.type === 'agent.switchResult' && options.resultStale) return { status: 403, body: { success: false, error: { code: 'STALE_SWITCH', message: 'settled' } } }
    return { status: 200, body: { success: true, data: { result: {} } } }
  })
  const daemon: Daemon = { machineId: 'm1', close: vi.fn(), request: vi.fn(async (type, payload = {}) => {
    calls.push([type, payload])
    if (type === 'agent_handoff_prepare') {
      return { agentId: 'h1', file: `.harness/handoff/h1-${payload.changeId}.md`, gitRepo: true, cwd: '/work', degraded: [] }
    }
    if (type === 'agent_close') { live = false; return { closed: true } }
    if (type === 'agent_create') return options.refuse ? { error: options.refuse } : { agent: { id: 'h2' } }
    return {}
  }) }
  const core = fakeCore({ dataDir, account: { backend },
    agents: { byAgent: vi.fn((id: string) => id === 'h1' && live ? { agentId: 'h1', engine: 'codex', cwd: '/work', permissionMode: 'ask', bypassPermission: false, defaultName: 'PM' } as never : undefined) } })
  const profiles = vi.fn(() => options.home === undefined ? '/home/p1' : options.home)
  const switches = new LeadSwitchRequests(core, 'm1', { open: async () => daemon, profiles: profiles as never, team: () => options.team === true })
  return { switches, calls, posted, daemon, profiles }
}

describe('a PM host carrying out a switch the Swarm asked for', () => {
  it('claims, prepares the handoff, closes with the change id, creates with creationId = changeId and the profile home, completes the handoff', async () => {
    const t = setup()
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close', 'agent_create', 'agent_handoff_complete'])
    const changeId = String(t.calls[0][1].changeId)
    expect(changeId).toMatch(/^[0-9a-f]{32}$/)
    expect(t.calls[1][1]).toEqual({ agentId: 'h1', mode: 'now', changeId })
    expect(t.calls[2][1]).toMatchObject({ engine: 'claude', cwd: '/work', creationId: changeId, claudeHome: '/home/p1', permissionMode: 'ask', name: 'PM' })
    expect(String(t.calls[2][1].prompt)).toContain(`.harness/handoff/h1-${changeId}.md`)
    expect(t.calls[3][1]).toEqual({ agentId: 'h1', replacementId: 'h2', changeId, targetEngine: 'claude' })
  })

  it('reports ok once agent.rebind is seen for the PM', async () => {
    const t = setup()
    await t.switches.serve(row())
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    expect(t.posted.at(-1)).toEqual({ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: true })
  })

  it('reports ok:false and leaves the old PM to the keep-alive when the create is refused', async () => {
    const t = setup({ refuse: 'SPAWN_LIMIT' })
    await t.switches.serve(row())
    expect(t.posted.at(-1)).toEqual({ type: 'agent.switchResult', agentId: 'a1', switchId: 'sw1', ok: false, error: 'the new session could not start' })
    expect(t.calls.map(c => c[0])).toEqual(['agent_handoff_prepare', 'agent_close', 'agent_create'])
  })

  it('refuses a gone profile without closing the PM, and a Team daemon any profile but the default', async () => {
    for (const t of [setup({ home: null }), setup({ team: true })]) {
      await t.switches.serve(row())
      expect(t.posted.at(-1)).toMatchObject({ type: 'agent.switchResult', ok: false, error: 'that account is no longer on this machine' })
      expect(t.calls).toEqual([])
    }
  })

  it('does nothing for a request it cannot claim', async () => {
    const t = setup({ claim: false })
    await t.switches.serve(row())
    expect(t.posted.map(c => c.type)).toEqual(['agent.switchClaim'])
    expect(t.calls).toEqual([])
  })

  it('treats a result the Swarm already settled as done', async () => {
    const t = setup({ resultStale: true })
    await t.switches.serve(row())
    await t.switches.serve({ tabId: 'tab', agent: { id: 'a1', harnessId: 'h2' } })
    const sent = t.posted.length
    await t.switches.serve(row())
    expect(t.posted.length).toBe(sent)
  })
})
