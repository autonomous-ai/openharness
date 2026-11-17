import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserFrame } from '../lib/agentFrame.js'
import type { Asker } from './api.js'
import { BROWSER_OPEN_WAIT_MS, BROWSER_OPENS_PENDING_MAX, BROWSER_UNACKED_MAX, createBrowserStreams } from './browserStreams.js'
import { encodeTerminalLocal, TerminalBinaryKind } from '../lib/terminalBinary.js'

const LOCAL: Asker = { local: true, owner: true }
const OTHER_DESKTOP: Asker = { local: false, owner: true, accountOwner: true }
const SHARE_GUEST: Asker = { local: false, owner: true, accountOwner: true, guest: 'kim@acme.io' }
const PLAIN_OWNER: Asker = { local: false, owner: true }
const ASKERS: Record<string, Asker> = { 'local:w': LOCAL, 'mac-2': OTHER_DESKTOP, guest: SHARE_GUEST, share: PLAIN_OWNER }
const STREAM = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

/** A stream's screen bytes as the agent browser frames them (services/agentBrowser.ts). */
const screenFrame = (streamId: string, seq: number, bytes: Uint8Array) =>
  encodeTerminalLocal({ kind: TerminalBinaryKind.browser, streamId, seq, bytes, compressed: false })!

function setup(served = true) {
  const frames: Array<{ connId: string; type: string; payload: Record<string, unknown> }> = []
  const binary: Array<{ connId: string; frame: Uint8Array }> = []
  let sendOk = true
  let binaryOk = true
  const port = {
    // The agents' browsers, as their frames show them: a1's and a2's ready, one starting, one failed, and none else.
    frameContext: vi.fn((agentId: string): AgentBrowserFrame | undefined => ({ a1: { state: 'ready' as const }, a2: { state: 'ready' as const }, starting: { state: 'starting' as const }, failed: { state: 'failed' as const, error: 'podman_old' } })[agentId]),
    stream: vi.fn((_connId: string, _type: string, _payload: Record<string, unknown>, _asker?: Asker) => true),
    streamInput: vi.fn((_streamId: string, _bytes: Uint8Array) => true),
    streamClosed: vi.fn(), streamRoute: vi.fn(), streamTransportError: vi.fn(), streamRefused: vi.fn(),
  }
  const log = vi.fn()
  let current: typeof port | null = served ? port : null
  const streams = createBrowserStreams({
    port: () => current,
    asker: (connId) => ASKERS[connId] ?? { local: false, owner: false },
    send: (connId, type, payload) => { frames.push({ connId, type, payload }); return sendOk },
    sendBinary: (connId, frame) => { binary.push({ connId, frame }); return binaryOk },
    log,
  })
  /** A stream [connId] holds: asked, and answered by the service. */
  const opened = (connId: string, streamId = STREAM, requestId = 'r-1') => {
    streams.open(connId, { requestId, agentId: 'a1' })
    expect(streams.frame(connId, 'agent_browser_open_result', { requestId, streamId })).toBe(true)
    frames.length = 0
    port.stream.mockClear()
  }
  return { streams, port, frames, binary, log, opened, off: () => { current = null }, failSend: () => { sendOk = false }, failBinary: () => { binaryOk = false } }
}

describe('opening a browser stream, as the core passes it on', () => {
  it('hands a window\'s open, and another of the owner\'s desktops\', to the agent browser with who asked', () => {
    const { streams, port, frames } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    streams.open('mac-2', { requestId: 'r-2', agentId: 'a1' })
    expect(port.stream.mock.calls).toEqual([
      ['local:w', 'agent_browser_open', { requestId: 'r-1', agentId: 'a1' }, LOCAL],
      ['mac-2', 'agent_browser_open', { requestId: 'r-2', agentId: 'a1' }, OTHER_DESKTOP],
    ])
    expect(frames).toEqual([])
  })

  // Review Focus 1: a verified machine share is `owner` too, and must never open the owner's logged-in browser. The
  // core decides it, before the service hears of it.
  it('refuses a share\'s guest, and an owner that is neither on this computer nor the account\'s own, without telling the service', () => {
    const { streams, port, frames } = setup()
    streams.open('guest', { requestId: 'r-1', agentId: 'a1' })
    streams.open('share', { requestId: 'r-2', agentId: 'a1' })
    streams.open('nobody', { requestId: 'r-3', agentId: 'a1' })
    expect(port.stream).not.toHaveBeenCalled()
    expect(frames).toEqual(['guest', 'share', 'nobody'].map((connId, index) => ({ connId, type: 'agent_browser_open_result', payload: { requestId: `r-${index + 1}`, error: 'NOT_OWNER' } })))
  })

  it('answers nothing to an open with no request id', () => {
    const { streams, port, frames } = setup()
    streams.open('local:w', { agentId: 'a1' })
    expect(port.stream).not.toHaveBeenCalled()
    expect(frames).toEqual([])
  })

  // As before the stream was its service's: the core answered these from the state it keeps for the agent's frame.
  it('answers in line for an agent with no browser, or one that is not ready, and asks nobody', () => {
    const { streams, port, frames } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'plain' })
    streams.open('local:w', { requestId: 'r-2' })
    streams.open('local:w', { requestId: 'r-3', agentId: 7 })
    streams.open('local:w', { requestId: 'r-4', agentId: 'starting' })
    streams.open('local:w', { requestId: 'r-5', agentId: 'failed' })
    expect(port.stream).not.toHaveBeenCalled()
    expect(frames.map(frame => [frame.payload.requestId, frame.payload.error])).toEqual([['r-1', 'NO_BROWSER'], ['r-2', 'NO_BROWSER'], ['r-3', 'NO_BROWSER'], ['r-4', 'NOT_READY'], ['r-5', 'NOT_READY']])
    // None of them is waited for.
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-4', streamId: STREAM })).toBe(false)
    // The agent browser off: no agent has one.
    const off = setup(false)
    off.streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(off.frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', error: 'NO_BROWSER' } }])
  })

  it('refuses an open at once while nobody takes it: the agent browser\'s process is not there', () => {
    // Its browser reads ready, as it last said, and its process did not take the open: gone, or one from before
    // streams were its own.
    const untaken = setup()
    untaken.port.stream.mockReturnValue(false)
    untaken.streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(untaken.frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', error: 'NOT_READY' } }])
    // Refused, it is not waited for: an answer that comes for it after all is nobody's.
    expect(untaken.streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(false)
    // An open the same connection still waits for keeps its place.
    const waiting = setup()
    waiting.streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    waiting.port.stream.mockReturnValueOnce(false)
    waiting.streams.open('local:w', { requestId: 'r-2', agentId: 'a1' })
    expect(waiting.streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(true)
  })

  it('holds a few opens unanswered for one connection, and no more', () => {
    const { streams, port, frames } = setup()
    for (let index = 0; index < BROWSER_OPENS_PENDING_MAX; index++) streams.open('local:w', { requestId: `r-${index}`, agentId: 'a1' })
    expect(port.stream).toHaveBeenCalledTimes(BROWSER_OPENS_PENDING_MAX)
    streams.open('local:w', { requestId: 'r-more', agentId: 'a1' })
    expect(port.stream).toHaveBeenCalledTimes(BROWSER_OPENS_PENDING_MAX)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-more', error: 'VIEWER_LIMIT' } }])
    // Another connection has its own; and an answer frees a place.
    streams.open('mac-2', { requestId: 'r-0', agentId: 'a1' })
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-0', error: 'NO_BROWSER' })).toBe(true)
    streams.open('local:w', { requestId: 'r-again', agentId: 'a1' })
    expect(port.stream).toHaveBeenCalledTimes(BROWSER_OPENS_PENDING_MAX + 2)
  })
})

describe('whose a browser stream is', () => {
  it('passes an open\'s answer only to the connection that asked, under the request it asked with', () => {
    const { streams, frames } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    // Another connection's, another request's, one with no request: not this open's answer.
    expect(streams.frame('mac-2', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-9', streamId: STREAM })).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_open_result', { streamId: STREAM })).toBe(false)
    expect(frames).toEqual([])
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(true)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', streamId: STREAM } }])
    // Answered once: a second answer to the same open is nobody's.
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: OTHER })).toBe(false)
  })

  it('holds no stream an answer names that is not a stream\'s id, and refuses the open', () => {
    const { streams, frames } = setup()
    for (const [index, streamId] of [[1, 'stream-1'], [2, 'AAAAAAAA-2222-4333-8444-555555555555'], [3, 7], [4, '']] as const) {
      streams.open('local:w', { requestId: `r-${index}`, agentId: 'a1' })
      expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: `r-${index}`, streamId })).toBe(false)
    }
    expect(frames.map(frame => frame.payload)).toEqual([1, 2, 3, 4].map(index => ({ requestId: `r-${index}`, error: 'NOT_READY' })))
  })

  // The service names a stream once. Were a second answer to move one a window holds, that window's screen would go to
  // the other connection, and its own acks and close would no longer be its stream's. A service that does it is
  // broken: the stream ends for both, and the service is told to end it.
  it('never hands a stream one connection holds to another: the stream ends, and the second open is refused', () => {
    const { streams, port, frames, binary, opened } = setup()
    opened('local:w')
    streams.open('mac-2', { requestId: 'r-2', agentId: 'a1' })
    expect(streams.frame('mac-2', 'agent_browser_open_result', { requestId: 'r-2', streamId: STREAM })).toBe(false)
    expect(frames).toEqual([
      { connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'agent' } },
      { connId: 'mac-2', type: 'agent_browser_open_result', payload: { requestId: 'r-2', error: 'NOT_READY' } },
    ])
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(STREAM)
    expect(streams.bytes(screenFrame(STREAM, 0, Uint8Array.of(1)))).toBe(false)
    expect(binary).toEqual([])
  })

  it('holds no stream for a refusal', () => {
    const { streams, port, binary } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', error: 'NOT_READY' })).toBe(true)
    expect(streams.bytes(screenFrame(STREAM, 0, new Uint8Array(4)))).toBe(false)
    expect(binary).toEqual([])
    streams.input('local:w', STREAM, new Uint8Array(2))
    expect(port.streamInput).not.toHaveBeenCalled()
  })

  it('hands the screen\'s bytes to the connection that holds the stream, as browser frames, and to no other', () => {
    const { streams, binary, opened } = setup()
    opened('local:w')
    const screen = Uint8Array.of(1, 2, 3)
    const frame = screenFrame(STREAM, 7, screen)
    expect(streams.bytes(frame)).toBe(true)
    // Sent on as it came: the very bytes, never a copy.
    expect(binary).toEqual([{ connId: 'local:w', frame }])
    expect(binary[0]!.frame).toBe(frame)
    // The service names a stream and never a connection: one nobody holds goes nowhere.
    expect(streams.bytes(screenFrame(OTHER, 8, screen))).toBe(false)
    expect(binary).toHaveLength(1)
  })

  it('sends on nothing that is not a browser\'s screen frame, whole', () => {
    const { streams, binary, opened } = setup()
    opened('local:w')
    const frame = screenFrame(STREAM, 0, Uint8Array.of(1, 2))
    const changed = (at: number, value: number) => { const copy = Uint8Array.from(frame); copy[at] = value; return copy }
    for (const wrong of [
      // A terminal's output, keys or keyframe for the same stream id, a compressed one, one cut short or with more after.
      encodeTerminalLocal({ kind: TerminalBinaryKind.output, streamId: STREAM, seq: 0, bytes: Uint8Array.of(1), compressed: false })!,
      encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: STREAM, seq: 0, bytes: Uint8Array.of(1), compressed: false })!,
      changed(6, 1), changed(7, 1), changed(4, 9), changed(0, 0), frame.subarray(0, frame.length - 1), Uint8Array.from([...frame, 0]),
      frame.subarray(0, 35), new Uint8Array(0),
    ]) expect(streams.bytes(wrong)).toBe(false)
    expect(binary).toEqual([])
    // A seq past what a number holds exactly.
    const far = Uint8Array.from(frame)
    new DataView(far.buffer).setBigUint64(12 + 16, 2n ** 60n, false)
    expect(streams.bytes(far)).toBe(false)
    expect(streams.bytes(frame)).toBe(true)
  })

  it('ends a stream whose send its viewer\'s transport refused, which is a hole in the screen: the viewer and the service are told', () => {
    const { streams, port, frames, binary, opened, failBinary } = setup()
    opened('local:w')
    failBinary()
    expect(streams.bytes(screenFrame(STREAM, 0, new Uint8Array(8)))).toBe(false)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'backlog' } }])
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(STREAM)
    // The core forgot it: the service's own close for it, and its bytes after, are nobody's.
    expect(streams.frame('local:w', 'agent_browser_close', { streamId: STREAM, reason: 'backlog' })).toBe(false)
    expect(streams.bytes(screenFrame(STREAM, 1, new Uint8Array(8)))).toBe(false)
    expect(binary).toHaveLength(1)
    expect(port.streamRefused).toHaveBeenCalledTimes(1)
  })

  // The agent browser holds each stream's credit (a 256 KiB window). The core does not lean on it: a window's send has
  // no limit of its own, so a service that stopped counting would grow the core's buffer to that window for good.
  it('ends a stream whose viewer has more than BROWSER_UNACKED_MAX unread, whatever the service counts; acks make room', () => {
    const { streams, port, frames, opened } = setup()
    opened('local:w')
    const chunk = new Uint8Array(BROWSER_UNACKED_MAX / 4)
    for (let seq = 0; seq < 4; seq++) expect(streams.bytes(screenFrame(STREAM, seq, chunk))).toBe(true)
    // An ack the viewer sends, through the core, makes room; one that is no count makes none.
    for (const bytes of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, '9', undefined]) streams.ack('local:w', { streamId: STREAM, bytes })
    streams.ack('local:w', { streamId: STREAM, bytes: chunk.length })
    expect(port.stream).toHaveBeenCalledTimes(7)
    expect(streams.bytes(screenFrame(STREAM, 4, chunk))).toBe(true)
    // An ack of more than was sent leaves nothing owed, and nothing in hand to send beyond the bound.
    streams.ack('local:w', { streamId: STREAM, bytes: 10 * BROWSER_UNACKED_MAX })
    for (let seq = 5; seq < 9; seq++) expect(streams.bytes(screenFrame(STREAM, seq, chunk))).toBe(true)
    expect(frames).toEqual([])
    // One byte past it.
    expect(streams.bytes(screenFrame(STREAM, 9, Uint8Array.of(1)))).toBe(false)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'backlog' } }])
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(STREAM)
    // An ack for another connection's stream, or none, is passed on nowhere.
    streams.ack('mac-2', { streamId: STREAM, bytes: 1 })
    expect(port.stream).toHaveBeenCalledTimes(8)
  })

  it('passes a viewer\'s ack, close and bytes on only for a stream that connection holds', () => {
    const { streams, port, opened } = setup()
    opened('local:w')
    streams.ack('local:w', { streamId: STREAM, bytes: 64 })
    streams.input('local:w', STREAM, Uint8Array.of(9))
    streams.close('local:w', { streamId: STREAM })
    // Who asked goes with an open alone: an ack and a close are the stream's own, and acks come 30 times a second.
    expect(port.stream.mock.calls).toEqual([
      ['local:w', 'agent_browser_ack', { streamId: STREAM, bytes: 64 }],
      ['local:w', 'agent_browser_close', { streamId: STREAM }],
    ])
    expect(port.streamInput).toHaveBeenCalledExactlyOnceWith(STREAM, Uint8Array.of(9))
    port.stream.mockClear()
    // Another connection's word on it, a stream nobody holds, and no stream named: nothing is passed on.
    streams.ack('mac-2', { streamId: STREAM, bytes: 64 })
    streams.close('mac-2', { streamId: STREAM })
    streams.input('mac-2', STREAM, Uint8Array.of(9))
    streams.ack('local:w', { streamId: OTHER, bytes: 64 })
    streams.close('local:w', {})
    expect(port.stream).not.toHaveBeenCalled()
    expect(port.streamInput).toHaveBeenCalledTimes(1)
  })

  it('passes the service\'s close on to the stream\'s connection, once, and holds it no more', () => {
    const { streams, frames, opened } = setup()
    opened('local:w')
    expect(streams.frame('mac-2', 'agent_browser_close', { streamId: STREAM, reason: 'agent' })).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_close', { streamId: OTHER, reason: 'agent' })).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_close', { streamId: STREAM, reason: 'agent' })).toBe(true)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'agent' } }])
    expect(streams.frame('local:w', 'agent_browser_close', { streamId: STREAM, reason: 'agent' })).toBe(false)
    expect(streams.bytes(screenFrame(STREAM, 1, new Uint8Array(1)))).toBe(false)
    // No other frame is a stream's to send a viewer.
    expect(streams.frame('local:w', 'terminal_output', { streamId: STREAM })).toBe(false)
  })

  it('says whether a frame reached its connection', () => {
    const { streams, opened, failSend } = setup()
    opened('local:w')
    failSend()
    expect(streams.frame('local:w', 'agent_browser_close', { streamId: STREAM, reason: 'closed' })).toBe(false)
  })
})

describe('what ends a browser stream on the core\'s side', () => {
  it('forgets a connection that ended, and tells the service', () => {
    const { streams, port, opened } = setup()
    opened('local:w')
    opened('mac-2', OTHER, 'r-2')
    streams.open('local:w', { requestId: 'r-3', agentId: 'a1' })
    streams.closeConnection('local:w')
    expect(port.streamClosed).toHaveBeenCalledExactlyOnceWith('local:w')
    expect(streams.bytes(screenFrame(STREAM, 0, new Uint8Array(1)))).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-3', streamId: STREAM })).toBe(false)
    // The other connection's stream goes on.
    expect(streams.bytes(screenFrame(OTHER, 0, new Uint8Array(1)))).toBe(true)
  })

  // In the core's process the service is the port; out of it, its process hears every connection's end itself, as
  // every service does, and the link says nothing (core/agentBrowserLink.ts).
  it('tells the service of every connection\'s end, one that never watched too', () => {
    const { streams, port } = setup()
    streams.closeConnection('phone-1')
    expect(port.streamClosed.mock.calls).toEqual([['phone-1']])
  })

  it('passes the gateway\'s word on a stream\'s route, and that it went away, for a stream that is held', () => {
    const { streams, port, opened } = setup()
    opened('mac-2')
    streams.route(STREAM, 'direct')
    streams.routeLost(STREAM)
    streams.route(OTHER, 'relay')
    streams.routeLost(OTHER)
    expect(port.streamRoute.mock.calls).toEqual([[STREAM, 'direct'], [STREAM, null]])
    streams.transportError()
    expect(port.streamTransportError).toHaveBeenCalledOnce()
  })

  it('tells every viewer its stream closed when the agent browser goes, and every open still asked that it is not ready', () => {
    const { streams, frames, opened } = setup()
    opened('local:w')
    opened('mac-2', OTHER, 'r-2')
    streams.open('local:w', { requestId: 'r-3', agentId: 'a1' })
    frames.length = 0
    streams.gone()
    expect(frames).toEqual([
      { connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'agent' } },
      { connId: 'mac-2', type: 'agent_browser_close', payload: { streamId: OTHER, reason: 'agent' } },
      { connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-3', error: 'NOT_READY' } },
    ])
    // Nothing is held after it.
    frames.length = 0
    streams.gone()
    expect(frames).toEqual([])
    expect(streams.bytes(screenFrame(STREAM, 0, new Uint8Array(1)))).toBe(false)
  })

  it('passes nothing on while the agent browser is off', () => {
    const { streams, port, frames, opened, off } = setup()
    opened('local:w')
    off()
    streams.ack('local:w', { streamId: STREAM, bytes: 1 })
    streams.close('local:w', { streamId: STREAM })
    // A viewer's bytes that reach nobody would leave VNC reading the rest of its stream wrong: it ends.
    streams.input('local:w', STREAM, Uint8Array.of(1))
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'agent' } }])
    streams.route(STREAM, 'relay')
    streams.routeLost(STREAM)
    streams.transportError()
    streams.closeConnection('local:w')
    expect(port.stream).not.toHaveBeenCalled()
    expect(port.streamInput).not.toHaveBeenCalled()
    expect(port.streamRoute).not.toHaveBeenCalled()
    expect(port.streamTransportError).not.toHaveBeenCalled()
    expect(port.streamClosed).not.toHaveBeenCalled()
  })

  it('a refused send with the agent browser off still says the bytes did not go', () => {
    const { streams, port, opened, off, failBinary } = setup()
    opened('local:w')
    off()
    failBinary()
    expect(streams.bytes(screenFrame(STREAM, 0, new Uint8Array(1)))).toBe(false)
    expect(port.streamRefused).not.toHaveBeenCalled()
  })
})

describe('the core\'s own bounds on a browser stream', () => {
  afterEach(() => { vi.useRealTimers() })

  // Standard 6: every wait has a timeout. A service that took an open and never answered (its exec failed in a way it
  // did not name) left the panel waiting for good, and after eight the connection was refused every open.
  it('refuses an open the service has not answered in BROWSER_OPEN_WAIT_MS, says so, and ends the stream a late answer names', () => {
    vi.useFakeTimers()
    const { streams, port, frames, log } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    vi.advanceTimersByTime(BROWSER_OPEN_WAIT_MS - 1)
    expect(frames).toEqual([])
    vi.advanceTimersByTime(1)
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', error: 'NOT_READY' } }])
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toContain('did not answer')
    // Its answer after all is a stream started for nobody: the service ends it.
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(false)
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(STREAM)
    expect(frames).toHaveLength(1)
    // One answered in time is never given up.
    streams.open('local:w', { requestId: 'r-2', agentId: 'a1' })
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-2', streamId: OTHER })).toBe(true)
    vi.advanceTimersByTime(2 * BROWSER_OPEN_WAIT_MS)
    expect(frames).toHaveLength(2)
  })

  it('gives up no open whose connection ended, or that went with the service', () => {
    vi.useFakeTimers()
    const { streams, frames } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    streams.closeConnection('local:w')
    streams.open('mac-2', { requestId: 'r-2', agentId: 'a1' })
    streams.gone()
    expect(frames).toEqual([{ connId: 'mac-2', type: 'agent_browser_open_result', payload: { requestId: 'r-2', error: 'NOT_READY' } }])
    vi.advanceTimersByTime(2 * BROWSER_OPEN_WAIT_MS)
    expect(frames).toHaveLength(1)
  })

  // In the core's process the service answers in the same call, and a port that then fails is the host's fallback.
  it('answers an open once when the service answered it and then failed', () => {
    const { streams, port, frames } = setup()
    port.stream.mockImplementationOnce((connId, _type, payload) => {
      streams.frame(connId, 'agent_browser_open_result', { requestId: payload.requestId, error: 'NO_BROWSER' })
      return false
    })
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-1', error: 'NO_BROWSER' } }])
  })

  it('passes an open asked again while it is unanswered on once: one answer, one exec', () => {
    const { streams, port } = setup()
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(port.stream).toHaveBeenCalledOnce()
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-1', streamId: STREAM })).toBe(true)
    // Answered, it is a new open.
    streams.open('local:w', { requestId: 'r-1', agentId: 'a1' })
    expect(port.stream).toHaveBeenCalledTimes(2)
  })

  it('tells the service to end a stream an answer named that nobody asked for, and only a stream', () => {
    const { streams, port } = setup()
    expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-9', streamId: STREAM })).toBe(false)
    expect(streams.frame('local:w', 'agent_browser_open_result', { streamId: OTHER })).toBe(false)
    for (const streamId of ['stream-1', 7, undefined, '']) expect(streams.frame('local:w', 'agent_browser_open_result', { requestId: 'r-9', streamId })).toBe(false)
    expect(port.streamRefused.mock.calls).toEqual([[STREAM], [OTHER]])
  })

  it('ends a stream whose viewer\'s bytes did not reach the service: VNC would read the rest of it wrong', () => {
    const { streams, port, frames, opened } = setup()
    opened('local:w')
    port.streamInput.mockReturnValueOnce(false)
    streams.input('local:w', STREAM, Uint8Array.of(4, 1))
    expect(frames).toEqual([{ connId: 'local:w', type: 'agent_browser_close', payload: { streamId: STREAM, reason: 'agent' } }])
    expect(port.streamRefused).toHaveBeenCalledExactlyOnceWith(STREAM)
    streams.input('local:w', STREAM, Uint8Array.of(4, 1))
    expect(port.streamInput).toHaveBeenCalledOnce()
  })

  // Standard 6: nothing fails without a word. A frame the core cannot read is a service that frames them wrong (one of
  // another version, say): said once, not once a frame, and again after the service connects again.
  it('says a screen frame it cannot read once each time the agent browser connects', () => {
    const { streams, log } = setup()
    expect(streams.bytes(Uint8Array.of(1, 2, 3))).toBe(false)
    expect(streams.bytes(new Uint8Array(64))).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toContain('cannot read (3 bytes)')
    // A frame for a stream nobody holds is the tail of one that ended: no word.
    expect(streams.bytes(screenFrame(STREAM, 0, Uint8Array.of(1)))).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    streams.gone()
    expect(streams.bytes(Uint8Array.of(1))).toBe(false)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('logs to the console when it is given no log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const streams = createBrowserStreams({ port: () => null, asker: () => ({ local: true, owner: true }), send: () => true, sendBinary: () => true })
      streams.bytes(Uint8Array.of(1))
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

