/** The fixed gateway/devices endpoint. No core state, service RPC or terminal capability lives here. */
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { harnessdEnv } from '../harnessdEnv.js'
import { listenLocalSocket, pipeProofOf, socketPathIn } from '../localSocket.js'
import { socketIsPrivate } from '../localTransport.js'
import { readPrivateStateFile, secureStateDirectory } from '../secureState.js'
import { isPipePath, newPipePath, PIPE_PROOF_HEADER, pipeIdOf } from '../windows/pipeAuth.js'
import { pipeWebSocket } from '../windows/pipeClient.js'
import { DEVICE_PEER_DRAIN_MS, DEVICE_PEER_HANDSHAKE_MS, DEVICE_PEER_MESSAGE_BYTES, DEVICE_PEER_VERSION, type DevicePeerRole } from './peerProtocol.js'

export type DevicePeerFailure = 'PEER_AUTH_UNAVAILABLE' | 'PEER_ENDPOINT_INVALID' | 'PEER_AUTH_REFUSED'
  | 'PEER_CONNECTION_LIMIT' | 'PEER_DRAIN_DEADLINE' | 'PEER_PROTOCOL_INVALID' | 'PEER_UNAVAILABLE'
let inlineKey: Buffer | undefined

/** Inline construction must say so explicitly; a missing master credential never enables a fallback. */
export function devicePeerKey(composition: 'inline' | 'services', env: NodeJS.ProcessEnv = harnessdEnv()): Buffer | null {
  const token = env.HARNESSD_SERVICE_TOKEN
  if (token !== undefined) return Buffer.byteLength(token) >= 32 ? createHmac('sha256', token).update('harness.device-peer.v1').digest() : null
  if (composition !== 'inline' || env.HARNESSD_SUPERVISED === '1'
    || (env.HARNESSD_SERVICES !== undefined && env.HARNESSD_SERVICES !== 'none')
    || (env.HARNESSD_SERVICE_PROCESSES !== undefined && env.HARNESSD_SERVICE_PROCESSES !== '')) return null
  return Buffer.from(inlineKey ??= randomBytes(32))
}

export interface DevicePeerEndpoint { version: number; endpoint: string; epoch: string }
export function devicePeerRecord(dataDir: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PEER_ENDPOINT_INVALID')
  return join(dataDir, `gateway-device-${port}.json`)
}

function sameFile(path: string, owned: Stats): boolean {
  try { const current = lstatSync(path); return current.dev === owned.dev && current.ino === owned.ino } catch { return false }
}
function removeOwned(path: string, owned: Stats): void { if (sameFile(path, owned)) try { unlinkSync(path) } catch { /* already gone */ } }

/** The record is disposable metadata, bounded before parsing, and never chooses an arbitrary endpoint. */
export function readDevicePeerEndpoint(dataDir: string, port: number): DevicePeerEndpoint | null {
  try {
    const record: unknown = JSON.parse(readPrivateStateFile(devicePeerRecord(dataDir, port), 4096))
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null
    const value = record as Record<string, unknown>
    if (Object.keys(value).length !== 3 || value.version !== DEVICE_PEER_VERSION
      || typeof value.epoch !== 'string' || !/^[0-9a-f]{32}$/.test(value.epoch) || typeof value.endpoint !== 'string') return null
    const expected = process.platform === 'win32' ? `\\\\.\\pipe\\harness-${value.epoch}` : socketPathIn(dataDir, `harness-${value.epoch}`)
    if (value.endpoint !== expected || !isPipePath(value.endpoint)
      || (process.platform !== 'win32' && !socketIsPrivate(value.endpoint))) return null
    return value as unknown as DevicePeerEndpoint
  } catch { return null }
}

export function connectDevicePeer(options: {
  dataDir: string; port: number; key: Buffer | null; role: DevicePeerRole
  failed(code: DevicePeerFailure): void
}): { socket: WebSocket; epoch: string } | null {
  if (!options.key) { options.failed('PEER_AUTH_UNAVAILABLE'); return null }
  const record = readDevicePeerEndpoint(options.dataDir, options.port)
  if (!record) { options.failed('PEER_ENDPOINT_INVALID'); return null }
  const socket = pipeWebSocket({ pipe: record.endpoint, token: Buffer.from(options.key) }, `/device-peer/v${DEVICE_PEER_VERSION}/${options.role}`, {
    maxPayload: DEVICE_PEER_MESSAGE_BYTES, handshakeTimeout: DEVICE_PEER_HANDSHAKE_MS,
  })
  return { socket, epoch: record.epoch }
}

export interface OpenDevicePeerOptions {
  dataDir: string
  port: number
  key: Buffer | null
  /** Captured gateway instance; a construction that finishes after replacement has no authority to publish. */
  current(): boolean
  connected(role: DevicePeerRole, socket: WebSocket, epoch: string): void
  failed(code: DevicePeerFailure): void
  /** Controlled publication races in tests; production publishes synchronously. */
  publish?: (record: DevicePeerEndpoint, write: () => void) => Promise<void>
}

export async function openDevicePeerEndpoint(options: OpenDevicePeerOptions): Promise<{ epoch: string; close(): Promise<void> } | null> {
  if (!options.key) { options.failed('PEER_AUTH_UNAVAILABLE'); return null }
  const key = Buffer.from(options.key)
  let endpoint: string, record: string
  try {
    secureStateDirectory(options.dataDir)
    record = devicePeerRecord(options.dataDir, options.port)
    const name = newPipePath()
    endpoint = process.platform === 'win32' ? name : socketPathIn(options.dataDir, `harness-${pipeIdOf(name)}`) ?? ''
    if (!endpoint) throw new Error('PEER_ENDPOINT_INVALID')
    if (process.platform !== 'win32') secureStateDirectory(dirname(endpoint))
  } catch { options.failed('PEER_ENDPOINT_INVALID'); return null }
  const epoch = pipeIdOf(endpoint)!
  const listener = await listenLocalSocket((_req, res) => { res.writeHead(404).end() }, endpoint, { token: key })
    .catch(() => { options.failed('PEER_UNAVAILABLE'); return null })
  if (!listener) return null
  let socketFile: Stats | undefined, recordFile: Stats | undefined
  const removeFiles = (): void => {
    if (recordFile) removeOwned(record, recordFile)
    if (socketFile) removeOwned(endpoint, socketFile)
  }
  const server = new WebSocketServer({ noServer: true, maxPayload: DEVICE_PEER_MESSAGE_BYTES, perMessageDeflate: false })
  const active = new Map<DevicePeerRole, WebSocket>()
  const physical = new Map<WebSocket, Promise<void>>()
  let stopped = false, closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    stopped = true
    listener.closeSync()
    const drained = Promise.all(physical.values()).then(() => { server.close(); removeFiles() })
    for (const peer of physical.keys()) peer.terminate()
    let deadline: NodeJS.Timeout | undefined
    await Promise.race([drained, new Promise<void>(resolve => {
      deadline = setTimeout(() => { options.failed('PEER_DRAIN_DEADLINE'); resolve() }, DEVICE_PEER_DRAIN_MS).unref()
    })])
    if (deadline) clearTimeout(deadline)
  })()
  server.on('headers', (headers, req) => { headers.push(`${PIPE_PROOF_HEADER}: ${pipeProofOf(req)}`) })
  // Bound even unauthenticated sockets and slow HTTP headers. Upgraded peers have their own drain owner below.
  listener.server.maxConnections = 16
  listener.server.requestTimeout = DEVICE_PEER_HANDSHAKE_MS
  listener.server.headersTimeout = DEVICE_PEER_HANDSHAKE_MS
  listener.server.on('connection', socket => { socket.setTimeout(DEVICE_PEER_HANDSHAKE_MS, () => socket.destroy()) })
  listener.server.on('upgrade', (req, socket, head) => {
    if (socket.destroyed || !pipeProofOf(req)) { options.failed('PEER_AUTH_REFUSED'); socket.destroy(); return }
    const role = req.url === `/device-peer/v${DEVICE_PEER_VERSION}/devices` ? 'devices'
      : req.url === `/device-peer/v${DEVICE_PEER_VERSION}/recaps` ? 'recaps' : null
    if (stopped || !options.current() || !role || physical.size >= 4) {
      options.failed(physical.size >= 4 ? 'PEER_CONNECTION_LIMIT' : 'PEER_PROTOCOL_INVALID'); socket.destroy(); return
    }
    server.handleUpgrade(req, socket, head, peer => {
      // HTTP's idle deadline must not poll or close an otherwise idle component link.
      req.socket.setTimeout(0)
      const previous = active.get(role)
      active.set(role, peer)
      physical.set(peer, new Promise<void>(resolve => {
        peer.once('close', () => {
          physical.delete(peer)
          if (active.get(role) === peer) active.delete(role)
          resolve()
        })
      }))
      peer.on('error', () => { options.failed('PEER_UNAVAILABLE') })
      previous?.terminate()
      // Endpoint ownership survives reconnect; reply authority does not. Each accepted peer gets a new epoch.
      try { options.connected(role, peer, randomBytes(16).toString('hex')) } catch { options.failed('PEER_UNAVAILABLE'); peer.terminate() }
    })
  })
  try {
    if (process.platform !== 'win32') { socketFile = lstatSync(endpoint); chmodSync(endpoint, 0o600) }
    if (!options.current()) { await close(); options.failed('PEER_UNAVAILABLE'); return null }
    const value = { version: DEVICE_PEER_VERSION, endpoint, epoch }
    const publish = (): void => {
      if (!options.current() || stopped) throw new Error('PEER_UNAVAILABLE')
      const staging = `${record}.${epoch}`
      let staged: Stats | undefined
      try {
        writeFileSync(staging, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
        staged = lstatSync(staging)
        renameSync(staging, record)
        recordFile = lstatSync(record)
      } finally { if (staged) removeOwned(staging, staged) }
    }
    if (options.publish) await options.publish(value, publish)
    else publish()
    if (!options.current()) { await close(); options.failed('PEER_UNAVAILABLE'); return null }
  } catch {
    await close()
    options.failed('PEER_ENDPOINT_INVALID')
    return null
  }
  return { epoch, close }
}
