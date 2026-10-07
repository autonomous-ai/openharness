import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const installed = vi.hoisted(() => new Map<string, { id: string }>())
vi.mock('../dsh/installed.js', () => ({ installedDsh: (id: string) => installed.get(id) }))
const { storeAgents, wifiCreate, wifiDoors, wifiView } = await import('./wifiAgents.js')

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
  it('gives the Store its evidence on each agent: the harness it runs, its folder as it really is, and whether its engine is up', () => {
    installed.set('autonomous/robot', { id: 'autonomous/robot' })
    const work = join(root, 'work'); mkdirSync(work)
    const link = join(root, 'link'); symlinkSync(work, link)
    const agents = [
      agent({ agentId: 'ready', cwd: link, dsh: 'autonomous/robot', launch: { state: 'ready' } }),
      agent({ agentId: 'unknown-dsh', dsh: 'someone/else', sessionId: 's' }),
      agent({ agentId: 'starting', launch: { state: 'starting' } }),
      agent({ agentId: 'failed', launch: { state: 'failed', error: 'ENGINE_FAILED' } }),
      agent({ agentId: 'failed-detail', launch: { state: 'failed', error: 'ENGINE_FAILED', detail: 'npm said no' } }),
      agent({ agentId: 'no-terminal' }),
      agent({ agentId: 'stopped', active: false }),
      agent({ agentId: 'terminal', engine: 'terminal', sessionId: '' }),
      agent({ agentId: 'unbound', sessionId: '', cwd: null as unknown as string }),
    ]
    const rows = storeAgents({ registry: registryOf(agents, (id) => id !== 'no-terminal'), machineId: () => 'mac' })
    const by = (id: string) => rows.find((row) => row.agentId === id)!
    expect(by('ready')).toEqual({ agentId: 'ready', machineId: 'mac', packageId: 'autonomous/robot', engine: 'claude', workspace: work, state: 'active', runtime: 'ready' })
    expect(by('unknown-dsh')).toMatchObject({ packageId: 'someone/else', workspace: '/nowhere', runtime: 'ready' })
    expect(by('starting').runtime).toBe('starting')
    expect(by('failed')).toMatchObject({ runtime: 'unavailable', error: 'ENGINE_FAILED' })
    expect(by('failed-detail')).toMatchObject({ runtime: 'unavailable', error: 'npm said no' })
    expect(by('no-terminal').runtime).toBe('unavailable')
    expect(by('stopped')).toMatchObject({ state: 'inactive', runtime: 'unavailable' })
    expect(by('terminal').runtime).toBe('ready')
    expect(by('unbound')).toMatchObject({ workspace: null, runtime: 'starting' })
  })

  it('lists the agents the apps are shown, with their names, the Store\'s evidence, and whether each is running', () => {
    const agents = [agent({ agentId: 'a', sessionId: 's-a', launch: { state: 'ready' } }), agent({ agentId: 'b', sessionId: 's-b', cwd: '/b' })]
    const view = wifiView({ registry: registryOf(agents, (id) => id === 'a'), machineId: () => 'mac', displayName: (s) => `name ${s.agentId}`,
      running: (sessionId) => sessionId === 's-a', hasWindow: () => true })
    expect(view.hasWindow).toBe(true)
    expect(view.store).toHaveLength(2)
    expect(view.agents).toEqual([
      { agentId: 'a', name: 'name a', engine: 'claude', packageId: null, workspace: '/nowhere', runtime: 'ready', state: 'running' },
      { agentId: 'b', name: 'name b', engine: 'claude', packageId: null, workspace: '/b', runtime: 'unavailable', state: 'idle' },
    ])
    // An agent the apps are shown but the registry's list does not have (a moment apart): no evidence.
    const odd = { ...registryOf(agents), list: () => [] }
    expect(wifiView({ registry: odd, machineId: () => 'mac', displayName: () => '', running: () => false, hasWindow: () => false }).agents[0])
      .toMatchObject({ packageId: null, workspace: '/nowhere', runtime: 'unavailable' })
  })

  it('makes an agent for a Store harness with the device\'s fixed launch arguments, never over another agent\'s folder', async () => {
    const agents = [agent({ agentId: 'busy', cwd: '/busy' })]
    const created = vi.fn(async () => ({ ok: true as const, session: agent({ agentId: 'made' }) }))
    const create = wifiCreate({ registry: registryOf(agents), machineId: () => 'mac', createAgent: () => created })
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
    expect(await wifiCreate({ registry: registryOf([]), machineId: () => 'mac', createAgent: () => null })('p', 'claude', '/free'))
      .toEqual({ ok: false, error: 'UNSUPPORTED' })
  })
})

describe('the Wi-Fi device\'s doors into the core', () => {
  function doorsWith(over: { window?: boolean; socket?: boolean; devices?: boolean } = {}) {
    const agents = [agent({ agentId: 'a', sessionId: 's-a', engine: 'codex' })]
    const socket = { hasLocalClient: vi.fn(() => over.window !== false), sendFirstLocal: vi.fn(() => true), onCreateAgent: null }
    const deviceInput = { submit: vi.fn(), cancelDelivery: vi.fn(() => true), onTurnStarted: vi.fn() }
    const devices = { stepFocus: vi.fn(async () => ({ machineId: 'mac', agentId: 'a' })), scroll: vi.fn() }
    const answer = vi.fn(async () => ({ ok: true }))
    const stop = vi.fn(async () => true)
    const doors = wifiDoors({
      registry: registryOf(agents), machineId: () => 'mac', displayName: () => 'A', running: () => false,
      socket: () => (over.socket === false ? null : socket), deviceInput: () => deviceInput, answer, stop,
      devices: () => (over.devices === false ? null : devices),
    })
    return { doors, socket, deviceInput, devices, answer, stop }
  }

  it('lists the agents and says whether a window is there', async () => {
    const { doors } = doorsWith()
    expect(await doors.view()).toMatchObject({ agents: [{ agentId: 'a', name: 'A', state: 'idle' }], hasWindow: true })
    expect((await doorsWith({ socket: false }).doors.view()).hasWindow).toBe(false)
  })

  it('types a device\'s prompt through the pane\'s lock, adapted to the agent\'s engine, and lets go of it as its turn starts', () => {
    const { doors, deviceInput } = doorsWith()
    doors.submit('s-a', '/goal ship it', 'd1')
    expect(deviceInput.submit).toHaveBeenCalledWith('a', expect.any(String), 'd1')
    doors.submit('gone', 'hello', 'd2')
    expect(deviceInput.submit).toHaveBeenLastCalledWith('gone', 'hello', 'd2')
    doors.cancel('d1')
    expect(deviceInput.cancelDelivery).toHaveBeenCalledWith('d1')
    doors.started('a', 'hello')
    expect(deviceInput.onTurnStarted).toHaveBeenCalledWith('a', 'hello')
  })

  it('stops a turn and answers a question, never a permission dialog', async () => {
    const { doors, answer, stop } = doorsWith()
    expect(await doors.stop('a')).toBe(true)
    expect(stop).toHaveBeenCalledWith('a')
    expect(await doors.answer('a', 'r', { q: 'yes' })).toBe(true)
    expect(answer).toHaveBeenCalledWith({ agentId: 'a', requestId: 'r', answers: { q: 'yes' }, allowPermissions: false })
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

  it('asks the first window to show an agent, or a Store preparation\'s, with this machine named', () => {
    const { doors, socket } = doorsWith()
    expect(doors.focusApp('a', 123, 'rev')).toBe(true)
    expect(socket.sendFirstLocal).toHaveBeenCalledWith({ type: 'device_focus', payload: { machineId: 'mac', agentId: 'a', expiresAt: 123, focusRevision: 'rev' } })
    doors.reveal('op', 'a')
    expect(socket.sendFirstLocal).toHaveBeenLastCalledWith({ type: 'device_prepare_open', payload: { operationId: 'op', machineId: 'mac', agentId: 'a' } })
    const none = doorsWith({ socket: false }).doors
    expect(none.focusApp('a', 1, 'r')).toBe(false)
    expect(none.reveal('op', 'a')).toBeUndefined()
  })
})
