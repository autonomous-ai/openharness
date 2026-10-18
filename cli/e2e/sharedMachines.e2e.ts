/**
 * A machine shared across accounts (docs/plans/2026-10-15-share-machine-plan.md), end to end: two real
 * daemons on two accounts at one domain, signed in to the fake backend (harness/fakeBackend.ts).
 *
 * Dee shares her machine with everyone at acme.io; Kim, at acme.io on another account, adds it. Kim's
 * daemon then pins Dee's machine and Dee's daemon trusts Kim's (services/sharedMachines.ts, through the
 * gateway: gateway/sharedTrust.ts), so a window on Kim's computer reaches Dee's machine through the relay,
 * end to end encrypted, with the owner's rights. Neither joins the other's trust group. Dee stopping
 * sharing ends the session and takes the trust back on both sides.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { b64e, newIdentity } from '../src/lib/e2ee/core.js'
import { LocalClient } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { signedInDaemon, writeE2ee } from './harness/fleet.js'

/** What a window's `machine_select` of `machineId` through `daemon` comes to: connected, or the code it was closed with. */
async function select(daemon: IsolatedDaemon, machineId: string): Promise<'connected' | number> {
  const ws = new WebSocket(`ws+unix://${daemon.socketPath}:/api/local-ws`)
  return new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1 } })))
    ws.on('message', (raw) => {
      if ((JSON.parse(raw.toString()) as { type?: string }).type !== 'connected') return
      resolve('connected')
      ws.close()
    })
    ws.on('close', (code) => resolve(code))
    ws.on('error', () => resolve(-1))
  })
}

function e2eFile(daemon: IsolatedDaemon, name: string): unknown[] {
  try { return JSON.parse(readFileSync(join(daemon.dataDir, 'e2e', name), 'utf-8')) as unknown[] } catch { return [] }
}
const roster = (daemon: IsolatedDaemon): string => {
  try { return readFileSync(join(daemon.dataDir, 'e2e', 'group.json'), 'utf-8') } catch { return '' }
}

describe('a machine shared across accounts', () => {
  let backend: FakeBackend | null = null
  const daemons: IsolatedDaemon[] = []
  const clients: LocalClient[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    await Promise.allSettled(daemons.splice(0).map((daemon) => daemon.close()))
    await backend?.close()
    backend = null
  })

  it('is reached from a colleague’s computer once shared and added, with the owner’s rights, and no longer once sharing stops', async () => {
    backend = await FakeBackend.start()
    const specs = [
      { machineId: 'd1'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000d1', name: 'dee-studio', token: 'e2e-token-dee', account: 'dee', email: 'dee@acme.io', identity: newIdentity() },
      { machineId: 'c2'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000c2', name: 'kim-mac', token: 'e2e-token-kim', account: 'kim', email: 'kim@acme.io', identity: newIdentity() },
    ]
    for (const spec of specs) {
      const machine: FakeMachine = { ...spec, pub: b64e(spec.identity.pub) }
      backend.addMachine(machine)
      const daemon = await signedInDaemon(backend, machine)
      daemons.push(daemon)
      await writeE2ee(daemon, { 'identity.json': { priv: b64e(spec.identity.priv), pub: b64e(spec.identity.pub) } })
    }
    const [dee, kim] = daemons
    const [deeSpec, kimSpec] = specs
    onTestFailed(() => {
      console.log(`---- Dee's daemon\n${dee.log().split('\n').slice(-80).join('\n')}`)
      console.log(`---- Kim's daemon\n${kim.log().split('\n').slice(-80).join('\n')}`)
    })
    await Promise.all(daemons.map((daemon) => daemon.start()))
    await until('both machines on the relay', () => backend!.nodeUp(deeSpec.machineId) && backend!.nodeUp(kimSpec.machineId), 30_000)

    // Not shared: Kim's computer has no way to Dee's machine.
    expect(await select(kim, deeSpec.machineId)).toBe(4404)

    // Dee shares it with everyone at acme.io, from her own window.
    const onDee = await LocalClient.connect(dee, { machineId: deeSpec.machineId })
    clients.push(onDee)
    expect(await onDee.request('shared_machines', { action: 'set', emails: [], sameDomain: true }, 30_000))
      .toMatchObject({ emails: [], sameDomain: true, domain: 'acme.io', members: [] })
    // Listed to Kim, not yet added: still no way there.
    const onKim = await LocalClient.connect(kim, { machineId: kimSpec.machineId })
    clients.push(onKim)
    expect(await select(kim, deeSpec.machineId)).toBe(4404)

    // Kim adds it. Her daemon pins Dee's machine; Dee's, told by the backend, trusts Kim's.
    expect(await onKim.request('shared_machines', { action: 'add', machineId: deeSpec.machineId }, 30_000)).toMatchObject({ ok: true })
    await until('Dee’s machine pinned on Kim’s', () => e2eFile(kim, 'machinePeers.json')
      .some((p) => (p as { machineId: string; shared?: boolean }).machineId === deeSpec.machineId && (p as { shared?: boolean }).shared === true) || null, 30_000)
    await until('Kim’s machine trusted on Dee’s', () => e2eFile(dee, 'paired.json')
      .some((p) => (p as { identityPub: string; shared?: boolean }).identityPub === b64e(kimSpec.identity.pub) && (p as { shared?: boolean }).shared === true) || null, 30_000)

    // A window on Kim's computer works on Dee's machine, with the owner's rights: the sharing itself reads.
    const viaKim = await LocalClient.connect(kim, { machineId: deeSpec.machineId })
    clients.push(viaKim)
    expect((await viaKim.request<{ agents?: unknown[] }>('agents_list', {}, 30_000)).agents).toEqual(expect.any(Array))
    expect(await viaKim.request('shared_machines', { action: 'get' }, 30_000)).toMatchObject({
      sameDomain: true, members: [{ email: 'kim@acme.io', via: 'domain', machines: 1 }] })
    // Sealed end to end: the relay saw the outer type and never what was in it.
    const relayed = [...backend.webSent.values()].flat().filter((frame) => frame.type === 'agents_list' || frame.type === 'shared_machines')
    expect(relayed.length).toBeGreaterThanOrEqual(2)
    expect(relayed.every((frame) => !!(frame.payload as { __e2e?: unknown } | undefined)?.__e2e)).toBe(true)

    // Neither account's trust group took in the other's machine.
    expect(roster(dee)).not.toContain(b64e(kimSpec.identity.pub))
    expect(roster(kim)).not.toContain(b64e(deeSpec.identity.pub))

    // Dee stops sharing: Kim's session ends, and the trust goes on both sides.
    expect(await onDee.request('shared_machines', { action: 'set', emails: [], sameDomain: false }, 30_000)).toMatchObject({ sameDomain: false })
    await until('Kim’s window on Dee’s machine closed', () => viaKim.closed || null, 30_000)
    await until('Kim’s machine untrusted on Dee’s', () => !e2eFile(dee, 'paired.json')
      .some((p) => (p as { identityPub: string }).identityPub === b64e(kimSpec.identity.pub)) || null, 30_000)
    await until('Dee’s machine unpinned on Kim’s', () => !e2eFile(kim, 'machinePeers.json')
      .some((p) => (p as { machineId: string }).machineId === deeSpec.machineId) || null, 30_000)
    expect(await select(kim, deeSpec.machineId)).not.toBe('connected')
  }, 240_000)
})
