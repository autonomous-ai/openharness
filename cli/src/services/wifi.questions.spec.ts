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
import { createQuestions } from '../core/questions.js'
import { emptyPorts, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { observeQuestions } from '../agentClient/questions.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi } from './wifi.js'

let server: http.Server | undefined, local: LocalWsServer | undefined, port: WifiPort | undefined, dataDir: string | undefined
afterEach(async () => {
  await port?.stop()
  await local?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve())
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  port = undefined; local = undefined; server = undefined; dataDir = undefined
  vi.restoreAllMocks()
})

it('keeps all-agent questions working with only the real Wi-Fi tool connection, including initial state and reconnect closes', async () => {
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
  local = attachLocalWsServer(server, { machineId: 'machine-1', backend, openQuestions: () => asking.snapshot('local') })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-ws`
  const core = fakeCore({ dataDir, wifi: { view: vi.fn(async () => ({ hasWindow: false, store: [], agents: ['agent', 'unfocused'].map(agentId => ({
    agentId, name: 'Fixture', engine: 'claude', state: 'idle',
  })) })) } })
  let service!: AutonomousDeviceService
  const ports = emptyPorts()
  startWifi(core, ports, {
    service: options => service = new AutonomousDeviceService(options),
    observeQuestions: listener => observeQuestions({ port: 1, dataDir: dataDir!, machineId: 'machine-1' }, listener, () => new WebSocket(url)),
  })
  port = ports.wifi!
  const client = { role: 'device' as const, identity: 'fixture-device', direct: true, label: 'Fixture' }
  port.session('device', client)
  await port.request('device', { payload: { __e2e: true } }, { payload: { type: 'hello', proto: 1, requestId: 'hello' } })
  await vi.waitFor(() => expect(vi.mocked(core.wifi.send).mock.calls.some(([, , , payload]) => payload.type === 'hello_result')).toBe(true))
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
  await port.resume({ sessions: [{ connId: 'device', client }], helloed: [{ connId: 'device', identity: client.identity }], focus: null })
  expect(watcher.hasDevice('unfocused')).toBe(true)
  expect((await status('unfocused')).openQuestion).toBeNull()
  expect((await status('agent')).openQuestion).toMatchObject({ requestId: 'live' })
  port.dropped('device')
  await vi.waitFor(() => expect(watcher.hasDevice('agent')).toBe(false))
})
