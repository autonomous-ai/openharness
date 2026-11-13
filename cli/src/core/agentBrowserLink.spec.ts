import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentBrowserLink, wakeAgentBrowser } from './agentBrowserLink.js'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

const row = (agentId: string, browser = true) => ({ agentId, sessionId: `s-${agentId}`, ...(browser ? { browser: true } : {}) }) as RegisteredSession

function setup(live: RegisteredSession[] = []) {
  const sync = vi.fn()
  const count = vi.fn()
  const ids = vi.fn(async () => ({ live: ['a1'], stopped: ['a2'] }))
  const ofPane = vi.fn(async (pane: string, _ancestors?: number[]) => (pane === '%7' ? { agentId: 'a1', guest: false } : pane === '%8' ? { agentId: 'kim', guest: true } : null))
  const browserFrame = vi.fn((..._frame: [connId: string, type: string, payload: Record<string, unknown>]) => true)
  const browserBytes = vi.fn((_frame: Uint8Array) => true)
  const core = fakeCore({ count, agents: { sync, ids, ofPane, live: () => live, byAgent: (agentId: string) => live.find(s => s.agentId === agentId) }, clients: { browserFrame, browserBytes } })
  const notify = vi.fn((..._frame: [frame: { type: string, payload?: unknown }, opts?: { untilDelivered?: boolean }]) => true)
  const notifyBinary = vi.fn((_bytes: Uint8Array) => true)
  const want = vi.fn()
  const streamsGone = vi.fn()
  const link = createAgentBrowserLink({ core, notify, notifyBinary, want, streamsGone })
  return { link, core, sync, count, notify, notifyBinary, want, streamsGone, ids, ofPane, browserFrame, browserBytes }
}
/** A link whose core answers what the test gives, and tells nobody anything. */
const bareLink = (core = fakeCore()) => createAgentBrowserLink({ core, notify: () => true, notifyBinary: () => true, want: () => {}, streamsGone: () => {} })

describe('the agent browser in its own process, as the core sees it', () => {
  it('tells the process of an agent with a browser, and asks for the process until it is there', () => {
    const { link, notify, want } = setup()
    link.port.attached(row('plain', false))
    expect(notify).not.toHaveBeenCalled()
    expect(want).not.toHaveBeenCalled()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(1)
    // An attach it misses is said again when it connects, so it is never held.
    expect(notify).toHaveBeenCalledWith({ type: 'service_event', payload: { kind: 'attached', session: row('a1') } }, undefined)
    link.connected()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(1)
    link.disconnected()
    link.port.attached(row('a1'))
    expect(want).toHaveBeenCalledTimes(2)
  })

  it('holds a stop and a delete until the process hears them', () => {
    const { link, notify } = setup()
    link.port.stopped('a1')
    link.port.deleted('a2')
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'stopped', agentId: 'a1' } }, { untilDelivered: true }],
      [{ type: 'service_event', payload: { kind: 'deleted', agentId: 'a2' } }, { untilDelivered: true }],
    ])
    expect(link.port.stop()).toBeUndefined()
  })

  it('says every agent with a browser again each time the process connects', () => {
    const { link, notify } = setup([row('a1'), row('plain', false)])
    link.connected()
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'attached', session: row('a1') } }, undefined]])
  })

  it('keeps what the process says of an attached agent\'s browser, for its frame, and sends the frame again', async () => {
    const { link, sync } = setup([row('a1')])
    link.port.attached(row('a1'))
    expect(await link.answer('browser_state', { agentId: 'a1', state: { state: 'setup', step: 'building' } })).toEqual({ ok: true })
    expect(link.port.frameContext('a1')).toEqual({ state: 'setup', step: 'building' })
    expect(sync).toHaveBeenCalledWith(row('a1'))
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'failed', error: 'podman_old', extra: 'dropped' } })
    expect(link.port.frameContext('a1')).toEqual({ state: 'failed', error: 'podman_old' })
    await link.answer('browser_state', { agentId: 'a1' })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // What it says of an agent the core did not attach, or has since stopped, brings nothing back.
    await link.answer('browser_state', { agentId: 'other', state: { state: 'ready' } })
    expect(link.port.frameContext('other')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    link.port.stopped('a1')
    expect(link.port.frameContext('a1')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    link.port.attached(row('a1'))
    link.port.deleted('a1')
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // A state that is no state is refused.
    link.port.attached(row('a1'))
    for (const state of [{ state: 'flying' }, 'ready', { state: 'setup', step: 7 }, { state: 'failed', error: null }]) {
      expect(await link.answer('browser_state', { agentId: 'a1', state }), JSON.stringify(state)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await link.answer('browser_state', { state: { state: 'ready' } })).toEqual({ error: 'INVALID_REQUEST' })
    // An agent the registry no longer has gets no frame.
    const gone = setup([])
    gone.link.port.attached(row('a9'))
    await gone.link.answer('browser_state', { agentId: 'a9', state: { state: 'ready' } })
    expect(gone.sync).not.toHaveBeenCalled()
  })

  // Until the audit of 2026-11-12 the core kept the exec into each ready browser and started it for a viewer. A process
  // may still name one, for a core from before: this one does not read it, whatever it is.
  it('keeps a browser\'s state and no command: one the process names is not read', async () => {
    const { link } = setup([row('a1')])
    link.port.attached(row('a1'))
    for (const command of [['/opt/podman/bin/podman', 'exec', '-i', 'harness-browser-a1', 'socat', 'STDIO', 'TCP:127.0.0.1:5900'], ['/bin/sh', '-c', 'true'], [1], 'sh']) {
      expect(await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' }, command })).toEqual({ ok: true })
    }
    expect(link.port.frameContext('a1')).toEqual({ state: 'ready' })
    expect(link.port).not.toHaveProperty('streamCommand')
  })

  // A viewer's stream is the process's whole (services/agentBrowser/streams.ts): the core passes its frames on.
  it('passes a viewer\'s frames on as events and its bytes as binary frames, once the process has said it takes streams', async () => {
    const { link, notify, notifyBinary } = setup()
    const asker = { local: true, owner: true }
    const stream = '11111111-2222-4333-8444-555555555555'
    // A process that has not said so (one from before 2026-11-13) is told nothing: the open is refused at once
    // (core/browserStreams.ts), never left unanswered.
    link.connected()
    notify.mockClear()
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, asker)).toBe(false)
    expect(link.port.streamInput(stream, Uint8Array.of(1))).toBe(false)
    link.port.streamClosed('local:w')
    link.port.streamRoute(stream, 'direct')
    link.port.streamTransportError()
    link.port.streamRefused(stream)
    expect(notify).not.toHaveBeenCalled()
    expect(notifyBinary).not.toHaveBeenCalled()

    expect(await link.answer('streams', {})).toEqual({ ok: true })
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, asker)).toBe(true)
    // An ack is the stream's own: nobody asking goes with it.
    expect(link.port.stream('local:w', 'agent_browser_ack', { streamId: stream, bytes: 9 })).toBe(true)
    // A connection's end the process hears from the core's service links itself, as every service does.
    link.port.streamClosed('local:w')
    link.port.streamRoute(stream, 'direct')
    link.port.streamRoute(stream, null)
    link.port.streamTransportError()
    link.port.streamRefused(stream)
    expect(notify.mock.calls.map(([frame]) => frame)).toEqual([
      { type: 'service_event', payload: { kind: 'stream', connId: 'local:w', type: 'agent_browser_open', payload: { requestId: 'r-1', agentId: 'a1' }, asker } },
      { type: 'service_event', payload: { kind: 'stream', connId: 'local:w', type: 'agent_browser_ack', payload: { streamId: stream, bytes: 9 } } },
      { type: 'service_event', payload: { kind: 'stream_route', streamId: stream, route: 'direct' } },
      { type: 'service_event', payload: { kind: 'stream_route', streamId: stream, route: null } },
      { type: 'service_event', payload: { kind: 'stream_transport_error' } },
      { type: 'service_event', payload: { kind: 'stream_refused', streamId: stream } },
    ])
    // None is held for a process that is down: a frame told late would open a stream nobody waits for.
    expect(notify.mock.calls.every(([, opts]) => opts === undefined)).toBe(true)
    // A viewer's bytes ride a terminal's plain frame, which names the stream and no connection.
    expect(link.port.streamInput(stream, Uint8Array.of(7, 8))).toBe(true)
    expect(decodeTerminalLocal(notifyBinary.mock.calls[0]![0])).toEqual({ kind: TerminalBinaryKind.browser, streamId: stream, seq: 0, bytes: Uint8Array.of(7, 8), compressed: false })
    // Bytes for a stream that cannot be one make no frame, and bytes the link would not take did not reach it: the core
    // ends that stream (core/browserStreams.ts).
    expect(link.port.streamInput('not-a-stream', Uint8Array.of(1))).toBe(false)
    expect(notifyBinary).toHaveBeenCalledTimes(1)
    notifyBinary.mockReturnValueOnce(false)
    expect(link.port.streamInput(stream, Uint8Array.of(9))).toBe(false)
    // A frame the process is not there to take says so.
    notify.mockReturnValueOnce(false)
    expect(link.port.stream('local:w', 'agent_browser_ack', { streamId: stream, bytes: 1 }, asker)).toBe(false)
  })

  it('hands the process\'s answers and the screen\'s bytes to the core\'s streams, which hold them to their connection', () => {
    const { link, browserFrame, browserBytes } = setup()
    const stream = '11111111-2222-4333-8444-555555555555'
    link.notice({ kind: 'stream_frame', connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', streamId: stream } })
    link.notice({ kind: 'stream_frame', connId: 'local:w', type: 'agent_browser_close' })
    expect(browserFrame.mock.calls).toEqual([
      ['local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: stream }],
      ['local:w', 'agent_browser_close', {}],
    ])
    // Not a stream's frame, or one that names no connection or type: nothing is handed on.
    for (const payload of [{ kind: 'viewer', connId: 'local:w', type: 'agent_browser_close' }, { kind: 'stream_frame', type: 'agent_browser_close' }, { kind: 'stream_frame', connId: 'local:w' }, { kind: 'stream_frame', connId: 7, type: 'x' }]) link.notice(payload)
    expect(browserFrame).toHaveBeenCalledTimes(2)

    // The screen's bytes name their stream and no connection: whose it is, is the core's to say, and which frames are a
    // screen's (core/browserStreams.ts, which reads each in place and sends it on as it came).
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId: stream, seq: 3, bytes: Uint8Array.of(4, 5), compressed: false })!
    link.binary(frame)
    expect(browserBytes).toHaveBeenCalledOnce()
    expect(browserBytes.mock.calls[0]![0]).toBe(frame)
    // A core that offers a service no streams hands nothing on, and does not fail.
    const bare = bareLink()
    bare.notice({ kind: 'stream_frame', connId: 'local:w', type: 'agent_browser_close', payload: {} })
    bare.binary(frame)
  })

  it('takes no streams from a process that went, until the next one says it does, and tells the core its streams are gone', async () => {
    const { link, notify, streamsGone } = setup()
    const asker = { local: true, owner: true }
    link.connected()
    await link.answer('streams', {})
    streamsGone.mockClear()
    link.disconnected()
    expect(streamsGone).toHaveBeenCalledOnce()
    notify.mockClear()
    link.connected()
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-1' }, asker)).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    expect(link.port.stop()).toBeUndefined()
  })

  // A link that is replaced by a newer one is closed without a word (core/serviceLinks.ts): the process that connects
  // is the only sign the one before it went. Its streams' panels would show a still screen for good.
  it('a process that connects over one never said gone: the streams of the one before are gone, and it has said nothing yet', async () => {
    const { link, notify, streamsGone } = setup()
    const asker = { local: true, owner: true }
    link.connected()
    await link.answer('streams', {})
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-1' }, asker)).toBe(true)
    streamsGone.mockClear()
    notify.mockClear()
    link.connected()
    expect(streamsGone).toHaveBeenCalledOnce()
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-2' }, asker)).toBe(false)
    expect(notify).not.toHaveBeenCalled()
    await link.answer('streams', {})
    expect(link.port.stream('local:w', 'agent_browser_open', { requestId: 'r-3' }, asker)).toBe(true)
  })

  // Out of its process, a stop sent the windows nothing: the Browser panel kept the browser's last state, ready or
  // starting, until something else about the agent changed (CLI 0.6.40, 2026-11-12).
  it('a stop, a delete and a move send the agent\'s frame again, without its browser', async () => {
    const { link, sync } = setup([row('a1'), row('a2'), row('a3')])
    for (const agentId of ['a1', 'a2', 'a3']) {
      link.port.attached(row(agentId))
      await link.answer('browser_state', { agentId, state: { state: 'ready' } })
    }
    sync.mockClear()
    link.port.stopped('a1')
    link.port.deleted('a2')
    link.port.moved('a3', row('b1'), true)
    expect(sync.mock.calls).toEqual([[row('a1')], [row('a2')], [row('a3')]])
    for (const agentId of ['a1', 'a2', 'a3']) expect(link.port.frameContext(agentId)).toBeUndefined()
    // An agent the registry no longer has gets no frame.
    link.port.stopped('gone')
    expect(sync).toHaveBeenCalledTimes(3)
  })

  it('answers the ids of its agents and the agent of a pane, whether it is a guest\'s, held to the parents it was given', async () => {
    const { link, ids, ofPane } = setup()
    expect(await link.answer('agent_ids', {})).toEqual({ live: ['a1'], stopped: ['a2'] })
    expect(ids).toHaveBeenCalled()
    expect(await link.answer('agent_of_pane', { pane: '%7', ancestors: [4242, 1] })).toEqual({ agentId: 'a1', guest: false })
    expect(await link.answer('agent_of_pane', { pane: '%8', ancestors: [4343] })).toEqual({ agentId: 'kim', guest: true })
    expect(await link.answer('agent_of_pane', { pane: '%9', ancestors: [4242] })).toEqual({ agentId: null })
    // An older relay's `agent_browser_state` names its pane alone.
    expect(await link.answer('agent_of_pane', { pane: '%7' })).toEqual({ agentId: 'a1', guest: false })
    for (const payload of [{}, { pane: 7 }, { pane: '%7', ancestors: 4242 }, { pane: '%7', ancestors: [4242, '1'] }, { pane: '%7', ancestors: [-1] }, { pane: '%7', ancestors: [1.5] }]) {
      expect(await link.answer('agent_of_pane', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(ofPane.mock.calls).toEqual([['%7', [4242, 1]], ['%8', [4343]], ['%9', [4242]], ['%7', undefined]])
    expect(await link.answer('anything', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    // A core without the calls has no answer to give.
    const bare = bareLink()
    expect(await bare.answer('agent_ids', {})).toEqual({ error: 'UNSUPPORTED' })
    expect(await bare.answer('agent_of_pane', { pane: '%7' })).toEqual({ agentId: null })
  })

  // The person's Start and Stop, from the agent browser's own process: the core sets the flag and tells the browser.
  it('set_browser sets the flag through the core and answers what it said; a payload without an id or a boolean is INVALID_REQUEST', async () => {
    const setBrowser = vi.fn((agentId: string, on: boolean) => Promise.resolve(agentId === 'a1'
      ? { ok: true as const, changed: on } : { error: 'NOT_RUNNING' as const }))
    const link = bareLink(fakeCore({ agents: { setBrowser } }))
    expect(await link.answer('set_browser', { agentId: 'a1', on: true })).toEqual({ ok: true, changed: true })
    expect(await link.answer('set_browser', { agentId: 'a1', on: false })).toEqual({ ok: true, changed: false })
    expect(await link.answer('set_browser', { agentId: 'gone', on: true })).toEqual({ error: 'NOT_RUNNING' })
    for (const payload of [{ on: true }, { agentId: 7, on: true }, { agentId: 'a1' }, { agentId: 'a1', on: 'yes' }]) {
      expect(await link.answer('set_browser', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(setBrowser.mock.calls).toEqual([['a1', true], ['a1', false], ['gone', true]])
    // A core without the call has no answer to give.
    const bare = bareLink()
    expect(await bare.answer('set_browser', { agentId: 'a1', on: true })).toEqual({ error: 'UNSUPPORTED' })
  })

  // Decision 19: the pane's new agent takes the browser of the agent that ended there.
  it('a move is said to the process with both ids and the flag, held until it hears, and asks for the process only when the flag is on', () => {
    const { link, notify, want } = setup()
    const to = row('shell', false)
    link.port.moved('ended', to, false)
    expect(want).not.toHaveBeenCalled()
    link.port.moved('ended', to, true)
    expect(want).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'moved', from: 'ended', session: to, on: false } }, { untilDelivered: true }],
      [{ type: 'service_event', payload: { kind: 'moved', from: 'ended', session: to, on: true } }, { untilDelivered: true }],
    ])
    // Once there, it is not asked for again.
    link.connected()
    link.port.moved('ended', to, true)
    expect(want).toHaveBeenCalledTimes(1)
  })

  it('the previous agent\'s state goes at once, and a late word of it brings nothing back', async () => {
    const { link } = setup([row('ended')])
    link.port.attached(row('ended'))
    await link.answer('browser_state', { agentId: 'ended', state: { state: 'ready' } })
    expect(link.port.frameContext('ended')).toEqual({ state: 'ready' })
    link.port.moved('ended', row('shell', false), true)
    expect(link.port.frameContext('ended')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'ended', state: { state: 'ready' } })
    expect(link.port.frameContext('ended')).toBeUndefined()
  })

  it('move_browser asks the core and answers what it said; anything but two ids is INVALID_REQUEST', async () => {
    const moveBrowser = vi.fn((_from: string, to: string) => Promise.resolve(to === 'shell'
      ? { ok: true as const, changed: true } : { error: 'NOT_RUNNING' as const }))
    const link = bareLink(fakeCore({ agents: { moveBrowser } }))
    expect(await link.answer('move_browser', { from: 'ended', to: 'shell' })).toEqual({ ok: true, changed: true })
    expect(await link.answer('move_browser', { from: 'ended', to: 'gone' })).toEqual({ error: 'NOT_RUNNING' })
    for (const payload of [{}, { from: 'ended' }, { to: 'shell' }, { from: '', to: 'shell' }, { from: 'ended', to: '' }, { from: 7, to: 'shell' }, { from: 'ended', to: ['shell'] }]) {
      expect(await link.answer('move_browser', payload), JSON.stringify(payload)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(moveBrowser.mock.calls).toEqual([['ended', 'shell'], ['ended', 'gone']])
    // A core without the call has no answer to give.
    const bare = bareLink()
    expect(await bare.answer('move_browser', { from: 'ended', to: 'shell' })).toEqual({ error: 'UNSUPPORTED' })
  })

  it('hands on the agent browser\'s own counters, and no other', async () => {
    const { link, count } = setup()
    expect(await link.answer('count', { metric: 'agent_browser_failed_podman_old' })).toEqual({ ok: true })
    for (const metric of ['launch_started', 'agent_browser_made_up', 7]) expect(await link.answer('count', { metric })).toEqual({ error: 'INVALID_REQUEST' })
    expect(count.mock.calls).toEqual([['agent_browser_failed_podman_old']])
  })
})

describe('wakeAgentBrowser', () => {
  it('asks for the process as the core starts only when it runs out of the core and its state file is there', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-browser-wake-'))
    try {
      const want = vi.fn()
      wakeAgentBrowser({ outOfProcess: new Set(['agentBrowser']), dataDir, want })
      expect(want).not.toHaveBeenCalled()
      writeFileSync(join(dataDir, 'agent-browser.json'), '{}')
      wakeAgentBrowser({ outOfProcess: new Set(), dataDir, want })
      expect(want).not.toHaveBeenCalled()
      wakeAgentBrowser({ outOfProcess: new Set(['agentBrowser']), dataDir, want })
      expect(want).toHaveBeenCalledWith('agentBrowser')
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
