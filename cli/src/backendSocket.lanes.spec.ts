/**
 * The order a remote client's terminal frames are handled in. Its keystrokes used to wait in its
 * connection's line behind every request it made — an `agents_list`, a `session_get`, its own pane's
 * resize keyframe on each keyboard show or hide — and a phone typed into a pane that answered seconds
 * late. These hold the rules that replaced it: a stream's bytes keep their own order and nothing else's,
 * an upload's control frames stay in line with its chunks, and a stream's bookkeeping is never queued.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalStreamManager } from './lib/terminalStreamManager.js'
import { TerminalBinaryKind, type TerminalBinaryClear } from './lib/terminalBinary.js'
import { env } from './config/env.js'
import { relaySocket } from './testing/relaySocket.js'

afterEach(() => vi.restoreAllMocks())

const STREAM_A = '00000000-0000-4000-8000-00000000000a'
const STREAM_B = '00000000-0000-4000-8000-00000000000b'

const kindName = (kind: TerminalBinaryKind): string =>
  kind === TerminalBinaryKind.input ? 'input' : kind === TerminalBinaryKind.paste ? 'paste' : kind === TerminalBinaryKind.imagePaste ? 'imagePaste' : String(kind)

const input = (streamId: string, seq: number, kind = TerminalBinaryKind.input): TerminalBinaryClear =>
  ({ kind, streamId, seq, bytes: new TextEncoder().encode(String(seq)), compressed: false })

/** A promise the test settles, and whether anything has waited on it. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

/** A socket whose terminal streams record what reached them, and hold whatever the test tells them to. */
function streamsOn() {
  const socket = relaySocket('fixture')
  const seen: string[] = []
  const holds = new Map<string, Promise<void>>()
  const hold = (what: string) => { const g = gate(); holds.set(what, g.opened); return g.open }
  const handleFrame = vi.fn(async (_connId: string, type: string, payload: Record<string, unknown>) => {
    const what = `${type}:${String(payload.streamId ?? '')}`
    seen.push(what)
    await holds.get(what)
    return true
  })
  const handleBinary = vi.fn(async (_connId: string, frame: TerminalBinaryClear) => {
    const what = `${kindName(frame.kind)}:${frame.streamId}:${frame.seq}`
    seen.push(what)
    await holds.get(what)
  })
  socket.setTerminalStreamManager({
    handleFrame, handleBinary,
    closeConnection: vi.fn(async () => {}), closeConnectionsWhere: vi.fn(async () => {}), stop: vi.fn(async () => {}),
  } as unknown as TerminalStreamManager)
  const frame = (type: string, payload: Record<string, unknown>) =>
    socket.fromGateway.frame('phone-1', { type, payload }, 'relay', 'web')
  const binary = (clear: TerminalBinaryClear) => socket.fromGateway.binary('phone-1', clear)
  return { socket, seen, hold, frame, binary }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a remote client\'s keystrokes', () => {
  it('reach their pane while its resize keyframe is still being taken', async () => {
    const { socket, seen, hold, frame, binary } = streamsOn()
    const keyframeDone = hold(`terminal_resize:${STREAM_A}`)
    void frame('terminal_resize', { streamId: STREAM_A, resizeSeq: 1, cols: 42, rows: 24 })
    await settle()
    void binary(input(STREAM_A, 1))
    await settle()
    expect(seen).toEqual([`terminal_resize:${STREAM_A}`, `input:${STREAM_A}:1`])
    keyframeDone()
    await socket.stop()
  })

  it('reach their pane while a slow request on the same connection is still being answered', async () => {
    const { socket, seen, frame, binary } = streamsOn()
    const history = gate()
    ;(socket as unknown as { historyProvider: () => Promise<Record<string, unknown>> }).historyProvider = async () => { await history.opened; return {} }
    void frame('session_get', { requestId: 'h-1', agentId: 'a1' })
    void binary(input(STREAM_A, 1))
    await settle()
    expect(seen).toEqual([`input:${STREAM_A}:1`])
    history.open()
    await socket.stop()
  })

  it('keep their own stream\'s order: a key typed after a paste waits for the paste, another pane\'s does not', async () => {
    const { socket, seen, hold, binary } = streamsOn()
    const pasted = hold(`paste:${STREAM_A}:0`)
    void binary(input(STREAM_A, 0, TerminalBinaryKind.paste))
    void binary(input(STREAM_A, 1))
    void binary(input(STREAM_B, 1))
    await settle()
    expect(seen).toEqual([`paste:${STREAM_A}:0`, `input:${STREAM_B}:1`])
    pasted()
    await vi.waitFor(() => expect(seen).toEqual([`paste:${STREAM_A}:0`, `input:${STREAM_B}:1`, `input:${STREAM_A}:1`]))
    await socket.stop()
  })

  it('go on after one of them fails', async () => {
    const { socket, seen, binary } = streamsOn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const streams = (socket as unknown as { terminalStreams: { handleBinary: ReturnType<typeof vi.fn> } }).terminalStreams
    streams.handleBinary.mockImplementationOnce(async () => { throw new Error('tmux went away') })
    void binary(input(STREAM_A, 1))
    await binary(input(STREAM_A, 2))
    expect(seen).toEqual([`input:${STREAM_A}:2`])
    expect(error).toHaveBeenCalledWith('[backend] binary terminal dispatch failed:', 'tmux went away')
    await socket.stop()
  })
})

describe('a remote client\'s keystrokes, traced', () => {
  it('say how long each waited in its stream\'s line while tracing is on, and nothing while it is off', async () => {
    const { socket, hold, binary } = streamsOn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const traced = () => log.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[typing]'))
    await binary(input(STREAM_A, 0))
    expect(traced()).toEqual([])
    const was = env.TYPING_TRACE
    ;(env as { TYPING_TRACE: boolean }).TYPING_TRACE = true
    try {
      const pasted = hold(`paste:${STREAM_A}:0`)
      void binary(input(STREAM_A, 0, TerminalBinaryKind.paste))
      const typed = binary(input(STREAM_A, 1))
      await new Promise((resolve) => setTimeout(resolve, 20))
      pasted()
      await typed
      expect(traced()).toEqual([expect.stringMatching(new RegExp(`^\\[typing\\] lane conn=phone-1 stream=${STREAM_A.slice(0, 8)} seq=1 waited (1\\d|[2-9]\\d|\\d{3,})ms$`))])
    } finally {
      ;(env as { TYPING_TRACE: boolean }).TYPING_TRACE = was
      await socket.stop()
    }
  })
})

describe('a stream\'s acknowledgements and heartbeats', () => {
  it('are handled while the connection waits on a request', async () => {
    // An ack stuck behind a slow request let unacknowledged output reach the pause mark: the screen stopped.
    const { socket, seen, hold, frame } = streamsOn()
    const keyframeDone = hold(`terminal_resize:${STREAM_A}`)
    void frame('terminal_resize', { streamId: STREAM_A, resizeSeq: 1, cols: 42, rows: 24 })
    await settle()
    void frame('terminal_ack', { streamId: STREAM_A, lastSeq: 3 })
    void frame('terminal_alive', { streamId: STREAM_A })
    await settle()
    expect(seen).toEqual([`terminal_resize:${STREAM_A}`, `terminal_ack:${STREAM_A}`, `terminal_alive:${STREAM_A}`])
    keyframeDone()
    await socket.stop()
  })

  it('wait at the gate like everything else while the daemon is starting', async () => {
    const { socket, seen, frame } = streamsOn()
    socket.holdRequests()
    void frame('terminal_ack', { streamId: STREAM_A, lastSeq: 3 })
    await settle()
    expect(seen).toEqual([])
    socket.openRequests()
    await vi.waitFor(() => expect(seen).toEqual([`terminal_ack:${STREAM_A}`]))
    await socket.stop()
  })
})

describe('an upload\'s begin and cancel', () => {
  it('stay in line with the chunks already waiting in their stream', async () => {
    // A cancel and a new begin let past the old upload's chunks took those chunks into the new upload.
    const { socket, seen, hold, frame, binary } = streamsOn()
    const chunkDone = hold(`imagePaste:${STREAM_A}:0`)
    void binary(input(STREAM_A, 0, TerminalBinaryKind.imagePaste))
    void binary(input(STREAM_A, 1, TerminalBinaryKind.imagePaste))
    void frame('terminal_chunked_upload_cancel', { streamId: STREAM_A })
    void frame('terminal_chunked_upload_begin', { streamId: STREAM_A, requestId: 'u-2' })
    await settle()
    expect(seen).toEqual([`imagePaste:${STREAM_A}:0`])
    chunkDone()
    await vi.waitFor(() => expect(seen).toEqual([
      `imagePaste:${STREAM_A}:0`,
      `imagePaste:${STREAM_A}:1`,
      `terminal_chunked_upload_cancel:${STREAM_A}`,
      `terminal_chunked_upload_begin:${STREAM_A}`,
    ]))
    await socket.stop()
  })

  it('from a window on this computer keep the window\'s own line, which its bytes never waited in', async () => {
    const { socket, seen } = streamsOn()
    socket.registerLocalClient('local:window', { sendFrame: () => true, sendBinary: () => true })
    socket.handleLocalFrame('local:window', { type: 'terminal_chunked_upload_begin', payload: { streamId: STREAM_A, requestId: 'u-1' } })
    await vi.waitFor(() => expect(seen).toEqual([`terminal_chunked_upload_begin:${STREAM_A}`]))
    await socket.unregisterLocalClient('local:window')
    await socket.stop()
  })
})
