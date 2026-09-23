// Opt-in benchmark adapter. Uses production transport in its own process/pool;
// never changes the installed daemon, saved trust, authentication, or routing.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import type { AuthSessionManager } from '../src/lib/authSession.js'
import type { MachinePeer, MachinePeerStore } from '../src/lib/e2ee/machinePeers.js'
import type { RemoteRelayPool, RelaySession } from '../src/lib/remoteRelay.js'
import { decodeTerminalLocal } from '../src/lib/terminalBinary.js'

export type BenchmarkRoute = 'p2p' | 'turn' | 'relay'
type Counts = { p2p: number; relay: number }
type Candidate = { type: string; protocol: string }
export type RouteSnapshot = {
  route: BenchmarkRoute | 'unknown'; ready: boolean; migrating: boolean;
  pair: { local: Candidate; remote: Candidate } | null;
  sent: Counts; received: Counts;
}

// Never retain SDP, addresses, ports, keys, or ICE credentials in an artifact.
export function candidateSummary(sdp: string | undefined): Candidate | null {
  const parts = sdp?.trim().split(/\s+/) ?? []
  const type = parts[parts.indexOf('typ') + 1]
  const protocol = parts[2]?.toLowerCase()
  if (!['host', 'srflx', 'prflx', 'relay'].includes(type) || !['udp', 'tcp'].includes(protocol)) return null
  return { type, protocol }
}

export function verifiedRoute(onDataChannel: boolean, ready: boolean, migrating: boolean,
  pair: RouteSnapshot['pair']): RouteSnapshot['route'] {
  if (migrating) return 'unknown'
  if (!onDataChannel) return 'relay'
  if (!ready || !pair) return 'unknown'
  return pair.local.type === 'relay' || pair.remote.type === 'relay' ? 'turn' : 'p2p'
}

export function verifyExchange(route: BenchmarkRoute, before: RouteSnapshot, after: RouteSnapshot): boolean {
  const wire = route === 'relay' ? 'relay' : 'p2p'
  const other = wire === 'relay' ? 'p2p' : 'relay'
  return before.route === route && after.route === route
    && JSON.stringify(before.pair) === JSON.stringify(after.pair)
    && after.sent[wire] - before.sent[wire] === 1
    && after.received[wire] > before.received[wire]
    && after.sent[other] === before.sent[other]
    && after.received[other] === before.received[other]
}

// These deliberately read the pinned werift/production implementation, rather
// than adding a product diagnostics API just for a benchmark. Missing internals
// fail closed. Revalidate against changes to RemoteRelayPool/werift.
type InspectedEntry = {
  ws: WebSocket;
  p2p: any;
  p2pStreams: Set<string>;
  streams: Set<string>;
  p2pMigrating: Map<string, number>;
  p2pPolicy: { turn?: { urls: string[] } } | null;
}
type InspectedPool = {
  entries: Map<string, InspectedEntry>;
  handleP2pData: (...args: any[]) => void;
  startP2p: (machineId: string, entry: InspectedEntry) => void;
}

export async function createBenchmarkRoute(machineId: string, route: BenchmarkRoute) {
  // env.ts has legacy adoption at import time. Refuse a non-established install
  // and use an explicit scratch directory to bypass the remaining migrations.
  if (!existsSync(join(homedir(), '.harness', 'computer-id'))) throw new Error('Established Harness computer identity required')
  const stateDir = process.env.ADAPTER_DATA_DIR || join(homedir(), '.harness', 'cli', 'data')
  const rawIdentity = JSON.parse(readFileSync(join(stateDir, 'e2e', 'identity.json'), 'utf8'))
  const identity = { priv: Buffer.from(rawIdentity.priv, 'base64'), pub: Buffer.from(rawIdentity.pub, 'base64') }
  if (identity.priv.length !== 32 || identity.pub.length !== 32) throw new Error('Invalid existing identity')
  const savedPeers = JSON.parse(readFileSync(join(stateDir, 'e2e', 'machinePeers.json'), 'utf8')) as MachinePeer[]
  const pin = savedPeers.find((peer) => peer.machineId === machineId)
  if (!pin || Buffer.from(pin.pub, 'base64').length !== 32) throw new Error('Requested machine is not linked')
  const peers = new Map([[machineId, pin]])
  const scratch = mkdtempSync(join(tmpdir(), 'harness-route-'))
  process.env.ADAPTER_DATA_DIR = scratch
  process.env.TERMINAL_P2P_FORCE_RELAY = route === 'turn' ? 'true' : 'false'
  let pool: RemoteRelayPool | undefined
  let server: WebSocketServer | undefined
  try {
    const { readAuthSession } = await import('../src/lib/authSession.js')
    const { RemoteRelayPool: Pool } = await import('../src/lib/remoteRelay.js')
    const { env } = await import('../src/config/env.js')
    const authSession = readAuthSession()
    if (!authSession) throw new Error('Existing Harness login required')
    const autonomousEnv = authSession.autonomousEnv
    // Normal credential consumption, read-only. Let the running daemon own
    // refreshes; this probe cannot rotate a token or clear a user's login.
    const auth = { accessToken: async () => {
      const current = readAuthSession()
      if (!current || current.autonomousEnv !== autonomousEnv) throw new Error('Harness login changed')
      if (current.expiresAt && current.expiresAt <= Date.now()) throw new Error('Access token expired; retry after daemon refresh')
      return current.accessToken
    } } as AuthSessionManager
    const trust = { get: (id: string) => peers.get(id) ?? null, unlink: (id: string) => peers.delete(id) } as MachinePeerStore
    pool = new Pool(auth, env.BACKEND_WS_URL.replace(/\/$/, ''), identity, trust, { p2p: route !== 'relay' })
    const inspected = pool as unknown as InspectedPool
    if (route === 'p2p') {
      // Restrict only this benchmark connection's offer policy. Without this,
      // ICE can nominate a working TURN pair before checking a direct pair.
      // The responder obtains its TURN credentials from the same offer.
      const startP2p = inspected.startP2p.bind(pool)
      inspected.startP2p = (id, entry) => {
        if (entry.p2pPolicy) {
          const { turn: _turn, ...directPolicy } = entry.p2pPolicy
          entry.p2pPolicy = directPolicy
        }
        startP2p(id, entry)
      }
    }
    const sent: Counts = { p2p: 0, relay: 0 }
    const received: Counts = { p2p: 0, relay: 0 }
    let receivingP2p = false
    const handleP2pData = inspected.handleP2pData.bind(pool)
    inspected.handleP2pData = (...args) => {
      receivingP2p = true
      try { handleP2pData(...args) } finally { receivingP2p = false }
    }
    const instrumented = new WeakSet<object>()
    const instrument = () => {
      const entry = inspected.entries.get(machineId)
      if (!entry) return
      if (!instrumented.has(entry.ws)) {
        instrumented.add(entry.ws)
        const send = entry.ws.send.bind(entry.ws)
        entry.ws.send = ((data: any, ...args: any[]) => {
          if (typeof data !== 'string') sent.relay++
          return (send as any)(data, ...args)
        }) as typeof entry.ws.send
      }
      if (entry.p2p && !instrumented.has(entry.p2p)) {
        instrumented.add(entry.p2p)
        const send = entry.p2p.send.bind(entry.p2p)
        entry.p2p.send = (data: any) => {
          const ok = send(data)
          if (ok && typeof data !== 'string') sent.p2p++
          return ok
        }
      }
    }
    const snapshot = (stream: string): RouteSnapshot => {
      instrument()
      const entry = inspected.entries.get(machineId)
      const ready = entry?.p2p?.isReady === true
      const migrating = entry?.p2pMigrating.has(stream) ?? false
      let pair: RouteSnapshot['pair'] = null
      if (ready) {
        for (const ice of entry!.p2p.pc?.iceTransports ?? []) {
          if (!ice.connection?.candidatePairs?.some((p: any) => p.nominated)) continue
          const selected = ice.getSelectedCandidatePair?.()
          const local = candidateSummary(selected?.local?.candidate)
          const remote = candidateSummary(selected?.remote?.candidate)
          if (local && remote) { pair = { local, remote }; break }
        }
      }
      return {
        route: entry?.streams.has(stream) !== true ? 'unknown'
          : verifiedRoute(entry?.p2pStreams.has(stream) ?? false, ready, migrating, pair),
        ready, migrating, pair, sent: { ...sent }, received: { ...received },
      }
    }
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/local-ws' })
    server.on('connection', (socket) => {
      let session: RelaySession | undefined
      let pending = Promise.resolve()
      const sendFrame = (frame: unknown) => {
        if (socket.readyState !== WebSocket.OPEN) return false
        socket.send(JSON.stringify(frame)); return true
      }
      socket.on('error', () => {})
      socket.on('close', () => { session?.detach() })
      socket.on('message', (raw, binary) => {
        pending = pending.then(async () => {
          if (binary) {
            const clear = decodeTerminalLocal(new Uint8Array(raw as Buffer))
            if (!clear || !session) throw new Error('Invalid benchmark binary frame')
            instrument()
            await session.sendBinary(clear)
          } else {
            const frame = JSON.parse(raw.toString())
            if (frame.type === 'machine_select' && !session) {
              if (frame.payload.machineId !== machineId) throw new Error('Benchmark target mismatch')
              session = await pool!.acquire(machineId, autonomousEnv, frame, {
                sendFrame,
                sendBinary: (bytes) => {
                  if (socket.readyState !== WebSocket.OPEN) return false
                  received[receivingP2p ? 'p2p' : 'relay']++
                  socket.send(bytes, { binary: true }); return true
                },
              }, () => socket.close(1011, 'Benchmark upstream closed'))
              instrument()
              if (socket.readyState !== WebSocket.OPEN) session.detach()
            } else if (session) await session.send(frame)
            else throw new Error('Select the benchmark machine first')
          }
        }).catch(() => { socket.close(1011, 'Benchmark transport failed') })
      })
    })
    await new Promise<void>((resolve, reject) => { server!.once('listening', resolve); server!.once('error', reject) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing benchmark loopback port')
    return {
      port: address.port,
      snapshot,
      negotiation: () => inspected.entries.get(machineId)?.p2p?.negotiationDetail ?? 'no data channel',
      turnHosts: () => (inspected.entries.get(machineId)?.p2pPolicy?.turn?.urls ?? [])
        .map((url) => url.match(/^turns?:([^:/?]+)/i)?.[1] ?? 'unrecognized'),
      close: async () => {
        for (const socket of server!.clients) socket.terminate()
        pool!.invalidate(machineId)
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        rmSync(scratch, { recursive: true, force: true })
      },
    }
  } catch (error) {
    pool?.invalidate(machineId)
    server?.close()
    rmSync(scratch, { recursive: true, force: true })
    throw error
  }
}
