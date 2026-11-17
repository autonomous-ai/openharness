import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { createLaunchAuthority } from './launchAuthority.js'

const agent = () => ({ agentId: 'fixture-agent', engine: 'claude', sessionId: 'conversation', registeredAt: 1,
  boundAt: 2, cwd: '/workspace', active: true, processIdentity: { pid: 42, startMarker: 'old' },
  runtimes: [{ backend: 'tmux', paneId: '%7' }], gridLaunch: { model: 'original' },
}) as unknown as RegisteredSession

describe('launch preparation authority', () => {
  it('captures binding and operation revision, independently of the mutable registry object', () => {
    let row: RegisteredSession | undefined = agent(), revision = 1, cancelled = false
    const authority = createLaunchAuthority({ byAgent: () => row, revision: () => revision, cancelled: () => cancelled })
    const current = authority(row.agentId)
    expect(current()).toBe(true)
    cancelled = true; expect(current()).toBe(false)
    cancelled = false; revision++; expect(current()).toBe(false)
    const next = authority(row.agentId)
    row = undefined; expect(next()).toBe(false)
  })

  it.each([
    { cwd: '/replacement' }, { engine: 'codex' }, { sessionId: 'replacement' }, { registeredAt: 3 },
    { boundAt: 3 }, { processIdentity: { pid: 42, startMarker: 'replacement' } },
    { runtimes: [{ backend: 'tmux', paneId: '%8' }] }, { codexHome: '/profile' },
    { dsh: 'fixture/other' }, { dshRuntime: 'other' }, { agent: 'other' },
    { gridLaunch: { model: 'replacement' } }, { scmLaunch: { kind: 'fixture' } },
    { subscriptionModel: 'replacement' }, { permissionMode: 'auto' }, { bypassPermission: true },
    { active: false }, { launch: { state: 'held', service: 'store' } }, { externalResume: { token: 'other' } },
  ])('revokes after changed launch facts: %j', change => {
    const row = agent()
    const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })(row.agentId)
    Object.assign(row, change)
    expect(current()).toBe(false)
  })

  it('allows display-only updates and route ordering without losing the original target', () => {
    const row = agent()
    row.runtimes.push({ backend: 'tmux', paneId: '%9' })
    const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })(row.agentId)
    row.runtimes.reverse()
    row.defaultName = 'Display name'
    expect(current()).toBe(true)
    row.gridLaunch!.model = 'changed in place'
    expect(current()).toBe(false)
  })

  it('can prepare an absent stopped row until another live binding appears', () => {
    let row: RegisteredSession | undefined
    const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })('fixture-agent')
    expect(current()).toBe(true)
    row = agent()
    expect(current()).toBe(false)
  })
})
