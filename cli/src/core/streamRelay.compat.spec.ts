import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asker } from './api.js'
import { createClientStreams } from './clientStreams.js'
import type { ClientStreamEvent } from '../lib/clientStreamContract.js'
import { createViewersLink } from './viewersLink.js'
import { fakeCore } from '../testing/fakeCore.js'
import { clientStreamLocalFrame, encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

const LOCAL: Asker = { local: true, owner: true }
const ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ID = '00000000-0000-4000-8000-000000000002'
type Payload = Record<string, unknown>

// Public frames are recorded as JSON, not partial matches: the extraction changes private service transport
// while old clients keep their exact request, response and close spellings and payloads.
function browser() {
  const wire: string[] = []
  const raw: Uint8Array[] = []
  const port = {
    stream: vi.fn(() => true), streamInput: vi.fn((_id: string, _bytes: Uint8Array) => true), streamClosed: vi.fn(),
    streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(),
  }
  const grants = new Map<string, ClientStreamEvent>()
  const relay = createClientStreams({
    endpoint: () => ({
      frame: event => { grants.set(event.connection, event); return port.stream() },
      binary: bytes => { const read = clientStreamLocalFrame(bytes)!; return port.streamInput(read.streamId, read.bytes) },
      closed: port.streamClosed, control: () => {}, refused: (_grant, streamId) => { if (streamId) port.streamRefused(streamId) },
    }), disabled: () => false, wake: () => {},
    send: (_service, connection, type, payload) => { wire.push(JSON.stringify({ connection, type, payload })); return true },
    sendBinary: (_service, _connection, bytes) => { raw.push(bytes); return true },
  })
  const sink = relay.connected('agentBrowser')!
  relay.serving('agentBrowser')
  const streams = {
    open: (connection: string, payload: Payload) => relay.frame(connection, 'agent_browser_open', payload, LOCAL),
    frame: (connection: string, type: string, payload: Payload) => {
      const grant = grants.get(connection)!.grant
      return sink.frame(grant, type, type === 'agent_browser_open_result' ? { ...payload, requestId: grant } : payload)
    },
    bytes: sink.binary,
    input: (connection: string, streamId: string, bytes: Uint8Array) => relay.binary(connection, encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId, seq: 0, bytes, compressed: false })!),
    ack: (connection: string, payload: Payload) => relay.frame(connection, 'agent_browser_ack', payload, LOCAL),
    close: (connection: string, payload: Payload) => relay.frame(connection, 'agent_browser_close', payload, LOCAL),
    gone: () => relay.disconnected('agentBrowser'),
  }
  return { streams, port, wire, raw }
}

afterEach(() => { vi.useRealTimers() })

describe('public stream contracts preserved by the shared relay', () => {
  it('keeps a successful Browser open, close and exact binary buffer on its owning connection', () => {
    const { streams, port, wire, raw } = browser()
    streams.open('one', { requestId: 'open', agentId: 'agent' })
    streams.open('two', { requestId: 'open', agentId: 'agent' })
    streams.frame('one', 'agent_browser_open_result', { requestId: 'open', streamId: ID })
    streams.frame('two', 'agent_browser_open_result', { requestId: 'open', streamId: OTHER_ID })
    const encoded = encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: ID, seq: 7,
      compressed: false, bytes: Uint8Array.of(82, 70, 66, 0, 255) })!
    expect(streams.bytes(encoded)).toBe(true)
    expect(raw).toHaveLength(1)
    expect(raw[0]).toBe(encoded)
    const keys = Uint8Array.of(1, 2, 3)
    streams.input('two', ID, keys)
    streams.ack('two', { streamId: ID, bytes: 5 })
    streams.close('two', { streamId: ID })
    expect(port.streamInput).not.toHaveBeenCalled()
    expect(port.stream).toHaveBeenCalledTimes(2)
    streams.input('one', ID, keys)
    expect(port.streamInput).toHaveBeenCalledWith(ID, keys)
    streams.frame('one', 'agent_browser_close', { streamId: ID, reason: 'closed' })
    streams.gone()
    expect(wire).toEqual([
      '{"connection":"one","type":"agent_browser_open_result","payload":{"requestId":"open","streamId":"00000000-0000-4000-8000-000000000001"}}',
      '{"connection":"two","type":"agent_browser_open_result","payload":{"requestId":"open","streamId":"00000000-0000-4000-8000-000000000002"}}',
      '{"connection":"one","type":"agent_browser_close","payload":{"streamId":"00000000-0000-4000-8000-000000000001","reason":"closed"}}',
      '{"connection":"two","type":"agent_browser_close","payload":{"streamId":"00000000-0000-4000-8000-000000000002","reason":"agent"}}',
    ])
  })

  it('rejects a duplicate Browser UUID without moving the old screen to the second requester', () => {
    const { streams, port, wire } = browser()
    streams.open('one', { requestId: 'first', agentId: 'agent' })
    streams.frame('one', 'agent_browser_open_result', { requestId: 'first', streamId: ID })
    streams.open('two', { requestId: 'second', agentId: 'agent' })
    expect(streams.frame('two', 'agent_browser_open_result', { requestId: 'second', streamId: ID })).toBe(false)
    expect(wire.slice(1)).toEqual([
      '{"connection":"one","type":"agent_browser_close","payload":{"streamId":"00000000-0000-4000-8000-000000000001","reason":"agent"}}',
      '{"connection":"two","type":"agent_browser_open_result","payload":{"requestId":"second","error":"NOT_READY"}}',
    ])
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(ID)
    streams.gone()
  })

  it('keeps viewer unavailable close bytes, invalid-ID silence, close silence and surface fallback', async () => {
    const wire: string[] = []
    const streams = createClientStreams({ endpoint: () => null, disabled: () => true, wake: () => {}, sendBinary: () => false,
      send: (_service, connection, type, payload) => { wire.push(JSON.stringify({ connection, type, payload })); return true },
    })
    streams.frame('one', 'viewer_request', { streamId: 'viewer-1', agentId: 'agent' }, LOCAL)
    streams.frame('two', 'viewer_data', { streamId: 'viewer-1', data: 'AA==' }, LOCAL)
    streams.frame('one', 'viewer_close', { streamId: 'viewer-1' }, LOCAL)
    streams.frame('one', 'viewer_request', { streamId: '../invalid' }, LOCAL)
    streams.frame('one', 'viewer_request', {}, LOCAL)
    expect(wire).toEqual([
      '{"connection":"one","type":"viewer_close","payload":{"streamId":"viewer-1","error":"Viewer is no longer available"}}',
      '{"connection":"two","type":"viewer_close","payload":{"streamId":"viewer-1","error":"Viewer is no longer available"}}',
    ])
    expect(JSON.stringify(await createViewersLink(fakeCore()).port.surface('one', { surfaceId: 'surface' })))
      .toBe('{"error":"SERVICE_UNAVAILABLE","service":"viewers","retryable":true}')
  })

  it('holds the original viewer request/upload/half-close order at first start and drops a closed connection', () => {
    vi.useFakeTimers()
    const sent: Array<{ connection: string; type: string; payload: Payload }> = []
    const wake = vi.fn()
    const streams = createClientStreams({ disabled: () => false, wake, send: () => true, sendBinary: () => false,
      endpoint: service => service === 'viewers' ? {
        frame: event => { sent.push({ connection: event.connection, type: event.type, payload: event.payload }); return true },
        binary: () => false, closed: () => {}, control: () => {}, refused: () => {},
      } : null,
    })
    streams.frame('gone', 'viewer_request', { streamId: 'same', agentId: 'gone' }, LOCAL)
    streams.frame('one', 'viewer_request', { streamId: 'same', agentId: 'agent', method: 'POST', path: '/' }, LOCAL)
    streams.frame('one', 'viewer_data', { streamId: 'same', data: 'AAH/' }, LOCAL)
    streams.frame('one', 'viewer_end', { streamId: 'same' }, LOCAL)
    streams.closed('gone')
    expect(sent).toEqual([])
    expect(wake).toHaveBeenCalledOnce()
    streams.connected('viewers'); streams.serving('viewers')
    const privateId = sent[0]!.payload.streamId
    expect(sent.every(event => event.payload.streamId === privateId)).toBe(true)
    expect(privateId).not.toBe('same')
    for (const event of sent) event.payload = { ...event.payload, streamId: 'same' }
    expect(JSON.stringify(sent)).toBe('[{"connection":"one","type":"viewer_request","payload":{"streamId":"same","agentId":"agent","method":"POST","path":"/"}},{"connection":"one","type":"viewer_data","payload":{"streamId":"same","data":"AAH/"}},{"connection":"one","type":"viewer_end","payload":{"streamId":"same"}}]')
    expect(vi.getTimerCount()).toBe(0)
  })
})
