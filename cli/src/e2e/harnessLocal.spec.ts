import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startHookServer, type HookServerHandlers } from '../hookServer.js'
import { machineId } from './harnessLocal.js'

// The e2e reads the daemon it drives through the daemon's own local API, which since guest machine sharing
// (bc7f56ff9) answers the full /api/status only to a caller that shows the local credential. grid-dev's run
// stopped at "daemon /api/status has no machineId" the day its daemon updated to 0.4.21 (2026-10-19), because
// the e2e asked without it. Against the real server, so a change to that gate fails here, not on grid-dev.
let server: Server | null = null
afterEach(async () => {
  delete process.env.HARNESS_PORT
  delete process.env.HARNESS_MACHINE_ID
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  server = null
})

async function daemon(): Promise<void> {
  // A pinned id skips the daemon altogether: this test would then pass without asking it.
  delete process.env.HARNESS_MACHINE_ID
  const started = await startHookServer(0, {
    onStatus: () => ({ version: '9.9.9', pid: 1, computerId: 'c1', machineId: 'm1', signedIn: true, localWs: { path: '/api/local-ws' }, localSocket: null }),
  } as Partial<HookServerHandlers> as HookServerHandlers)
  server = started.server
  process.env.HARNESS_PORT = String(started.port)
}

describe('the e2e reads the machine it drives', () => {
  it('from a daemon that answers the full status only with the local credential', async () => {
    await daemon()
    await expect(machineId()).resolves.toBe('m1')
  })

  it('says the credential could not be read when the daemon gives only its public status', async () => {
    delete process.env.HARNESS_MACHINE_ID
    // What a daemon answers a caller without its credential (hookServer.ts `publicStatus`).
    server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ credentialRequired: true, version: '9.9.9', pid: 1, computerId: 'c1' })) })
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    process.env.HARNESS_PORT = String((server.address() as AddressInfo).port)
    await expect(machineId()).rejects.toThrow(/wants its local credential, and this process could not read it/)
  })
})
