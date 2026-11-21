import { describe, expect, it, vi } from 'vitest'
import { browserStreamEndpoint, mayOpenBrowser } from './agentBrowserRuntime.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

describe('Browser service stream endpoint', () => {
  it('keeps Browser authorization in the service', () => {
    expect(mayOpenBrowser({ local: true, owner: true })).toBe(true)
    expect(mayOpenBrowser({ local: false, owner: true, accountOwner: true })).toBe(true)
    expect(mayOpenBrowser({ local: false, owner: true })).toBe(false)
    expect(mayOpenBrowser({ local: true, owner: true, guest: 'guest' })).toBe(false)
  })

  it('accepts its own raw kind, routes, refusal and teardown, and no other control', () => {
    const port = { stream: vi.fn(() => true), streamInput: vi.fn(() => true), streamClosed: vi.fn(),
      streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(), stop: vi.fn() }
    const endpoint = browserStreamEndpoint(port), id = '00000000-0000-4000-8000-000000000001'
    const event = { grant: 'g1', connection: 'c1', type: 'agent_browser_open', payload: { requestId: 'g1' }, asker: { local: true, owner: true } }
    expect(endpoint.frame(event)).toBe(true)
    expect(port.stream).toHaveBeenCalledWith('c1', event.type, event.payload, event.asker)
    const raw = encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: id, seq: 0, bytes: Uint8Array.of(1), compressed: false })!
    expect(endpoint.binary(raw)).toBe(true)
    expect(port.streamInput).toHaveBeenCalledWith(id, Uint8Array.of(1))
    expect(endpoint.binary(Uint8Array.of(1))).toBe(false)
    for (const route of ['direct', 'turn', 'relay', null]) endpoint.control('g1', { streamId: id, route })
    endpoint.control(null, { kind: 'transport_error' })
    for (const payload of [{}, { streamId: id }, { streamId: 7, route: 'direct' }, { streamId: id, route: 'unknown' }]) endpoint.control('g1', payload)
    expect(port.streamRoute.mock.calls).toEqual([[id, 'direct'], [id, 'turn'], [id, 'relay'], [id, null]])
    expect(port.streamTransportError).toHaveBeenCalledOnce()
    endpoint.refused('g1'); endpoint.refused('g1', id)
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(id)
    endpoint.closed('c1'); endpoint.closed()
    expect(port.streamClosed.mock.calls).toEqual([['c1'], [undefined]])
  })
})
