import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { AgentEngine } from '../../engines/types.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { BYPASS_PERMISSION_FLAGS, PERMISSION_MODES, dropPermissionFlagIfUnsupported, permissionFlagToVerify, permissionModeFlags } from '../../lib/engineLaunch.js'
import { DEFAULT_HARNESS_PERMISSION } from '../../lib/harnessDefaults.js'
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

  it.each(Object.keys(PERMISSION_MODES) as AgentEngine[])('keeps %s authority when discovery names the same approving mode', async engine => {
    expect(DEFAULT_HARNESS_PERMISSION).toBe('auto')
    // This is the launch contract: an unnamed approving launch already uses auto's exact flags.
    expect(permissionModeFlags(engine, 'auto')).toEqual(BYPASS_PERMISSION_FLAGS[engine])
    for (const before of [undefined, null]) {
      const row = { ...agent(), engine, bypassPermission: true }
      Object.assign(row, { permissionMode: before })
      const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })(row.agentId)
      row.permissionMode = 'auto'
      expect(current()).toBe(true)
      row.permissionMode = 'full'
      expect(current()).toBe(false)
      row.permissionMode = 'ask'
      expect(current()).toBe(false)
      row.permissionMode = 'auto'; row.bypassPermission = false
      expect(current()).toBe(false)
    }
  })

  it.each(Object.keys(PERMISSION_MODES) as AgentEngine[])('keeps %s permission fallback equivalent after the same mode is named', async engine => {
    const unnamed = { bypassPermission: true, permissionMode: null }
    const named = { bypassPermission: true, permissionMode: 'auto' }
    const flag = permissionFlagToVerify(engine, unnamed)
    expect(permissionFlagToVerify(engine, named)).toBe(flag)
    for (const support of ['supported', 'unsupported', 'unknown'] as const) {
      const native = { permission: async (choice: typeof unnamed | typeof named) => {
        expect(permissionFlagToVerify(engine, choice)).toBe(flag)
        return support
      } } as NativeLaunch
      const before = await dropPermissionFlagIfUnsupported(engine, unnamed, native)
      const after = await dropPermissionFlagIfUnsupported(engine, named, native)
      expect(permissionFlagToVerify(engine, after.choice)).toBe(permissionFlagToVerify(engine, before.choice))
      expect(after.choice.bypassPermission).toBe(before.choice.bypassPermission)
      expect(after.droppedFlag).toBe(before.droppedFlag)
      expect(after.nativeHold).toBe(before.nativeHold)
    }
  })

  it.each([
    [{ state: 'ready' }, undefined],
    [undefined, { state: 'ready' }],
  ] as const)('keeps its target when a ready launch is written %j and read %j', (before, after) => {
    const row = agent()
    if (before) row.launch = { ...before }
    const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })(row.agentId)
    if (after) row.launch = { ...after }; else delete row.launch
    expect(current()).toBe(true)
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
