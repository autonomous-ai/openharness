import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyHostBackend } from '../ptyHostBackend.js'
import { rewrapTmuxHistory } from '../historyRewrap.js'
import { removeTree, SHELL, WAIT_MS } from '../terminalBackend.contract.js'
import { KEYFRAME_MAX_BYTES, type PtyRuntimeRef, type TerminalStreamSnapshot } from '../terminalTypes.js'
import { CONVERSATION_HISTORY_LINES, SNAPSHOT_HISTORY_LINES, tmuxKeyframe, type PaneMeta } from '../tmuxStream.js'
import { listDiscoveries } from './launch.js'
import { encodeFrame, FrameKind, FrameReader, PTY_PROTOCOL, type PtyPaneMeta, type StreamSnapshotRequest } from './protocol.js'
import { PtyHostStream, type PtyHostStreamOptions } from './stream.js'

const RUNTIME: PtyRuntimeRef = { backend: 'ptyhost', instance: 'p1', paneId: '%1' }

const META: PtyPaneMeta = {
  cols: 80, rows: 24, alternate_on: false, cursor_x: 2, cursor_y: 0, cursor_visible: true,
  mouse_standard: false, mouse_button: false, mouse_all: false, mouse_utf8: false, mouse_sgr: false,
}

/** The tmux metadata a capture with [m] would have had. */
function tmuxMeta(m: PtyPaneMeta): PaneMeta {
  return {
    sessionId: '$0', windowId: '@0', windowPanes: 1, windowWidth: m.cols, windowHeight: m.rows,
    paneWidth: m.cols, paneHeight: m.rows, alternateOn: m.alternate_on, cursorX: m.cursor_x, cursorY: m.cursor_y,
    cursorVisible: m.cursor_visible, mouseStandard: m.mouse_standard, mouseButton: m.mouse_button,
    mouseAll: m.mouse_all, mouseUtf8: m.mouse_utf8, mouseSgr: m.mouse_sgr,
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

interface Received { kind: FrameKind; payload: Buffer }

/**
 * A `PtyHostStream` over an in-memory connection the test drives as the host: what it writes the stream reads, and
 * the frames the stream sends are kept, parsed, in `sent`.
 */
async function openFakeStream(options: {
  readOnly?: boolean
  subscribe?: 'ack' | 'refuse' | 'silent'
  /** What the Subscribe ack says of the pane's size: whether subscribing changed it. */
  subscribeResized?: boolean
  streamOptions?: PtyHostStreamOptions
} = {}) {
  const toStream = new PassThrough()
  const fromStream = new PassThrough()
  const connection = Duplex.from({ readable: toStream, writable: fromStream })
  connection.pause()
  const reader = new FrameReader()
  const sent: Received[] = []
  const waiters: Array<() => void> = []
  fromStream.on('data', (chunk: Buffer) => {
    sent.push(...reader.push(chunk))
    for (const wake of waiters.splice(0)) wake()
  })
  const data: Buffer[] = []
  const closes: string[] = []
  const sink = {
    onData: (bytes: Uint8Array) => { data.push(Buffer.from(bytes)) },
    onClose: (reason: string) => { closes.push(reason) },
    text: () => Buffer.concat(data).toString('utf8'),
    get closedWith() { return closes[0] },
    closes,
  }
  const json = (kind: FrameKind, value: unknown) => toStream.write(encodeFrame(kind, Buffer.from(JSON.stringify(value))))
  /** The next frame of [kind] the stream sends from [from] on, once it has. */
  const nextSent = async (kind: FrameKind, from = 0): Promise<Received & { at: number }> => {
    for (;;) {
      const at = sent.findIndex((frame, index) => index >= from && frame.kind === kind)
      if (at >= 0) return { ...sent[at], at }
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  }
  let snapshotsAnswered = 0
  const host = {
    sent,
    nextSent,
    async output(seq: number, text: string) {
      const head = Buffer.alloc(8)
      head.writeBigUInt64BE(BigInt(seq))
      toStream.write(encodeFrame(FrameKind.Output, Buffer.concat([head, Buffer.from(text)])))
      await tick()
    },
    async ack(value: Record<string, unknown>) {
      json(FrameKind.Ack, value)
      await tick()
    },
    /** Answer the stream's next Snapshot request with [reply] (its id filled in); the request is returned. */
    async snapshotReply(reply: Record<string, unknown>): Promise<StreamSnapshotRequest> {
      const frames = sent.filter((frame) => frame.kind === FrameKind.Snapshot)
      let request: StreamSnapshotRequest
      if (frames.length > snapshotsAnswered) request = JSON.parse(frames[snapshotsAnswered].payload.toString())
      else request = JSON.parse((await nextSent(FrameKind.Snapshot, sent.length)).payload.toString())
      snapshotsAnswered++
      json(FrameKind.SnapshotReply, { id: request.id, ok: true, ...reply })
      await tick()
      return request
    },
    async closed(reason: string) {
      json(FrameKind.Closed, { reason })
      toStream.end()
      await tick()
      await tick()
    },
    async json(kind: FrameKind, value: unknown) {
      json(kind, value)
      await tick()
    },
    async raw(bytes: Buffer) {
      toStream.write(bytes)
      await tick()
      await tick()
    },
    end() { toStream.end() },
    fail(error: Error) { connection.destroy(error) },
  }
  const opening = PtyHostStream.open(connection, RUNTIME, { cols: 80, rows: 24 }, sink, options.readOnly ?? false, options.streamOptions)
  const subscribe = await nextSent(FrameKind.Subscribe)
  if (options.subscribe === 'refuse') json(FrameKind.Ack, { for: FrameKind.Subscribe, ok: false, reason: 'no_pane' })
  else if (options.subscribe !== 'silent') json(FrameKind.Ack, { for: FrameKind.Subscribe, ok: true, resized: options.subscribeResized ?? false })
  const opened = await opening
  return {
    opened,
    stream: opened.state === 'succeeded' ? opened.value : (null as unknown as PtyHostStream),
    host, sink, connection, subscribe: JSON.parse(subscribe.payload.toString()),
  }
}

afterEach(() => { vi.useRealTimers() })

describe('PtyHostStream open', () => {
  it('subscribes to the pane at the bounded size and opens on the ack', async () => {
    const { opened, subscribe } = await openFakeStream()
    expect(opened.state).toBe('succeeded')
    expect(subscribe).toEqual({ pane: '%1', cols: 80, rows: 24, readOnly: false })
  })

  it('fails when the host refuses the subscription, and closes the connection', async () => {
    const { opened, connection } = await openFakeStream({ subscribe: 'refuse' })
    expect(opened).toEqual({ state: 'failed', reason: 'pty host refused the stream: no_pane' })
    await tick()
    expect(connection.writableEnded || connection.destroyed).toBe(true)
  })

  it('fails when the subscription is not answered', async () => {
    const { opened } = await openFakeStream({ subscribe: 'silent', streamOptions: { ackTimeoutMs: 20 } })
    expect(opened).toEqual({ state: 'failed', reason: 'pty host did not answer the subscription' })
  })

  it('a read-only stream subscribes read-only and sends no input', async () => {
    const { stream, host, subscribe } = await openFakeStream({ readOnly: true })
    expect(subscribe.readOnly).toBe(true)
    expect(await stream.writeRaw(Buffer.from('x'))).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'VIEW_ONLY' })
    expect(await stream.pasteRaw('x')).toMatchObject({ dispatch: 'not_started', reason: 'VIEW_ONLY' })
    expect(await stream.resize({ cols: 10, rows: 10 })).toMatchObject({ dispatch: 'not_started', reason: 'VIEW_ONLY' })
    expect(await stream.scroll('up', 3)).toMatchObject({ dispatch: 'not_started', reason: 'VIEW_ONLY' })
    expect(host.sent.map((frame) => frame.kind)).toEqual([FrameKind.Subscribe])
  })
})

describe('PtyHostStream output and snapshots', () => {
  it('drops output already contained in the snapshot', async () => {
    const { stream, host, sink } = await openFakeStream()
    await host.output(1, 'a'); await host.output(2, 'b')
    stream.beginSnapshot()
    const pending = stream.snapshot()
    await host.output(3, 'c') // arrives during the snapshot
    await host.snapshotReply({ seq: 2, capture: 'ab', history: '', meta: META })
    expect((await pending).state).toBe('succeeded')
    await host.output(4, 'd')
    stream.endSnapshot()
    // a and b were forwarded live before beginSnapshot; c was held during it and is after the cut (seq 3 > 2); d is
    // held until endSnapshot releases it.
    expect(sink.text()).toBe('abcd')
  })

  it('drops held output at or below the cut, and output at or below it that lags behind the reply', async () => {
    const { stream, host, sink } = await openFakeStream()
    stream.beginSnapshot()
    await host.output(1, 'a')
    await host.output(2, 'b')
    const pending = stream.snapshot()
    await host.snapshotReply({ seq: 3, capture: 'abc', history: '', meta: META })
    await host.output(3, 'c') // the dispatcher lagged: already in the capture
    await host.output(4, 'd')
    expect((await pending).state).toBe('succeeded')
    stream.endSnapshot()
    await host.output(3, 'c') // a late duplicate is never forwarded either
    await host.output(5, 'e')
    expect(sink.text()).toBe('de')
  })

  it('builds the keyframe tmux builds from the same capture', async () => {
    const { stream, host } = await openFakeStream()
    stream.beginSnapshot()
    const pending = stream.snapshot()
    const capture = '\u001b[1mhello\u001b[0m\nworld\n'
    const history = 'old 1\nold 2\n'
    const request = await host.snapshotReply({ seq: 0, capture, history, meta: META })
    expect(request).toEqual({ id: request.id, history: 'plain', historyLines: SNAPSHOT_HISTORY_LINES })
    const taken = await pending
    expect(taken).toEqual({
      state: 'succeeded',
      value: {
        bytes: tmuxKeyframe(Buffer.from(capture), tmuxMeta(META), Buffer.from(history), null, { conversation: false, tuiOwnsScrollback: false }),
        cols: 80,
        rows: 24,
      },
    })
  })

  it('a TUI that owns its scrollback asks for no history and is labelled the alternate screen', async () => {
    const { stream, host } = await openFakeStream()
    stream.beginSnapshot()
    const pending = stream.snapshot({ tuiOwnsScrollback: true })
    const request = await host.snapshotReply({ seq: 0, capture: 'x\n', history: '', meta: META })
    expect(request.history).toBe('none')
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(Buffer.from(taken.value.bytes)).toEqual(Buffer.from(
      tmuxKeyframe(Buffer.from('x\n'), tmuxMeta(META), Buffer.alloc(0), null, { conversation: false, tuiOwnsScrollback: true }),
    ))
    expect(Buffer.from(taken.value.bytes).toString()).toContain('\u001b[?1049h')
  })

  it('the alternate screen seeds no history', async () => {
    const { stream, host } = await openFakeStream()
    stream.beginSnapshot()
    const pending = stream.snapshot()
    const meta = { ...META, alternate_on: true }
    await host.snapshotReply({ seq: 0, capture: 'x\n', history: 'stale\n', meta })
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(Buffer.from(taken.value.bytes)).toEqual(Buffer.from(
      tmuxKeyframe(Buffer.from('x\n'), tmuxMeta(meta), Buffer.alloc(0), null, { conversation: false, tuiOwnsScrollback: false }),
    ))
  })

  it('a conversation is re-wrapped by word from the joined history, as tmux does', async () => {
    const { stream, host } = await openFakeStream()
    stream.beginSnapshot()
    const pending = stream.snapshot({ conversationHistory: true })
    const meta = { ...META, cols: 20, rows: 3 }
    const joined = 'the quick brown fox jumps over the lazy dog\n'
    const plain = 'the quick brown fox \njumps over the lazy \ndog\n'
    const request = await host.snapshotReply({ seq: 0, capture: 'a\nb\nc\n', history: plain, historyJoined: joined, lastContinues: false, meta })
    expect(request).toEqual({ id: request.id, history: 'conversation', historyLines: CONVERSATION_HISTORY_LINES })
    const rows = rewrapTmuxHistory(Buffer.from(joined), 20, { lastContinues: false })
    expect(rows).not.toBeNull()
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(Buffer.from(taken.value.bytes)).toEqual(Buffer.from(
      tmuxKeyframe(Buffer.from('a\nb\nc\n'), tmuxMeta(meta), Buffer.from(plain), rows, { conversation: true, tuiOwnsScrollback: false }),
    ))
  })

  it('a conversation reply that lost its joined history (too large) seeds the plain one, as far back as fits', async () => {
    const { stream, host } = await openFakeStream()
    stream.beginSnapshot()
    const pending = stream.snapshot({ conversationHistory: true })
    const plain = `${'x'.repeat(70)}\n`.repeat(8000)
    await host.snapshotReply({ seq: 0, capture: 'a\n', history: plain, meta: META })
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(taken.value.bytes.length).toBeLessThanOrEqual(KEYFRAME_MAX_BYTES)
    expect(Buffer.from(taken.value.bytes)).toEqual(Buffer.from(
      tmuxKeyframe(Buffer.from('a\n'), tmuxMeta(META), Buffer.from(plain), null, { conversation: true, tuiOwnsScrollback: false }),
    ))
  })

  it('a snapshot needs the gate, and fails on a refusal or no reply', async () => {
    const { stream, host } = await openFakeStream({ streamOptions: { snapshotTimeoutMs: 30 } })
    expect(await stream.snapshot()).toEqual({ state: 'failed', reason: 'pty host snapshot gate is not active' })
    stream.beginSnapshot()
    const refused = stream.snapshot()
    const request = JSON.parse((await host.nextSent(FrameKind.Snapshot)).payload.toString())
    await host.json(FrameKind.SnapshotReply, { id: request.id, ok: false, reason: 'no_pane' })
    expect(await refused).toEqual({ state: 'failed', reason: 'pty host snapshot failed: no_pane' })
    expect(await stream.snapshot()).toEqual({ state: 'failed', reason: 'pty host snapshot timed out' })
  })

  it('closes the stream when output held behind the gate grows past the limit', async () => {
    const { stream, host, sink } = await openFakeStream()
    stream.beginSnapshot()
    await host.output(1, 'x'.repeat(1024 * 1024))
    await host.output(2, 'x'.repeat(1024 * 1024))
    await host.output(3, 'x')
    expect(sink.closes).toEqual(['pty host snapshot output exceeded safe buffer limit'])
  })

  it('takes the snapshot again when the print after a resize had begun but not ended at the cut', async () => {
    const { stream, host } = await openFakeStream()
    const resized = stream.resize({ cols: 100, rows: 30 })
    await host.nextSent(FrameKind.Resize)
    await host.ack({ for: FrameKind.Resize, ok: true, seq: 0 })
    expect((await resized).state).toBe('succeeded')
    stream.beginSnapshot()
    const repaint = { clears: '\u001b[2J', ends: '\u001b[?2026l', withinMs: 0 }
    const pending = stream.snapshot({ repaint })
    await host.output(1, 'before\u001b[2Jhalf')
    // withinMs 0: no wait before the first capture, which is cut inside the print.
    const first = await host.snapshotReply({ seq: 1, capture: 'half\n', history: '', meta: META })
    await host.output(2, 'rest\u001b[?2026l')
    const second = await host.snapshotReply({ seq: 2, capture: 'whole\n', history: '', meta: META })
    expect(second.id).not.toBe(first.id)
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(Buffer.from(taken.value.bytes).toString()).toContain('whole')
  })

  it('looks for the print in outputs the capture contains that came after its reply', async () => {
    const { stream, host } = await openFakeStream()
    await host.output(1, 'idle')
    stream.beginSnapshot()
    const pending = stream.snapshot({ repaint: { clears: '\u001b[2J', ends: 'END', withinMs: 0 } })
    // The capture has output 2, the clear, which the host's dispatcher had not yet sent.
    const first = await host.snapshotReply({ seq: 2, capture: 'cleared\n', history: '', meta: META })
    await host.output(2, '\u001b[2Jhalf')
    await host.output(3, 'restEND')
    const second = await host.snapshotReply({ seq: 3, capture: 'whole\n', history: '', meta: META })
    expect(second.id).not.toBe(first.id)
    const taken = (await pending) as { value: TerminalStreamSnapshot }
    expect(Buffer.from(taken.value.bytes).toString()).toContain('whole')
  })

  it('a subscription that resized the pane waits for the print that causes, as a resize does', async () => {
    const { stream, host } = await openFakeStream({ subscribeResized: true })
    stream.beginSnapshot()
    const pending = stream.snapshot({ repaint: { clears: '\u001b[2J', ends: 'END', withinMs: 5_000 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.sent.some((frame) => frame.kind === FrameKind.Snapshot)).toBe(false)
    await host.output(1, '\u001b[2Jnew screenEND')
    await host.snapshotReply({ seq: 1, capture: 'new screen\n', history: '', meta: META })
    expect((await pending).state).toBe('succeeded')
  })

  it('a subscription or resize that changed no size waits for no print', async () => {
    const { stream, host } = await openFakeStream({ subscribeResized: false })
    const repaint = { clears: '\u001b[2J', ends: 'END', withinMs: 5_000 }
    stream.beginSnapshot()
    const first = stream.snapshot({ repaint })
    await host.snapshotReply({ seq: 0, capture: 'screen\n', history: '', meta: META })
    expect((await first).state).toBe('succeeded')
    stream.endSnapshot()
    // The host already had this size (its size was unknown here after a failed resize, say).
    const resized = stream.resize({ cols: 100, rows: 30 })
    await host.nextSent(FrameKind.Resize)
    await host.ack({ for: FrameKind.Resize, ok: true, seq: 0, resized: false })
    expect((await resized).state).toBe('succeeded')
    stream.beginSnapshot()
    const second = stream.snapshot({ repaint })
    await host.snapshotReply({ seq: 0, capture: 'screen\n', history: '', meta: META })
    expect((await second).state).toBe('succeeded')
  })

  it('waits for the print a recent resize causes before asking for the snapshot', async () => {
    const { stream, host } = await openFakeStream()
    const resized = stream.resize({ cols: 100, rows: 30 })
    await host.nextSent(FrameKind.Resize)
    await host.ack({ for: FrameKind.Resize, ok: true, seq: 0, resized: true })
    await resized
    stream.beginSnapshot()
    const pending = stream.snapshot({ repaint: { clears: '\u001b[2J', ends: 'END', withinMs: 5_000 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.sent.some((frame) => frame.kind === FrameKind.Snapshot)).toBe(false)
    await host.output(1, '\u001b[2Jnew screenEND')
    await host.snapshotReply({ seq: 1, capture: 'new screen\n', history: '', meta: META })
    expect((await pending).state).toBe('succeeded')
  })
})

describe('PtyHostStream input', () => {
  it('writeRaw sends an Input frame and succeeds on its ack', async () => {
    const { stream, host } = await openFakeStream()
    const written = stream.writeRaw(Buffer.from('ls\r'))
    const frame = await host.nextSent(FrameKind.Input)
    expect(frame.payload.toString()).toBe('ls\r')
    await host.ack({ for: FrameKind.Input, ok: true })
    expect(await written).toEqual({ state: 'succeeded', dispatch: 'executed' })
  })

  it('sends input in the order it was given, before any reply', async () => {
    const { stream, host } = await openFakeStream()
    const first = stream.writeRaw(Buffer.from('a'))
    const second = stream.pasteRaw('b')
    const third = stream.writeRaw(Buffer.from('c'))
    await tick()
    expect(host.sent.slice(1).map((frame) => [frame.kind, frame.payload.toString()]))
      .toEqual([[FrameKind.Input, 'a'], [FrameKind.Paste, 'b'], [FrameKind.Input, 'c']])
    await host.ack({ for: FrameKind.Input, ok: true })
    await host.ack({ for: FrameKind.Paste, ok: false, reason: 'exited' })
    await host.ack({ for: FrameKind.Input, ok: false, reason: 'no_pane' })
    expect(await first).toMatchObject({ state: 'succeeded' })
    expect(await second).toEqual({ state: 'failed', dispatch: 'rejected', reason: 'exited' })
    expect(await third).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'no_pane' })
  })

  it('an unanswered write may have happened, and its late ack is not taken for the next one', async () => {
    const { stream, host } = await openFakeStream({ streamOptions: { ackTimeoutMs: 20 } })
    expect(await stream.writeRaw(Buffer.from('a'))).toEqual({
      state: 'unknown', dispatch: 'possibly_executed', reason: 'pty host did not acknowledge the input',
    })
    const next = stream.writeRaw(Buffer.from('b'))
    await host.ack({ for: FrameKind.Input, ok: false, reason: 'exited' }) // the first one's
    await host.ack({ for: FrameKind.Input, ok: true })
    expect(await next).toMatchObject({ state: 'succeeded' })
  })

  it('nothing to write is done at once', async () => {
    const { stream, host } = await openFakeStream()
    expect(await stream.writeRaw(new Uint8Array())).toMatchObject({ state: 'succeeded' })
    expect(await stream.pasteRaw('')).toMatchObject({ state: 'succeeded' })
    expect(host.sent).toHaveLength(1)
  })

  it('pastes as one Paste frame', async () => {
    const { stream, host } = await openFakeStream()
    const pasted = stream.pasteRaw('line 1\nline 2 é')
    const frame = await host.nextSent(FrameKind.Paste)
    expect(frame.payload.toString('utf8')).toBe('line 1\nline 2 é')
    await host.ack({ for: FrameKind.Paste, ok: true })
    expect(await pasted).toMatchObject({ state: 'succeeded' })
  })

  it('resizes within the bounds a stream takes', async () => {
    const { stream, host } = await openFakeStream()
    const resized = stream.resize({ cols: 1000, rows: 0 })
    const frame = await host.nextSent(FrameKind.Resize)
    expect(JSON.parse(frame.payload.toString())).toEqual({ cols: 300, rows: 1 })
    await host.ack({ for: FrameKind.Resize, ok: true, seq: 4 })
    expect(await resized).toMatchObject({ state: 'succeeded' })
  })

  it('scroll sends PageUp or PageDown, one page a burst, as tmux does', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { stream, host } = await openFakeStream()
    const up = stream.scroll('up', 5)
    const frame = await host.nextSent(FrameKind.Input)
    expect(frame.payload.toString('latin1')).toBe('\u001b[5~')
    await host.ack({ for: FrameKind.Input, ok: true })
    expect(await up).toMatchObject({ state: 'succeeded' })
    // Within the burst interval: dropped.
    expect(await stream.scroll('down', 5)).toMatchObject({ state: 'succeeded' })
    expect(host.sent.filter((f) => f.kind === FrameKind.Input)).toHaveLength(1)
    vi.setSystemTime(Date.now() + 1000)
    const down = stream.scroll('down', 5)
    const second = await host.nextSent(FrameKind.Input, frame.at + 1)
    expect(second.payload.toString('latin1')).toBe('\u001b[6~')
    await host.ack({ for: FrameKind.Input, ok: true })
    expect(await down).toMatchObject({ state: 'succeeded' })
    expect(await stream.scroll('up', 0)).toMatchObject({ state: 'succeeded' })
  })

  it('pause and resume send their frames and wait for nothing', async () => {
    const { stream, host } = await openFakeStream()
    expect(await stream.pauseOutput()).toMatchObject({ state: 'succeeded' })
    expect(await stream.resumeOutput()).toMatchObject({ state: 'succeeded' })
    await tick()
    expect(host.sent.slice(1).map((frame) => frame.kind)).toEqual([FrameKind.Pause, FrameKind.Resume])
  })
})

describe('PtyHostStream close', () => {
  it('reports overflow as close', async () => {
    const { host, sink } = await openFakeStream()
    await host.closed('overflow')
    expect(sink.closedWith).toBe('overflow')
    expect(sink.closes).toHaveLength(1)
  })

  it('a pending write may have happened when the host closes the stream, and later ones are not started', async () => {
    const { stream, host, sink } = await openFakeStream()
    const written = stream.writeRaw(Buffer.from('a'))
    await host.closed('exited')
    expect(await written).toMatchObject({ dispatch: 'possibly_executed' })
    expect(await stream.writeRaw(Buffer.from('b'))).toMatchObject({ dispatch: 'not_started' })
    expect(await stream.pauseOutput()).toMatchObject({ dispatch: 'not_started' })
    expect(sink.closes).toEqual(['exited'])
  })

  it('close ends the connection once and reports closed once', async () => {
    const { stream, sink, connection } = await openFakeStream()
    const closing = stream.close()
    await stream.close()
    await closing
    expect(connection.writableEnded || connection.destroyed).toBe(true)
    expect(sink.closes).toEqual(['closed'])
  })

  it('forwards no output once close has begun', async () => {
    const { stream, host, sink } = await openFakeStream()
    await host.output(1, 'before')
    const closing = stream.close()
    await host.output(2, 'after')
    await closing
    expect(sink.text()).toBe('before')
    expect(sink.closes).toEqual(['closed'])
  })

  it('releases no held output once close has begun', async () => {
    const { stream, host, sink } = await openFakeStream()
    stream.beginSnapshot()
    await host.output(1, 'held')
    const closing = stream.close()
    stream.endSnapshot()
    await closing
    expect(sink.text()).toBe('')
  })

  it('a connection error closes the stream once, without throwing', async () => {
    const { host, sink } = await openFakeStream()
    host.fail(new Error('boom'))
    await tick()
    await tick()
    expect(sink.closes).toEqual(['pty host stream failed: boom'])
  })

  it('the host ending the connection closes the stream', async () => {
    const { host, sink } = await openFakeStream()
    host.end()
    await tick()
    await tick()
    expect(sink.closes).toEqual(['pty host stream closed'])
  })

  it('a frame it cannot read closes the stream', async () => {
    const { host, sink, connection } = await openFakeStream()
    await host.raw(Buffer.from([0xee, 0, 0, 0, 0]))
    expect(sink.closes).toEqual(['pty host stream protocol error: unknown frame kind 238'])
    expect(connection.destroyed).toBe(true)
  })
})

// Runs the real host: `cd pty && cargo +stable build`, then
// HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty npx vitest run src/lib/ptyHost/stream.spec.ts
describe.skipIf(!process.env.HARNESS_PTY_BIN)('PtyHostStream with the real harness-pty', () => {
  let home: string | null = null
  afterEach(async () => {
    if (!home) return
    const pid = listDiscoveries(home).findLast((found) => found.protocol === PTY_PROTOCOL)?.pid
    if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    const dir = home
    home = null
    await removeTree(dir)
  })

  it('opens a stream on a shell, snapshots, types, resizes and closes', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'pty-stream-'))
    const backend = new PtyHostBackend({ home, owner: () => 'test' })
    expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    const created = await backend.create({ command: SHELL, cwd: home })
    if (created.state !== 'succeeded') throw new Error(JSON.stringify(created))
    const chunks: Buffer[] = []
    const closes: string[] = []
    const opened = await backend.openStream(created.runtime, { engine: 'terminal' }, { cols: 90, rows: 20 }, {
      onData: (bytes) => chunks.push(Buffer.from(bytes)),
      onClose: (reason) => closes.push(reason),
    })
    if (opened.state !== 'succeeded') throw new Error(JSON.stringify(opened))
    const stream = opened.value
    stream.beginSnapshot()
    const snapshot = await stream.snapshot()
    expect(snapshot).toMatchObject({ state: 'succeeded', value: { cols: 90, rows: 20 } })
    stream.endSnapshot()
    expect(await stream.writeRaw(Buffer.from('echo live-$((1+1))\r'))).toMatchObject({ state: 'succeeded' })
    // `$((1+1))`: arithmetic to sh, a subexpression to PowerShell.
    await expect.poll(() => Buffer.concat(chunks).toString(), { timeout: WAIT_MS }).toContain('live-2')
    expect(await stream.resize({ cols: 70, rows: 15 })).toMatchObject({ state: 'succeeded' })
    stream.beginSnapshot()
    const resized = await stream.snapshot()
    stream.endSnapshot()
    expect(resized).toMatchObject({ state: 'succeeded', value: { cols: 70, rows: 15 } })
    if (resized.state === 'succeeded') expect(Buffer.from(resized.value.bytes).toString()).toContain('live-2')
    await stream.close()
    expect(closes).toEqual(['closed'])
    expect((await backend.kill(created.runtime)).state).toBe('succeeded')
  }, WAIT_MS * 2)
})
