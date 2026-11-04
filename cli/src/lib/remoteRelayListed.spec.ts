import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { RemoteRelayPool } from './remoteRelay.js'
import { MachinePeerStore } from './e2ee/machinePeers.js'
import { b64e, newIdentity } from './e2ee/core.js'
import type { LocalClientSink } from '../backendSocket.js'

/**
 * A machine the account's machine list already shows offline is not dialled. Prod, 2026-11-04: about 3,600 web-ws
 * opens an hour from 76 users, mostly CLI 0.5.33, each signed in, refused MACHINE_OFFLINE and closed in ~120 ms. The
 * 2026-10-28 backoff is per machine and capped at 30 s, so a person with many offline machines kept the loop going,
 * and every open cost the backend a session sign-in.
 */
const machineId = 'abcdabcdabcdabcdabcdabcdabcdabcd'
const other = 'efefefefefefefefefefefefefefefef'
const sink: LocalClientSink = { sendFrame: () => true, sendBinary: () => true }
const select = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'machine_select', payload: { machineId: id, ...extra } })
const offline = { message: 'MACHINE_OFFLINE', closeCode: 1013 }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** A backend that refuses every select as webWs.ts refuses a relay's select of an offline machine. */
async function offlineBackend(onRecheck?: (maxAgeMs: number) => void) {
  const dials: string[] = []
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => wss.once('listening', resolve))
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type: 'connected', payload: { userId: 'user-1' } }))
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as { type: string; payload: { machineId: string } }
      if (frame.type !== 'machine_select') return
      dials.push(frame.payload.machineId)
      ws.send(JSON.stringify({ type: 'machine_select_error', payload: { machineId: frame.payload.machineId, error: 'MACHINE_OFFLINE', retryAfterMs: 30_000 } }))
    })
  })
  let now = 1_000_000
  let rechecks = 0
  const asked: number[] = []
  const peers = new MachinePeerStore()
  peers.pin(machineId, b64e(newIdentity().pub), 'test remote')
  peers.pin(other, b64e(newIdentity().pub), 'test remote 2')
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'fixture-token' } as never,
    `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    newIdentity(), peers, { p2p: false, now: () => now, recheckList: async (maxAgeMs) => { rechecks++; asked.push(maxAgeMs); onRecheck?.(maxAgeMs) } },
  )
  cleanups.push(async () => {
    peers.unlink(machineId); peers.unlink(other)
    pool.close()
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  })
  return {
    pool,
    dials: (id = machineId) => dials.filter(d => d === id).length,
    rechecks: () => rechecks,
    asked: () => asked,
    advance(ms: number) { now += ms },
    window: (id = machineId) => pool.acquire(id, 'prod', select(id), sink, () => {}),
    redial: () => pool.acquire(machineId, 'prod', select(machineId, { forceReconnect: true }), sink, () => {}),
    background: () => pool.acquireIsolated(machineId, 'prod', select(machineId), sink, () => {}),
  }
}

describe('a machine the machine list shows offline', () => {
  it('is not dialled by the window, a background client or an explicit redial', async () => {
    const b = await offlineBackend()
    b.pool.listed([machineId])
    for (let minute = 0; minute < 10; minute++) {
      await expect(b.window()).rejects.toMatchObject(offline)
      await expect(b.background()).rejects.toMatchObject(offline)
      await expect(b.redial()).rejects.toMatchObject(offline)
      b.advance(60_000)
    }
    expect(b.dials()).toBe(0)
  })

  it('is dialled again as soon as the list shows it online', async () => {
    const b = await offlineBackend()
    b.pool.listed([machineId])
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(0)
    b.pool.listed([])
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)
  })

  it('coming online lifts the backoff of an earlier refusal, so the next select dials at once', async () => {
    const b = await offlineBackend()
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)
    b.pool.listed([machineId])
    b.advance(5_000)
    b.pool.listed([])
    await expect(b.window()).rejects.toMatchObject(offline)
    await expect(b.background()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(2)
  })

  it('asks the list again at most every 5 minutes while selects are held', async () => {
    const b = await offlineBackend()
    b.pool.listed([machineId])
    await expect(b.window()).rejects.toMatchObject(offline)
    await expect(b.background()).rejects.toMatchObject(offline)
    expect(b.rechecks()).toBe(1)
    b.advance(5 * 60_000 - 1)
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.rechecks()).toBe(1)
    b.advance(1)
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.rechecks()).toBe(2)
  })

  // Review of #2891: no online event reaches the CLI (the backend pushes a list change only on create, rename, delete or
  // share), so a person pressing Retry on a machine back for a minute would have waited for the 5-minute recheck.
  it('asks the list again on an explicit redial, at most 30 s old, and dials if it shows the machine back', async () => {
    let back = false
    let pool: RemoteRelayPool | null = null
    const b = await offlineBackend(() => { if (back) pool?.listed([]) })
    pool = b.pool
    b.pool.listed([machineId])
    await expect(b.window()).rejects.toMatchObject(offline)
    await expect(b.redial()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(0)
    expect(b.asked()).toEqual([5 * 60_000, 30_000])

    back = true
    b.advance(60_000)
    await expect(b.redial()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)
    expect(b.asked()).toEqual([5 * 60_000, 30_000, 30_000])
  })

  it('holds nothing on a list that is not the backend\'s, or one read more than 15 minutes ago', async () => {
    const b = await offlineBackend()
    b.pool.listed([machineId])
    b.pool.listed(null)
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)

    b.pool.listed([other])
    b.advance(15 * 60_000)
    await expect(b.window(other)).rejects.toMatchObject(offline)
    expect(b.dials(other)).toBe(1)
  })

  it('does not hold a machine the list does not show offline', async () => {
    const b = await offlineBackend()
    b.pool.listed([other])
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)
  })
})
