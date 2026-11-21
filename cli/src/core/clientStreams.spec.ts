import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClientStreams } from './clientStreams.js'
import { CLIENT_STREAMS, CLIENT_STREAM_HELD_FRAMES, CLIENT_STREAM_QUEUE_BYTES, type ClientStreamEvent, type ClientStreamSink, type ClientStreamSpec } from '../lib/clientStreamContract.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

const LOCAL = { local: true, owner: true }
const ID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const encoded = (id = ID, size = 3) => encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: id, seq: 1, compressed: false, bytes: new Uint8Array(size) })!

function setup(connected = true, specs: readonly ClientStreamSpec[] = CLIENT_STREAMS) {
  const port = () => ({ frame: vi.fn((_event: ClientStreamEvent) => true), binary: vi.fn((_raw: Uint8Array) => true), closed: vi.fn(), control: vi.fn(), refused: vi.fn() })
  const ports = { viewers: port(), agentBrowser: port() }
  const send = vi.fn((_service: string, _connection: string, _type: string, _payload: Record<string, unknown>, _final: boolean) => true), sendBinary = vi.fn((_service: string, _connection: string, _raw: Uint8Array) => true), wake = vi.fn(), log = vi.fn()
  const disabled = new Set<string>()
  const relay = createClientStreams({ endpoint: name => ports[name as keyof typeof ports] ?? null, disabled: name => disabled.has(name),
    send, sendBinary, wake, log, specs, startWaitMs: 100 })
  const sinks = new Map<string, ClientStreamSink>()
  const connect = (name: keyof typeof ports) => { const sink = relay.connected(name)!; sinks.set(name, sink); relay.serving(name); return sink }
  if (connected) { connect('viewers'); connect('agentBrowser') }
  const browser = (connection = 'one', requestId = 'open', streamId = ID) => {
    relay.frame(connection, 'agent_browser_open', { requestId, agentId: 'agent' }, LOCAL)
    const event = ports.agentBrowser.frame.mock.calls.at(-1)![0]
    expect(sinks.get('agentBrowser')!.frame(event.grant, 'agent_browser_open_result', { requestId: event.grant, streamId })).toBe(true)
    return event
  }
  return { relay, ports, sinks, send, sendBinary, wake, log, connect, browser, disabled }
}

afterEach(() => { vi.useRealTimers() })

describe('one connection-owned relay for both stream consumers', () => {
  it('holds first-start viewer traffic through the physical-connection readiness handshake', () => {
    vi.useFakeTimers()
    const t = setup(false)
    t.relay.connected('viewers')
    t.relay.frame('one', 'viewer_request', { streamId: 'startup' }, LOCAL)
    t.relay.frame('one', 'viewer_data', { streamId: 'startup', data: 'AA==' }, LOCAL)
    expect(t.send).not.toHaveBeenCalled()
    expect(t.ports.viewers.frame).not.toHaveBeenCalled()
    t.relay.serving('viewers')
    expect(t.ports.viewers.frame.mock.calls.map(([event]) => event.type)).toEqual(['viewer_request', 'viewer_data'])
    expect(vi.getTimerCount()).toBe(0)
    t.relay.closed()
  })

  it('routes both services through private grants and restores exact public IDs', () => {
    const t = setup()
    t.relay.frame('one', 'viewer_request', { streamId: 'view', path: '/' }, LOCAL)
    const viewer = t.ports.viewers.frame.mock.calls[0][0]
    expect(viewer.payload).toEqual({ streamId: viewer.grant, path: '/' })
    expect(viewer.connection).toBe('one')
    expect(t.sinks.get('viewers')!.frame(viewer.grant, 'viewer_response', { streamId: viewer.grant, status: 200 })).toBe(true)
    const browser = t.browser()
    expect(browser.payload).toEqual({ requestId: browser.grant, agentId: 'agent' })
    expect(t.send.mock.calls).toEqual([
      ['viewers', 'one', 'viewer_response', { streamId: 'view', status: 200 }, false],
      ['agentBrowser', 'one', 'agent_browser_open_result', { requestId: 'open', streamId: ID }, false],
    ])
    t.relay.closed()
  })

  it('keeps identical client viewer IDs separate and reuses only the duplicate live grant', () => {
    const t = setup()
    for (const connection of ['one', 'two', 'one']) t.relay.frame(connection, 'viewer_request', { streamId: 'same' }, LOCAL)
    const [one, two, duplicate] = t.ports.viewers.frame.mock.calls.map(([event]) => event)
    expect(one.grant).not.toBe(two.grant)
    expect(duplicate.grant).toBe(one.grant)
    expect(t.sinks.get('agentBrowser')!.frame(one.grant, 'agent_browser_close', { streamId: ID })).toBe(false)
    expect(t.sinks.get('viewers')!.frame(one.grant, 'viewer_data', { streamId: two.grant, data: 'AA==' })).toBe(false)
    expect(t.sinks.get('viewers')!.frame(one.grant, 'viewer_data', { streamId: one.grant, data: 'AA==' })).toBe(true)
    expect(t.send).toHaveBeenLastCalledWith('viewers', 'one', 'viewer_data', { streamId: 'same', data: 'AA==' }, false)
    t.relay.closed()
  })

  it('checks the current viewer audience before a duplicate open or continuation can reuse a grant', () => {
    const t = setup()
    t.relay.frame('one', 'viewer_request', { streamId: 'same' }, LOCAL)
    for (const asker of [{ local: false, owner: false }, { local: false, owner: true, guest: '' }]) {
      for (const type of ['viewer_request', 'viewer_data', 'viewer_ack', 'viewer_end', 'viewer_close']) {
        t.relay.frame('one', type, { streamId: 'same', data: 'AA==', bytes: 1 }, asker)
      }
    }
    expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
    t.relay.frame('one', 'viewer_data', { streamId: 'same', data: 'AA==' }, LOCAL)
    expect(t.ports.viewers.frame).toHaveBeenCalledTimes(2)
    t.relay.closed()
  })

  it('revokes old grants before a reused connection can open under its replacement session', () => {
    const t = setup(), old = t.browser()
    t.relay.frame('one', 'viewer_request', { streamId: 'same' }, LOCAL)
    const oldViewer = t.ports.viewers.frame.mock.calls[0][0]
    t.relay.closed('one')
    const replacement = { local: false, owner: false }
    t.relay.frame('one', 'viewer_request', { streamId: 'same' }, replacement)
    t.relay.frame('one', 'agent_browser_open', { requestId: 'open' }, replacement)
    expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
    expect(t.ports.agentBrowser.frame).toHaveBeenCalledOnce()
    expect(t.sinks.get('viewers')!.frame(oldViewer.grant, 'viewer_data', { streamId: oldViewer.grant, data: 'AA==' })).toBe(false)
    expect(t.sinks.get('agentBrowser')!.frame(old.grant, 'agent_browser_close', { streamId: ID })).toBe(false)
    expect(t.sinks.get('agentBrowser')!.binary(encoded())).toBe(false)
    t.relay.closed()
  })

  it('forwards the same validated binary buffers and rejects another connection', () => {
    const t = setup(), grant = t.browser()
    const raw = encoded()
    expect(t.sinks.get('agentBrowser')!.binary(raw)).toBe(true)
    expect(t.sendBinary.mock.calls[0][2]).toBe(raw)
    expect(t.relay.binary('foreign', raw)).toBe(true)
    expect(t.ports.agentBrowser.binary).not.toHaveBeenCalled()
    expect(t.relay.binary('one', raw)).toBe(true)
    expect(t.ports.agentBrowser.binary.mock.calls[0][0]).toBe(raw)
    expect(t.relay.binary('one', Uint8Array.of(1))).toBe(false)
    expect(t.sinks.get('agentBrowser')!.frame(grant.grant, 'agent_browser_close', { streamId: ID, reason: 'closed' })).toBe(true)
    expect(t.sinks.get('agentBrowser')!.binary(raw)).toBe(false)
  })

  it('fences service replacement and a public request ID reused after timeout', () => {
    vi.useFakeTimers()
    const t = setup(), oldSink = t.sinks.get('agentBrowser')!
    t.relay.frame('one', 'agent_browser_open', { requestId: 'same', agentId: 'missing' }, LOCAL)
    const old = t.ports.agentBrowser.frame.mock.calls[0][0]
    vi.advanceTimersByTime(10_000)
    t.relay.frame('one', 'agent_browser_open', { requestId: 'same', agentId: 'agent' }, LOCAL)
    const next = t.ports.agentBrowser.frame.mock.calls[1][0]
    expect(next.grant).not.toBe(old.grant)
    expect(oldSink.frame(old.grant, 'agent_browser_open_result', { requestId: old.grant, streamId: OTHER })).toBe(false)
    expect(oldSink.frame(next.grant, 'agent_browser_open_result', { requestId: next.grant, streamId: ID })).toBe(true)
    t.connect('agentBrowser')
    expect(oldSink.binary(encoded())).toBe(false)
    expect(oldSink.frame(next.grant, 'agent_browser_close', { streamId: ID })).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps eight unanswered admissions bounded before service readiness policy, and reopens after cleanup', () => {
    const t = setup()
    for (let index = 0; index < 9; index++) t.relay.frame('one', 'agent_browser_open', { requestId: `r${index}`, agentId: 'absent' }, LOCAL)
    expect(t.ports.agentBrowser.frame).toHaveBeenCalledTimes(8)
    expect(t.send).toHaveBeenCalledExactlyOnceWith('agentBrowser', 'one', 'agent_browser_open_result', { requestId: 'r8', error: 'VIEWER_LIMIT' }, true)
    for (const [event] of t.ports.agentBrowser.frame.mock.calls) {
      t.sinks.get('agentBrowser')!.frame(event.grant, 'agent_browser_open_result', { requestId: event.grant, error: 'NO_BROWSER' })
    }
    t.relay.closed('one')
    t.browser('one', 'valid')
    t.relay.closed()
  })

  it('preserves distinct disabled and enabled-unavailable refusals without reading any agent projection', () => {
    const t = setup(false)
    t.relay.frame('one', 'agent_browser_open', { requestId: 'down', agentId: 'agent' }, LOCAL)
    t.disabled.add('agentBrowser')
    t.relay.frame('one', 'agent_browser_open', { requestId: 'off', agentId: 'agent' }, LOCAL)
    t.relay.frame('other', 'agent_browser_open', { requestId: 'foreign' }, { local: false, owner: true })
    expect(t.send.mock.calls).toEqual([
      ['agentBrowser', 'one', 'agent_browser_open_result', { requestId: 'down', error: 'NOT_READY' }, true],
      ['agentBrowser', 'one', 'agent_browser_open_result', { requestId: 'off', error: 'NO_BROWSER' }, true],
      ['agentBrowser', 'other', 'agent_browser_open_result', { requestId: 'foreign', error: 'NOT_OWNER' }, true],
    ])
    expect(t.wake).not.toHaveBeenCalled()
  })

  it('preserves first-start viewer ordering and cancels work whose connection has closed', () => {
    vi.useFakeTimers()
    const t = setup(false)
    t.relay.frame('gone', 'viewer_request', { streamId: 'same' }, LOCAL)
    t.relay.frame('one', 'viewer_request', { streamId: 'same' }, LOCAL)
    t.relay.frame('one', 'viewer_data', { streamId: 'same', data: 'AA==' }, LOCAL)
    t.relay.frame('one', 'viewer_end', { streamId: 'same' }, LOCAL)
    t.relay.closed('gone')
    expect(t.ports.viewers.frame).not.toHaveBeenCalled()
    t.connect('viewers')
    expect(t.ports.viewers.frame.mock.calls.map(([event]) => [event.connection, event.type])).toEqual([
      ['one', 'viewer_request'], ['one', 'viewer_data'], ['one', 'viewer_end'],
    ])
    expect(vi.getTimerCount()).toBe(0)
    t.relay.closed()
  })

  it('keeps independent service shares and reclaims reservations on disconnect', () => {
    const specs = CLIENT_STREAMS.map(spec => ({ ...spec, grants: 2, perConnection: 2, pending: 2, pendingPerConnection: 2 }))
    const t = setup(true, specs)
    t.browser('one', 'first')
    t.browser('two', 'second', OTHER)
    t.relay.frame('three', 'agent_browser_open', { requestId: 'full' }, LOCAL)
    expect(t.send).toHaveBeenLastCalledWith('agentBrowser', 'three', 'agent_browser_open_result', { requestId: 'full', error: 'VIEWER_LIMIT' }, true)
    t.relay.frame('viewer', 'viewer_request', { streamId: 'still-available' }, LOCAL)
    expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
    t.relay.disconnected('agentBrowser')
    t.connect('agentBrowser')
    t.browser('one', 'new')
    t.relay.closed()
  })
})

describe('shared stream boundary limits and failure cleanup', () => {
  it('ends a held stream when its service is disabled before readiness', () => {
    vi.useFakeTimers()
    const t = setup(false)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    t.disabled.add('viewers')
    t.relay.frame('one', 'viewer_data', { streamId: 'a', data: 'AA==' }, LOCAL)
    expect(t.send).toHaveBeenCalledExactlyOnceWith('viewers', 'one', 'viewer_close', { streamId: 'a', error: 'Viewer is no longer available' }, true)
    t.connect('viewers')
    expect(t.ports.viewers.frame).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses an opened stream whose answer cannot reach its client and rejects a mismatched close', () => {
    const t = setup()
    t.relay.frame('one', 'agent_browser_open', { requestId: 'open' }, LOCAL)
    const event = t.ports.agentBrowser.frame.mock.calls[0]![0], sink = t.sinks.get('agentBrowser')!
    expect(sink.frame(event.grant, 'agent_browser_close', { streamId: OTHER })).toBe(false)
    t.send.mockReturnValue(false)
    expect(sink.frame(event.grant, 'agent_browser_open_result', { requestId: event.grant, streamId: ID })).toBe(false)
    expect(t.ports.agentBrowser.refused).toHaveBeenCalledExactlyOnceWith(event.grant, ID, 'one')
    expect(sink.binary(encoded())).toBe(false)
    const viewerOnly = setup(false, [CLIENT_STREAMS[0]!])
    expect(viewerOnly.relay.binary('one', encoded())).toBe(false)
    t.relay.closed()
  })

  it('recognizes only declared stream frames and the reserved viewer prefix', () => {
    const t = setup()
    expect(t.relay.handles('viewer_request')).toBe(true)
    expect(t.relay.handles('viewer_future')).toBe(true)
    expect(t.relay.handles('agent_browser_open')).toBe(true)
    expect(t.relay.handles('terminal_open')).toBe(false)
    expect(t.relay.frame('one', 'viewer_future', {}, LOCAL)).toBe(true)
    expect(t.relay.frame('one', 'terminal_open', {}, LOCAL)).toBe(false)
    expect(t.relay.connected('other')).toBeNull()
    expect(t.relay.serving('other')).toBe(false)
    t.relay.disconnected('other')
  })

  it('rejects an invalid declaration before allocating streams', () => {
    const viewer = CLIENT_STREAMS[0]!, browser = CLIENT_STREAMS[1]!
    const wrong: ClientStreamSpec[][] = [
      [viewer, viewer], [{ ...viewer, down: [] }], [{ ...viewer, down: [viewer.open] }], [{ ...viewer, up: [] }],
      [{ ...browser, up: [browser.close] }], [{ ...viewer, grants: 0 }], [{ ...viewer, perConnection: viewer.grants + 1 }],
      [{ ...viewer, pending: viewer.grants + 1 }], [{ ...viewer, pendingPerConnection: viewer.pending + 1 }],
      [{ ...viewer, down: [...viewer.down, ''] }], [{ ...viewer, down: [...viewer.down, 'terminal_output'] }],
      [{ ...viewer, down: [...viewer.down, 'message'] }], [{ ...viewer, down: [...viewer.down, viewer.open] }],
      [browser, { ...viewer, binary: browser.binary }],
      [{ ...browser, binary: { ...browser.binary!, kind: 7 } }],
      [{ ...browser, binary: { ...browser.binary!, chunkBytes: 0 } }],
      [{ ...browser, binary: { ...browser.binary!, chunkBytes: 0.5 } }],
      [{ ...browser, binary: { ...browser.binary!, unreadBytes: 1 } }],
    ]
    for (const specs of wrong) expect(() => setup(false, specs)).toThrow('CLIENT_STREAM_DECLARATION')
  })

  it('bounds public-ID storage both per service and per connection, with exact cleanup', () => {
    for (const limits of [{ idBytes: 39 }, { connectionIdBytes: 39 }]) {
      const viewer = { ...CLIENT_STREAMS[0]!, ...limits }
      const t = setup(false, [viewer]); t.connect('viewers')
      t.relay.frame('one', 'viewer_request', { streamId: 'v' }, LOCAL)
      expect(t.ports.viewers.frame).not.toHaveBeenCalled()
      expect(t.send).toHaveBeenCalledWith('viewers', 'one', 'viewer_close', { streamId: 'v', error: 'Too many viewer requests' }, true)
    }
    const t = setup(false, [{ ...CLIENT_STREAMS[0]!, grants: 2, perConnection: 1, pending: 2, pendingPerConnection: 1 }])
    t.connect('viewers')
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    t.relay.frame('one', 'viewer_request', { streamId: 'b' }, LOCAL)
    t.relay.frame('two', 'viewer_request', { streamId: 'b' }, LOCAL)
    t.relay.frame('three', 'viewer_request', { streamId: 'c' }, LOCAL)
    expect(t.ports.viewers.frame).toHaveBeenCalledTimes(2)
    t.relay.closed('one')
    t.relay.frame('three', 'viewer_request', { streamId: 'c' }, LOCAL)
    expect(t.ports.viewers.frame).toHaveBeenCalledTimes(3)
    t.relay.closed()
  })

  it('refuses held viewer requests on deadline, and refuses later requests until a service arrives', () => {
    vi.useFakeTimers()
    const t = setup(false)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    t.relay.frame('one', 'viewer_data', { streamId: 'a', data: 'AA==' }, LOCAL)
    t.relay.frame('two', 'viewer_request', { streamId: 'b' }, LOCAL)
    vi.advanceTimersByTime(100)
    expect(t.send.mock.calls.map(call => call[3])).toEqual([
      { streamId: 'a', error: 'Viewer is no longer available' }, { streamId: 'b', error: 'Viewer is no longer available' },
    ])
    t.relay.frame('three', 'viewer_request', { streamId: 'c' }, LOCAL)
    expect(t.send).toHaveBeenCalledTimes(3)
    t.connect('viewers')
    t.relay.frame('three', 'viewer_request', { streamId: 'c' }, LOCAL)
    expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
    t.relay.closed()
  })

  it('bounds first-start bytes and tiny frame count, then recovers every reservation', () => {
    vi.useFakeTimers()
    for (const overflow of ['bytes', 'frames']) {
      const t = setup(false)
      t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
      if (overflow === 'bytes') t.relay.frame('one', 'viewer_data', { streamId: 'a', data: 'x'.repeat(CLIENT_STREAM_QUEUE_BYTES) }, LOCAL)
      else for (let index = 0; index < CLIENT_STREAM_HELD_FRAMES; index++) t.relay.frame('one', 'viewer_data', { streamId: 'a', data: '' }, LOCAL)
      expect(t.send).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      t.connect('viewers')
      expect(t.ports.viewers.frame).not.toHaveBeenCalled()
      t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
      expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
      t.relay.closed()
    }
  })

  it('cleans a first-start stream when the service rejects the queued open', () => {
    vi.useFakeTimers()
    const t = setup(false)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    t.relay.frame('one', 'viewer_data', { streamId: 'a' }, LOCAL)
    t.ports.viewers.frame.mockReturnValue(false)
    t.connect('viewers')
    expect(t.ports.viewers.frame).toHaveBeenCalledOnce()
    expect(t.send).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes no invalid or foreign viewer ID and never creates a stream from a continuation', () => {
    const t = setup()
    for (const streamId of [undefined, 7, '../bad', '', 'x'.repeat(65)]) t.relay.frame('one', 'viewer_request', { streamId }, LOCAL)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, { local: false, owner: false })
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, { local: true, owner: true, guest: '' })
    t.relay.frame('one', 'viewer_data', { streamId: 'a' }, LOCAL)
    t.relay.frame('one', 'viewer_close', { streamId: 'a' }, LOCAL)
    expect(t.ports.viewers.frame).not.toHaveBeenCalled()
    expect(t.send).not.toHaveBeenCalled()
    t.relay.disconnected('viewers')
    t.relay.frame('one', 'viewer_data', { streamId: 'a' }, LOCAL)
    t.relay.frame('one', 'viewer_close', { streamId: 'a' }, LOCAL)
    expect(t.send).toHaveBeenCalledOnce()
  })

  it('forwards viewer credit and retires both half-close orders without retaining the public ID', () => {
    for (const outgoingFirst of [false, true]) {
      const t = setup()
      t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
      const grant = t.ports.viewers.frame.mock.calls[0]![0].grant, sink = t.sinks.get('viewers')!
      expect(sink.frame(grant, 'viewer_data', { streamId: 'wrong' })).toBe(false)
      expect(sink.frame(grant, 'terminal_output', { streamId: grant })).toBe(false)
      t.relay.frame('one', 'viewer_ack', { streamId: 'a', bytes: 123 }, LOCAL)
      const outgoing = () => sink.frame(grant, 'viewer_end', { streamId: grant })
      if (outgoingFirst) outgoing()
      t.relay.frame('one', 'viewer_end', { streamId: 'a' }, LOCAL)
      if (!outgoingFirst) outgoing()
      expect(sink.frame(grant, 'viewer_data', { streamId: grant, data: 'AA==' })).toBe(false)
      t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
      expect(t.ports.viewers.frame.mock.calls.at(-1)![0].grant).not.toBe(grant)
      t.relay.closed()
    }
  })

  it('refuses both sides when an active viewer send or a duplicate request fails', () => {
    const t = setup()
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    const event = t.ports.viewers.frame.mock.calls[0]![0]
    t.send.mockReturnValue(false)
    expect(t.sinks.get('viewers')!.frame(event.grant, 'viewer_data', { streamId: event.grant, data: 'AA==' })).toBe(false)
    expect(t.ports.viewers.refused).toHaveBeenCalledWith(event.grant, 'a', 'one')
    t.send.mockReturnValue(true)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    t.ports.viewers.frame.mockReturnValue(false)
    t.relay.frame('one', 'viewer_request', { streamId: 'a' }, LOCAL)
    expect(t.ports.viewers.refused).toHaveBeenCalledTimes(2)
    t.relay.closed()
  })

  it('accepts bounded transport control only from gateway and for current grants', () => {
    const t = setup(), opened = t.browser()
    for (const [source, service, grant, payload] of [
      ['viewers', 'agentBrowser', opened.grant, {}], ['gateway', 'other', null, {}],
      ['gateway', 'agentBrowser', 'unknown', {}], ['gateway', 'agentBrowser', null, { data: 'x'.repeat(256) }],
    ] as const) t.relay.control(source, service, grant, payload)
    t.relay.controlStream('viewers', ID, {})
    t.relay.controlStream('gateway', ID, { data: 'x'.repeat(256) })
    expect(t.ports.agentBrowser.control).not.toHaveBeenCalled()
    t.relay.control('gateway', 'agentBrowser', opened.grant, { route: 'direct' })
    t.relay.control('gateway', 'agentBrowser', null, { kind: 'transport_error' })
    t.relay.controlStream('gateway', ID, { streamId: ID, route: null })
    expect(t.ports.agentBrowser.control).toHaveBeenCalledTimes(3)
    t.relay.disconnected('agentBrowser')
    t.relay.control('gateway', 'agentBrowser', null, {})
    expect(t.ports.agentBrowser.control).toHaveBeenCalledTimes(3)
  })

  it('rejects malformed or unrelated raw input and fences an old grant from a reused stream UUID', () => {
    const t = setup()
    expect(t.relay.binary('one', Uint8Array.of(1))).toBe(false)
    expect(t.relay.binary('one', encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: ID, seq: 1, bytes: Uint8Array.of(1), compressed: false })!)).toBe(false)
    const old = t.browser('one')
    t.relay.closed('one')
    t.browser('two', 'second', ID)
    expect(t.sinks.get('agentBrowser')!.frame(old.grant, 'agent_browser_open_result', { requestId: old.grant, streamId: ID })).toBe(false)
    expect(t.ports.agentBrowser.refused).not.toHaveBeenCalled()
    expect(t.sinks.get('agentBrowser')!.binary(encoded())).toBe(true)
    t.relay.closed()
  })
})
