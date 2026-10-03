import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { RemoteRelayPool } from './remoteRelay.js'
import { E2eeManager } from './e2ee/manager.js'
import { MachinePeerStore } from './e2ee/machinePeers.js'
import { b64e, newIdentity } from './e2ee/core.js'
import { E2eeStore } from './e2ee/store.js'
import type { LocalClientSink } from '../backendSocket.js'

const machineId = 'abcdabcdabcdabcdabcdabcdabcdabcd'
type Frame = { type: string; payload?: Record<string, unknown> }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(opts: { offline?: boolean; lingerMs?: number } = {}) {
  const sockets = new Map<string, WebSocket>()
  let next = 0
  let hellos = 0
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => wss.once('listening', resolve))
  const managerDeps = {
    machineId, isConnected: () => true,
    sendTo: (id: string, frame: unknown) => sockets.get(id)?.send(JSON.stringify(frame)),
  }
  let manager = new E2eeManager(managerDeps)
  const self = newIdentity()
  manager.trustPeer({ pub: b64e(self.pub), kind: 'machine', machineId: '12341234123412341234123412341234', label: 'test client' })
  const store = new E2eeStore(); store.init()
  const peerPub = b64e(store.getIdentity().pub)
  const peers = new MachinePeerStore(); peers.pin(machineId, peerPub, 'test remote')
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'fixture-token' } as never,
    `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    self, peers, { p2p: false, lingerMs: opts.lingerMs },
  )
  wss.on('connection', ws => {
    const id = `remote-${++next}`
    sockets.set(id, ws)
    ws.on('close', () => { sockets.delete(id); manager.dropSession(id) })
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.type === 'machine_select') {
        ws.send(JSON.stringify({ type: 'connected', payload: { machineId } }))
        if (opts.offline) ws.send(JSON.stringify({ type: 'node_status', payload: { online: false } }))
      } else if (frame.type === 'e2e_hello') {
        hellos++
        if (!opts.offline) manager.handleFrame(id, frame)
      } else if (frame.type === 'agents_list') {
        const clear = manager.unwrapDown(id, frame)
        if (clear) ws.send(JSON.stringify(manager.wrapTarget(id, 'agents_list_result', { ...clear.payload as object, agents: [{ id: 'still-here' }] })))
      }
    })
  })
  cleanups.push(async () => {
    pool.invalidate(machineId); pool.invalidateIsolated(machineId)
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  })
  return {
    pool, peers, peerPub, hellos: () => hellos,
    select: { type: 'machine_select', payload: { machineId } },
    restart() { manager = new E2eeManager(managerDeps) },
    status(online: boolean) { for (const ws of sockets.values()) ws.send(JSON.stringify({ type: 'node_status', payload: { online } })) },
  }
}

describe('remote daemon restart recovery', () => {
  it('reports an offline peer immediately during the handshake and keeps its trust', async () => {
    const f = await fixture({ offline: true })
    await expect(f.pool.acquire(machineId, 'prod', f.select, { sendFrame: () => true, sendBinary: () => true }, () => {}))
      .rejects.toMatchObject({ message: 'MACHINE_OFFLINE', closeCode: 1013 })
    expect(f.peers.get(machineId)?.pub).toBe(f.peerPub)
  })

  it.each(['desktop', 'background'] as const)('renegotiates after a remote restart for a %s client, without discarding trust', async kind => {
    const f = await fixture()
    const inbox: Frame[] = []
    const closed = vi.fn()
    const sink: LocalClientSink = { sendFrame: frame => { inbox.push(frame as Frame); return true }, sendBinary: () => true }
    const acquire = () => kind === 'desktop'
      ? f.pool.acquire(machineId, 'prod', f.select, sink, closed)
      : f.pool.acquireIsolated(machineId, 'prod', f.select, sink, closed)
    const first = await acquire()
    await first.send({ type: 'agents_list', payload: { requestId: 'before' } })
    await vi.waitFor(() => expect(inbox.some(frame => frame.payload?.requestId === 'before')).toBe(true))
    // The backend WebSocket survives. Only the remote daemon, which owns the session keys, restarts.
    f.status(false)
    f.restart()
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(1012, 'remote machine disconnected'))
    expect(f.peers.get(machineId)?.pub).toBe(f.peerPub)
    first.detach()
    const second = await acquire()
    f.status(true)
    await second.send({ type: 'agents_list', payload: { requestId: 'after' } })
    await vi.waitFor(() => expect(inbox.some(frame => frame.payload?.requestId === 'after')).toBe(true))
    expect(f.hellos()).toBe(2)
    second.detach()
  })

  it('preserves a healthy session when ordinary online presence arrives', async () => {
    const f = await fixture()
    const closed = vi.fn()
    const inbox: Frame[] = []
    const session = await f.pool.acquire(machineId, 'prod', f.select, { sendFrame: frame => { inbox.push(frame as Frame); return true }, sendBinary: () => true }, closed)
    f.status(true)
    await session.send({ type: 'agents_list', payload: { requestId: 'healthy' } })
    await vi.waitFor(() => expect(inbox.some(frame => frame.payload?.requestId === 'healthy')).toBe(true))
    expect(closed).not.toHaveBeenCalled()
    expect(f.hellos()).toBe(1)
    session.detach()
  })

  it('an obsolete view detaching cannot evict the replacement connection later', async () => {
    const f = await fixture({ lingerMs: 10 })
    const sink = { sendFrame: () => true, sendBinary: () => true }
    const first = await f.pool.acquire(machineId, 'prod', f.select, sink, () => {})
    f.pool.invalidate(machineId)
    const second = await f.pool.acquire(machineId, 'prod', f.select, sink, () => {})
    first.detach()
    first.detach()
    await new Promise(resolve => setTimeout(resolve, 40))
    const third = await f.pool.acquire(machineId, 'prod', f.select, sink, () => {})
    expect(f.hellos()).toBe(2)
    second.detach(); third.detach()
  })
})
