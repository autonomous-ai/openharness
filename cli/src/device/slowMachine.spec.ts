/**
 * A slow linked machine, with real keys end to end: the fleet (deviceFleet.ts) over its lane (deviceLink.ts), sealed by
 * the gateway's sessions (gateway/lane.ts), against a far machine running its own E2eeManager, through a fake device
 * socket the test plays the relay on. Diego, 10-30: a slow but working Mac's replies came after their requests had
 * timed out, and two timeouts threw away a session that was answering. Here a late reply the far machine sealed keeps
 * it reachable with its session; what the relay could make (a reply in the clear, an old one replayed) or any commander
 * of the machine could seal (under its group key) proves nothing; and a machine that proves nothing is still reset.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type * as CoreCrypto from '../lib/e2ee/core.js'
import type { E2eeManager as Manager } from '../lib/e2ee/manager.js'
import { LaneSessions } from '../gateway/lane.js'
import { DeviceFleet } from './deviceFleet.js'
import { DeviceLink } from './deviceLink.js'
import { FleetRouter } from '../services/fleetRouter.js'

type Frame = Record<string, unknown>
const MACHINE = 'b1b2c3d4e5f60718293a4b5c6d7e8f90'
const CONN = 'device:slow-lane'

// The far machine's store reads its data folder when its module loads: a throwaway one, set first.
const dataDir = mkdtempSync(join(tmpdir(), 'slow-machine-'))
let C: typeof CoreCrypto
let E2eeManager: typeof Manager
beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = dataDir
  C = await import('../lib/e2ee/core.js')
  E2eeManager = (await import('../lib/e2ee/manager.js')).E2eeManager
})
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }) })

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const stop of stops.splice(0)) await stop()
})

/** Wait on the lane without a timer (they are faked): it reads each frame through promises alone. */
async function until(what: string, check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20_000; turn++) {
    if (check()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`never: ${what}`)
}

async function slowMachine(over: { now?: () => number } = {}) {
  const identity = C.newIdentity()
  const lane = new LaneSessions(() => identity)
  // The far machine, which trusts this one's key (as `harness link connect` leaves two machines).
  const out: Frame[] = []
  const far = new E2eeManager({ machineId: MACHINE, sendTo: (_conn, frame) => { out.push(frame) }, isConnected: () => true })
  far.trustPeer({ pub: C.b64e(identity.pub), machineId: 'this-machine', label: 'this machine' })
  const farPub = C.b64e((far as unknown as { store: { getIdentity(): CoreCrypto.Identity } }).store.getIdentity().pub)

  // The relay: hellos go to the far machine and its welcome comes back; requests are opened there and kept unanswered.
  const asked: Array<{ type: string; requestId: string }> = []
  const turns: Frame[] = []
  let socket: WebSocket | null = null
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (protocols) => [...protocols][0] ?? false })
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  const toLane = (frame: Frame) => socket?.send(JSON.stringify({ ...frame, machineId: MACHINE }))
  wss.on('connection', (ws) => {
    socket = ws
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame
      if (frame.machineId !== MACHINE) return
      if (frame.type === 'e2e_hello') {
        const before = out.length
        far.handleFrame(CONN, frame)
        for (const reply of out.slice(before)) toLane(reply)
        return
      }
      const plain = far.unwrapDown(CONN, frame)
      if (!plain) return
      if (plain.type === 'message') { turns.push(plain); return }
      asked.push({ type: String(plain.type), requestId: String((plain.payload as Frame).requestId) })
    })
  })
  stops.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()) }))

  const lines: string[] = []
  const link = new DeviceLink({
    auth: { accessToken: async () => 'token' }, backendWsBase: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    computerId: 'this-computer', autonomousEnv: 'test', seal: lane,
    peer: (machineId) => machineId === MACHINE ? { machineId, pub: farPub, label: 'far', linkedAt: 1 } as never : null,
    localMachineId: () => 'this-machine', log: (line) => { lines.push(line) },
    ...(over.now ? { now: over.now } : {}),
  })
  stops.push(async () => link.stop())
  const rows = [{ machineId: MACHINE, name: 'slow-mac', state: 'ready', authMode: 'remote', local: false }]
  const fleet = new DeviceFleet({ list: { list: () => ({ machines: rows, source: 'backend' as const }), find: (id: string) => rows.find((r) => r.machineId === id) } as never,
    link, hasPeerLink: () => true, log: (line) => { lines.push(line) } })
  await link.online()
  const hellos = () => out.filter((frame) => frame.type === 'e2e_welcome').length
  /** One agent list that the far machine reads and does not answer in time. */
  const timesOut = async () => {
    const before = asked.length
    const listed = fleet.listAgents(MACHINE).catch((error: Error) => error)
    await until('the far machine to read the request', () => asked.length === before + 1)
    await vi.advanceTimersByTimeAsync(45_000)
    expect(await listed).toEqual(new Error('agents_list timed out'))
    return asked[before]!
  }
  const read = (what: string) => until(what, () => lines.some((line) => line.includes(what)))
  return { far, fleet, link, lines, toLane, timesOut, hellos, read, turns, asked }
}

/** The router over that fleet, with the far machine's one agent listed: what ⌘K and the dial send a turn through. */
async function routed(m: Awaited<ReturnType<typeof slowMachine>>, answer: () => Promise<void>) {
  const router = new FleetRouter({ machineName: () => 'here', machineId: () => 'this-machine', computerId: () => 'c', sessions: () => [],
    displayName: () => '', desk: () => [], sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), recent: () => [], recentAsks: () => [],
    log: (line) => { m.lines.push(line) } }, m.fleet)
  await router.listAgentsFlat()
  await answer()
  expect((await router.listAgentsFlat()).map((a) => a.id)).toEqual(['agent-1'])
  return router
}

/** The far machine answering the last list it was asked, sealed for this session alone. */
function answerLast(m: Awaited<ReturnType<typeof slowMachine>>) {
  return async () => {
    await until('the far machine to read the list', () => m.asked.some((a) => a.type === 'agents_list'))
    const last = m.asked.filter((a) => a.type === 'agents_list').at(-1)!
    m.toLane(m.far.wrapRpcReply(CONN, 'agents_list_result', last.requestId, { agents: [{ id: 'agent-1', name: 'api', engine: 'claude' }] })!)
    await until('its answer', () => m.fleet.reachable(MACHINE)?.ok === true)
  }
}

// #2387's review: B's daemon killed, nothing told this machine (the relay's list still said running), and a list to it
// waited 45 s, so a turn sent meanwhile was lost, not refused ('B going away' in e2e/fleet.e2e.ts). Now the list fails
// once the machine has been quiet 30 s, and the turn is refused from then.
it('refuses a turn to a machine gone quiet with nothing said, 30 s after it was last heard, not after a 45 s list', async () => {
  let clock = 1_000_000
  const m = await slowMachine({ now: () => clock })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const router = await routed(m, answerLast(m))
  expect(router.sendTurn('agent-1', 'while it is up')).toEqual({ ok: true })
  // It dies now. The next list, 5 s on, is read by nobody who answers.
  clock += 5_000
  const listed = m.fleet.listAgents(MACHINE).catch((error: Error) => error)
  await until('the list to go out', () => m.asked.filter((a) => a.type === 'agents_list').length === 2)
  await vi.advanceTimersByTimeAsync(24_999)
  expect(router.sendTurn('agent-1', 'just after it went')).toEqual({ ok: true })
  await vi.advanceTimersByTimeAsync(1)
  clock += 25_000
  expect(router.sendTurn('agent-1', 'to a machine gone 30 s')).toMatchObject({ ok: false, reason: 'the last request to it did not come back' })
  expect(await listed).toEqual(new Error('agents_list timed out'))
})

// #2381's rule kept: a machine answering every list 20 s late is never quiet 30 s, keeps its tiles, and takes every turn.
it('keeps a machine that answers every list 20 s late reachable, on the carousel, and taking turns', async () => {
  let clock = 1_000_000
  const m = await slowMachine({ now: () => clock })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const router = await routed(m, answerLast(m))
  for (let round = 1; round <= 4; round++) {
    const listed = m.fleet.listAgents(MACHINE)
    await until('the list to go out', () => m.asked.filter((a) => a.type === 'agents_list').length === round + 1)
    for (let second = 0; second < 20; second++) {
      await vi.advanceTimersByTimeAsync(1_000)
      clock += 1_000
      expect(router.sendTurn('agent-1', `round ${round}, ${second + 1} s`)).toEqual({ ok: true })
    }
    await answerLast(m)()
    expect((await listed).map((a) => a.id)).toEqual(['agent-1'])
    expect((await router.listAgentsFlat()).map((a) => a.id)).toEqual(['agent-1'])
  }
  expect(m.lines.some((line) => line.includes('timed out'))).toBe(false)
  expect(m.hellos()).toBe(1)
})

it('keeps a slow machine reachable with its session on its own late reply, and on nothing the relay or a commander could make', async () => {
  const { far, fleet, lines, toLane, timesOut, hellos, read, turns } = await slowMachine()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = await timesOut()
  expect(hellos()).toBe(1)
  expect(fleet.reachable(MACHINE)).toMatchObject({ ok: false })

  // What the relay can write: a reply in the clear.
  toLane({ type: 'agents_list_result', payload: { requestId: first.requestId, agents: [] } })
  // What any commander of the machine can seal: a reply under its group key, which opens.
  const group = far as unknown as { groupKey: Uint8Array; groupCounter: number; epoch: string }
  toLane({ type: 'agents_list_result', payload: C.wrapPayload(group.groupKey, 'g', group.groupCounter++, 'agents_list_result', undefined,
    { requestId: first.requestId, agents: [] }, group.epoch) })
  await until('both read', () => lines.filter((line) => line.includes('unmatched agents_list_result')).length === 2)
  expect(fleet.reachable(MACHINE)).toMatchObject({ ok: false })

  // Its own late reply, sealed for this session alone.
  const late = far.wrapRpcReply(CONN, 'agents_list_result', first.requestId, { agents: [] })!
  toLane(late)
  await until('the late reply to count', () => fleet.reachable(MACHINE)?.ok === true)

  // Its misses start again, so the next timeout is the first: the session stays, and a turn is sealed for it.
  const second = await timesOut()
  expect(lines.some((line) => line.includes('in a row — dropped its E2EE session'))).toBe(false)
  fleet.sendTurn(MACHINE, 'agent-1', 'still there?')
  await until('the turn to reach the far machine', () => turns.length === 1)
  expect(turns[0]).toMatchObject({ type: 'message', payload: { content: 'still there?', agentId: 'agent-1' } })
  expect(hellos()).toBe(1)

  // The same late reply again, as a relay replays it: the session's counter refuses it.
  toLane(late)
  await read('could not decrypt agents_list_result')
  expect(fleet.reachable(MACHINE)).toMatchObject({ ok: false })
  void second

  // Nothing of its own comes back now: the second miss in a row throws the session away, and the next call says hello.
  await timesOut()
  await read('missed 2 in a row — dropped its E2EE session')
  await timesOut()
  expect(hellos()).toBe(2)
})
