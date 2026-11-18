import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInput, type InputDeps } from './input.js'
import { createDeliveries } from './deliveries.js'
import { createWifiCore } from './wifi.js'
import { createWifiLink } from './wifiLink.js'
import { agentView } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'
import { runWifiService } from '../services/wifiProcess.js'
import { startWifi } from '../services/wifi.js'
import type { CoreConnection, ServiceProcessOptions } from '../services/process.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import type { RegisteredSession } from '../lib/registry.js'
import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import { fakeCore } from '../testing/fakeCore.js'

const READY = '────────────\n❯\n────────────\n  ? for shortcuts'
const captured = JSON.parse(readFileSync(new URL('../../../docs/contracts/autonomous-device-summary-correlation/claude-native-queue.json', import.meta.url), 'utf8'))
const stopped: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stopped.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks() })

/** The real session writer, core feed/link, worker adapter and component; only the transport and terminal are replaced. */
async function bridge() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T00:00:00Z'))
  const dataDir = mkdtempSync(join(tmpdir(), 'wifi-input-bridge-'))
  const session = { agentId: 'agent', sessionId: 'session', engine: 'claude', active: true, cliVersion: '2.1.283' } as RegisteredSession
  const core = fakeCore({ dataDir, machine: { id: () => 'machine' }, agents: { byAgent: () => agentView(session) },
    wifi: { view: async () => ({ agents: [{ agentId: 'agent', name: 'Agent', engine: 'claude', state: 'working' }], store: [], hasWindow: true }) } })
  let options!: ServiceProcessOptions, component!: AutonomousDeviceService
  const frames: ServiceFrame[] = [], watchedAtDispatch: boolean[] = []
  const notify = (frame: ServiceFrame): boolean => {
    const copy = JSON.parse(JSON.stringify(frame)) as ServiceFrame
    frames.push(copy)
    const payload = copy.payload as Record<string, any>
    if (payload.kind === 'input' && payload.event.phase === 'dispatching') {
      watchedAtDispatch.push(wifi.feed.needsTranscript('agent', 'session', 'claude'))
    }
    queueMicrotask(() => options.onEvent!(payload))
    return true
  }
  const deliveries = createDeliveries({
    submit: (id, text, deliveryId, extra) => input.submitInput(id, { content: text, deliveryId, when: extra?.when ?? 'turn', current: extra?.current }),
    cancel: id => input.input.cancelDelivery(id), deliverers: new Set(['wifi']),
    tell: (_maker, event) => notify({ type: 'service_event', payload: { kind: 'delivery', event } }),
    // The composition root arms the transcript feed before publishing dispatch to the worker.
    tellInput: (_maker, event) => {
      if (event.phase === 'dispatching' && event.deliveryId && event.content !== undefined) {
        wifi.feed.inputDispatched(event.agentId)
      }
      link.port.input(event)
    },
  })
  const link = createWifiLink({ core, notify })
  const wifi = createWifiCore({ port: () => link.port, doors: core.wifi, fullText: () => undefined })
  core.wifi = wifi.api
  const paste = vi.fn<InputDeps['terminal']['submitTerminalAction']>(async (_id, _text, effect) => {
    expect(wifi.feed.needsTranscript('agent', 'session', 'claude')).toBe(true)
    expect(effect?.allowed?.()).not.toBe(false)
    expect(await effect?.beforeEnter?.()).toBeNull()
    return { state: 'succeeded', dispatch: 'executed' }
  })
  const input = createInput({ resolve: () => session, readScreen: readInlineScreen,
    submission: { ...inlineSubmission, read: async () => ({ draft: false, composer: true, nativeDraft: 'clear' }) },
    terminal: { validateTerminal: async () => true, captureTerminal: async () => READY, submitTerminalAction: paste,
      keyTerminalAction: vi.fn(), pinTerminalControl: () => () => {} },
    deliveries: { settled: deliveries.settled, input: deliveries.input, canWrite: () => true },
    clients: { send: vi.fn(), sendCommander: vi.fn() }, agentIdFor: id => id, openTurn: async () => [], emit: vi.fn(),
  })
  const authority = { current: () => true, ownsRequest: () => false }
  const connection: CoreConnection = {
    query: async (query, payload = {}) => {
      if (query === 'resolve') return { value: agentView(session) }
      if (query === 'follow_agents') return { agents: [] }
      return await deliveries.answer('wifi', query, payload, authority) ?? await link.answer(query, payload)
    },
    notice: (kind, payload) => link.notice({ ...payload, kind }),
  }
  const worker = runWifiService({ dataDir, machineId: 'machine', socketPath: join(dataDir, 'unused.sock'), token: 'fixture',
    run: given => { options = given; return { stop: () => {} } },
    start: (api, ports, deps) => startWifi(api, ports, { ...deps, service: value => component = new AutonomousDeviceService(value) }),
  })
  const drain = async () => { await vi.advanceTimersByTimeAsync(0); await options.requests!.wifi_http!({ method: 'GET', target: '/not-a-route' }, { local: true, owner: true }) }
  stopped.push(async () => { input.input.forget('agent'); await worker.stop(); wifi.stopped(); rmSync(dataDir, { recursive: true, force: true }) })
  deliveries.ready()
  options.onConnected!(connection)
  wifi.started(null)
  await drain()
  frames.length = 0
  return { component, wifi, frames, paste, watchedAtDispatch, drain,
    send: (index = 0) => component.request('device', { type: 'turn.send', requestId: `00000000-0000-4000-8000-00000000000${index + 1}`, machineId: 'machine',
      agentId: 'agent', idempotencyKey: index === 0 ? 'inputA' : 'inputB', text: captured.inputs[index] }),
  }
}

describe('Wi-Fi input through the admitted shared worker cohort', () => {
  it('sends each input fact and lifecycle batch once, arms the watch first and completes the same receipt', async () => {
    const f = await bridge()
    expect(await f.send()).toMatchObject({ status: 'accepted' })
    await f.drain()
    // This recorded final answer covers both inputs on its parent chain; an unmatched B must remain unknown.
    expect(await f.send(1)).toMatchObject({ status: 'accepted' })
    await f.drain()
    expect(f.paste).toHaveBeenCalledTimes(2)
    expect(f.watchedAtDispatch).toEqual([true, true])
    expect(f.component.receipt('device', 'inputA')).toMatchObject({ state: 'delivered', input: { phase: 'accepted' } })
    const batch = [{ type: 'turn_started', payload: { userMessage: captured.inputs[0] } }, { type: 'turn_ended', payload: {} }] as const
    f.wifi.feed.events('agent', batch)
    await f.drain()
    const inputFrames = [...f.frames]
    for (const row of captured.records) f.wifi.feed.observeTranscript('agent', 'session', 'claude', JSON.stringify(row))
    await f.drain()
    expect(f.component.receipt('device', 'inputA')).toMatchObject({ state: 'completed' })
    expect(f.component.receipt('device', 'inputB')).toMatchObject({ state: 'completed' })
    expect(await f.send()).toMatchObject({ status: 'duplicate', receipt: { state: 'completed' } })
    expect(f.paste).toHaveBeenCalledTimes(2)
    const expected: ServiceFrame[] = []
    const fact = (kind: string, event: Record<string, unknown>) => ({ type: 'service_event' as const, payload: { kind, event } })
    for (const [index, key] of ['inputA', 'inputB'].entries()) {
      const deliveryId = f.component.receipt('device', key)!.deliveryId
      const progress = { agentId: 'agent', sessionId: 'session', deliveryId, when: 'composer', duringTurn: false }
      expected.push(fact('delivery', { deliveryId, sessionId: 'agent', state: 'queued' }),
        fact('input', { ...progress, phase: 'dispatching', content: captured.inputs[index] }),
        fact('input', { ...progress, phase: 'written' }),
        fact('delivery', { deliveryId, sessionId: 'agent', state: 'delivered' }),
        fact('input', { ...progress, phase: 'composer_available' }))
    }
    expected.push({ type: 'service_event', payload: { kind: 'input_events', agentId: 'agent', events: batch } })
    expect(inputFrames).toEqual(expected)
    expect(inputFrames).toHaveLength(11)
    expect(inputFrames.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0))
      .toBe(expected.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0))
  })
})
