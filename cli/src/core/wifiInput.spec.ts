import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInput, type InputDeps } from './input.js'
import { createDeliveries } from './deliveries.js'
import { createDeviceEvidence } from '../lib/autonomous-device/evidenceReader.js'
import type { DeviceSessionFeedOptions } from '../lib/autonomous-device/sessionFeed.js'
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
import { answerSessionRead } from './agentQueries.js'
import { snapshotFixture, snapshotRow, snapshotReader } from '../testing/sessionSnapshot.js'
import { fakeCore } from '../testing/fakeCore.js'

const READY = '────────────\n❯\n────────────\n  ? for shortcuts'
const captured = JSON.parse(readFileSync(new URL('../../../docs/contracts/autonomous-device-summary-correlation/claude-native-queue.json', import.meta.url), 'utf8'))
const stopped: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stopped.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks() })

/** The real session writer, shared core input link, worker adapter and component; only the transport and terminal are replaced. */
async function bridge() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T00:00:00Z'))
  const dataDir = mkdtempSync(join(tmpdir(), 'wifi-input-bridge-'))
  const file = join(dataDir, 'session.jsonl'); writeFileSync(file, '')
  const session = { agentId: 'agent', sessionId: 'session', engine: 'claude', active: true, cliVersion: '2.1.283',
    transcriptPath: file, boundAt: 1, processIdentity: { pid: 42, startMarker: '1970-01-01T00:00:00Z' }, evidenceRevision: 1 } as RegisteredSession
  const core = fakeCore({ dataDir, machine: { id: () => 'machine' }, agents: { byAgent: () => agentView(session),
    readSessions: snapshotReader(async () => snapshotFixture({ machine: { id: 'machine', computerId: 'computer', name: 'Fixture' }, registered: [snapshotRow()] })) } })
  let options!: ServiceProcessOptions, component!: AutonomousDeviceService, feed!: DeviceSessionFeedOptions, armed = false
  const frames: ServiceFrame[] = [], watchedAtDispatch: boolean[] = []
  const notify = (frame: ServiceFrame): boolean => {
    const copy = JSON.parse(JSON.stringify(frame)) as ServiceFrame
    frames.push(copy)
    const payload = copy.payload as Record<string, any>
    if (payload.kind === 'input' && payload.event.phase === 'dispatching') {
      watchedAtDispatch.push(armed)
    }
    queueMicrotask(() => options.onEvent!(payload))
    return true
  }
  const deliveries = createDeliveries({
    submit: (id, text, deliveryId, extra) => input.submitInput(id, { content: text, deliveryId, when: extra?.when ?? 'turn', current: extra?.current }),
    cancel: id => input.input.cancelDelivery(id), deliverers: new Set(['wifi']),
    tell: (_maker, event) => notify({ type: 'service_event', payload: { kind: 'delivery', event } }),
    tellInput: (_maker, event) => link.port.input(event),
  })
  const link = createWifiLink({ core, notify })
  const paste = vi.fn<InputDeps['terminal']['submitTerminalAction']>(async (_id, _text, effect) => {
    expect(armed).toBe(true)
    expect(effect?.allowed?.()).not.toBe(false)
    expect(await effect?.beforeEnter?.()).toBeNull()
    return { state: 'succeeded', dispatch: 'executed' }
  })
  const input = createInput({ resolve: () => session, readScreen: readInlineScreen,
    submission: { ...inlineSubmission, read: async () => ({ draft: false, composer: true, nativeDraft: 'clear' }) },
    terminal: { validateTerminal: async () => true, captureTerminal: async () => READY, submitTerminalAction: paste,
      keyTerminalAction: vi.fn(), pinTerminalControl: () => () => {} },
    deliveries: { settled: deliveries.settled, input: deliveries.input, canWrite: () => true },
    clients: { send: vi.fn() }, failure: vi.fn(), agentIdFor: id => id, openTurn: async () => [], emit: vi.fn(),
  })
  const authority = { current: () => true, ownsRequest: () => false }
  const connection: CoreConnection = {
    read: (query, _payload, receive, signal) => answerSessionRead(core, 'wifi', query, (record, settled) => {
      receive(record); settled(true); return true
    }, signal ?? new AbortController().signal, authority),
    query: async (query, payload = {}) => {
      if (query === 'resolve') return { value: agentView(session) }
      if (query === 'follow_agents') return { agents: [] }
      return await deliveries.answer('wifi', query, payload, authority) ?? await link.answer(query, payload)
    },
    notice: (kind, payload) => link.notice({ ...payload, kind }),
  }
  const worker = runWifiService({ dataDir, machineId: 'machine', socketPath: join(dataDir, 'unused.sock'), token: 'fixture',
    run: given => { options = given; return { stop: () => {} } },
    start: (api, ports, deps) => startWifi(api, ports, { ...deps,
      service: value => component = new AutonomousDeviceService(value),
      observeSessions: options => { feed = options; return { ready: Promise.resolve(), close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async () => {}) } },
      evidence: options => {
        const reader = createDeviceEvidence(options)
        return { ...reader, arm: async (...args) => { await reader.arm(...args); armed = true } }
      },
    }),
  })
  const drain = async () => { await vi.advanceTimersByTimeAsync(0); await options.requests!.wifi_http!({ method: 'GET', target: '/not-a-route' }, { local: true, owner: true }) }
  stopped.push(async () => { input.input.forget('agent'); await worker.stop(); rmSync(dataDir, { recursive: true, force: true }) })
  deliveries.ready()
  options.onConnected!(connection)
  void link.port.resume({ focus: null })
  await drain()
  frames.length = 0
  return { component, frames, paste, watchedAtDispatch, drain,
    finish: async () => {
      appendFileSync(file, captured.records.map((row: unknown) => JSON.stringify(row)).join("\n") + "\n")
      await feed.receive("agent", [{ type: "turn_ended", payload: {} }], () => true)
    },
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
    const inputFrames = [...f.frames]
    await f.finish()
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
    expect(inputFrames).toEqual(expected)
    expect(inputFrames).toHaveLength(10)
    expect(inputFrames.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0))
      .toBe(expected.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame)), 0))
  })
})
