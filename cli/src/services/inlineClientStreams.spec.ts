import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_BROWSER_REQUESTS, emptyPorts, type CoreApi } from '../core/api.js'
import type { ClientStreamEndpoint, ClientStreamEvent } from '../lib/clientStreamContract.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createServiceHost } from './inlineHost.js'
import { startInlineClientStreams } from './inlineClientStreams.js'

const mocked = vi.hoisted(() => ({ apis: new Map<string, CoreApi>(), viewers: null as any, browser: null as any }))
vi.mock('./viewers.js', () => ({
  startViewers: (core: CoreApi, slots: any) => { mocked.apis.set('viewers', core); slots.viewers = mocked.viewers },
  viewerStreamEndpoint: (port: any): ClientStreamEndpoint => ({ frame: event => port.stream(event), binary: () => false,
    closed: port.closed, control: port.control, refused: port.refused }),
}))
vi.mock('./agentBrowser.js', () => ({ startAgentBrowser: (core: CoreApi, slots: any) => {
  mocked.apis.set('agentBrowser', core); slots.agentBrowser = mocked.browser
  return Object.fromEntries(AGENT_BROWSER_REQUESTS.map(type => [type, () => ({ ok: true })]))
} }))

function setup(outOfProcess: string[] = [], faults: string[] = []) {
  const ports = emptyPorts(), core = fakeCore(), log = vi.fn()
  const host = createServiceHost(ports, { faults: new Set(faults), maxFailures: 1, log })
  const endpoints = new Map<string, ClientStreamEndpoint>()
  const frame = vi.fn(() => true), binary = vi.fn(() => true), gone = vi.fn()
  const stop = startInlineClientStreams({ host, outOfProcess: new Set(outOfProcess), scope: () => core,
    register: (service, endpoint) => { endpoints.set(service, endpoint); return { frame, binary } }, gone })
  return { host, ports, core, endpoints, frame, binary, gone, stop }
}
const event = (service: 'viewers' | 'agentBrowser'): ClientStreamEvent => ({ grant: 'g1', connection: 'c1',
  type: service === 'viewers' ? 'viewer_request' : 'agent_browser_open',
  payload: service === 'viewers' ? { streamId: 'g1' } : { requestId: 'g1' }, asker: { local: true, owner: true },
})

beforeEach(() => {
  mocked.apis.clear()
  mocked.viewers = { forwardingUrl: vi.fn(() => null), surface: vi.fn(async () => ({})), stop: vi.fn(async () => {}),
    stream: vi.fn(() => true), closed: vi.fn(), control: vi.fn(), refused: vi.fn() }
  mocked.browser = { stream: vi.fn(() => true), streamInput: vi.fn(() => true), streamClosed: vi.fn(),
    streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(), stop: vi.fn() }
})

describe('explicit inline stream hosts', () => {
  it('starts both actual consumers with service-scoped senders and the same private grants', () => {
    const x = setup()
    expect([...x.endpoints.keys()]).toEqual(['viewers', 'agentBrowser'])
    expect(x.ports.viewers?.forwardingUrl('a1')).toBeNull()
    expect('agentBrowser' in x.ports).toBe(false)
    for (const service of ['viewers', 'agentBrowser'] as const) {
      x.endpoints.get(service)!.frame(event(service))
      const api = mocked.apis.get(service)!
      const payload = service === 'viewers' ? { streamId: 'g1', data: 'AA==' } : { requestId: 'g1', error: 'NO_BROWSER' }
      expect(api.clients.streamFrame('c1', service === 'viewers' ? 'viewer_data' : 'agent_browser_open_result', payload)).toBe(true)
      expect(x.frame).toHaveBeenCalledWith('g1', service === 'viewers' ? 'viewer_data' : 'agent_browser_open_result', payload)
    }
    const bytes = Uint8Array.of(1)
    expect(mocked.apis.get('agentBrowser')!.clients.streamBytes!(bytes)).toBe(true)
    expect(x.binary).toHaveBeenCalledWith(bytes)
    x.endpoints.get('viewers')!.control('g1', { arbitrary: 'component fact' })
    x.endpoints.get('viewers')!.refused('g1')
    x.endpoints.get('viewers')!.closed('c1')
    expect(x.endpoints.get('viewers')!.binary(bytes)).toBe(false)
    x.stop()
    expect(x.gone.mock.calls).toEqual([['viewers'], ['agentBrowser']])
    expect(mocked.browser.stop).toHaveBeenCalledOnce()
  })

  it('loads neither consumer when both run in their own processes', () => {
    const x = setup(['viewers', 'agentBrowser'])
    expect(mocked.apis.size).toBe(0)
    expect(x.endpoints.size).toBe(0)
    x.stop()
  })

  it.each(['viewers', 'agentBrowser'])('isolates %s startup and endpoint faults', service => {
    const failed = setup([], [service])
    expect(failed.host.isOff(service)).toBe(true)
    expect(failed.endpoints.has(service)).toBe(false)
    failed.stop()
    const running = setup([], [`${service}.frame`])
    running.endpoints.get(service)!.frame(event(service as 'viewers' | 'agentBrowser'))
    expect(running.host.isOff(service)).toBe(true)
    expect(running.gone).toHaveBeenCalledWith(service)
    running.stop()
  })
})
