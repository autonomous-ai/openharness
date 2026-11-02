/**
 * How a Store package reaches the Harness daemon on this computer: its Unix socket, owner only, and on macOS and Linux only that. Any
 * account can bind the daemon's TCP port while the daemon restarts, and would hear whatever is sent to it (audit H1). With the socket
 * gone the daemon is down, and the caller says so. TCP remains where a socket cannot be: Windows, or a data folder too long for one.
 *
 * One file, the same in every package that talks to the daemon, and in store/tools: a package stands alone and has no dependencies
 * (store/tools/port-holder.test.mjs pins the copies). The rules are the CLI's: cli/src/lib/localSocket.ts.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** sockaddr_un has 104 bytes on macOS, and the daemon creates the socket under a name 4 bytes longer. */
const MAX_SOCKET_PATH_BYTES = 96
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** Far above any answer a package reads: it only stops a runaway peer. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
const CLOSE_WAIT_MS = 2000

export function daemonDataDir(env = process.env) {
  return env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data')
}

/**
 * The daemon's socket for `port`: in its data folder, or where that path is too long for a socket, in a 0700 folder under the home folder
 * named by the folder's hash (the CLI's `socketPathIn`). Null where it can have none: Windows, or a home too long as well.
 */
export function daemonSocketPath(port, env = process.env, platform = process.platform) {
  if (platform === 'win32') return null
  const folder = daemonDataDir(env), name = `daemon-${port}.sock`, beside = join(folder, name)
  if (Buffer.byteLength(beside) <= MAX_SOCKET_PATH_BYTES) return beside
  const hash = createHash('sha256').update(folder).digest('hex').slice(0, 16)
  const short = join(env.HOME || homedir(), '.harness', 's', hash, name)
  return Buffer.byteLength(short) <= MAX_SOCKET_PATH_BYTES ? short : null
}

/** Whether `path` is the daemon's: a socket of this account's, owner only, in a real folder nobody else can write to. */
export function socketIsPrivate(path) {
  const uid = process.getuid?.()
  try {
    const folder = lstatSync(join(path, '..')), file = lstatSync(path)
    return folder.isDirectory() && (folder.mode & 0o022) === 0 && file.isSocket() && (file.mode & 0o077) === 0
      && (uid === undefined || (folder.uid === uid && file.uid === uid))
  } catch {
    return false
  }
}

const portOf = (url) => Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)

/** One client frame: clients mask (RFC 6455 5.3). */
function frame(opcode, payload) {
  const size = payload.length
  const head = size < 126 ? Buffer.from([0x80 | opcode, 0x80 | size])
    : size < 65_536 ? Buffer.from([0x80 | opcode, 0x80 | 126, size >> 8, size & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(size)); return b })()])
  const mask = randomBytes(4), masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([head, mask, masked])
}

class SocketEvent extends Event {
  constructor(type, fields) { super(type); Object.assign(this, fields) }
}

/** The WebSocket client these packages use, over the daemon's socket: open, message (text), error, close, send, close. */
class UnixWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readyState = 0
  #asked = null; #stream = null; #closed = false; #held = Buffer.alloc(0); #parts = []; #size = 0; #timer = null

  constructor(path, resource) {
    super()
    // Told after this returns, as a WebSocket always is: the caller adds its listeners first.
    if (!socketIsPrivate(path)) { queueMicrotask(() => this.#end(1006, new Error('The Harness socket is missing or not private.'))); return }
    const key = randomBytes(16).toString('base64')
    const asked = this.#asked = request({ socketPath: path, path: resource, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } })
    asked.on('error', (error) => this.#end(1006, error))
    asked.on('response', (answer) => { answer.resume(); this.#end(1006, new Error(`The daemon answered ${answer.statusCode}.`)) })
    asked.on('upgrade', (answer, stream, head) => {
      // Given up on while it was on its way: the caller has been told, so it never comes back to life.
      if (this.#closed) { stream.destroy(); return }
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
      if (answer.headers['sec-websocket-accept'] !== accept) { stream.destroy(); this.#end(1006, new Error('The daemon answered no WebSocket.')); return }
      this.#stream = stream
      this.readyState = 1
      stream.on('data', (chunk) => this.#read(chunk))
      stream.on('error', (error) => this.#end(1006, error))
      stream.on('close', () => this.#end(1006))
      this.dispatchEvent(new SocketEvent('open'))
      if (head.length) this.#read(head)
    })
    asked.end()
  }

  send(text) {
    if (this.readyState !== 1) throw new Error('The Harness connection is not open.')
    this.#stream.write(frame(1, Buffer.from(String(text))))
  }

  close(code = 1000) {
    if (this.readyState !== 1) { if (this.readyState === 0) this.#end(1006); return }
    this.readyState = 2
    const body = Buffer.alloc(2); body.writeUInt16BE(code)
    this.#stream.write(frame(8, body))
    // A peer that never answers must not hold this process.
    this.#timer = setTimeout(() => this.#stream.destroy(), CLOSE_WAIT_MS)
    this.#timer.unref?.()
  }

  #end(code, error) {
    if (this.#closed) return
    this.#closed = true
    this.readyState = 3
    clearTimeout(this.#timer)
    // A request still waiting holds the process and could open after the caller was told it failed.
    this.#asked?.destroy()
    this.#stream?.destroy()
    if (error) this.dispatchEvent(new SocketEvent('error', { error, message: error.message }))
    this.dispatchEvent(new SocketEvent('close', { code, reason: '', wasClean: code !== 1006 }))
  }

  #read(chunk) {
    this.#held = this.#held.length ? Buffer.concat([this.#held, chunk]) : chunk
    while (!this.#closed) {
      const taken = this.#next()
      if (taken === 0) return
      this.#held = this.#held.subarray(taken)
    }
  }

  /** One whole server frame off the held bytes; how many bytes it took, or 0 until more come. */
  #next() {
    const held = this.#held
    if (held.length < 2) return 0
    const fin = (held[0] & 0x80) !== 0, opcode = held[0] & 0x0f, short = held[1] & 0x7f
    // A server never masks, and these packages negotiate no extension (RFC 6455 5.1, 5.2).
    if ((held[1] & 0x80) !== 0 || (held[0] & 0x70) !== 0) { this.#fail(1002); return 0 }
    const start = short === 126 ? 4 : short === 127 ? 10 : 2
    if (held.length < start) return 0
    const big = short === 127 ? held.readBigUInt64BE(2) : BigInt(short === 126 ? held.readUInt16BE(2) : short)
    if (big > BigInt(MAX_MESSAGE_BYTES)) { this.#fail(1009); return 0 }
    const size = Number(big)
    if (held.length < start + size) return 0
    const payload = held.subarray(start, start + size)
    if (opcode === 9) this.#stream.write(frame(10, payload))
    else if (opcode === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      if (this.readyState === 1) { this.readyState = 2; this.#stream.write(frame(8, payload.subarray(0, 2))) }
      this.#end(code)
    } else if (opcode === 0 || opcode === 1 || opcode === 2) {
      this.#size += size
      if (this.#size > MAX_MESSAGE_BYTES) { this.#fail(1009); return 0 }
      this.#parts.push(Buffer.from(payload))
      if (fin) {
        const data = Buffer.concat(this.#parts)
        this.#parts = []; this.#size = 0
        this.dispatchEvent(new SocketEvent('message', { data: data.toString('utf8') }))
      }
    }
    return start + size
  }

  #fail(code) {
    const body = Buffer.alloc(2); body.writeUInt16BE(code)
    this.#stream.write(frame(8, body))
    this.#end(code)
  }
}

/**
 * What a package opens to the daemon's `/api/local-ws`: `new DaemonWebSocket(url, { headers, env })`, over the socket where one can be.
 * Elsewhere Node's own WebSocket on `url`, with the headers given.
 */
export class DaemonWebSocket {
  constructor(url, { headers = {}, env = process.env } = {}) {
    const parsed = new URL(url)
    const path = daemonSocketPath(portOf(parsed), env)
    return path ? new UnixWebSocket(path, parsed.pathname) : new globalThis.WebSocket(url, { headers })
  }
}

/** `fetch` for the daemon's REST API at `url`, over its socket where one can be. Answers `status`, `ok`, `json()` and `text()`. */
export function daemonFetch(url, { method = 'GET', headers = {}, body, signal, env = process.env } = {}) {
  const parsed = new URL(url)
  const path = daemonSocketPath(portOf(parsed), env)
  if (!path) return fetch(url, { method, headers, ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}) })
  return new Promise((resolve, reject) => {
    if (!socketIsPrivate(path)) { reject(new Error('The Harness socket is missing or not private.')); return }
    const payload = body === undefined ? null : Buffer.from(body)
    const asked = request({ socketPath: path, method, path: `${parsed.pathname}${parsed.search}`, ...(signal ? { signal } : {}),
      headers: { ...headers, ...(payload ? { 'content-length': String(payload.length) } : {}) } }, (answer) => {
      const parts = []
      answer.on('data', (part) => parts.push(part))
      answer.on('error', reject)
      answer.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8'), status = answer.statusCode ?? 502
        resolve({ status, ok: status >= 200 && status < 300, text: async () => text, json: async () => JSON.parse(text) })
      })
    })
    // As fetch rejects: the signal's own reason, so a caller can tell a timeout from a daemon that is down.
    asked.on('error', (error) => reject(signal?.aborted ? signal.reason : error))
    asked.end(payload ?? undefined)
  })
}
