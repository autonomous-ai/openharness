/**
 * The real backend's port is the one it bound (harness/realBackend.ts). The harness used to open a listener on port 0,
 * read its port, close it and hand the number to the backend: anything could take the port in between, and the harness
 * then waited on, and gave its tests the address of, whoever held it. The daemon's side of the same pick failed cli-e2e
 * run 43568618113 (shard 2).
 *
 * Here that race is lost every time. A stranger holds a port, and any listener the harness opens through `node:net` to
 * pick one is told it got that port. With no pick the stand-in is never asked and the stranger hears nothing; a pick
 * that comes back goes straight to the stranger, and this fails.
 *
 * Needs the backend's in-memory Mongo and Redis (HARNESS_E2E_SERVICES_DIR, see harness/realBackend.ts).
 */
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startRealBackend, type RealBackend } from './harness/realBackend.js'

/** The port every `node:net` listener of the harness is told it got, while one is set. */
const pick = vi.hoisted(() => ({ port: 0 }))
vi.mock('node:net', async (original) => {
  const net = await original<typeof import('node:net')>()
  const createServer = (...args: Parameters<typeof net.createServer>) => {
    const server = net.createServer(...args)
    const address = server.address.bind(server)
    server.address = () => {
      const real = address()
      return pick.port && real && typeof real === 'object' ? { ...real, port: pick.port } : real
    }
    return server
  }
  return { ...net, createServer, default: { ...net.default, createServer } }
})

describe.skipIf(!process.env.HARNESS_E2E_SERVICES_DIR)('the real backend\'s port', () => {
  let backend: RealBackend | undefined
  let stranger: Server | undefined
  const limit = process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND
  afterEach(async () => {
    pick.port = 0
    if (limit === undefined) delete process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND
    else process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND = limit
    await backend?.stop()
    backend = undefined
    stranger?.closeAllConnections()
    await new Promise<void>((done) => { if (stranger) stranger.close(() => done()); else done() })
    stranger = undefined
  })

  it('is the port the backend bound: a port a stranger holds is never handed to it, and the stranger hears nothing', async () => {
    const heard: string[] = []
    stranger = createServer((req, res) => { heard.push(`${req.method} ${req.url}`); req.resume(); res.end('{}') })
    await new Promise<void>((resolve) => { stranger!.listen(0, '127.0.0.1', resolve) })
    pick.port = (stranger.address() as AddressInfo).port
    backend = await startRealBackend([], () => {})
    const said = [...readFileSync(backend.logPath, 'utf8').matchAll(/ backend listening on (\d+)\n/g)].map((line) => Number(line[1]))
    expect(said).toHaveLength(1)
    expect(Number(new URL(backend.url).port)).toBe(said[0])
    expect(new URL(backend.wsUrl).port).toBe(new URL(backend.url).port)
    expect(await (await fetch(`${backend.url}/api/health`)).json()).toMatchObject({ success: true, data: { status: 'ok' } })
    expect(heard).toEqual([])
  }, 300_000)

  it('ends the wait at once, in the backend\'s own words, when the backend exits before it says its port', async () => {
    // Refused by the backend's own check of its settings (backend/src/config/env.ts): it exits as it starts.
    process.env.ROUTE_RATE_LIMIT_PER_CALLER_SECOND = '-1'
    await expect(startRealBackend([], () => {})).rejects.toThrow(/the backend exited \(1\) while starting; backend log [^]*Invalid environment variables/)
  }, 300_000)
})
