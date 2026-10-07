// The devices in their own process, as the core sees them (core/devicesLink.ts): what it tells them, what it
// asks and what it does when they do not answer, and what it answers them.
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createDevicesLink, DEVICES_WAIT_MS, ROUTE_TASK_WAIT_MS, type DevicesState } from './devicesLink.js'

const STATE: DevicesState = {
  desk: ['a1'], foreground: true, swarms: null, unread: [], focus: { voice: null, form: null }, engines: ['claude'], commanders: false,
}

function link(answer: Record<string, unknown> = {}) {
  const core = fakeCore()
  const sent: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const call = vi.fn(async (_type: string, _payload: Record<string, unknown>, _waitMs: number) => answer)
  const log = vi.fn()
  const devices = createDevicesLink({ core, notify: (frame) => { sent.push(frame); return true }, call, state: () => STATE, log })
  return { core, sent, call, log, devices, port: devices.port }
}

describe('what the core tells the devices', () => {
  it('is a notice for each, by kind, carrying what the windows said', () => {
    const { sent, port } = link()
    port.card({ type: 'commander_event', agentId: 'a1' })
    port.desk(['a1'], false)
    port.swarms(null)
    port.unread([])
    port.appFocus('m1', 'a1')
    port.seen('a1')
    port.seen('a1', 'tok')
    port.settings('usb', { brightness: 3 })
    port.windowFocus({ voice: null, form: null })
    port.windowReply('form', 'w1', 'm1', { ok: true })
    port.voiceReply('v1', { t: 'taken' })
    port.windowGone('w1')
    port.scroll('move', 2, 9)
    port.engines(['codex'])
    port.commanders(true)
    expect(sent.map((frame) => frame.payload)).toEqual([
      { kind: 'card', frame: { type: 'commander_event', agentId: 'a1' } },
      { kind: 'desk', agentIds: ['a1'], foreground: false },
      { kind: 'swarms', swarms: null },
      { kind: 'unread', items: [] },
      { kind: 'appFocus', machineId: 'm1', agentId: 'a1' },
      { kind: 'seen', agentId: 'a1' },
      { kind: 'seen', agentId: 'a1', readToken: 'tok' },
      { kind: 'settings', id: 'usb', patch: { brightness: 3 } },
      { kind: 'windowFocus', focus: { voice: null, form: null } },
      { kind: 'windowReply', which: 'form', connId: 'w1', machineId: 'm1', reply: { ok: true } },
      { kind: 'voiceReply', voiceId: 'v1', reply: { t: 'taken' } },
      { kind: 'windowGone', connId: 'w1' },
      { kind: 'scroll', phase: 'move', dy: 2, velocity: 9 },
      { kind: 'engines', engines: ['codex'] },
      { kind: 'commanders', connected: true },
    ])
    expect(sent.every((frame) => frame.type === 'service_event')).toBe(true)
  })

  it('tells devices started in the core\'s own process the same, as calls on their port', () => {
    const { devices, sent } = link()
    const started = { desk: vi.fn(), swarms: vi.fn(), unread: vi.fn(), windowFocus: vi.fn(), engines: vi.fn(), commanders: vi.fn() }
    devices.started(started as never)
    expect(started.desk).toHaveBeenCalledWith(['a1'], true)
    expect(started.swarms).toHaveBeenCalledWith(null)
    expect(started.unread).toHaveBeenCalledWith([])
    expect(started.windowFocus).toHaveBeenCalledWith({ voice: null, form: null })
    expect(started.engines).toHaveBeenCalledWith(['claude'])
    expect(started.commanders).toHaveBeenCalledWith(false)
    expect(sent).toEqual([])
  })

  it('says everything again when they connect, and nothing to stop: the master stops their process', async () => {
    const { sent, devices, port } = link()
    devices.connected()
    expect(sent).toEqual([{ type: 'service_event', payload: { ...STATE, kind: 'state' } }])
    await expect(port.stop()).resolves.toBeUndefined()
  })
})

describe('what the core asks of the devices', () => {
  it('asks ⌘K and the Wi-Fi device\'s step under their own types, with deadlines', async () => {
    const answer = { agentId: 'a1', machineId: 'm1', name: 'api', confidence: 1, reason: 'r', candidates: [], weighed: 1, machines: 1, via: 'model' }
    const { call, port } = link(answer)
    expect(await port.routeTask('fix it')).toEqual(answer)
    expect(call).toHaveBeenLastCalledWith('routeTask', { text: 'fix it' }, ROUTE_TASK_WAIT_MS)
    call.mockResolvedValueOnce({ ok: false, machine: 'mac-mini', reason: 'gone' })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: false, machine: 'mac-mini', reason: 'gone' })
    expect(call).toHaveBeenLastCalledWith('routeSend', { agentId: 'a1', text: 'go' }, DEVICES_WAIT_MS)
    call.mockResolvedValueOnce({ machineId: 'm1', agentId: 'a2' })
    expect(await port.stepFocus('next', 'a1')).toEqual({ machineId: 'm1', agentId: 'a2' })
    expect(call).toHaveBeenLastCalledWith('stepFocus', { direction: 'next', currentAgentId: 'a1' }, DEVICES_WAIT_MS)
    call.mockResolvedValueOnce({ step: 'no_agents' })
    expect(await port.stepFocus('previous')).toBe('no_agents')
    expect(call).toHaveBeenLastCalledWith('stepFocus', { direction: 'previous' }, DEVICES_WAIT_MS)
    call.mockResolvedValueOnce({ machineId: 7 })
    expect(await port.stepFocus('next')).toEqual({ machineId: '', agentId: '' })
  })

  it('answers with the port\'s fallbacks when they are down, slow or failing: ⌘K says so, the walk finds no desk', async () => {
    const { port } = link({ error: 'SERVICE_UNAVAILABLE', service: 'devices', retryable: true })
    expect(await port.routeTask('fix it')).toMatchObject({ agentId: '', reason: 'the devices service is unavailable', candidates: [] })
    expect(await port.routeSend('a1', 'go')).toEqual({ ok: false, machine: '', reason: 'the devices service is unavailable' })
    expect(await port.stepFocus('next')).toBe('no_agents')
  })
})

describe('what the devices ask of the core', () => {
  it('is this computer\'s agents as the dial lists them, with what the dial reads in line', async () => {
    const agent = { agentId: 'a1', engine: 'claude' } as RegisteredSession
    const { core, devices } = link()
    vi.mocked(core.agents.advertised).mockReturnValue([agent])
    vi.mocked(core.agents.displayName).mockReturnValue('api')
    vi.mocked(core.agents.runtimeProfile).mockReturnValue('runtime-v1:s:claude:opus@high')
    expect(await devices.answer('view', {})).toEqual({
      agents: [{ ...agent, displayName: 'api', runtimeProfile: 'runtime-v1:s:claude:opus@high' }],
      machine: { id: 'machine-1', computerId: 'computer-1', name: 'This machine' },
      signedIn: true, environment: 'prod', hasWindow: true,
    })
  })

  it('is the core\'s own doors and the sign-in, asked when they need them', async () => {
    const { core, devices } = link()
    vi.mocked(core.agents.activityText).mockResolvedValue('Reading')
    vi.mocked(core.turns.recent).mockResolvedValue([{ recap: 'done' }])
    vi.mocked(core.turns.asks).mockResolvedValue(['why?'])
    vi.mocked(core.questions.answerReviewed).mockResolvedValue(true)
    vi.mocked(core.agents.runtimeModels).mockResolvedValue([{ id: 'opus' } as never])
    vi.mocked(core.agents.fork).mockResolvedValue({ ok: true, agentId: 'a2' })
    expect(await devices.answer('activityText', { agentId: 'a1' })).toEqual({ text: 'Reading' })
    expect(await devices.answer('recent', { agentId: 'a1', n: 2 })).toEqual({ turns: [{ recap: 'done' }] })
    expect(core.turns.recent).toHaveBeenLastCalledWith('a1', 2)
    await devices.answer('recent', { agentId: 7 })
    expect(core.turns.recent).toHaveBeenLastCalledWith('', 3)
    expect(await devices.answer('asks', { agentId: 'a1' })).toEqual({ asks: ['why?'] })
    expect(await devices.answer('answerReviewed', { answer: { agentId: 'a1' } })).toEqual({ ok: true })
    expect(await devices.answer('models', { agentId: 'a1' })).toEqual({ models: [{ id: 'opus' }] })
    expect(await devices.answer('fork', { agentId: 'a1' })).toEqual({ ok: true, agentId: 'a2' })
    // The account, as every service in its own process asks it (core/accountQueries.ts).
    expect(await devices.answer('access_token', {})).toEqual({ token: 'token' })
    expect(await devices.answer('access_token', { force: true, failedToken: 'old' })).toEqual({ token: 'token' })
    expect(core.account.accessToken).toHaveBeenLastCalledWith({ force: true, failedToken: 'old' })
    expect(await devices.answer('lane', { op: 'seal', machineId: 'm2', frame: { type: 'message' } })).toEqual({ frame: { type: 'message' } })
    expect(core.account.lane.seal).toHaveBeenCalledWith('m2', { type: 'message' })
    expect(await devices.answer('machines', {})).toEqual({ status: 200, body: { success: true, data: { machines: [] } } })
    expect(await devices.answer('nothing', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await devices.answer('constructor', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})

describe('what the devices tell the core', () => {
  it('is a turn, a stop, an answer, a model, the windows\' frames and the device status', () => {
    const { core, devices } = link()
    devices.notice({ kind: 'turn', agentId: 'a1', text: 'hello' })
    devices.notice({ kind: 'stop', agentId: 'a1' })
    devices.notice({ kind: 'answer', agentId: 'a1', requestId: 'r1', answers: { q: 'Coffee' } })
    devices.notice({ kind: 'answer', agentId: 'a1', requestId: 'r1', answers: 'nonsense' })
    devices.notice({ kind: 'setRuntime', agentId: 'a1', model: 'opus', effort: 'high' })
    devices.notice({ kind: 'setRuntime', agentId: 'a1' })
    devices.notice({ kind: 'sendLocal', frame: { type: 'dial_focus', payload: { agentId: 'a1' } } })
    devices.notice({ kind: 'sendLocal', frame: 'not a frame' })
    devices.notice({ kind: 'sendLocal', frame: { type: 'dial_focus' } })
    devices.notice({ kind: 'sendToWindow', connId: 'w1', frame: { type: 'dial_form', payload: {} } })
    devices.notice({ kind: 'sendToWindow', connId: 'w1', frame: null })
    devices.notice({ kind: 'devicesChanged', status: { attached: true }, revision: 2 })
    expect(core.turns.send).toHaveBeenCalledWith('a1', 'hello')
    expect(core.turns.stop).toHaveBeenCalledWith('a1')
    expect(vi.mocked(core.questions.answer).mock.calls).toEqual([['a1', 'r1', { q: 'Coffee' }], ['a1', 'r1', {}]])
    expect(vi.mocked(core.agents.setRuntime).mock.calls).toEqual([['a1', 'opus', 'high'], ['a1', undefined, undefined]])
    expect(vi.mocked(core.clients.sendLocal).mock.calls).toEqual([[{ type: 'dial_focus', payload: { agentId: 'a1' } }]])
    expect(vi.mocked(core.clients.sendToWindow).mock.calls).toEqual([['w1', { type: 'dial_form', payload: {} }]])
    expect(core.clients.devicesChanged).toHaveBeenCalledWith({ status: { attached: true }, revision: 2 })
  })

  it('is a dial on the wire, and none once their process is gone', () => {
    const { core, devices } = link()
    // Gone with no dial on the wire: nothing to take back.
    devices.disconnected()
    expect(core.clients.dialWatching).not.toHaveBeenCalled()
    devices.notice({ kind: 'dialWatching', watching: true })
    expect(core.clients.dialWatching).toHaveBeenLastCalledWith(true)
    devices.disconnected()
    expect(core.clients.dialWatching).toHaveBeenLastCalledWith(false)
    devices.notice({ kind: 'dialWatching', watching: 'yes' })
    expect(core.clients.dialWatching).toHaveBeenLastCalledWith(false)
  })

  it('logs what it does not hear, by kind, and to the console by default', () => {
    const { devices, log } = link()
    devices.notice({ kind: 'shout' })
    devices.notice({})
    devices.notice({ kind: 'hasOwnProperty' })
    expect(log.mock.calls).toEqual([
      ['[services] devices said shout, which the core does not hear'],
      ['[services] devices said nothing, which the core does not hear'],
      ['[services] devices said hasOwnProperty, which the core does not hear'],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createDevicesLink({ core: fakeCore(), notify: () => true, call: async () => ({}), state: () => STATE }).notice({ kind: 'shout' })
    expect(warn).toHaveBeenCalledWith('[services] devices said shout, which the core does not hear')
    warn.mockRestore()
  })
})
