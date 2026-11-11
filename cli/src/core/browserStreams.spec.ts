import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asker } from './api.js'
import { BROWSER_PACING_BYTES_PER_SECOND, BrowserStreamManager } from './browserStreams.js'
import { sealTerminalBinary } from '../lib/e2ee/terminalSeal.js'
import { BROWSER_CHUNK_BYTES, encodeTerminalPlain, TerminalBinaryKind, type TerminalBinaryClear } from '../lib/terminalBinary.js'
import { ownProcessGroup } from '../lib/windows/noWindow.js'

// The exec the manager starts: a fake child per open, as the harness below makes them.
const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (real) => ({ ...await real<object>(), spawn }))

const KiB = 1024
const ARGV = ['/opt/podman/bin/podman', 'exec', '-i', 'harness-browser-a1', 'socat', 'STDIO', 'TCP:127.0.0.1:5900']
const LOCAL: Asker = { local: true, owner: true }
const OTHER_DESKTOP: Asker = { local: false, owner: true, accountOwner: true }
const SHARE_GUEST: Asker = { local: false, owner: true, accountOwner: true, guest: 'kim@acme.io' }
const PLAIN_OWNER: Asker = { local: false, owner: true }
const ASKERS: Record<string, Asker> = { 'local:w': LOCAL, 'mac-2': OTHER_DESKTOP, 'mac-3': OTHER_DESKTOP, 'mac-4': OTHER_DESKTOP, guest: SHARE_GUEST, share: PLAIN_OWNER }

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; exitCode: number | null; signalCode: string | null; written: () => Uint8Array; exit: (code: number | null, signal: string | null) => void }

/** A child that ends when it is killed, unless told to ignore SIGTERM. */
function fakeChild(ignoresTerm = false): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  const chunks: Uint8Array[] = []
  child.stdin.on('data', (chunk: Buffer) => chunks.push(new Uint8Array(chunk)))
  child.written = () => Buffer.concat(chunks)
  // As Node does: the exit code or signal is set as 'exit' is emitted.
  child.exit = (code, signal) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
  }
  child.kill = vi.fn((signal: string = 'SIGTERM') => {
    if (ignoresTerm && signal === 'SIGTERM') return true
    queueMicrotask(() => child.exit(null, signal))
    return true
  })
  return child
}

function harness(opts: { pauseBytes?: number; resumeBytes?: number; ignoresTerm?: boolean } = {}) {
  const children: FakeChild[] = []
  spawn.mockReset().mockImplementation(() => { const child = fakeChild(opts.ignoresTerm); children.push(child); return child })
  const frames: Array<{ connId: string; type: string; payload: Record<string, unknown> }> = []
  const binary: Array<{ connId: string; frame: TerminalBinaryClear }> = []
  const measures: string[] = []
  let binaryOk = true
  const manager = new BrowserStreamManager({
    command: (agentId) => agentId === 'a1' || agentId === 'a2' ? { argv: ARGV } : agentId === 'starting' ? { error: 'NOT_READY' } : { error: 'NO_BROWSER' },
    asker: (connId) => ASKERS[connId] ?? { local: false, owner: false },
    sendTarget: (connId, type, payload) => { frames.push({ connId, type, payload }); return true },
    sendBinaryTarget: (connId, frame) => { binary.push({ connId, frame }); return binaryOk },
    measure: (metric) => { measures.push(metric) },
    pacing: { bytesPerSecond: 512 * KiB },
    window: { pauseBytes: opts.pauseBytes ?? 256 * KiB, resumeBytes: opts.resumeBytes ?? 128 * KiB },
    chunkBytes: 32 * KiB,
  })
  let request = 0
  /** Opens a stream and answers its id, or the refusal. */
  const open = (connId: string, agentId = 'a1'): string => {
    const requestId = `r-${++request}`
    manager.open(connId, { requestId, agentId })
    const result = frames.find(frame => frame.type === 'agent_browser_open_result' && frame.payload.requestId === requestId)!
    return (result.payload.streamId ?? result.payload.error) as string
  }
  const closes = () => frames.filter(frame => frame.type === 'agent_browser_close').map(frame => [frame.connId, frame.payload.streamId, frame.payload.reason])
  const sentBytes = (streamId: string) => binary.filter(sent => sent.frame.streamId === streamId).reduce((sum, sent) => sum + sent.frame.bytes.length, 0)
  return { manager, children, spawn, frames, binary, measures, open, closes, sentBytes, failBinary: () => { binaryOk = false } }
}

const bytes = (length: number, fill = 7) => Buffer.alloc(length, fill)

afterEach(() => { vi.useRealTimers() })

describe('opening a browser stream', () => {
  it('open allowed for a local asker and for accountOwner', () => {
    const h = harness()
    const local = h.open('local:w')
    const remote = h.open('mac-2')
    expect(local).toMatch(/^[0-9a-f-]{36}$/)
    expect(remote).toMatch(/^[0-9a-f-]{36}$/)
    expect(local).not.toBe(remote)
    expect(h.spawn).toHaveBeenCalledTimes(2)
  })

  // Review Focus 1: a verified machine share is `owner` too, and must never open the owner's logged-in browser.
  it('open refused for a share guest whose owner flag is true', () => {
    const h = harness()
    expect(h.open('guest')).toBe('NOT_OWNER')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('open refused for owner:true without local or accountOwner', () => {
    const h = harness()
    expect(h.open('share')).toBe('NOT_OWNER')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('open passes NO_BROWSER and NOT_READY through from the port', () => {
    const h = harness()
    expect(h.open('local:w', 'none')).toBe('NO_BROWSER')
    expect(h.open('local:w', 'starting')).toBe('NOT_READY')
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('open spawns the port\'s argv with ownProcessGroup', () => {
    const h = harness()
    h.open('local:w')
    expect(h.spawn).toHaveBeenCalledWith(ARGV[0], ARGV.slice(1), expect.objectContaining({ stdio: 'pipe', ...ownProcessGroup() }))
  })

  it('fifth viewer refused with VIEWER_LIMIT', () => {
    const h = harness()
    for (const connId of ['local:w', 'mac-2', 'mac-3', 'mac-4']) expect(h.open(connId)).toMatch(/^[0-9a-f-]{36}$/)
    expect(h.open('local:w')).toBe('VIEWER_LIMIT')
    expect(h.spawn).toHaveBeenCalledTimes(4)
    // Another agent's browser has viewers of its own.
    expect(h.open('local:w', 'a2')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('an open counts agent_browser_stream_opened, and a close counts agent_browser_stream_closed_<reason>', () => {
    const h = harness()
    const streamId = h.open('local:w')
    h.open('guest')
    h.manager.close('local:w', { streamId })
    expect(h.measures).toEqual(['agent_browser_stream_opened', 'agent_browser_stream_closed_closed'])
  })
})

describe('the bytes of a browser stream', () => {
  it('stdout becomes kind-8 frames of at most chunkBytes', () => {
    const h = harness()
    const streamId = h.open('local:w')
    const screen = Buffer.concat([bytes(40 * KiB, 1), bytes(60 * KiB, 2)])
    h.children[0].stdout.emit('data', screen)
    expect(h.binary.map(sent => sent.frame.bytes.length)).toEqual([32 * KiB, 32 * KiB, 32 * KiB, 4 * KiB])
    expect(h.binary.every(sent => sent.connId === 'local:w' && sent.frame.kind === TerminalBinaryKind.browser && sent.frame.streamId === streamId)).toBe(true)
    expect(h.binary.map(sent => sent.frame.seq)).toEqual([0, 1, 2, 3])
    expect(Buffer.concat(h.binary.map(sent => sent.frame.bytes)).equals(screen)).toBe(true)
  })

  it('input bytes reach the child\'s stdin', () => {
    const h = harness()
    const streamId = h.open('local:w')
    const version = new TextEncoder().encode('RFB 003.008\n')
    h.manager.input('local:w', streamId, version)
    // Another connection cannot type into it.
    h.manager.input('mac-2', streamId, new Uint8Array([1]))
    expect(Buffer.from(h.children[0].written()).equals(Buffer.from(version))).toBe(true)
  })

  it('a local connection\'s stream is direct and is not paced', () => {
    vi.useFakeTimers()
    const h = harness({ pauseBytes: 4096 * KiB, resumeBytes: 2048 * KiB })
    const streamId = h.open('local:w')
    h.children[0].stdout.emit('data', bytes(1024 * KiB))
    expect(h.sentBytes(streamId)).toBe(1024 * KiB)
    // The direct profile: Tight at quality 6 and compression 2.
    h.manager.input('local:w', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.manager.input('local:w', streamId, Uint8Array.of(1, 1)) // security type, ClientInit
    h.manager.input('local:w', streamId, Uint8Array.of(2, 0, 0, 1, 0, 0, 0, 7)) // SetEncodings [Tight]
    const written = h.children[0].written().subarray(14)
    const view = new DataView(written.buffer, written.byteOffset, written.byteLength)
    expect([view.getInt32(4), view.getInt32(8), view.getInt32(12)]).toEqual([7, -32 + 6, -256 + 2])
  })

  it('a remote stream is paced as a relayed one until its route is known, and takes its route\'s profile', () => {
    const h = harness()
    const streamId = h.open('mac-2')
    const encodings = () => {
      const written = h.children[0].written()
      const view = new DataView(written.buffer, written.byteOffset, written.byteLength)
      const out: number[][] = []
      for (let at = 14; at < written.length;) {
        const count = view.getUint16(at + 2)
        out.push(Array.from({ length: count }, (_, i) => view.getInt32(at + 4 + 4 * i)))
        at += 4 + 4 * count
      }
      return out
    }
    h.manager.input('mac-2', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.manager.input('mac-2', streamId, Uint8Array.of(1, 1, 2, 0, 0, 1, 0, 0, 0, 7))
    h.manager.route(streamId, 'turn')
    expect(encodings()).toEqual([[7, -32 + 3, -256 + 6], [7, -32 + 3, -256 + 6]])
    h.manager.route(streamId, 'direct')
    expect(encodings().at(-1)).toEqual([7, -32 + 6, -256 + 2])
  })

  it('the total output of relay and turn streams is paced to bytesPerSecond, shared between them; a direct stream is not paced', async () => {
    vi.useFakeTimers()
    const h = harness({ pauseBytes: 8192 * KiB, resumeBytes: 4096 * KiB })
    const relay = h.open('mac-2')
    const turn = h.open('mac-3')
    const direct = h.open('mac-4')
    h.manager.route(relay, 'relay')
    h.manager.route(turn, 'turn')
    h.manager.route(direct, 'direct')
    for (const child of h.children) child.stdout.emit('data', bytes(2048 * KiB))
    expect(h.sentBytes(direct)).toBe(2048 * KiB)
    await vi.advanceTimersByTimeAsync(2_000)
    const paced = h.sentBytes(relay) + h.sentBytes(turn)
    expect(paced).toBeLessThanOrEqual(2 * 512 * KiB)
    expect(paced).toBeGreaterThanOrEqual(2 * 512 * KiB - 2 * 32 * KiB)
    expect(Math.abs(h.sentBytes(relay) - h.sentBytes(turn))).toBeLessThanOrEqual(32 * KiB)
  })

  it('credit pauses the child\'s stdout at pauseBytes unacked and resumes below resumeBytes', () => {
    const h = harness()
    const streamId = h.open('local:w')
    const stdout = h.children[0].stdout
    stdout.emit('data', bytes(200 * KiB))
    expect(stdout.isPaused()).toBe(false)
    stdout.emit('data', bytes(56 * KiB))
    expect(stdout.isPaused()).toBe(true)
    h.manager.ack('local:w', { streamId, bytes: 100 * KiB })
    expect(stdout.isPaused()).toBe(true)
    // Another connection's ack is not this viewer's.
    h.manager.ack('mac-2', { streamId, bytes: 100 * KiB })
    expect(stdout.isPaused()).toBe(true)
    h.manager.ack('local:w', { streamId, bytes: 30 * KiB })
    expect(stdout.isPaused()).toBe(false)
  })

  it('a send that returns false closes the stream with reason backlog', () => {
    const h = harness()
    const streamId = h.open('local:w')
    h.failBinary()
    h.children[0].stdout.emit('data', bytes(64 * KiB))
    expect(h.binary).toHaveLength(1)
    expect(h.closes()).toEqual([['local:w', streamId, 'backlog']])
    expect(h.children[0].kill).toHaveBeenCalled()
  })

  // Review finding: the daemon paced plaintext at the whole budget, the backend counts sealed bytes per fixed minute,
  // and two viewers scrolling for a minute went over it, closing every relayed stream with `rate`.
  it('two relayed streams at full speed stay under the backend\'s count of sealed bytes, minute after minute', async () => {
    vi.useFakeTimers()
    // The backend's rule (backend lib/terminalRelay.ts, adapterWs.ts): a kind-8 frame's sealed length, into a bucket
    // that starts at its first frame and lasts a fixed minute, refused past 512 KiB × 60.
    const BUDGET = 512 * KiB * 60
    const windows: number[] = []
    let startedAt = Number.NEGATIVE_INFINITY
    let refused = 0
    const closed: string[] = []
    const key = new Uint8Array(32).fill(9)
    let counter = 0
    // A frame's sealed length is the sealer's, taken once for each shape a frame comes in: sealing every one of three
    // minutes of frames for real took 0.9 s of CPU alone and past 30 s on a loaded gate.
    const lengths = new Map<string, number>()
    const sealedLength = (frame: TerminalBinaryClear): number => {
      // Every frame must still be one the sealer takes (its stream id, seq and flags); only the AEAD is skipped.
      if (!encodeTerminalPlain(frame)) throw new Error(`frame ${frame.seq} cannot be sealed`)
      const shape = `${frame.kind}:${frame.bytes.length}:${frame.compressed ? 1 : 0}:${frame.tabId ?? ''}`
      let length = lengths.get(shape)
      if (length === undefined) lengths.set(shape, length = sealTerminalBinary(key, counter++, frame)!.length)
      return length
    }
    const children: FakeChild[] = []
    const manager = new BrowserStreamManager({
      command: () => ({ argv: ARGV }),
      asker: (connId) => ASKERS[connId],
      sendTarget: (connId, type, payload) => {
        // Each viewer answers the server's banner, as noVNC does.
        if (type === 'agent_browser_open_result') queueMicrotask(() => manager.input(connId, payload.streamId as string, new TextEncoder().encode('RFB 003.008\n')))
        if (type === 'agent_browser_close') closed.push(payload.reason as string)
        return true
      },
      sendBinaryTarget: (_connId, frame) => {
        const sealed = sealedLength(frame)
        if (Date.now() - startedAt >= 60_000) { startedAt = Date.now(); windows.push(0) }
        if (windows[windows.length - 1] + sealed > BUDGET) refused++
        else windows[windows.length - 1] += sealed
        return true
      },
      measure: () => {},
      pacing: { bytesPerSecond: BROWSER_PACING_BYTES_PER_SECOND },
      // The viewers draw at once: only the pace holds the bytes back.
      window: { pauseBytes: 1024 * 1024 * KiB, resumeBytes: 512 * 1024 * KiB },
      chunkBytes: BROWSER_CHUNK_BYTES,
    })
    spawn.mockReset().mockImplementation(() => { const child = fakeChild(); children.push(child); return child })
    // Neither route is known yet: both are paced as relayed.
    for (const connId of ['mac-2', 'mac-3']) manager.open(connId, { requestId: `r-${connId}`, agentId: 'a1' })
    // Idle first, so the pace's bucket is full when the scrolling starts.
    await vi.advanceTimersByTimeAsync(5_000)
    const screen = bytes(64 * KiB)
    // Each stream offers more than the whole budget: 640 KiB a second.
    const feed = setInterval(() => { for (const child of children) child.stdout.emit('data', screen) }, 100)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    clearInterval(feed)
    expect(refused).toBe(0)
    expect(closed).toEqual([])
    expect(windows).toHaveLength(3)
    // And the pace is not so careful that it wastes the budget.
    for (const used of windows) expect(used).toBeGreaterThan(0.85 * BUDGET)
  })

  it('a stream whose credit stays used up for 10 s is closed with reason backlog', async () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('local:w')
    h.manager.input('local:w', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.children[0].stdout.emit('data', bytes(256 * KiB))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.closes()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.closes()).toEqual([['local:w', streamId, 'backlog']])
  })

  // Review finding: a Desktop that gave up on its open (or closed its panel first) never answers, and its stream held one
  // of the browser's four viewer slots until it reconnected.
  it('a viewer that never answers the banner is closed with reason backlog 10 s after it was sent, and logged once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = harness()
    const silent = h.open('mac-2')
    const answered = h.open('mac-3')
    h.manager.route(silent, 'relay')
    h.manager.route(answered, 'relay')
    // The exec takes a while to start: the viewer is not owed a word before its banner left.
    await vi.advanceTimersByTimeAsync(5_000)
    const banner = new TextEncoder().encode('RFB 003.008\n')
    for (const child of h.children) child.stdout.emit('data', Buffer.from(banner))
    h.manager.input('mac-3', answered, banner)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.closes()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.closes()).toEqual([['mac-2', silent, 'backlog']])
    expect(warn.mock.calls.filter(call => call.join(' ').includes(`${silent.slice(0, 8)}`))).toHaveLength(1)
    expect(warn.mock.calls.flat().join(' ')).toContain('never answered')
    // Its slot is free again; the viewer that answered keeps its stream however long its screen stays still.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.closes()).toEqual([['mac-2', silent, 'backlog']])
  })

  it('an ack is an answer too', async () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('local:w')
    h.children[0].stdout.emit('data', bytes(64 * KiB))
    h.manager.ack('local:w', { streamId, bytes: 64 * KiB })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.closes()).toEqual([])
  })

  it('bytes still waiting for their pace do not count as a lost ack', async () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('mac-2')
    h.manager.input('mac-2', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.manager.route(streamId, 'relay')
    h.children[0].stdout.emit('data', bytes(256 * KiB))
    // A whole window at the relay's pace takes half a second to leave, after which the ack has 10 s.
    await vi.advanceTimersByTimeAsync(10_200)
    expect(h.closes()).toEqual([])
    await vi.advanceTimersByTimeAsync(500)
    expect(h.closes()).toEqual([['mac-2', streamId, 'backlog']])
  })
})

describe('what a browser stream ignores and how it fails', () => {
  it('an open without a request id is not answered, and one without an agent has no browser', () => {
    const h = harness()
    h.manager.open('local:w', { agentId: 'a1' })
    h.manager.open('local:w', { requestId: 'r-x' })
    expect(h.frames).toEqual([{ connId: 'local:w', type: 'agent_browser_open_result', payload: { requestId: 'r-x', error: 'NO_BROWSER' } }])
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('an ack that is not a positive count changes nothing, and an ack past what was sent leaves no credit owed', () => {
    const h = harness()
    const streamId = h.open('local:w')
    const stdout = h.children[0].stdout
    stdout.emit('data', bytes(256 * KiB))
    for (const value of [0, -5, Number.NaN, '64']) h.manager.ack('local:w', { streamId, bytes: value })
    expect(stdout.isPaused()).toBe(true)
    h.manager.ack('local:w', { streamId, bytes: 1024 * KiB })
    expect(stdout.isPaused()).toBe(false)
    stdout.emit('data', bytes(255 * KiB))
    expect(stdout.isPaused()).toBe(false)
  })

  it('a viewer message the shaper cannot read closes the stream with reason closed and a line naming it', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streamId = h.open('local:w')
    h.manager.input('local:w', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.manager.input('local:w', streamId, Uint8Array.of(1, 1, 99))
    expect(h.closes()).toEqual([['local:w', streamId, 'closed']])
    expect(warn.mock.calls.flat().join(' ')).toContain('unknown RFB client message type 99')
  })

  it('an exec that exits says why in the log', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.open('local:w')
    h.children[0].stderr.emit('data', Buffer.from('Error: no container with name or ID "harness-browser-a1" found\n'))
    h.children[0].exit(125, null)
    expect(warn.mock.calls.flat().join(' ')).toContain('exec exited (125): Error: no container with name or ID "harness-browser-a1" found')
    // An exec ended by a signal (the OOM killer's) names it.
    h.open('local:w')
    h.children[1].exit(null, 'SIGKILL')
    expect(warn.mock.calls.flat().join(' ')).toContain('exec exited (SIGKILL)')
  })

  it('an ack or a close that names no stream changes nothing', () => {
    const h = harness()
    const streamId = h.open('local:w')
    h.children[0].stdout.emit('data', bytes(256 * KiB))
    h.manager.ack('local:w', { bytes: 256 * KiB })
    h.manager.close('local:w', { streamId: 7 })
    expect(h.children[0].stdout.isPaused()).toBe(true)
    expect(h.closes()).toEqual([])
    expect(streamId).toBeTruthy()
  })

  it('an exec that fails after its stream closed closes it once', () => {
    const h = harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const streamId = h.open('local:w')
    h.manager.close('local:w', { streamId })
    h.children[0].emit('error', new Error('kill EPERM'))
    expect(h.closes()).toEqual([['local:w', streamId, 'closed']])
    expect(warn.mock.calls.flat().join(' ')).toContain('exec failed: kill EPERM')
  })

  it('a child that dies under a write to its stdin ends the stream only by its exit', () => {
    const h = harness()
    const streamId = h.open('local:w')
    h.children[0].stdin.emit('error', new Error('write EPIPE'))
    expect(h.closes()).toEqual([])
    h.children[0].exit(1, null)
    expect(h.closes()).toEqual([['local:w', streamId, 'agent']])
  })

  it('a frame request held for its pace is dropped when the stream closes', async () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('local:w')
    h.manager.input('local:w', streamId, new TextEncoder().encode('RFB 003.008\n'))
    h.manager.input('local:w', streamId, Uint8Array.of(1, 1))
    const update = Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 1, 0, 1)
    h.manager.input('local:w', streamId, update)
    // The second inside one frame of the first is held for the direct profile's 15 fps.
    h.manager.input('local:w', streamId, update)
    const write = vi.spyOn(h.children[0].stdin, 'write')
    h.manager.close('local:w', { streamId })
    await vi.advanceTimersByTimeAsync(1_000)
    // Its stdin is ended: a write would be a write after end.
    expect(write).not.toHaveBeenCalled()
  })

  it('a route or a lost route for no stream, and a route for a local stream, change nothing', () => {
    const h = harness()
    const local = h.open('local:w')
    h.manager.route('gone', 'relay')
    h.manager.routeLost('gone')
    h.manager.route(local, 'relay')
    h.children[0].stdout.emit('data', bytes(KiB))
    expect(h.sentBytes(local)).toBe(KiB)
    expect(h.closes()).toEqual([])
  })

  it('bytes waiting for their pace leave at once when the route turns out direct', () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('mac-2')
    h.children[0].stdout.emit('data', bytes(128 * KiB))
    expect(h.sentBytes(streamId)).toBe(0)
    h.manager.route(streamId, 'direct')
    expect(h.sentBytes(streamId)).toBe(128 * KiB)
  })

  it('a refused send while paced or while flushing closes the stream with reason backlog', async () => {
    vi.useFakeTimers()
    const h = harness()
    const paced = h.open('mac-2')
    const flushed = h.open('mac-3')
    h.children[0].stdout.emit('data', bytes(64 * KiB))
    h.children[1].stdout.emit('data', bytes(64 * KiB))
    h.failBinary()
    h.manager.route(flushed, 'direct')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.closes()).toEqual([['mac-3', flushed, 'backlog'], ['mac-2', paced, 'backlog']])
  })

  it('a refused send of bytes the pace lets through at once closes the stream with reason backlog', async () => {
    vi.useFakeTimers()
    const h = harness()
    const streamId = h.open('mac-2')
    // A full bucket: the first chunk leaves as it is read.
    await vi.advanceTimersByTimeAsync(1_000)
    h.failBinary()
    h.children[0].stdout.emit('data', bytes(256 * KiB))
    expect(h.binary).toHaveLength(1)
    expect(h.closes()).toEqual([['mac-2', streamId, 'backlog']])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.closes()).toEqual([['mac-2', streamId, 'backlog']])
  })
})

describe('closing a browser stream', () => {
  it('closeConnection kills every exec of that connection within one second', async () => {
    vi.useFakeTimers()
    const h = harness({ ignoresTerm: true })
    h.open('mac-2')
    h.open('mac-2')
    h.open('mac-3')
    h.manager.closeConnection('mac-2')
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(h.children[1].kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(h.children[0].kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(h.children[1].kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(h.children[2].kill).not.toHaveBeenCalled()
  })

  it('closeAgent sends agent_browser_close with reason agent and kills the children', () => {
    const h = harness()
    const first = h.open('local:w')
    const second = h.open('mac-2')
    const other = h.open('mac-3', 'a2')
    h.manager.closeAgent('a1')
    expect(h.closes()).toEqual([['local:w', first, 'agent'], ['mac-2', second, 'agent']])
    expect(h.children[0].kill).toHaveBeenCalled()
    expect(h.children[1].kill).toHaveBeenCalled()
    expect(h.children[2].kill).not.toHaveBeenCalled()
    expect(other).toBeTruthy()
  })

  it('child exit, agent stop and agent delete close with reason agent; a client\'s close closes with reason closed', () => {
    const h = harness()
    const exited = h.open('local:w')
    const stopped = h.open('mac-2', 'a2')
    const closed = h.open('mac-3')
    h.children[0].exit(1, null)
    h.manager.closeAgent('a2')
    h.manager.close('mac-2', { streamId: closed }) // not that connection's stream
    h.manager.close('mac-3', { streamId: closed })
    expect(h.closes()).toEqual([['local:w', exited, 'agent'], ['mac-2', stopped, 'agent'], ['mac-3', closed, 'closed']])
    // An exec that already exited is not killed.
    expect(h.children[0].kill).not.toHaveBeenCalled()
  })

  it('child exit sends agent_browser_close', () => {
    const h = harness()
    const streamId = h.open('mac-2')
    h.children[0].emit('error', new Error('spawn podman ENOENT'))
    h.children[0].emit('exit', null, null)
    expect(h.closes()).toEqual([['mac-2', streamId, 'agent']])
  })

  it('a stream whose direct link drops is closed with reason route, and is never moved to the relay', () => {
    const h = harness()
    const streamId = h.open('mac-2')
    h.manager.route(streamId, 'direct')
    h.manager.routeLost(streamId)
    h.children[0].stdout.emit('data', bytes(KiB))
    expect(h.closes()).toEqual([['mac-2', streamId, 'route']])
    expect(h.binary).toEqual([])
  })

  // Review Focus 5: a refused relay frame cannot name its stream, so every relayed one closes.
  it('a transport error closes every relayed browser stream with reason rate', () => {
    const h = harness()
    const relay = h.open('mac-2')
    const turn = h.open('mac-3')
    const direct = h.open('mac-4')
    const local = h.open('local:w')
    const unrouted = h.open('mac-2', 'a2')
    h.manager.route(relay, 'relay')
    h.manager.route(turn, 'turn')
    h.manager.route(direct, 'direct')
    h.manager.transportError()
    expect(h.closes()).toEqual([['mac-2', relay, 'rate'], ['mac-2', unrouted, 'rate']])
    expect(local && turn && direct).toBeTruthy()
  })
})
