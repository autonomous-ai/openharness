import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { createWifiLink } from './wifiLink.js'
import type { ServiceFrame } from './serviceLinks.js'

function link() {
  const core = fakeCore()
  const sent: ServiceFrame[] = []
  const log = vi.fn()
  const wifi = createWifiLink({ core, notify: (frame) => { sent.push(frame); return true }, log })
  const kinds = () => sent.map((frame) => (frame.payload as { kind: string }).kind)
  return { core, sent, log, wifi, kinds }
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

  it('forwards one intact live batch without interpreting engine policy', () => {
    const { wifi, sent, kinds, core } = link()
    const events = [{ type: 'turn_ended', payload: {} }, { type: 'turn_started', payload: { userMessage: 'next' } }] as never
    wifi.port.events('a', events)
    expect(sent).toEqual([{ type: 'service_event', payload: { kind: 'input_events', agentId: 'a', events } }])
    expect(kinds()).toEqual(['input_events'])
    expect(core.agents.byAgent).not.toHaveBeenCalled()
  })

  it('tells it everything as notices, in the order the core said it', async () => {
    const { wifi, sent, kinds } = link()
    await wifi.port.resume({ focus: null })
    wifi.port.card({ type: 'commander_event' })
    wifi.port.card({ type: 'commander_event' }, 'whole')
    wifi.port.turnEnded('a', true)
    wifi.port.stream('a', [])
    wifi.port.transcript('a', 's', 'claude', 'line')
    wifi.port.delivery({ deliveryId: 'd', sessionId: 'a', state: 'delivered' })
    wifi.port.agentGone('a')
    await wifi.port.appFocus('m', null, 'w')
    wifi.port.revealed('op', 'a')
    await wifi.port.stop()
    expect(kinds()).toEqual(['resume', 'card', 'card', 'turnEnded', 'stream',
      'transcript', 'delivery', 'agentGone', 'appFocus', 'revealed'])
    expect(sent[0].payload).toEqual({ kind: 'resume', focus: null })
    expect(sent[1].payload).toEqual({ kind: 'card', frame: { type: 'commander_event' } })
    expect(sent[2].payload).toEqual({ kind: 'card', frame: { type: 'commander_event' }, fullText: 'whole' })
    expect(sent[5].payload).toEqual({ kind: 'transcript', agentId: 'a', sessionId: 's', engine: 'claude', line: 'line' })
  })

  it('answers what it asks through the core\'s Wi-Fi doors', async () => {
    const { wifi, core } = link()
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
    expect(await wifi.answer('submit', { agentId: 'a', text: 'hi', deliveryId: 'd' })).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await wifi.answer('nothing', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('hears what it tells the core without asking, and says when it hears something else', () => {
    const { wifi, core, log } = link()
    wifi.notice({ kind: 'cancel', deliveryId: 'd' })
    wifi.notice({ kind: 'started', agentId: 'a', text: 'hi' })
    expect(log).toHaveBeenCalledWith('[services] wifi said cancel, which the core does not hear')
    expect(log).toHaveBeenCalledWith('[services] wifi said started, which the core does not hear')
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
    expect(core.wifi.scroll).toHaveBeenCalledTimes(2)
    expect(core.wifi.scroll).toHaveBeenCalledWith('move', 3, 9)
    expect(core.wifi.scroll).toHaveBeenLastCalledWith('up', 0, 0)
    expect(core.wifi.focusApp).toHaveBeenCalledWith('a', 5, 'r')
    expect(core.wifi.reveal).toHaveBeenCalledWith('op', 'a')
    for (const kind of ['send', 'hello', 'joined', 'ready', 'unpaired', 'focus']) expect(log).toHaveBeenCalledWith(`[services] wifi said ${kind}, which the core does not hear`)
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
    createWifiLink({ core: fakeCore(), notify: () => true }).notice({ kind: 'nope' })
    expect(warn).toHaveBeenCalledWith('[services] wifi said nope, which the core does not hear')
    warn.mockRestore()
  })
})
