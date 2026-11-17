import { describe, expect, it, vi } from 'vitest'
import { CLIENT_STREAMS, type ClientStreamEndpoint, type ClientStreamSpec, type ClientStreamEvent } from '../lib/clientStreamContract.js'
import { createServiceClientStreams } from './clientStreams.js'

const ID = '00000000-0000-4000-8000-000000000001'
function setup(service = 'agentBrowser', overrides: Partial<ClientStreamSpec> = {}) {
  const spec = { ...CLIENT_STREAMS.find(each => each.service === service)!, ...overrides }
  const endpoint = { frame: vi.fn((_event: ClientStreamEvent) => true), binary: vi.fn((_raw: Uint8Array) => true), closed: vi.fn(), control: vi.fn(), refused: vi.fn() }
  let port: ClientStreamEndpoint | null = endpoint
  const link = createServiceClientStreams(spec, () => port)
  const query = vi.fn(async () => ({ ok: true })), notice = vi.fn(), sendBinary = vi.fn((_raw: Uint8Array) => true)
  const connection = { query, notice, sendBinary }
  const event = (type = spec.open, grant = 'g1', owner = 'c1', payload: Record<string, unknown> = {}) => ({
    kind: 'client_stream', grant, connection: owner, type,
    payload: { [spec.ids === 'reply' ? 'requestId' : 'streamId']: grant, ...payload }, asker: { local: true, owner: true },
  })
  return { spec, endpoint, link, connection, event, query, notice, sendBinary, off: () => { port = null } }
}

describe('service side of the shared stream relay', () => {
  it('reports unavailable readiness only for the current core connection', async () => {
    const x = setup(), log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const refused = Promise.resolve({ ok: false })
      x.link.connected({ query: () => refused })
      await refused
      expect(log).toHaveBeenCalledExactlyOnceWith('[streams] agentBrowser UNAVAILABLE')
      for (const current of [true, false]) {
        let reject!: (error: Error) => void
        const pending = new Promise<Record<string, unknown>>((_resolve, fail) => { reject = fail })
        x.link.connected({ query: () => pending })
        if (!current) x.link.disconnected()
        reject(new Error('fixture unavailable'))
        await pending.catch(() => {})
      }
      expect(log).toHaveBeenCalledTimes(2)
    } finally { log.mockRestore(); x.link.disconnected() }
  })

  it.each(['agentBrowser', 'viewers'])('binds %s answers to the private grant and the owning connection', service => {
    const x = setup(service)
    // Each case uses its actual declaration; no service can choose the connection in its notice.
    x.link.connected(x.connection)
    x.link.event(x.event())
    expect(x.endpoint.frame).toHaveBeenCalledWith(expect.objectContaining({ grant: 'g1', connection: 'c1' }))
    const type = x.spec.opened ?? 'viewer_response'
    const payload = x.spec.opened ? { requestId: 'g1', streamId: ID } : { streamId: 'g1', status: 200 }
    expect(x.link.frame('foreign', type, payload)).toBe(false)
    expect(x.link.frame('c1', 'terminal_output', payload)).toBe(false)
    expect(x.link.frame('c1', type, payload)).toBe(true)
    expect(x.notice).toHaveBeenLastCalledWith('client_stream', { grant: 'g1', type, payload })
    expect(x.link.frame('c1', x.spec.close, { streamId: x.spec.opened ? ID : 'g1' })).toBe(true)
    expect(x.link.frame('c1', x.spec.close, { streamId: x.spec.opened ? ID : 'g1' })).toBe(false)
  })

  it('reuses a duplicate viewer grant and retires it only after both half-closes', () => {
    const x = setup('viewers'); x.link.connected(x.connection)
    x.link.event(x.event()); x.link.event(x.event())
    x.link.event(x.event('viewer_end'))
    expect(x.link.frame('c1', 'viewer_response', { streamId: 'g1' })).toBe(true)
    expect(x.link.frame('c1', 'viewer_end', { streamId: 'g1' })).toBe(true)
    expect(x.link.frame('c1', 'viewer_data', { streamId: 'g1', data: 'AA==' })).toBe(false)
    x.link.event(x.event('viewer_request', 'g2'))
    x.link.frame('c1', 'viewer_end', { streamId: 'g2' })
    x.link.event(x.event('viewer_end', 'g2'))
    expect(x.link.frame('c1', 'viewer_data', { streamId: 'g2' })).toBe(false)
    x.link.event(x.event('viewer_request', 'g3'))
    x.link.event(x.event('viewer_close', 'g3'))
    expect(x.link.frame('c1', 'viewer_data', { streamId: 'g3' })).toBe(false)
  })

  it('closes a late Browser answer, and releases refused opens and unknown IDs', () => {
    const x = setup(); x.link.connected(x.connection)
    expect(x.link.frame('c1', x.spec.opened!, { requestId: 'unknown', streamId: ID })).toBe(false)
    expect(x.endpoint.refused).toHaveBeenCalledWith('unknown', ID)
    expect(x.link.frame('c1', x.spec.opened!, { streamId: ID })).toBe(false)
    expect(x.endpoint.refused).toHaveBeenCalledWith('', ID)
    expect(x.link.frame('c1', x.spec.opened!, { requestId: 7, streamId: 'not-a-uuid' })).toBe(false)
    x.link.event(x.event())
    expect(x.link.frame('c1', x.spec.opened!, { requestId: 'g1', error: 'NO_BROWSER' })).toBe(true)
    expect(x.link.frame('c1', x.spec.opened!, { requestId: 'g1', streamId: ID })).toBe(false)
  })

  it('drops malformed, unowned and over-cap events before touching a component', () => {
    const x = setup('viewers', { grants: 1 }); x.link.connected(x.connection)
    for (const change of [{ grant: 7 }, { grant: '../bad' }, { connection: 7 }, { type: 7 }, { type: 'terminal_input' },
      { asker: null }, { asker: {} }, { asker: { local: true, owner: 7 } }, { payload: null }, { payload: [] }]) {
      expect(x.link.event({ ...x.event(), ...change })).toBe(true)
    }
    x.link.event(x.event('viewer_data'))
    expect(x.endpoint.frame).not.toHaveBeenCalled()
    x.link.event(x.event())
    x.link.event(x.event('viewer_request', 'g2'))
    x.link.event(x.event('viewer_request', 'g1', 'foreign'))
    x.link.event(x.event('viewer_data', 'g1', 'foreign'))
    expect(x.endpoint.frame).toHaveBeenCalledTimes(1)
    expect(x.link.event({ kind: 'unknown' })).toBe(false)
  })

  it('answers unavailable if a component rejects input or is absent, then retains no grant', () => {
    const x = setup(); x.link.connected(x.connection)
    x.endpoint.frame.mockReturnValueOnce(false)
    x.link.event(x.event())
    expect(x.notice).toHaveBeenCalledWith('client_stream', { grant: 'g1', type: x.spec.opened, payload: { requestId: 'g1', error: 'NOT_READY' } })
    x.off(); x.link.event(x.event())
    expect(x.link.binary(Uint8Array.of(1))).toBe(false)
    x.link.closed(); x.link.disconnected()
    expect(x.link.bytes(Uint8Array.of(1))).toBe(false)
  })

  it('forwards only known-grant control, and tears down a refused grant once', () => {
    const x = setup(); x.link.connected(x.connection); x.link.event(x.event())
    x.link.frame('c1', x.spec.opened!, { requestId: 'g1', streamId: ID })
    for (const grant of [7, 'unknown']) x.link.event({ kind: 'client_stream_control', grant, payload: {} })
    for (const payload of [null, [], 7]) x.link.event({ kind: 'client_stream_control', grant: 'g1', payload })
    expect(x.endpoint.control).not.toHaveBeenCalled()
    x.link.event({ kind: 'client_stream_control', grant: 'g1', payload: { route: 'direct' } })
    x.link.event({ kind: 'client_stream_control', grant: null, payload: { kind: 'transport_error' } })
    expect(x.endpoint.control.mock.calls).toEqual([['g1', { route: 'direct' }], [null, { kind: 'transport_error' }]])
    x.link.event({ kind: 'client_stream_refused', grant: 7 })
    x.link.event({ kind: 'client_stream_refused', grant: 'g1' })
    expect(x.endpoint.refused).toHaveBeenCalledWith('g1', ID, 'c1')
    x.link.event({ kind: 'client_stream_refused', grant: 'late', streamId: ID })
    expect(x.endpoint.refused).toHaveBeenCalledWith('late', ID, undefined)
    expect(x.link.frame('c1', x.spec.close, { streamId: ID })).toBe(false)
  })

  it('drops connection grants and never sends an old answer through a replacement core', () => {
    const x = setup(); x.link.connected(x.connection); x.link.event(x.event())
    x.link.event(x.event(x.spec.open, 'g2', 'c2'))
    x.link.event({ kind: 'client_stream_closed', connection: 7 })
    x.link.event({ kind: 'client_stream_closed', connection: 'c1' })
    expect(x.link.frame('c1', x.spec.opened!, { requestId: 'g1', error: 'NO_BROWSER' })).toBe(false)
    expect(x.link.frame('c2', x.spec.opened!, { requestId: 'g2', streamId: ID })).toBe(true)
    x.link.connected(x.connection)
    const replacement = { query: async () => ({ ok: true }), notice: vi.fn() }
    x.link.connected(replacement)
    expect(x.link.frame('c2', x.spec.close, { streamId: ID })).toBe(false)
    expect(replacement.notice).not.toHaveBeenCalled()
    expect(x.link.bytes(Uint8Array.of(1))).toBe(false)
    x.link.disconnected(); x.link.disconnected()
    x.link.event({ kind: 'client_stream_closed' })
  })

  it('passes the exact binary buffer and reports refusal from its real sender', () => {
    const x = setup(), raw = Uint8Array.of(1, 2)
    expect(x.link.bytes(raw)).toBe(false)
    x.link.connected(x.connection)
    expect(x.link.bytes(raw)).toBe(true)
    expect(x.sendBinary).toHaveBeenCalledWith(raw)
    expect(x.sendBinary.mock.calls[0]![0]).toBe(raw)
    expect(x.link.binary(raw)).toBe(true)
    expect(x.endpoint.binary.mock.calls[0]![0]).toBe(raw)
  })
})
