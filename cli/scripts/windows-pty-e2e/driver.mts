// Windows PTY E2E driver (docs/testing/windows-pty-e2e.md): runs ON the Windows machine against its daemon's
// loopback WebSocket, so no account is needed. Bundled by build.sh into one .mjs.
import { randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { localCredentialHeaders } from '../../src/lib/localCredential.ts'
import { encodeTerminalLocal, decodeTerminalLocal, TerminalBinaryKind } from '../../src/lib/terminalBinary.ts'

export const ts = () => new Date().toISOString().slice(11, 23)
export const log = (m: string) => console.log(`${ts()} ${m}`)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The machine id the daemon serves, picked as the CLI's own clients pick it (src/agentClient/daemon.ts): a signed-in
 * core serves under its account's machine id, from the sign-in, and only a signed-out one under this computer's id.
 * Sending the computer id to a signed-in daemon closed the socket with NO_PEER_LINK (the B4 install, 2026-10-17).
 */
export function machineId(): string {
  // E2E_MACHINE_ID first: the caller names the machine (docs/testing/windows-cli-e2e.md, a second Windows user).
  if (process.env.E2E_MACHINE_ID) return process.env.E2E_MACHINE_ID
  const auth = process.env.HARNESS_AUTH_DIR?.trim() || join(homedir(), '.harness', 'auth')
  try {
    const signedIn = JSON.parse(readFileSync(join(auth, 'session.json'), 'utf8')).machineId
    if (typeof signedIn === 'string' && signedIn) return signedIn
  } catch { /* not signed in: the computer id below */ }
  return readFileSync(process.env.ADAPTER_COMPUTER_ID_FILE ?? join(homedir(), '.harness', 'computer-id'), 'utf8').trim()
}

/** Keyframe → plain screen text: each row's `ESC[n;1H` becomes a newline, every other escape goes. */
export function screenText(bytes: string): string {
  return bytes
    .replace(/\u001b\[\d+;1H/g, '\n')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?<=>]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[()][0-9A-Za-z]/g, '')
    .replace(/\u001b[=>c78]/g, '')
}

export interface Stream {
  streamId: string
  agentId: string
  output: string
  keyframes: Array<{ at: number; text: string; cols?: number; rows?: number }>
  seq: number
  resizeSeq: number
}

export class Client {
  ws!: WebSocket
  frames: Array<Record<string, any>> = []
  waiters: Array<{ test: (f: Record<string, any>) => boolean; resolve: (f: Record<string, any>) => void }> = []
  streams = new Map<string, Stream>()
  closed = false
  timer?: NodeJS.Timeout

  async connect(url = `ws://127.0.0.1:${process.env.E2E_PORT ?? '18473'}/api/local-ws`): Promise<this> {
    const dataDir = process.env.ADAPTER_DATA_DIR?.trim() || join(homedir(), '.harness', 'cli', 'data')
    this.ws = new WebSocket(url, { headers: localCredentialHeaders(dataDir) })
    this.ws.binaryType = 'arraybuffer'
    this.ws.onclose = (e) => { this.closed = true; if (process.env.E2E_VERBOSE) log(`ws closed ${e.code} ${e.reason}`) }
    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const f = decodeTerminalLocal(new Uint8Array(e.data as ArrayBuffer))
        if (!f) return
        const s = this.streams.get(f.streamId)
        if (!s) return
        if (f.kind === TerminalBinaryKind.output || f.kind === TerminalBinaryKind.keyframe) {
          const text = (f.compressed ? inflateSync(Buffer.from(f.bytes)) : Buffer.from(f.bytes)).toString('utf8')
          if (f.kind === TerminalBinaryKind.keyframe) s.keyframes.push({ at: Date.now(), text, cols: f.cols, rows: f.rows })
          else s.output += text
          this.send('terminal_ack', { streamId: f.streamId, lastSeq: f.seq })
        }
        return
      }
      const f = JSON.parse(e.data) as Record<string, any>
      this.frames.push(f)
      if (f.type === 'terminal_error' && process.env.E2E_VERBOSE) log(`terminal_error ${JSON.stringify(f.payload)}`)
      for (const w of [...this.waiters]) if (w.test(f)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(f) }
    }
    await new Promise<void>((resolve, reject) => { this.ws.onopen = () => resolve(); this.ws.onerror = () => reject(new Error('ws error')) })
    this.send('machine_select', { machineId: machineId(), localProtocolVersion: 1 })
    await this.waitFor((f) => f.type === 'connected', 15_000, 'connected')
    this.timer = setInterval(() => { for (const s of this.streams.values()) this.send('terminal_alive', { streamId: s.streamId }) }, 10_000)
    return this
  }

  send(type: string, payload: Record<string, unknown>) { this.ws.send(JSON.stringify({ type, payload })) }

  waitFor(test: (f: Record<string, any>) => boolean, ms = 20_000, what = 'frame'): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const hit = this.frames.find(test)
      if (hit) return resolve(hit)
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), ms)
      this.waiters.push({ test, resolve: (f) => { clearTimeout(t); resolve(f) } })
    })
  }

  async rpc(type: string, payload: Record<string, unknown> = {}, ms = 60_000): Promise<Record<string, any>> {
    const requestId = randomUUID()
    this.send(type, { requestId, ...payload })
    const r = await this.waitFor((f) => f.type === `${type}_result` && f.payload?.requestId === requestId, ms, `${type}_result`)
    return r.payload as Record<string, any>
  }

  async list(includeStopped = true): Promise<any[]> {
    return (await this.rpc('agents_list', { includeStopped })).agents as any[]
  }

  async row(agentId: string): Promise<any | undefined> {
    return (await this.list()).find((a) => a.id === agentId)
  }

  async poll<T>(what: string, ms: number, probe: () => Promise<T | undefined | null | false>): Promise<T> {
    const until = Date.now() + ms
    let last: unknown
    while (Date.now() < until) {
      try { const v = await probe(); if (v) return v; last = v } catch (e) { last = e }
      await sleep(1000)
    }
    throw new Error(`timeout (${ms} ms): ${what}; last=${JSON.stringify(last)}`)
  }

  async open(agentId: string, cols = 120, rows = 40, options: { passive?: boolean } = {}): Promise<Stream> {
    const requestId = randomUUID()
    this.send('terminal_open', {
      requestId, agentId, cols, rows, protocolVersion: 3,
      ...(options.passive ? { takeover: false, watch: true } : {}),
    })
    const ready = await this.waitFor((f) => (f.type === 'terminal_ready' || f.type === 'terminal_error') && f.payload?.requestId === requestId, 20_000, 'terminal_ready')
    if (ready.type === 'terminal_error') throw new Error(`terminal_open → ${JSON.stringify(ready.payload)}`)
    const s: Stream = { streamId: ready.payload.streamId, agentId, output: '', keyframes: [], seq: -1, resizeSeq: 0 }
    this.streams.set(s.streamId, s)
    return s
  }

  input(s: Stream, text: string | Buffer) {
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.input, streamId: s.streamId, seq: ++s.seq, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), compressed: false })
    if (!frame) throw new Error('could not encode input')
    this.ws.send(frame)
  }

  paste(s: Stream, text: string) {
    const frame = encodeTerminalLocal({ kind: TerminalBinaryKind.paste, streamId: s.streamId, seq: 0, bytes: Buffer.from(text, 'utf8'), compressed: false })
    if (!frame) throw new Error('could not encode paste')
    this.ws.send(frame)
  }

  /** Types [text] a few characters at a time, as a person would. */
  async typeSlow(s: Stream, text: string, chunk = 8, gap = 20) {
    for (let i = 0; i < text.length; i += chunk) { this.input(s, text.slice(i, i + chunk)); await sleep(gap) }
  }

  async resize(s: Stream, cols: number, rows: number) {
    const before = s.keyframes.length
    this.send('terminal_resize', { streamId: s.streamId, resizeSeq: ++s.resizeSeq, cols, rows })
    await this.poll('resize keyframe', 15_000, async () => s.keyframes.length > before)
    return s.keyframes[s.keyframes.length - 1]
  }

  /** A fresh keyframe of the pane, as plain text. */
  async screen(s: Stream): Promise<string> {
    const before = s.keyframes.length
    this.send('terminal_resync', { streamId: s.streamId, attempt: 1 })
    await this.poll('resync keyframe', 15_000, async () => s.keyframes.length > before)
    return screenText(s.keyframes[s.keyframes.length - 1].text)
  }

  async waitScreen(s: Stream, what: string, ms: number, test: (text: string) => boolean): Promise<string> {
    let last = ''
    try {
      return await this.poll(what, ms, async () => { last = await this.screen(s); return test(last) ? last : undefined })
    } catch (e) {
      throw new Error(`${(e as Error).message}\n--- last screen ---\n${last.split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`)
    }
  }

  close(s: Stream) {
    this.send('terminal_close', { streamId: s.streamId })
    this.streams.delete(s.streamId)
  }

  end() {
    if (this.timer) clearInterval(this.timer)
    try { this.ws.close() } catch { /* gone */ }
  }
}

export function tail(text: string, n = 15): string {
  return text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l).slice(-n).join('\n')
}
