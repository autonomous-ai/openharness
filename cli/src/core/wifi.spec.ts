import { describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../lib/normalize.js'
import { WIFI_OFF, type RemoteClient, type WifiPort } from './api.js'
import { createWifiCore } from './wifi.js'

const device = (identity: string, direct = false): RemoteClient => ({ role: 'device', label: 'Desk', identity, direct })

function harness() {
  const port = {
    session: vi.fn(), request: vi.fn(async () => {}), dropped: vi.fn(), revoked: vi.fn(), resume: vi.fn(async () => {}), card: vi.fn(),
    turnStarted: vi.fn(), turnEnded: vi.fn(), stream: vi.fn(), transcript: vi.fn(), delivery: vi.fn(), dispatched: vi.fn(),
    inputStatus: vi.fn(), agentGone: vi.fn(), appFocus: vi.fn(async () => {}), revealed: vi.fn(), receipt: vi.fn(), stop: vi.fn(),
  } satisfies WifiPort
  let on: WifiPort | null = port
  const clients = new Map<string, RemoteClient>()
  const gateway = { device: vi.fn(), deviceClient: vi.fn(), revokeIdentity: vi.fn() }
  const joined = vi.fn()
  const ready = vi.fn()
  const fullText = vi.fn((agentId: string) => (agentId === 'a' ? 'the whole answer' : undefined))
  const wifi = createWifiCore({ port: () => on, gateway, remoteClient: (connId) => clients.get(connId) ?? null, fullText, joined, ready, doors: WIFI_OFF })
  return { wifi, port, clients, gateway, joined, ready, fullText, off: () => { on = null } }
}

describe('the Wi-Fi device, as the core keeps it', () => {
  it('counts a device as watching only while its app said hello on a session still its own, with the service there', () => {
    const { wifi, clients, gateway } = harness()
    clients.set('c1', device('id-1', true))
    clients.set('c2', device('id-2'))
    wifi.api.hello('c1', 'id-1')
    wifi.api.hello('c2', 'id-2')
    expect(gateway.deviceClient).toHaveBeenCalledWith('c1', 'id-1')
    // No service yet: nobody is served, so nobody watches.
    expect(wifi.connected()).toBe(false)
    wifi.started(null)
    expect(wifi.connected()).toBe(true)
    expect(wifi.directSessions()).toBe(1)
    // A session that became another identity's, or a phone's, is not the device that said hello.
    clients.set('c2', { ...device('id-3') })
    clients.set('c1', { ...device('id-1', true), role: 'web' })
    expect(wifi.connected()).toBe(false)
    clients.set('c1', device('id-1', true))
    wifi.api.hello('c1', null)
    expect(gateway.deviceClient).toHaveBeenLastCalledWith('c1', null)
    expect(wifi.connected()).toBe(false)
    wifi.stopped()
    expect(wifi.directSessions()).toBe(0)
  })

  it('seals an answer to a session only while it is still the identity\'s device', () => {
    const { wifi, clients, gateway } = harness()
    clients.set('c1', device('id-1'))
    wifi.api.send('c1', 'id-1', 'autonomous_device_result', { ok: true })
    wifi.api.send('c1', 'id-2', 'autonomous_device_result', { stolen: true })
    wifi.api.send('gone', 'id-1', 'autonomous_device_result', {})
    expect(gateway.device).toHaveBeenCalledTimes(1)
    expect(gateway.device).toHaveBeenCalledWith('c1', 'autonomous_device_result', { ok: true })
  })

  it('passes on the doors, a hello\'s join, its readiness and an unpairing the device asked for', () => {
    const { wifi, gateway, joined, ready } = harness()
    expect(wifi.api.view).toBe(WIFI_OFF.view)
    wifi.api.joined()
    expect(joined).toHaveBeenCalled()
    wifi.api.ready()
    expect(ready).toHaveBeenCalled()
    wifi.api.unpaired('id-1')
    expect(gateway.revokeIdentity).toHaveBeenCalledWith('id-1')
  })

  it('sends an agent\'s transcript lines from its prompt\'s dispatch until the service is done with it as of its last prompt', () => {
    const { wifi, port } = harness()
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    wifi.started(null)
    wifi.feed.inputDispatched('a', 'd1', 'hi', 's')
    expect(port.dispatched).toHaveBeenCalledWith('a', 'd1', 'hi', 's')
    // Before the service could ask for it: the prompt's first lines may come at once.
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(true)
    expect(wifi.feed.needsTranscript('a', 's', 'codex')).toBe(true)
    // Only the engines whose transcripts prove a turn.
    expect(wifi.feed.needsTranscript('a', 's', 'cursor')).toBe(false)
    wifi.feed.observeTranscript('a', 's', 'claude', '{"line":1}')
    expect(port.transcript).toHaveBeenCalledWith('a', 's', 'claude', '{"line":1}')
    // A second prompt the service has not heard of yet: its "done as of the first" leaves it watched.
    wifi.feed.inputDispatched('a', 'd2', 'again', 's')
    wifi.api.transcripts('a', 1)
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(true)
    wifi.api.transcripts('a', 2)
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    // An agent it was never told of.
    wifi.api.transcripts('b', 0)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(false)
  })

  it('takes the service\'s own list as it starts, and forgets the counts the last one heard', () => {
    const { wifi } = harness()
    wifi.started(null)
    wifi.feed.inputDispatched('a', 'd1', 'hi')
    wifi.api.watching(['b'])
    expect(wifi.feed.needsTranscript('a', 's', 'claude')).toBe(false)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(true)
    wifi.api.transcripts('b', 0)
    expect(wifi.feed.needsTranscript('b', 's', 'claude')).toBe(false)
  })

  it('streams the answer\'s text always and a tool\'s events only for a subscribed agent, and nothing with the service away', () => {
    const { wifi, port } = harness()
    const events = [
      { type: 'turn_started', payload: {} }, { type: 'text_delta', payload: { content: 'hi' } },
      { type: 'tool_start', payload: { id: 't', tool: 'Read', input: {} } }, { type: 'tool_end', payload: { id: 't', tool: 'Read', isError: false } },
      { type: 'thinking_delta', payload: {} }, { type: 'turn_ended', payload: {} },
    ] as unknown as LiveEvent[]
    wifi.feed.stream('a', events)
    expect(port.stream).not.toHaveBeenCalled()
    wifi.started(null)
    wifi.feed.stream('a', events)
    expect(port.stream).toHaveBeenLastCalledWith('a', [events[0], events[1], events[5]])
    wifi.api.streams(['a'])
    wifi.feed.stream('a', events)
    expect(port.stream).toHaveBeenLastCalledWith('a', [events[0], events[1], events[2], events[3], events[5]])
    port.stream.mockClear()
    wifi.feed.stream('a', [events[4]])
    expect(port.stream).not.toHaveBeenCalled()
  })

  it('passes what the agents do and the panes say on to the service, and nothing when it is off', () => {
    const { wifi, port, off } = harness()
    wifi.feed.delivery({ deliveryId: 'd', sessionId: 'a', state: 'delivered' })
    wifi.feed.inputStatus({ deliveryId: 'd', sessionId: 'a', mode: 'queued', phase: 'waiting' } as never)
    wifi.feed.agentGone('a')
    wifi.feed.turnStarted('a')
    wifi.feed.turnEnded('a')
    wifi.feed.turnEnded('b', true)
    expect(port.delivery).toHaveBeenCalledWith({ deliveryId: 'd', sessionId: 'a', state: 'delivered' })
    expect(port.inputStatus).toHaveBeenCalled()
    expect(port.agentGone).toHaveBeenCalledWith('a')
    expect(port.turnStarted).toHaveBeenCalledWith('a')
    expect(port.turnEnded).toHaveBeenCalledWith('a', false)
    expect(port.turnEnded).toHaveBeenCalledWith('b', true)
    off()
    for (const call of [() => wifi.feed.delivery({ deliveryId: 'd', sessionId: 'a', state: 'delivered' }), () => wifi.feed.agentGone('a'),
      () => wifi.feed.observeTranscript('a', 's', 'claude', 'x'), () => wifi.feed.inputDispatched('a', 'd', 't'),
      () => wifi.feed.inputStatus({} as never), () => wifi.feed.turnStarted('a'), () => wifi.feed.turnEnded('a'),
      () => wifi.card({ type: 'commander_event' }), () => wifi.fromGateway.request('c', {}, null), () => wifi.fromGateway.revoked('i'),
      () => wifi.fromGateway.dropped('c'), () => wifi.fromGateway.session('c', device('i')), () => wifi.started(null)]) expect(call()).toBeUndefined()
    wifi.api.streams(['a'])
    expect(wifi.feed.stream('a', [{ type: 'text_delta', payload: { content: 'x' } } as unknown as LiveEvent])).toBeUndefined()
  })

  it('hands a summary card its turn\'s whole answer, and any other card as it is', () => {
    const { wifi, port, fullText } = harness()
    const summary = { type: 'commander_event', agentId: 'a', payload: { kind: 'summary', text: 'short' } }
    wifi.card(summary)
    expect(port.card).toHaveBeenLastCalledWith(summary, 'the whole answer')
    const tool = { type: 'commander_event', agentId: 'a', payload: { kind: 'tool' } }
    wifi.card(tool)
    expect(port.card).toHaveBeenLastCalledWith(tool, undefined)
    wifi.card({ type: 'commander_question', agentId: 'a' })
    wifi.card({ type: 'commander_event', payload: { kind: 'summary' } })
    expect(fullText).toHaveBeenCalledTimes(1)
  })

  it('passes the gateway\'s device sessions on, and forgets a phone\'s', () => {
    const { wifi, port, gateway } = harness()
    wifi.fromGateway.session('phone', { role: 'web', label: null, identity: 'p', direct: false })
    wifi.fromGateway.session('phone', null)
    expect(port.session).not.toHaveBeenCalled()
    wifi.fromGateway.session('c1', device('id-1'))
    expect(port.session).toHaveBeenCalledWith('c1', device('id-1'))
    // A device session that became something else is gone, as far as the service knows.
    wifi.fromGateway.session('c1', { role: 'web', label: null, identity: 'p', direct: false })
    expect(port.session).toHaveBeenLastCalledWith('c1', null)
    wifi.fromGateway.session('c1', device('id-1'))
    wifi.fromGateway.session('c1', null)
    expect(port.session).toHaveBeenLastCalledWith('c1', null)
    wifi.fromGateway.request('c1', { type: 'autonomous_device_request' }, { payload: {} })
    expect(port.request).toHaveBeenCalledWith('c1', { type: 'autonomous_device_request' }, { payload: {} })
    // A connection that closed: forgotten here and told to the gateway, said or not by the service.
    wifi.api.hello('c1', 'id-1')
    gateway.deviceClient.mockClear()
    wifi.fromGateway.dropped('c1')
    expect(gateway.deviceClient).toHaveBeenCalledWith('c1', null)
    expect(port.dropped).toHaveBeenCalledWith('c1')
    gateway.deviceClient.mockClear()
    wifi.fromGateway.dropped('c1')
    expect(gateway.deviceClient).not.toHaveBeenCalled()
  })

  it('forgets an unpaired identity\'s sessions and tells the service', () => {
    const { wifi, port, clients } = harness()
    clients.set('c1', device('id-1'))
    clients.set('c2', device('id-2'))
    wifi.api.hello('c1', 'id-1')
    wifi.api.hello('c2', 'id-2')
    wifi.started(null)
    wifi.fromGateway.revoked('id-1')
    expect(port.revoked).toHaveBeenCalledWith('id-1')
    expect(wifi.connected()).toBe(true)
    wifi.fromGateway.revoked('id-2')
    expect(wifi.connected()).toBe(false)
  })

  it('hands a starting service what it holds: the sessions, those still the device that said hello, and the window\'s focus', () => {
    const { wifi, port, clients, gateway } = harness()
    clients.set('c1', device('id-1'))
    clients.set('c2', device('id-2'))
    wifi.fromGateway.session('c1', device('id-1'))
    wifi.fromGateway.session('c2', device('id-2'))
    wifi.api.hello('c1', 'id-1')
    wifi.api.hello('c2', 'id-2')
    // c2's session went to another identity while the service was away: not handed back as id-2's.
    clients.set('c2', device('id-9'))
    wifi.api.focus('old')
    wifi.started({ machineId: 'm', agentId: 'a', connId: 'w' })
    expect(gateway.deviceClient).toHaveBeenCalledWith('c2', null)
    expect(port.resume).toHaveBeenCalledWith({
      sessions: [{ connId: 'c1', client: device('id-1') }, { connId: 'c2', client: device('id-2') }],
      helloed: [{ connId: 'c1', identity: 'id-1' }],
      focus: { machineId: 'm', agentId: 'a', connId: 'w' },
    })
    // The revision is the new service's to say.
    expect(wifi.focusRevision()).toBeUndefined()
    wifi.api.focus('r1')
    expect(wifi.focusRevision()).toBe('r1')
    wifi.stopped()
    expect(wifi.focusRevision()).toBeUndefined()
  })
})
