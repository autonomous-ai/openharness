import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const installed = vi.hoisted(() => new Map<string, { id: string }>())
vi.mock('../dsh/installed.js', () => ({ installedDsh: (id: string) => installed.get(id) }))
const { wifiCreate, wifiDoors } = await import('./wifiAgents.js')

let root: string
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'wifi-agents-'))); installed.clear() })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const agent = (over: Partial<RegisteredSession>): RegisteredSession =>
  ({ agentId: 'a', sessionId: 's-a', engine: 'claude', cwd: '/nowhere', active: true, dsh: null, ...over }) as RegisteredSession

function registryOf(agents: RegisteredSession[], terminal = (_agentId: string) => true) {
  return {
    list: () => agents,
    advertised: () => agents.filter((a) => a.active),
    terminalAvailable: terminal,
    resolve: (id: string) => agents.find((a) => a.agentId === id || a.sessionId === id),
  }
}

describe('the agents as the Wi-Fi device lists them', () => {
  it('keeps canonical hidden and inactive workspace admission at the existing creator checkpoint', async () => {
    const work = join(root, 'work'); mkdirSync(work)
    const alias = join(root, 'alias'); symlinkSync(work, alias)
    const rows = [agent({ cwd: null as unknown as string }), agent({ cwd: alias, active: false })]
    const created = vi.fn(async () => ({ ok: true as const, session: agent({}) }))
    const create = wifiCreate({ registry: registryOf(rows), createAgent: () => created })
    expect(await create('package', 'claude', work)).toEqual({ ok: false, error: 'WORKSPACE_IN_USE' })
    expect(created).not.toHaveBeenCalled()
  })

  it('makes an agent for a Store harness with the device\'s fixed launch arguments, never over another agent\'s folder', async () => {
    const agents = [agent({ agentId: 'busy', cwd: '/busy' })]
    const created = vi.fn(async () => ({ ok: true as const, session: agent({ agentId: 'made' }) }))
    const create = wifiCreate({ registry: registryOf(agents), createAgent: () => created })
    expect(await create('autonomous/robot', 'claude', '/busy')).toEqual({ ok: false, error: 'WORKSPACE_IN_USE' })
    expect(created).not.toHaveBeenCalled()
    expect(await create('autonomous/robot', 'codex', '/free')).toEqual({ ok: true, agentId: 'made' })
    expect(created).toHaveBeenCalledWith({ engine: 'codex', cwd: '/free', dsh: 'autonomous/robot', bypassPermission: false,
      permissionMode: null, grid: null, codexHome: null, prompt: null, name: null, agent: null })
    created.mockResolvedValueOnce({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' } as never)
    expect(await create('autonomous/robot', 'claude', '/free')).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'tmux said no' })
    created.mockResolvedValueOnce({ ok: false, error: 'INVALID_DSH' } as never)
    expect(await create('autonomous/robot', 'claude', '/free')).toEqual({ ok: false, error: 'INVALID_DSH' })
    // Before the socket exists, nothing can be made.
    expect(await wifiCreate({ registry: registryOf([]), createAgent: () => null })('p', 'claude', '/free'))
      .toEqual({ ok: false, error: 'UNSUPPORTED' })
  })
})

describe('the Wi-Fi device\'s doors into the core', () => {
  function doorsWith(over: { window?: boolean; socket?: boolean; devices?: boolean } = {}) {
    const agents = [agent({ agentId: 'a', sessionId: 's-a', engine: 'codex' })]
    const socket = { hasLocalClient: vi.fn(() => over.window !== false), onCreateAgent: null }
    const devices = { stepFocus: vi.fn(async () => ({ machineId: 'mac', agentId: 'a' })), scroll: vi.fn() }
    const stop = vi.fn(async () => true)
    const doors = wifiDoors({
      registry: registryOf(agents),
      socket: () => (over.socket === false ? null : socket), stop,
      devices: () => (over.devices === false ? null : devices),
    })
    return { doors, socket, devices, stop }
  }

  it('stops a turn and refuses unsupported creation', async () => {
    const { doors, stop } = doorsWith()
    expect(await doors.stop('a')).toBe(true)
    expect(stop).toHaveBeenCalledWith('a')
    expect(await doors.create('p', 'claude', '/x')).toEqual({ ok: false, error: 'UNSUPPORTED' })
  })

  it('walks the desk and scrolls through the dials\' own, with a window to show it', async () => {
    const { doors, devices } = doorsWith()
    expect(await doors.stepFocus('next', 'a')).toEqual({ machineId: 'mac', agentId: 'a' })
    expect(devices.stepFocus).toHaveBeenCalledWith('next', 'a')
    expect(doors.scroll('move', 4, 10)).toBe(true)
    expect(devices.scroll).toHaveBeenCalledWith('move', 4, 10)
    expect(await doorsWith({ window: false }).doors.stepFocus('next')).toBe('no_app')
    expect(doorsWith({ window: false }).doors.scroll('down', 0, 0)).toBe(false)
    expect(await doorsWith({ devices: false }).doors.stepFocus('previous')).toBe('no_agents')
    expect(doorsWith({ devices: false }).doors.scroll('up', 0, 0)).toBe(true)
  })

  it('owns no feature-specific window payload builder', () => {
    const { doors } = doorsWith()
    expect(doors).not.toHaveProperty('focusApp')
    expect(doors).not.toHaveProperty('reveal')
  })
})
