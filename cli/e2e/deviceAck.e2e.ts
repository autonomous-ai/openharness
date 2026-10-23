/**
 * "It's mine" said once, for the whole account: two real daemons signed in to one fake backend that keeps
 * the account's device key log (harness/fakeBackend.ts `enableDeviceLog`). A phone joins; the person
 * confirms it on machine A (`harness devices dismiss <fp>` posts `confirm`), and machine B — which read
 * the acknowledgement A signed, and checked it against its own copy of the log — stops showing it as new,
 * and says where it was confirmed. A device that is itself new on a machine cannot vouch there until the
 * person confirms it; and a backend from before acknowledgements leaves every machine as it was.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { b64e, newIdentity, type Identity } from '../src/lib/e2ee/core.js'
import { nextDevLogEntry, signDevLogEntry } from '../src/lib/e2ee/deviceLog.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { signedInDaemon, writeE2ee } from './harness/fleet.js'

type Listing = { pending?: string[]; members: Array<{ pub: string; label: string; confirmed?: { by: string; label: string } }> }

const devices = async (daemon: IsolatedDaemon): Promise<Listing> =>
  (await fetch(`http://127.0.0.1:${daemon.port}/api/devices`, { headers: daemon.localHeaders({ 'x-adapter-local': '1' }) })).json() as Promise<Listing>
const dismiss = async (daemon: IsolatedDaemon, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`http://127.0.0.1:${daemon.port}/api/devices/dismiss`, { method: 'POST', headers: daemon.localHeaders({ 'x-adapter-local': '1', 'content-type': 'application/json' }), body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const pendingOn = async (daemon: IsolatedDaemon): Promise<string[]> => (await devices(daemon)).pending ?? []

let backend: FakeBackend | null = null
const daemons: IsolatedDaemon[] = []
afterEach(async () => {
  await Promise.allSettled(daemons.splice(0).map((d) => d.close()))
  await backend?.close()
  backend = null
})

/** A machine of the account, started, with its own identity. */
async function machine(b: FakeBackend, name: string, n: number): Promise<{ daemon: IsolatedDaemon; pub: string }> {
  const identity: Identity = newIdentity()
  const spec: FakeMachine = { machineId: String(n).repeat(32), computerId: `e2e-computer-0000-0000-00000000000${n}`, name, token: `e2e-token-${name}` }
  b.addMachine(spec)
  const daemon = await signedInDaemon(b, spec)
  daemons.push(daemon)
  await writeE2ee(daemon, { 'identity.json': { priv: b64e(identity.priv), pub: b64e(identity.pub) } })
  await daemon.start()
  return { daemon, pub: b64e(identity.pub) }
}

/** A phone of the account signing in: its key added to the log, as its `POST /api/device-keys` does. */
function phoneJoins(b: FakeBackend, label: string): string {
  const id = newIdentity()
  const pub = b64e(id.pub)
  const entry = signDevLogEntry(nextDevLogEntry(b.deviceLog!.state, { op: 'add', pub, kind: 'viewer', machineId: '', label, signer: pub }, Date.now()), id.priv)
  expect(b.appendDeviceEntry(entry)).toHaveProperty('head')
  return pub
}

describe('"It\'s mine" on one machine is the account\'s', () => {
  it('confirmed on A, a new phone stops being new on B; a device new on A vouches there only once confirmed', async () => {
    const b = backend = await FakeBackend.start()
    b.enableDeviceLog()
    // A first, then B: on A, B is new; on B, A was already on the account.
    const a = await machine(b, 'machine-a', 1)
    await until('A on the account\'s log', () => !!b.deviceLog!.state.active[a.pub], 60_000)
    const m = await machine(b, 'machine-b', 2)
    await until('B on the account\'s log', () => !!b.deviceLog!.state.active[m.pub], 60_000)
    await until('A to read B as new', async () => (await pendingOn(a.daemon)).includes(m.pub), 30_000)
    expect(await pendingOn(m.daemon)).not.toContain(a.pub)

    const phone = phoneJoins(b, 'phone')
    await until('both to read the phone as new', async () => (await pendingOn(a.daemon)).includes(phone) && (await pendingOn(m.daemon)).includes(phone), 30_000)

    // "It's mine" on A: marked there, and shared.
    const confirmed = await dismiss(a.daemon, { pub: phone, confirm: true })
    expect(confirmed).toEqual({ status: 200, body: { ok: true, shared: true } })
    expect(await pendingOn(a.daemon)).not.toContain(phone)
    await until('B to stop showing the phone as new', async () => !(await pendingOn(m.daemon)).includes(phone), 30_000)
    const onB = await devices(m.daemon)
    const labelOfA = onB.members.find((x) => x.pub === a.pub)!.label
    expect(onB.members.find((x) => x.pub === phone)?.confirmed).toEqual(expect.objectContaining({ by: a.pub, label: labelOfA }))

    // B vouches for a tablet: on A, B is itself new — it does not count there, until the person says B is theirs.
    const tablet = phoneJoins(b, 'tablet')
    await until('both to read the tablet as new', async () => (await pendingOn(a.daemon)).includes(tablet) && (await pendingOn(m.daemon)).includes(tablet), 30_000)
    const mark = b.seen.length
    expect((await dismiss(m.daemon, { pubs: [tablet], confirm: true })).body.shared).toBe(true)
    expect(b.deviceLog!.acks).toHaveLength(2)
    // A has read it (the backend's push; B, with nothing new left, asks for none), and kept the tablet
    // new: B is not a device A trusts to vouch yet.
    await until('A to read the acknowledgements again', () => b.seen.slice(mark).some((s) => s.startsWith('GET /api/device-keys/acks')), 10_000)
    await new Promise((done) => setTimeout(done, 1_000))
    expect(await pendingOn(a.daemon)).toContain(tablet)
    // "It's mine" for B on A: now B's word counts there, and the tablet goes too.
    expect((await dismiss(a.daemon, { pub: m.pub, confirm: true })).body.shared).toBe(true)
    await until('A to stop showing the tablet as new', async () => !(await pendingOn(a.daemon)).includes(tablet), 30_000)
  })

  it('a backend from before acknowledgements changes nothing: each machine keeps its own', async () => {
    const b = backend = await FakeBackend.start()
    b.enableDeviceLog()
    b.deviceAcks = false
    const a = await machine(b, 'machine-a', 1)
    await until('A on the account\'s log', () => !!b.deviceLog!.state.active[a.pub], 60_000)
    const m = await machine(b, 'machine-b', 2)
    await until('B on the account\'s log', () => !!b.deviceLog!.state.active[m.pub], 60_000)
    const phone = phoneJoins(b, 'phone')
    await until('both to read the phone as new', async () => (await pendingOn(a.daemon)).includes(phone) && (await pendingOn(m.daemon)).includes(phone), 30_000)
    expect(await dismiss(a.daemon, { pub: phone, confirm: true })).toEqual({ status: 200, body: { ok: true, shared: false } })
    expect(await pendingOn(a.daemon)).not.toContain(phone)
    // Something else moves the log: B reads it again, and still shows the phone as new.
    phoneJoins(b, 'tablet')
    await until('B to read the tablet', async () => (await pendingOn(m.daemon)).length === 2, 30_000)
    expect(await pendingOn(m.daemon)).toContain(phone)
  })
})
