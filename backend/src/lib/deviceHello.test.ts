import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it, vi } from 'vitest'

// A device's hello names its version. A Harness CLI's version is never firmware: it is stored as cliVersion,
// whether the CLI is new (cliVersion) or older (firmwareVersion); a dial's stays firmwareVersion. Both pass
// the one version check, and a value that fails it is dropped (spec 2026-11-27-cli-version-field-design.md).
const m = vi.hoisted(() => {
  // Before hub.ts is imported: its liveness sweep is a module-level interval.
  vi.useFakeTimers()
  return {
    auth: vi.fn(async () => ({ sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' })),
    upgrade: vi.fn(),
    sendDown: vi.fn(),
    recordHello: vi.fn(async (_input: Record<string, unknown>) => {}),
  }
})
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('../services/index.js', () => ({
  deviceService: {
    resolveOrCreateForComputer: vi.fn(async () => ({ userId: 'owner', deviceId: 'dial-1' })),
    machinesForUser: vi.fn(async () => []), setActiveMachine: vi.fn(async () => {}), recordHello: m.recordHello,
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
vi.mock('./hub.js', async original => ({
  ...await original<typeof import('./hub.js')>(),
  attachHubClient: vi.fn(() => ({ connId: 'conn-1', sendDown: m.sendDown, setActive: vi.fn(), detach: vi.fn() })),
}))

import { handleDeviceUpgrade } from './deviceWs.js'
import { logger } from '../utils/logger.js'

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  ping = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
}
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })

afterAll(() => { vi.useRealTimers() })

// The hello a new CLI really sends: its spec pins the CLI's frame to this same file.
const NEW_CLI_HELLO = JSON.parse(readFileSync(new URL('../../../tests/fixtures/cli-device-hello.json', import.meta.url), 'utf8'))
const info = vi.spyOn(logger, 'info')

/** One device socket that says [payload] as its hello; what reached recordHello. */
async function hello(payload: Record<string, unknown>) {
  const device = new Socket()
  m.upgrade.mockImplementationOnce((_r, _s, _h, done) => done(device))
  handleDeviceUpgrade({ url: `/api/device-ws?computer=${'a'.repeat(32)}`, headers: { 'sec-websocket-protocol': 'access-token' } } as never,
    raw() as never, Buffer.alloc(0))
  await flush()
  device.frame({ type: 'device_hello', payload })
  await flush()
  device.close()
  return m.recordHello.mock.lastCall?.[0]
}
const facts = (over: Record<string, unknown>) => ({ deviceId: 'dial-1', chip: 'harness-cli', ssid: null, rssi: null, ...over })
const CAPS = ['e2ee_data', 'multi_machine']

it('a new CLI\'s hello stores its cliVersion and no firmwareVersion', async () => {
  expect(await hello(NEW_CLI_HELLO.payload)).toEqual(facts({ cliVersion: '0.6.97', firmwareVersion: null }))
  expect(info).toHaveBeenCalledWith('commander device_hello', expect.objectContaining({ cliVersion: '0.6.97', firmwareVersion: null }))
})

it('an older CLI\'s firmwareVersion is stored as its cliVersion, never as firmware', async () => {
  expect(await hello({ chip: 'harness-cli', firmwareVersion: '0.6.96', caps: CAPS }))
    .toEqual(facts({ cliVersion: '0.6.96', firmwareVersion: null }))
})

it('a dial keeps its firmwareVersion, and a cliVersion it sends is ignored', async () => {
  expect(await hello({ chip: 'esp32s3', firmwareVersion: '0.2.9', cliVersion: '0.6.97' }))
    .toEqual(facts({ chip: 'esp32s3', cliVersion: null, firmwareVersion: '0.2.9' }))
})

it('a version that fails the check is dropped, and a failing cliVersion does not fall back to firmwareVersion', async () => {
  expect(await hello({ chip: 'harness-cli', cliVersion: 'x'.repeat(65), firmwareVersion: '0.6.96', caps: CAPS }))
    .toEqual(facts({ cliVersion: null, firmwareVersion: null }))
  expect(await hello({ chip: 'esp32s3', firmwareVersion: '0.2.9 beta' }))
    .toEqual(facts({ chip: 'esp32s3', cliVersion: null, firmwareVersion: null }))
})
