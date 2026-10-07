/**
 * The fleet's lane's sessions in the gateway, with real keys against a real machine on the far end (its
 * E2eeManager, as another daemon runs it). The lane used to hold this machine's identity and run these
 * sessions itself (device/deviceLink.ts); each rule here fails if it was lost in the move: what the lane
 * hands over is sealed so the far machine opens it, what the far machine seals is opened, and a session
 * the gateway does not hold (never welcomed, dropped, gone with a restart) seals nothing, so a frame for a
 * linked machine never leaves in the clear.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type * as CoreCrypto from '../lib/e2ee/core.js'
import type { E2eeManager as Manager } from '../lib/e2ee/manager.js'
import { LaneSessions } from './lane.js'

type Frame = Record<string, unknown>
const MACHINE = 'b1b2c3d4e5f60718293a4b5c6d7e8f90'
const CONN = 'device:lane-1'

// The far machine's store reads its data folder when its module loads: a throwaway one, set first.
const dataDir = mkdtempSync(join(tmpdir(), 'gateway-lane-'))
let C: typeof CoreCrypto
let E2eeManager: typeof Manager
beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = dataDir
  C = await import('../lib/e2ee/core.js')
  E2eeManager = (await import('../lib/e2ee/manager.js')).E2eeManager
})
afterAll(() => { rmSync(dataDir, { recursive: true, force: true }) })

/** The far machine, which trusts this one's key (as `harness link connect` leaves two machines). */
function farMachine(trusted: Uint8Array) {
  const sent: Frame[] = []
  const manager = new E2eeManager({ machineId: MACHINE, sendTo: (_connId, frame) => { sent.push(frame) }, isConnected: () => true })
  manager.trustPeer({ pub: C.b64e(trusted), machineId: 'this-machine', label: 'this machine' })
  const pub = C.b64e((manager as unknown as { store: { getIdentity(): CoreCrypto.Identity } }).store.getIdentity().pub)
  return { manager, sent, pub }
}

/** A lane with a session up to the far machine: hello, then its welcome. */
async function welcomed() {
  const identity = C.newIdentity()
  const lane = new LaneSessions(() => identity)
  const far = farMachine(identity.pub)
  const hello = await lane.hello(MACHINE, far.pub)
  expect(hello.type).toBe('e2e_hello')
  far.manager.handleFrame(CONN, hello)
  const welcome = far.sent.find((frame) => frame.type === 'e2e_welcome')!
  expect(welcome).toBeDefined()
  return { lane, far, identity, welcome }
}

describe('the fleet\'s lane, sealed by the gateway', () => {
  it('seals what the lane hands it so the far machine opens it, and opens what the far machine seals back', async () => {
    const { lane, far, welcome } = await welcomed()
    expect(await lane.welcome(MACHINE, welcome.payload as Frame)).toBe(true)
    const sealed = await lane.seal(MACHINE, { type: 'agents_list', machineId: MACHINE, payload: { requestId: 'r1', secret: 'the owner typed this' } })
    expect('frame' in sealed).toBe(true)
    const out = (sealed as { frame: Frame }).frame
    expect(JSON.stringify(out)).not.toContain('the owner typed this')
    expect(far.manager.unwrapDown(CONN, out)).toMatchObject({ type: 'agents_list', payload: { requestId: 'r1', secret: 'the owner typed this' } })
    const reply = far.manager.wrapRpcReply(CONN, 'agents_list_result', 'r1', { agents: [{ id: 'a1', name: 'on the far machine' }] })!
    expect(JSON.stringify(reply)).not.toContain('on the far machine')
    expect(await lane.open(MACHINE, reply)).toEqual({ frame: expect.objectContaining({ type: 'agents_list_result', payload: { requestId: 'r1', agents: [{ id: 'a1', name: 'on the far machine' }] } }) })
  })

  it('signs the hello as this machine, so a machine that trusts another key turns it away', async () => {
    const lane = new LaneSessions(() => C.newIdentity())
    const far = farMachine(C.newIdentity().pub)
    far.manager.handleFrame(CONN, await lane.hello(MACHINE, far.pub))
    expect(far.sent.some((frame) => frame.type === 'e2e_welcome')).toBe(false)
    expect(far.sent.some((frame) => frame.type === 'e2e_denied')).toBe(true)
  })

  it('seals nothing without a session up: not before the welcome, not after a drop, not after a restart', async () => {
    const frame = { type: 'message', machineId: MACHINE, payload: { content: 'never in the clear' } }
    const { lane, welcome } = await welcomed()
    // Hello sent, no welcome yet.
    expect(await lane.seal(MACHINE, frame)).toEqual({ lost: true })
    expect(await lane.open(MACHINE, frame)).toEqual({ lost: true })
    // A machine nobody started a session with.
    expect(await lane.seal('another-machine', frame)).toEqual({ lost: true })
    expect(await lane.welcome('another-machine', welcome.payload as Frame)).toBe(false)
    await lane.rekey('another-machine', {})
    expect(await lane.welcome(MACHINE, welcome.payload as Frame)).toBe(true)
    expect('frame' in await lane.seal(MACHINE, frame)).toBe(true)
    lane.drop(MACHINE)
    expect(await lane.seal(MACHINE, frame)).toEqual({ lost: true })
    // Up again, then the gateway stopping (a restart under the lane): every session goes.
    const again = await welcomed()
    expect(await again.lane.welcome(MACHINE, again.welcome.payload as Frame)).toBe(true)
    again.lane.clear()
    expect(await again.lane.seal(MACHINE, frame)).toEqual({ lost: true })
  })

  it('never forwards what does not open: a garbled, a replayed or a forged frame is unreadable', async () => {
    const { lane, far, welcome } = await welcomed()
    expect(await lane.welcome(MACHINE, welcome.payload as Frame)).toBe(true)
    const reply = far.manager.wrapRpcReply(CONN, 'agents_list_result', 'r1', { agents: [] })!
    expect('frame' in await lane.open(MACHINE, reply)).toBe(true)
    // The same frame again: the session's replay window refuses it.
    expect(await lane.open(MACHINE, reply)).toEqual({ unreadable: true })
    const payload = reply.payload as { __e2e: Record<string, unknown> }
    expect(await lane.open(MACHINE, { ...reply, payload: { __e2e: { ...payload.__e2e, n: 99, ct: 'AAAA' } } })).toEqual({ unreadable: true })
    // A frame never sealed is passed as it is, as the session reads one.
    expect(await lane.open(MACHINE, { type: 'machine_selected', payload: { machineId: MACHINE } })).toEqual({ frame: { type: 'machine_selected', payload: { machineId: MACHINE } } })
  })

  it('takes the far machine\'s new keys, and a new hello replaces the session it had', async () => {
    const { lane, far, welcome, identity } = await welcomed()
    expect(await lane.welcome(MACHINE, welcome.payload as Frame)).toBe(true)
    await lane.rekey(MACHINE, { epoch: 'nope' })
    // A second hello for the same machine: a fresh session, not yet up, so nothing is sealed under the old one.
    const second = await lane.hello(MACHINE, far.pub)
    expect(await lane.seal(MACHINE, { type: 'message', payload: {} })).toEqual({ lost: true })
    far.manager.handleFrame('device:lane-2', second)
    const welcome2 = far.sent.filter((frame) => frame.type === 'e2e_welcome').at(-1)!
    expect(await lane.welcome(MACHINE, welcome2.payload as Frame)).toBe(true)
    const sealed = await lane.seal(MACHINE, { type: 'message', payload: { content: 'second session' } }) as { frame: Frame }
    expect(far.manager.unwrapDown('device:lane-2', sealed.frame)).toMatchObject({ payload: { content: 'second session' } })
    expect(identity.pub).toBeInstanceOf(Uint8Array)
  })
})
