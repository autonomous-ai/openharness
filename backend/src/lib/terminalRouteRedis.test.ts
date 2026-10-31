import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { UpBusMsg } from './tunnel.js'

// A real Redis: REDIS_TEST_URL, e.g. redis://127.0.0.1:6379/15 (CI has none, so this file is skipped there). The bus
// connects to it as REDIS_URL. One process stands for several: a process's channel is just `termpod:`/`uppod:` + its id,
// so subscribing to another id here is what that other process would do.
const url = process.env.REDIS_TEST_URL
vi.hoisted(() => { if (process.env.REDIS_TEST_URL) process.env.REDIS_URL = process.env.REDIS_TEST_URL })
// A real client: the shared setup's never connects (noRedis.test-support.ts).
vi.unmock('ioredis')
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

describe.skipIf(!url)('terminal routes over a real Redis', () => {
  let bus: typeof import('./bus.js')
  beforeAll(async () => {
    bus = await import('./bus.js')
    // The command connection refuses commands until it is up (no offline queue), as in production at boot.
    if (bus.pub.status !== 'ready') await new Promise(resolve => bus.pub.once('ready', resolve))
  })
  afterAll(async () => { await bus?.closeBus() })

  const waitFor = async (done: () => boolean, ms = 5_000) => {
    const until = Date.now() + ms
    while (!done() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10))
  }
  const unique = (name: string) => `${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`

  it('records a viewer\'s process for 60 s, reads it back, and forgets it', async () => {
    const a = unique('conn'), b = unique('conn')
    await bus.recordConnOwners([a, b], 'process-x')
    expect(await bus.connOwner(a)).toBe('process-x')
    const ttl = await bus.pub.pttl(`conn:${a}`)
    expect(ttl).toBeGreaterThan(55_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
    await bus.forgetConnOwner(a)
    expect(await bus.connOwner(a)).toBeNull()
    expect(await bus.connOwner(b)).toBe('process-x')
  })

  it('hands 1,000 hops and 1,000 JSON frames to their process once and in order, and nothing to another process', async () => {
    const mine = unique('pid'), other = unique('pid')
    const hops: Array<[string, number]> = [], json: Array<[string, number]> = [], elsewhere: unknown[] = []
    const stopMine = await bus.subscribePod(mine, { hop: (m, p) => hops.push([m, p[0]!]), json: (m, msg) => json.push([m, (msg.frame.payload as { n: number }).n]) })
    const stopOther = await bus.subscribePod(other, { hop: m => elsewhere.push(m), json: m => elsewhere.push(m) })
    for (let i = 0; i < 1_000; i++) {
      void bus.publishPodHop(mine, 'machine-a', Uint8Array.of(i % 256, 1, 2))
      void bus.publishPodJson(mine, 'machine-a', { targetConnId: 'c', frame: { type: 'terminal_output', payload: { n: i } } } as UpBusMsg)
    }
    await waitFor(() => hops.length === 1_000 && json.length === 1_000)
    expect(hops.map(([, b]) => b)).toEqual(Array.from({ length: 1_000 }, (_, i) => i % 256))
    expect(json.map(([, n]) => n)).toEqual(Array.from({ length: 1_000 }, (_, i) => i))
    expect(new Set([...hops, ...json].map(([m]) => m))).toEqual(new Set(['machine-a']))
    expect(elsewhere).toEqual([])
    stopMine(); stopOther()
  })

  it('ignores a process-channel JSON message that is not for one connection', async () => {
    const mine = unique('pid'), got: unknown[] = []
    const stop = await bus.subscribePod(mine, { hop: () => {}, json: (_m, msg) => got.push(msg) })
    void bus.publishPodJson(mine, 'machine-a', { frame: { type: 'agent_synced', payload: {} } } as UpBusMsg)
    void bus.publishPodJson(mine, 'machine-a', { targetConnId: 'c', frame: { type: 'agent_synced', payload: {} } } as UpBusMsg)
    await waitFor(() => got.length === 1)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(got).toEqual([{ targetConnId: 'c', frame: { type: 'agent_synced', payload: {} } }])
    stop()
  })

  it('keeps a viewer\'s order across the switch from the machine\'s channel to its process\'s, as the owner reads both', async () => {
    const { createConnectionRoutes } = await import('./terminalRoute.js')
    const { startPodRoutes } = await import('./hub.js')
    const stopRoutes = await startPodRoutes()
    const owner = unique('pid'), conn = unique('conn'), machine = unique('machine'), got: number[] = []
    await bus.recordConnOwners([conn], owner)
    // The owner holds a viewer of the machine, so it reads the machine's channel too, on the same subscriber connection.
    const onFrame = (msg: UpBusMsg) => { if (msg.targetConnId === conn) got.push((msg.frame.payload as { n: number }).n) }
    const stopMachine = await bus.subscribeUp(machine, onFrame)
    const stopOwner = await bus.subscribePod(owner, { hop: () => {}, json: (_m, msg) => onFrame(msg) })
    const routes = createConnectionRoutes(machine)
    // The first frames go out while the owner is being looked up (the machine's channel), the rest after (the owner's).
    for (let i = 0; i < 1_000; i++) {
      routes.targeted({ targetConnId: conn, webEligible: true, frame: { type: 'terminal_output', payload: { n: i } } } as UpBusMsg & { targetConnId: string })
      if (i % 100 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    await waitFor(() => got.length === 1_000)
    expect(got).toEqual(Array.from({ length: 1_000 }, (_, i) => i))
    routes.close(); stopMachine(); stopOwner(); stopRoutes()
  })

  it('routes a viewer\'s frames to the process its record names, in order, from an adapter on another process', async () => {
    const { createConnectionRoutes } = await import('./terminalRoute.js')
    const { startPodRoutes } = await import('./hub.js')
    const stopRoutes = await startPodRoutes()
    const owner = unique('pid'), conn = unique('conn'), got: number[] = []
    await bus.recordConnOwners([conn], owner)
    const stop = await bus.subscribePod(owner, { hop: () => {}, json: (_m, msg) => got.push((msg.frame.payload as { n: number }).n) })
    const routes = createConnectionRoutes('machine-b')
    // The first frame goes out on the machine's channel while the owner is looked up; once known, every frame goes to it.
    routes.targeted({ targetConnId: conn, webEligible: true, frame: { type: 'terminal_output', payload: { n: -1 } } } as UpBusMsg & { targetConnId: string })
    await new Promise(resolve => setTimeout(resolve, 50))
    for (let i = 0; i < 1_000; i++) routes.targeted({ targetConnId: conn, webEligible: true, frame: { type: 'terminal_output', payload: { n: i } } } as UpBusMsg & { targetConnId: string })
    await waitFor(() => got.length === 1_000)
    expect(got).toEqual(Array.from({ length: 1_000 }, (_, i) => i))
    routes.close(); stop(); stopRoutes()
  })
})
