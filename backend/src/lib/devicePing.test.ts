import { EventEmitter } from 'node:events'
import { afterAll, expect, it, vi } from 'vitest'

// A device's 15 s presence ping is for the backend alone: its liveness rides the socket (hub.ts
// trackSocketLiveness). Relayed to the attached machine, the ping reached a daemon that has no use for it
// and refused it as plaintext, a warning every 15 s per device.
const m = vi.hoisted(() => {
  // Before hub.ts is imported: its liveness sweep is a module-level interval.
  vi.useFakeTimers()
  return {
    auth: vi.fn(async () => ({ sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' })),
    upgrade: vi.fn(),
    sendDown: vi.fn(),
  }
})
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('../services/index.js', () => ({
  deviceService: {
    resolveOrCreateForComputer: vi.fn(async () => ({ userId: 'owner', deviceId: 'dial-1' })),
    machinesForUser: vi.fn(async () => []), setActiveMachine: vi.fn(async () => {}), recordHello: vi.fn(async () => {}),
  },
}))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: vi.fn(async () => ({ machineId: 'mac', userId: 'owner', autonomousEnv: 'prod', billingStatus: 'not_required', authMode: 'remote', deletedAt: null })) } },
  machineAlive: {},
}))
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: vi.fn(async () => 'running') }))
vi.mock('./bus.js', () => ({
  getAgentPresence: vi.fn(async () => null), getAgentPresenceMany: vi.fn(async () => new Map()), getMachineAppStateMany: vi.fn(async () => new Map()),
  subscribeStatus: vi.fn(async () => () => {}), setDevicePresence: vi.fn(async () => {}), clearDevicePresence: vi.fn(async () => 'cleared'),
  publishDeviceStatus: vi.fn(async () => {}), subscribeDeviceControl: vi.fn(async () => () => {}), publishDeviceControl: vi.fn(async () => {}),
  subscribeDeviceMachineListChanged: vi.fn(async () => () => {}), setDeviceLastMachine: vi.fn(async () => {}), getDeviceLastMachine: vi.fn(async () => null),
  parkVoiceUpload: vi.fn(async () => {}), resumeVoiceUpload: vi.fn(async () => null), evictVoiceUpload: vi.fn(async () => {}),
  bumpCommanderJoinGeneration: vi.fn(), getAgentClientState: vi.fn(), publishDown: vi.fn(), publishTerminalDown: vi.fn(), publishUp: vi.fn(),
  setAgentClientCount: vi.fn(), setAgentClientCountsBatch: vi.fn(), subscribeUp: vi.fn(), subscribeTerminalUp: vi.fn(),
}))
vi.mock('./dailyTracking.js', async original => ({ ...await original<typeof import('./dailyTracking.js')>(), touchDeviceOnlineDay: vi.fn(async () => {}) }))
// The real hub, so the socket's real liveness deadline is what keeps it or drops it; only the machine side is faked.
vi.mock('./hub.js', async original => ({
  ...await original<typeof import('./hub.js')>(),
  attachHubClient: vi.fn(() => ({ connId: 'conn-1', sendDown: m.sendDown, setActive: vi.fn(), detach: vi.fn() })),
}))

import { handleDeviceUpgrade } from './deviceWs.js'
import { DEVICE_IDLE_DEADLINE_MS } from './hub.js'

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  ping = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string)) }
}
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })

afterAll(() => { vi.useRealTimers() })

it('a device attached to a machine pings the backend alone, and the ping still keeps its socket alive', async () => {
  const device = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(device))
  handleDeviceUpgrade({ url: '/api/device-ws?computer=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', headers: { 'sec-websocket-protocol': 'access-token' } } as never,
    raw() as never, Buffer.alloc(0))
  await flush()
  device.frame({ type: 'machine_select', payload: { machineId: 'mac' } })
  await flush()
  expect(device.sent()).toContainEqual({ type: 'machine_selected', payload: { machineId: 'mac' } })

  // Twice the silence deadline, the device's own 15 s ping its only traffic.
  for (let t = 0; t < 2 * DEVICE_IDLE_DEADLINE_MS; t += 15_000) {
    device.frame({ type: 'ping' })
    await vi.advanceTimersByTimeAsync(15_000)
  }
  expect(m.sendDown).not.toHaveBeenCalled()
  expect(device.terminate).not.toHaveBeenCalled()

  // The same socket, silent, is dropped: the sweep above was live.
  await vi.advanceTimersByTimeAsync(DEVICE_IDLE_DEADLINE_MS + 5_000)
  expect(device.terminate).toHaveBeenCalled()
})
