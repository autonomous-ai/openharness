import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { BackendSocket } from '../backendSocket.js'
import { attachLocalWsServer, type LocalWsServer } from '../localWsServer.js'
import { createQuestionResponse, createQuestions } from '../core/questions.js'
import { emptyPorts, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { observeQuestions } from '../agentClient/questions.js'
import { snapshotFixture, snapshotRow, snapshotReader } from '../testing/sessionSnapshot.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi } from './wifi.js'
import { GatewayDeviceFixture } from '../testing/devicePeer.js'
import { observeDeviceSessions } from '../lib/autonomous-device/sessionFeed.js'
import { listenLocalSocket, localSocketPath } from '../lib/localSocket.js'

let peer: GatewayDeviceFixture
vi.mock('../lib/autonomous-device/peerConnection.js', () => ({ devicePeerConnection: vi.fn(options => {
  peer = new GatewayDeviceFixture(options)
  return peer
}) }))

let server: http.Server | undefined, local: LocalWsServer | undefined, port: WifiPort | undefined, dataDir: string | undefined
let unix: Awaited<ReturnType<typeof listenLocalSocket>> | undefined
afterEach(async () => {
  await port?.stop()
  await local?.close()
  await unix?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  port = undefined; local = undefined; server = undefined; dataDir = undefined; unix = undefined
  vi.restoreAllMocks()
})

it('keeps all-agent questions working through real component tool connections, including initial state and reconnect closes', async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wifi-questions-'))
  const backend = new BackendSocket('machine-1')
  const asking = createQuestions({
    questionControlFor: () => undefined, readQuestion: () => ({ kind: 'none' }) as never, resolve: () => undefined,
    terminal: { captureTerminal: async () => null, submitTerminal: async () => true, keyTerminal: async () => true },
    acquireTerminalControl: () => null, clients: backend, agentIdFor: id => id, sessionTurnOpen: () => false,
    observed: agentId => backend.questionsObserved(agentId), input: { setUserAction: () => {} }, waitOver: () => {},
  })
  backend.questionSnapshot = () => asking.snapshot('local')
  const watcher = Reflect.get(asking.questionWatcher, 'deps') as {
    hasDevice(id: string): boolean; onQuestion(id: string, requestId: string, questions: unknown[]): void; onQuestionGone(id: string, requestId: string): void
  }
  expect(watcher.hasDevice('unfocused')).toBe(false)
  watcher.onQuestion('unfocused', 'existing', [{ key: 'Which?', q: 'Which?', options: ['One'], multi: false }])
  server = http.createServer()
  if (process.platform !== 'win32') unix = await listenLocalSocket((_req, res) => res.end(), localSocketPath(dataDir, 18473)!)
  local = attachLocalWsServer(server, { machineId: 'machine-1', backend, openQuestions: () => asking.snapshot('local'), localSocketServer: unix?.server })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`
  const core = fakeCore({ dataDir, agents: { readSessions: vi.fn(snapshotReader(async () => snapshotFixture({ hasWindow: false,
    registered: ['agent', 'unfocused'].map(agentId => snapshotRow(agentId)),
  }))) } })
  let service!: AutonomousDeviceService
  const ports = emptyPorts()
  startWifi(core, ports, {
    service: options => service = new AutonomousDeviceService(options),
    observeQuestions: (listener, budget) => observeQuestions({ port: 1, dataDir: dataDir!, machineId: 'machine-1' }, listener, () => new WebSocket(url), budget),
    ...(unix ? {} : { observeSessions: (options: Parameters<typeof observeDeviceSessions>[1]) =>
      observeDeviceSessions({ port: 1, dataDir: dataDir!, machineId: 'machine-1' }, options, () => new WebSocket(url)) }),
  })
  port = ports.wifi!
  const client = { role: 'device' as const, identity: 'fixture-device', direct: true, label: 'Fixture' }
  await port.resume({ focus: null })
  peer.session('device', client)
  await peer.request('device', { type: 'hello', proto: 1, requestId: 'hello' })
  await vi.waitFor(() => expect(peer.replies().some(payload => payload.type === 'hello_result')).toBe(true))
  expect(watcher.hasDevice('unfocused')).toBe(true)
  expect(watcher.hasDevice('agent')).toBe(true)
  expect(backend.hasLocalClient()).toBe(false)
  expect(backend.hasCommander()).toBe(false)
  expect(backend.hasRemoteApp()).toBe(false)
  const status = (agentId: string) => service.request('fixture-device', { type: 'status', requestId: randomUUID(), machineId: 'machine-1', agentId })
  expect((await status('unfocused')).openQuestion).toMatchObject({ requestId: 'existing' })
  watcher.onQuestion('agent', 'live', [{ key: 'Continue?', q: 'Continue?', options: ['Yes'], multi: false }])
  await vi.waitFor(async () => expect((await status('agent')).openQuestion).toMatchObject({ requestId: 'live' }))
  port.disconnected()
  await vi.waitFor(() => expect(watcher.hasDevice('unfocused')).toBe(false))
  expect(await status('agent')).toMatchObject({ error: { code: 'QUESTION_STATE_UNAVAILABLE' } })
  watcher.onQuestionGone('unfocused', 'existing')
  await port.resume({ focus: null })
  await vi.waitFor(() => expect(watcher.hasDevice('unfocused')).toBe(true))
  expect((await status('unfocused')).openQuestion).toBeNull()
  expect((await status('agent')).openQuestion).toMatchObject({ requestId: 'live' })
  const answer = vi.fn(async () => ({ ok: true as const }))
  backend.questionProvider = createQuestionResponse(answer)
  const answered = await service.request('fixture-device', { type: 'question.answer', requestId: randomUUID(), machineId: 'machine-1',
    agentId: 'agent', questionRequestId: 'live', answers: { 'Continue?': 'Yes' }, idempotencyKey: randomUUID() })
  expect(answered.receipt).toMatchObject({ state: 'completed' })
  expect(answer).toHaveBeenCalledExactlyOnceWith({ agentId: 'agent', requestId: 'live', answers: { 'Continue?': 'Yes' }, allowPermissions: false })
  expect((await status('agent')).openQuestion).toBeNull()
  expect(backend.hasLocalClient()).toBe(false)
  peer.drop('device')
  await vi.waitFor(() => expect(watcher.hasDevice('agent')).toBe(false))
})
