import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createAgentBrowserLink, wakeAgentBrowser } from './agentBrowserLink.js'
import { createAgentLife } from './agentLife.js'
import { decodeTerminalLocal, encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

const row = (agentId: string, browser = true) => ({ agentId, sessionId: `s-${agentId}`, ...(browser ? { browser: true } : {}) }) as RegisteredSession

function setup(live: RegisteredSession[] = []) {
  const sync = vi.fn()
  const count = vi.fn()
  const ofPane = vi.fn(async (pane: string, _ancestors?: number[]) => (pane === '%7' ? { agentId: 'a1', guest: false } : pane === '%8' ? { agentId: 'kim', guest: true } : null))
  const browserFrame = vi.fn((..._frame: [connId: string, type: string, payload: Record<string, unknown>]) => true)
  const browserBytes = vi.fn((_frame: Uint8Array) => true)
  // What happens to agents, as the core tells whoever follows them (core/agentLife.ts).
  const hub = createAgentLife({ live: () => live, notify: () => true, hears: {} })
  const core = fakeCore({ count, agents: { sync, ofPane, live: () => live, byAgent: (agentId: string) => live.find(s => s.agentId === agentId), follow: hub.follow }, clients: { browserFrame, browserBytes } })
  const notify = vi.fn((..._frame: [frame: { type: string, payload?: unknown }, opts?: { untilDelivered?: boolean }]) => true)
  const notifyBinary = vi.fn((_bytes: Uint8Array) => true)
  const want = vi.fn()
  const streamsGone = vi.fn()
  const link = createAgentBrowserLink({ core, notify, notifyBinary, want, streamsGone })
  const unfollow = link.follow()
  return { link, core, sync, count, notify, notifyBinary, want, streamsGone, ofPane, browserFrame, browserBytes, hub, unfollow }
}
/** A link whose core answers what the test gives, and tells nobody anything. */
const bareLink = (core = fakeCore()) => createAgentBrowserLink({ core, notify: () => true, notifyBinary: () => true, want: () => {}, streamsGone: () => {} })

describe('the agent browser in its own process, as the core sees it', () => {
  // What happens to agents the process hears as every service that follows agents does (core/agentLife.ts).
  it('tells the process nothing of agents itself', () => {
    const { notify, hub } = setup()
    hub.running(row('a1'))
    hub.ended('a1')
    hub.purged('a1', ['s-a1'])
    expect(notify).not.toHaveBeenCalled()
  })

  // A Desktop from before Browser left New agent still sets the row's flag at a create, which only the process takes in
  // (services/agentBrowser.ts `adopt`). Delete on or after 2026-12-18, with the flag.
  it('asks for the process for an agent whose row still carries the flag from before, until it is there', () => {
    const { link, want, hub } = setup()
    hub.running(row('plain', false))
    expect(want).not.toHaveBeenCalled()
    hub.running(row('a1'))
    expect(want).toHaveBeenCalledTimes(1)
    link.connected()
    hub.running(row('a2'))
    expect(want).toHaveBeenCalledTimes(1)
    link.disconnected()
    hub.running(row('a3'))
    expect(want).toHaveBeenCalledTimes(2)
    // As the core starts, the flagged rows it restored ask for it too.
    expect(setup([row('restored')]).want).toHaveBeenCalledTimes(1)
  })

  it('follows nothing in a core that lends no following, and stops following when asked', async () => {
    expect(() => bareLink().follow()()).not.toThrow()
    const { link, hub, unfollow, want } = setup()
    unfollow()
    hub.running(row('a1'))
    expect(want).not.toHaveBeenCalled()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    expect(link.port.stop()).toBeUndefined()
  })

  it('keeps what the process says of a running agent\'s browser, for its frame, and sends the frame again', async () => {
    const { link, sync, hub } = setup([row('a1')])
    hub.running(row('a1'))
    expect(await link.answer('browser_state', { agentId: 'a1', state: { state: 'setup', step: 'building' } })).toEqual({ ok: true })
    expect(link.port.frameContext('a1')).toEqual({ state: 'setup', step: 'building' })
    expect(sync).toHaveBeenCalledWith(row('a1'))
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'failed', error: 'podman_old', extra: 'dropped' } })
    expect(link.port.frameContext('a1')).toEqual({ state: 'failed', error: 'podman_old' })
    await link.answer('browser_state', { agentId: 'a1' })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // What it says of an agent the core was not told runs, or was since told ended, brings nothing back.
    await link.answer('browser_state', { agentId: 'other', state: { state: 'ready' } })
    expect(link.port.frameContext('other')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    hub.ended('a1')
    expect(link.port.frameContext('a1')).toBeUndefined()
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // A state that is no state is refused.
    hub.running(row('a1'))
    for (const state of [{ state: 'flying' }, 'ready', { state: 'setup', step: 7 }, { state: 'failed', error: null }]) {
      expect(await link.answer('browser_state', { agentId: 'a1', state }), JSON.stringify(state)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(await link.answer('browser_state', { state: { state: 'ready' } })).toEqual({ error: 'INVALID_REQUEST' })
    // An agent the registry no longer has gets no frame.
    const gone = setup([])
    gone.hub.running(row('a9'))
    await gone.link.answer('browser_state', { agentId: 'a9', state: { state: 'ready' } })
    expect(gone.sync).not.toHaveBeenCalled()
  })

  // Until the audit of 2026-11-12 the core kept the exec into each ready browser and started it for a viewer. A process
  // may still name one, for a core from before: this one does not read it, whatever it is.
  it('keeps a browser\'s state and no command: one the process names is not read', async () => {
    const { link, hub } = setup([row('a1')])
    hub.running(row('a1'))
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
  it('an end sends the agent\'s frame again, without its browser, and a late word of it brings nothing back', async () => {
    const { link, sync, hub } = setup([row('a1'), row('a2')])
    for (const agentId of ['a1', 'a2']) {
      hub.running(row(agentId))
      await link.answer('browser_state', { agentId, state: { state: 'ready' } })
    }
    sync.mockClear()
    hub.ended('a1')
    expect(sync.mock.calls).toEqual([[row('a1')]])
    expect(link.port.frameContext('a1')).toBeUndefined()
    expect(link.port.frameContext('a2')).toEqual({ state: 'ready' })
    await link.answer('browser_state', { agentId: 'a1', state: { state: 'ready' } })
    expect(link.port.frameContext('a1')).toBeUndefined()
    // One that had no browser to show sends nothing, nor one the registry no longer has.
    hub.running(row('plain', false))
    hub.ended('plain')
    hub.running(row('gone'))
    await link.answer('browser_state', { agentId: 'gone', state: { state: 'ready' } })
    hub.ended('gone')
    expect(sync).toHaveBeenCalledTimes(1)
  })

  // Whatever else the process asks it asks as any service may (core/agentQueries.ts).
  it('answers the agent of a pane, whether it is a guest\'s, held to the parents it was given, and nothing of a browser\'s switch', async () => {
    const { link, ofPane } = setup()
    expect(await link.answer('agent_of_pane', { pane: '%7', ancestors: [4242, 1] })).toEqual({ agentId: 'a1', guest: false })
    expect(await link.answer('agent_of_pane', { pane: '%8', ancestors: [4343] })).toEqual({ agentId: 'kim', guest: true })
    expect(await link.answer('agent_of_pane', { pane: '%9', ancestors: [4242] })).toEqual({ agentId: null })
    expect(ofPane.mock.calls).toEqual([['%7', [4242, 1]], ['%8', [4343]], ['%9', [4242]]])
    // The core keeps no Browser switch and no list of its own for it, and answers nothing else any service may ask.
    for (const query of ['agent_ids', 'set_browser', 'move_browser', 'live', 'hachi_goal_done']) {
      expect(await link.answer(query, { agentId: 'a1', on: true, from: 'a', to: 'b' })).toEqual({ error: 'UNKNOWN_QUERY' })
    }
    expect(await link.answer('agents', {})).toEqual({ agents: [] })
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
