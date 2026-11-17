import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { createWifiLink } from './wifiLink.js'
import type { ServiceFrame } from './serviceLinks.js'

function link() {
  const core = fakeCore()
  const sent: ServiceFrame[] = []
  const log = vi.fn()
  const deliveries = { answer: vi.fn(() => ({})) }
  const wifi = createWifiLink({ core, deliveries, notify: (frame) => { sent.push(frame); return true }, log })
  const kinds = () => sent.map((frame) => (frame.payload as { kind: string }).kind)
  return { core, sent, log, wifi, kinds, deliveries }
}

describe('the Wi-Fi device in the devices\' process, as the core sees it', () => {
  it('forwards shared input facts and disconnects without legacy interpretation', () => {
    const { wifi, sent } = link()
    const progress = { agentId: 'a', deliveryId: 'd', when: 'composer' as const, phase: 'written' as const }
    wifi.port.input(progress)
    wifi.port.disconnected()
    expect(sent).toEqual([
      { type: 'service_event', payload: { kind: 'input', event: progress } },
      { type: 'service_event', payload: { kind: 'disconnected' } },
    ])
  })

  it.each([
    ['claude', '2.0.0', 's', 'waiting_for_writer', true, 'daemon_queue', 'waiting_for_writer'],
    ['claude', '2.0.0', 's', 'dispatching', false, 'direct', 'submitted'],
    ['codex', '0.106.0', 's', 'written', true, 'steering', 'submitted'],
    ['codex', '1.0.0', 's', 'composer_available', true, 'steering', 'accepted'],
    ['codex', '0.105.0', 's', 'unconfirmed', true, 'native_input', 'unconfirmed'],
    ['codex', undefined, 's', 'written', true, 'native_input', 'submitted'],
    ['commandcode', '1.0.0', 's', 'written', true, 'native_input', 'submitted'],
    ['codex', '0.106.0', 'different', 'written', true, 'native_input', 'submitted'],
    [undefined, undefined, 's', 'written', true, 'native_input', 'submitted'],
  ])('translates retained-worker progress for %s %s bound to %s during %s', (engine, cliVersion, sessionId, phase, duringTurn, mode, legacyPhase) => {
    const { wifi, core, sent } = link()
    vi.mocked(core.agents.byAgent).mockReturnValue(engine ? { agentId: 'a', sessionId: 's', engine, cliVersion } as never : undefined)
    const progress = { agentId: 'a', sessionId, deliveryId: 'd', when: 'composer', phase, duringTurn } as Parameters<typeof wifi.input>[0]
    wifi.input({ ...progress, deliveryId: undefined })
    expect(sent).toEqual([])
    wifi.input(progress)
    expect(sent).toEqual([{ type: 'service_event', payload: { kind: 'inputStatus', event: { sessionId: 'a', deliveryId: 'd', mode, phase: legacyPhase } } }])
  })
  it('tells an error-ignoring old worker its input was refused through the legacy receipt event', async () => {
    const { wifi, deliveries, sent } = link()
    deliveries.answer.mockReturnValueOnce({ error: 'INVALID_INPUT' })
    const authority = { current: () => true, ownsRequest: () => false }
    // Old wifiProcess.submit awaits the query but discards its returned error.
    await wifi.answer('submit', { agentId: 'a', deliveryId: 'd', text: '' }, authority)
    expect(deliveries.answer).toHaveBeenCalledWith('wifi', 'input', { version: 1, agentId: 'a', text: '', deliveryId: 'd', when: 'composer' }, authority)
    expect(sent).toEqual([{ type: 'service_event', payload: { kind: 'delivery', event: { sessionId: 'a', deliveryId: 'd', state: 'rejected', reason: 'INVALID_INPUT' } } }])
  })

  it('does not translate a stale legacy refusal into a replacement connection', async () => {
    const { wifi, deliveries, sent } = link()
    deliveries.answer.mockReturnValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await wifi.answer('submit', { agentId: 'a', deliveryId: 'd', text: 'hello' }, { current: () => false, ownsRequest: () => false }))
      .toEqual({ error: 'SERVICE_UNAVAILABLE' })
    expect(sent).toEqual([])
  })

  it.each(['claude', 'codex', 'commandcode'])('translates %s batches for retained workers without changing the shared batch', engine => {
    const { wifi, core, sent, kinds } = link()
    vi.mocked(core.agents.byAgent).mockReturnValue({ agentId: 'a', sessionId: 's', engine } as never)
    const events = [{ type: 'turn_ended', payload: {} }, { type: 'turn_started', payload: { userMessage: 'next' } }] as never
    wifi.port.events('a', events)
    expect(sent[0]).toEqual({ type: 'service_event', payload: { kind: 'input_events', agentId: 'a', events } })
    expect(kinds()).toEqual(engine === 'commandcode' ? ['input_events', 'turnEnded', 'turnStarted'] : ['input_events', 'turnStarted'])
  })

  it('tells it everything as notices, in the order the core said it', async () => {
    const { wifi, sent, kinds } = link()
    const client = { role: 'device' as const, label: 'Desk', identity: 'id', direct: false }
    wifi.port.session('c', client)
    await wifi.port.request('c', { type: 'autonomous_device_request' }, { payload: { type: 'hello' } })
    wifi.port.dropped('c')
    wifi.port.revoked('id')
    await wifi.port.resume({ sessions: [{ connId: 'c', client }], helloed: [], focus: null })
    wifi.port.card({ type: 'commander_event' })
    wifi.port.card({ type: 'commander_event' }, 'whole')
    wifi.port.turnStarted('a')
    wifi.port.turnEnded('a', true)
    wifi.port.stream('a', [])
    wifi.port.transcript('a', 's', 'claude', 'line')
    wifi.port.delivery({ deliveryId: 'd', sessionId: 'a', state: 'delivered' })
    wifi.port.dispatched('a', 'd', 'hi')
    wifi.port.dispatched('a', 'd', 'hi', 's')
    wifi.port.inputStatus({ deliveryId: 'd' } as never)
    wifi.port.agentGone('a')
    await wifi.port.appFocus('m', null, 'w')
    wifi.port.revealed('op', 'a')
    await wifi.port.stop()
    expect(kinds()).toEqual(['session', 'request', 'dropped', 'revoked', 'resume', 'card', 'card', 'turnStarted', 'turnEnded', 'stream',
      'transcript', 'delivery', 'dispatched', 'dispatched', 'inputStatus', 'agentGone', 'appFocus', 'revealed'])
    expect(sent[0].payload).toEqual({ kind: 'session', connId: 'c', client })
    expect(sent[5].payload).toEqual({ kind: 'card', frame: { type: 'commander_event' } })
    expect(sent[6].payload).toEqual({ kind: 'card', frame: { type: 'commander_event' }, fullText: 'whole' })
    expect(sent[12].payload).toEqual({ kind: 'dispatched', agentId: 'a', deliveryId: 'd', text: 'hi' })
    expect(sent[13].payload).toMatchObject({ sessionId: 's' })
  })

  it('answers what it asks through the core\'s Wi-Fi doors', async () => {
    const { wifi, core, deliveries } = link()
    expect(await wifi.answer('machine', {})).toEqual({ id: 'machine-1' })
    expect(await wifi.answer('view', {})).toEqual({ agents: [], store: [], hasWindow: true })
    vi.mocked(core.turns.recent).mockResolvedValueOnce([{ recap: 'done' }] as never)
    expect(await wifi.answer('recent', { agentId: 'a', n: 1 })).toEqual({ turns: [{ recap: 'done' }] })
    expect(core.turns.recent).toHaveBeenLastCalledWith('a', 1)
    await wifi.answer('recent', { agentId: 7 })
    expect(core.turns.recent).toHaveBeenLastCalledWith('', 3)
    expect(await wifi.answer('stop', { agentId: 'a' })).toEqual({ ok: true })
    expect(await wifi.answer('answer', { agentId: 'a', questionRequestId: 'r', answers: { q: 'yes' }, requestId: 'the-link-s-own' })).toEqual({ ok: true })
    expect(core.wifi.answer).toHaveBeenLastCalledWith('a', 'r', { q: 'yes' })
    await wifi.answer('answer', { agentId: 'a', questionRequestId: 'r', answers: ['no'] })
    expect(core.wifi.answer).toHaveBeenLastCalledWith('a', 'r', {})
    expect(await wifi.answer('create', { packageId: 'p', engine: 'claude', cwd: '/w' })).toEqual({ ok: false, error: 'UNSUPPORTED' })
    expect(await wifi.answer('stepFocus', { direction: 'previous', currentAgentId: 'a' })).toEqual({ step: 'no_agents' })
    expect(core.wifi.stepFocus).toHaveBeenLastCalledWith('previous', 'a')
    vi.mocked(core.wifi.stepFocus).mockResolvedValueOnce({ machineId: 'm', agentId: 'b' })
    expect(await wifi.answer('stepFocus', { direction: 'next' })).toEqual({ machineId: 'm', agentId: 'b' })
    expect(core.wifi.stepFocus).toHaveBeenLastCalledWith('next', undefined)
    expect(await wifi.answer('submit', { agentId: 'a', text: 'hi', deliveryId: 'd' })).toEqual({})
    expect(deliveries.answer).toHaveBeenCalledWith('wifi', 'input', { version: 1, agentId: 'a', text: 'hi', deliveryId: 'd', when: 'composer' }, undefined)
    expect(await wifi.answer('nothing', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('hears what it tells the core without asking, and says when it hears something else', () => {
    const { wifi, core, log, deliveries } = link()
    wifi.notice({ kind: 'cancel', deliveryId: 'd' })
    wifi.notice({ kind: 'started', agentId: 'a', text: 'hi' })
    wifi.notice({ kind: 'scroll', phase: 'move', dy: 3, velocity: 9 })
    wifi.notice({ kind: 'scroll', phase: 'fling', dy: 3 })
    wifi.notice({ kind: 'scroll', phase: 'up', dy: 'far' })
    wifi.notice({ kind: 'focusApp', agentId: 'a', expiresAt: 5, focusRevision: 'r' })
    wifi.notice({ kind: 'reveal', operationId: 'op', agentId: 'a' })
    wifi.notice({ kind: 'send', connId: 'c', identity: 'id', type: 'autonomous_device_result', payload: { ok: true } })
    wifi.notice({ kind: 'hello', connId: 'c', identity: 'id' })
    wifi.notice({ kind: 'hello', connId: 'c', identity: null })
    wifi.notice({ kind: 'joined' })
    wifi.notice({ kind: 'ready' })
    wifi.notice({ kind: 'unpaired', identity: 'id' })
    wifi.notice({ kind: 'focus', revision: 'r' })
    wifi.notice({ kind: 'transcripts', agentId: 'a', seen: 2 })
    wifi.notice({ kind: 'watching', agentIds: ['a', 4] })
    wifi.notice({ kind: 'streams', agentIds: 'a' })
    expect(deliveries.answer).toHaveBeenCalledWith('wifi', 'cancel_delivery', { deliveryId: 'd' })
    expect(deliveries.answer).toHaveBeenCalledTimes(1)
    expect(core.wifi.scroll).toHaveBeenCalledTimes(2)
    expect(core.wifi.scroll).toHaveBeenCalledWith('move', 3, 9)
    expect(core.wifi.scroll).toHaveBeenLastCalledWith('up', 0, 0)
    expect(core.wifi.focusApp).toHaveBeenCalledWith('a', 5, 'r')
    expect(core.wifi.reveal).toHaveBeenCalledWith('op', 'a')
    expect(core.wifi.send).toHaveBeenCalledWith('c', 'id', 'autonomous_device_result', { ok: true })
    expect(core.wifi.hello).toHaveBeenCalledWith('c', 'id')
    expect(core.wifi.hello).toHaveBeenLastCalledWith('c', null)
    expect(core.wifi.joined).toHaveBeenCalled()
    expect(core.wifi.ready).toHaveBeenCalled()
    expect(core.wifi.unpaired).toHaveBeenCalledWith('id')
    expect(core.wifi.focus).toHaveBeenCalledWith('r')
    expect(core.wifi.transcripts).toHaveBeenCalledWith('a', 2)
    expect(core.wifi.watching).toHaveBeenCalledWith(['a'])
    expect(core.wifi.streams).toHaveBeenCalledWith([])
    wifi.notice({ kind: 'toString' })
    wifi.notice({})
    expect(log).toHaveBeenCalledWith('[services] wifi said toString, which the core does not hear')
    expect(log).toHaveBeenLastCalledWith('[services] wifi said nothing, which the core does not hear')
  })

  it('logs to the console by default', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createWifiLink({ core: fakeCore(), deliveries: { answer: () => ({}) }, notify: () => true }).notice({ kind: 'nope' })
    expect(warn).toHaveBeenCalledWith('[services] wifi said nope, which the core does not hear')
    warn.mockRestore()
  })
})
