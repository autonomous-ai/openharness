/**
 * A client that speaks to the daemon exactly as the desktop app does: the local WebSocket over the
 * daemon's Unix socket (or its loopback port), `machine_select`, request frames answered by
 * `<type>_result`, the event stream in between, and the terminals' binary frames beside it.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { decodeTerminalLocal, encodeTerminalLocal, type TerminalBinaryClear } from '../../src/lib/terminalBinary.js'
import type { IsolatedDaemon } from './daemon.js'

export type Frame = { type: string; payload?: Record<string, any>; [key: string]: unknown }

export class LocalClient {
  readonly frames: Frame[] = []
  /** The terminals' binary frames (keyframes, output, sync), in the order they came. */
  readonly binaries: TerminalBinaryClear[] = []
  private waiters: Array<{ test: (frame: Frame) => boolean; done: (frame: Frame) => void }> = []
  private binaryWaiters: Array<{ test: (frame: TerminalBinaryClear) => boolean; done: (frame: TerminalBinaryClear) => void }> = []
  closed = false
  closeCode: number | null = null

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw, binary) => {
      if (binary) {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)
        const frame = decodeTerminalLocal(new Uint8Array(bytes))
        if (!frame) return
        this.binaries.push(frame)
        for (const waiter of [...this.binaryWaiters]) {
          if (waiter.test(frame)) { this.binaryWaiters.splice(this.binaryWaiters.indexOf(waiter), 1); waiter.done(frame) }
        }
        return
      }
      let frame: Frame
      try { frame = JSON.parse(raw.toString()) as Frame } catch { return }
      this.frames.push(frame)
      for (const waiter of [...this.waiters]) {
        if (waiter.test(frame)) { this.waiters.splice(this.waiters.indexOf(waiter), 1); waiter.done(frame) }
      }
    })
    ws.on('close', (code) => { this.closed = true; this.closeCode = code })
  }

  static async connect(daemon: IsolatedDaemon, options: { tcp?: boolean; tool?: boolean } = {}): Promise<LocalClient> {
    const url = options.tcp
      ? `ws://127.0.0.1:${daemon.port}/api/local-ws`
      : `ws+unix://${daemon.socketPath}:/api/local-ws`
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })
    const client = new LocalClient(ws)
    client.send('machine_select', { machineId: daemon.computerId, localProtocolVersion: 1, ...(options.tool ? { tool: true } : {}) })
    await client.waitFor((frame) => frame.type === 'connected', 10_000, 'connected')
    return client
  }

  send(type: string, payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ type, payload }))
  }

  /** A terminal frame in the loopback wire format, as the desktop sends keystrokes and pastes. */
  sendBinary(frame: TerminalBinaryClear): void {
    const bytes = encodeTerminalLocal(frame)
    if (!bytes) throw new Error(`a terminal frame that cannot be encoded: ${JSON.stringify({ ...frame, bytes: frame.bytes.length })}`)
    this.ws.send(bytes, { binary: true })
  }

  /** Raw bytes on the socket, valid or not: what a broken or hostile client sends. */
  sendRaw(bytes: Uint8Array, binary: boolean): void {
    this.ws.send(bytes, { binary })
  }

  /** Resolves with the first binary frame, past or future, that passes `test`. */
  waitForBinary(test: (frame: TerminalBinaryClear) => boolean, ms = 20_000, what = 'a terminal frame', since = 0): Promise<TerminalBinaryClear> {
    const seen = this.binaries.slice(since).find(test)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.binaryWaiters = this.binaryWaiters.filter((waiter) => waiter.done !== done)
        reject(new Error(`timed out after ${ms}ms waiting for ${what}; ${this.binaries.length} terminal frames so far`))
      }, ms)
      const done = (frame: TerminalBinaryClear) => { clearTimeout(timer); resolve(frame) }
      this.binaryWaiters.push({ test, done })
    })
  }

  /** Resolves with the first frame, past or future, that passes `test`. */
  waitFor(test: (frame: Frame) => boolean, ms = 20_000, what = 'a frame', since = 0): Promise<Frame> {
    const seen = this.frames.slice(since).find(test)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.done !== done)
        reject(new Error(`timed out after ${ms}ms waiting for ${what}; last frames: ${JSON.stringify(this.frames.slice(-8).map((f) => f.type))}`))
      }, ms)
      const done = (frame: Frame) => { clearTimeout(timer); resolve(frame) }
      this.waiters.push({ test, done })
    })
  }

  /** Only frames that arrive after this call. */
  next(test: (frame: Frame) => boolean, ms = 20_000, what = 'a frame'): Promise<Frame> {
    return this.waitFor(test, ms, what, this.frames.length)
  }

  async request<T = Record<string, any>>(type: string, payload: Record<string, unknown> = {}, ms = 30_000): Promise<T> {
    const requestId = randomUUID()
    const answer = this.next((frame) => frame.type === `${type}_result` && frame.payload?.requestId === requestId, ms, `${type}_result`)
    this.send(type, { requestId, ...payload })
    return (await answer).payload as T
  }

  close(): void {
    try { this.ws.close() } catch { /* already closed */ }
  }
}
