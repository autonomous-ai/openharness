import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { RemoteRelayPool } from './remoteRelay.js'
import { MachinePeerStore } from './e2ee/machinePeers.js'
import { b64e, newIdentity } from './e2ee/core.js'
import type { LocalClientSink } from '../backendSocket.js'

/**
 * A machine the backend refuses must not cost a backend socket on every select a local client makes. Prod,
 * 2026-10-28: 2,304 of 2,308 web-ws opens in 15 minutes came from daemon relays, median life 0.4 s — open, sign
 * in, select, refused, closed — because the window's pool dialled again on every select (the app's retry, a
 * TUI, a CLI command), and nothing read the backend's retry-after.
 */
const machineId = 'abcdabcdabcdabcdabcdabcdabcdabcd'
const sink: LocalClientSink = { sendFrame: () => true, sendBinary: () => true }
const select = { type: 'machine_select', payload: { machineId } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

/** A backend that answers every select the way webWs.ts answers a relay's: `refusal` for this machine. */
async function refusingBackend(refusal: Record<string, unknown>) {
  let dials = 0
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => wss.once('listening', resolve))
  wss.on('connection', ws => {
    dials++
    ws.send(JSON.stringify({ type: 'connected', payload: { userId: 'user-1' } }))
    ws.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as { type: string }
      if (frame.type === 'machine_select') ws.send(JSON.stringify({ type: 'machine_select_error', payload: { machineId, ...refusal } }))
    })
  })
  let now = 1_000_000
  const peers = new MachinePeerStore(); peers.pin(machineId, b64e(newIdentity().pub), 'test remote')
  const pool = new RemoteRelayPool(
    { accessToken: async () => 'fixture-token' } as never,
    `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    newIdentity(), peers, { p2p: false, now: () => now },
  )
  cleanups.push(async () => {
    pool.close()
    for (const ws of wss.clients) ws.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  })
  return {
    pool,
    dials: () => dials,
    advance(ms: number) { now += ms },
    window: () => pool.acquire(machineId, 'prod', select, sink, () => {}),
    redial: () => pool.acquire(machineId, 'prod', { ...select, payload: { ...select.payload, forceReconnect: true } }, sink, () => {}),
    background: () => pool.acquireIsolated(machineId, 'prod', select, sink, () => {}),
  }
}

describe('a machine the backend refuses', () => {
  it('is not dialled again, by the window or a background client, until the retry-after has passed', async () => {
    const b = await refusingBackend({ error: 'MACHINE_OFFLINE', retryAfterMs: 30_000 })
    const offline = { message: 'MACHINE_OFFLINE', closeCode: 1013 }
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)

    // The app's retry a second later, a CLI command, a monitor pane: answered here, from the refusal.
    b.advance(1_000)
    await expect(b.window()).rejects.toMatchObject(offline)
    await expect(b.background()).rejects.toMatchObject(offline)
    b.advance(28_000)
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(1)

    // Once the backend's 30 s are up, the machine is asked again.
    b.advance(1_000)
    await expect(b.window()).rejects.toMatchObject(offline)
    expect(b.dials()).toBe(2)
  })

  it('makes even an explicit redial wait out the retry-after', async () => {
    const b = await refusingBackend({ error: 'MACHINE_OFFLINE', retryAfterMs: 30_000 })
    await expect(b.window()).rejects.toMatchObject({ message: 'MACHINE_OFFLINE' })
    b.advance(5_000)
    await expect(b.redial()).rejects.toMatchObject({ message: 'MACHINE_OFFLINE' })
    expect(b.dials()).toBe(1)
  })

  it('without a retry-after is asked again after 1, 2, 4 … seconds, at most every 30', async () => {
    const b = await refusingBackend({ error: 'NOT_YOUR_MACHINE' })
    const refused = { message: 'NOT_YOUR_MACHINE' }
    const expected: number[] = []
    for (const wait of [1, 2, 4, 8, 16, 30, 30]) {
      await expect(b.window()).rejects.toMatchObject(refused)
      expected.push(b.dials())
      // A select just before the wait is up is answered from the refusal.
      b.advance(wait * 1_000 - 1)
      await expect(b.window()).rejects.toMatchObject(refused)
      expect(b.dials(), `${wait} s`).toBe(expected.length)
      b.advance(1)
    }
    expect(expected).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
