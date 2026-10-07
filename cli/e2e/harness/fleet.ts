/**
 * Two machines on one account: two real daemons, each under its own throwaway home, private tmux server
 * and fake engines, with its own computer id, machine id and E2EE identity, signed in to one fake backend
 * (fakeBackend.ts) and linked the way `harness link connect` leaves two machines — A holds B's key
 * pinned, B trusts A's — so that A's lane to B opens a real end-to-end encrypted session through the
 * fake relay. Machine A can have a dial on a pseudo-terminal (fakeDial.ts), which is what opens that
 * lane: a daemon holds it on a dial's behalf.
 *
 * Nothing reaches beyond this machine. Every URL the daemon has a setting for points at the fake, and
 * `assertLocalOnly` refuses to start a daemon whose environment names anything else.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { b64e, newIdentity, type Identity } from '../../src/lib/e2ee/core.js'
import { IsolatedDaemon, type DaemonOptions } from './daemon.js'
import { FakeBackend, type FakeMachine } from './fakeBackend.js'
import { FakeDial } from './fakeDial.js'

export interface FleetMachine extends FakeMachine {
  daemon: IsolatedDaemon
  identity: Identity
}

export interface Fleet {
  backend: FakeBackend
  a: FleetMachine
  b: FleetMachine
  /** A's dial, when it has one. */
  dial: FakeDial | null
  close(): Promise<void>
}

export interface FleetOptions {
  /** Plug a dial into A: its attach is what opens A's lane to B. */
  dialOnA?: boolean
  envA?: Record<string, string>
  envB?: Record<string, string>
}

/** Every daemon setting whose default is a server somewhere else, all pointed at the fake. */
export function remoteSettings(backend: FakeBackend): Record<string, string> {
  return {
    BACKEND_WS_URL: backend.wsUrl,
    WEB_URL: backend.httpUrl,
    ADAPTER_UPDATE_URL: `${backend.httpUrl}/update/cli.json`,
    ADAPTER_RUNTIME_METADATA_URL: `${backend.httpUrl}/update/runtime.json`,
    ADAPTER_GRID_RUNTIME_METADATA_URL: `${backend.httpUrl}/update/grid.json`,
    CABLE_FW_MANIFEST_URL: `${backend.httpUrl}/update/firmware.json`,
  }
}

/** The host a variable names, when its value is a server address; null for anything else. */
function serverHost(value: string | undefined): string | null {
  if (typeof value !== 'string' || !/^(https?|wss?):\/\//i.test(value)) return null
  try { return new URL(value).hostname } catch { return null }
}
const loopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '[::1]'

/**
 * Refuse a daemon whose environment names a server that is not on this machine: the fake backend is
 * the only one a fleet test may reach. Throws, naming the variable.
 */
export function assertLocalOnly(env: NodeJS.ProcessEnv, backend: FakeBackend): void {
  for (const [key, value] of Object.entries(env)) {
    const host = serverHost(value)
    if (host && !loopback(host)) throw new Error(`${key} points at ${host}: a fleet test must reach nothing beyond this machine`)
  }
  for (const [key, value] of Object.entries(remoteSettings(backend))) {
    if (env[key] !== value) throw new Error(`${key} is ${env[key] ?? 'unset'}, not the fake backend`)
  }
}

/** Sign a daemon in, as `harness login` leaves a computer: a session for its machine on this account. */
export async function signIn(daemon: IsolatedDaemon, machine: FakeMachine): Promise<void> {
  await writeFile(join(daemon.root, 'auth', 'session.json'), JSON.stringify({
    version: 1, accessToken: machine.token, autonomousEnv: 'prod', computerId: machine.computerId,
    machineId: machine.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
}

/** The E2EE files `harness link connect` and pairing leave, written before the daemon first starts. */
export async function writeE2ee(daemon: IsolatedDaemon, files: Record<string, unknown>): Promise<void> {
  const dir = join(daemon.dataDir, 'e2e')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 })
}

/** A daemon for one machine of the account, signed in to the fake backend and nothing else. */
async function signedInDaemon(backend: FakeBackend, spec: FakeMachine, env: Record<string, string> = {}, scriptPath?: string): Promise<IsolatedDaemon> {
  const daemon = await IsolatedDaemon.create({ ...(scriptPath ? { scriptPath } : {}), env: { ...remoteSettings(backend), ADAPTER_COMPUTER_ID: spec.computerId, ...env } })
  // The daemon inherits the runner's environment, where a registry or a proxy may be named. None of
  // them is anywhere a fleet daemon may go.
  for (const [key, value] of Object.entries(daemon.env)) {
    const host = serverHost(value)
    if (host && !loopback(host)) delete daemon.env[key]
  }
  assertLocalOnly(daemon.env, backend)
  await signIn(daemon, spec)
  return daemon
}

export interface PhoneMachine {
  backend: FakeBackend
  machine: FleetMachine
  /** A phone of the account, paired with the machine: its key is trusted there as a web client. */
  phone: { identity: Identity; token: string }
  /** A Wi-Fi device paired with the machine (`wifiDevice`): its key is trusted there as a device, and it
   *  reaches the machine through the relay as a phone does (harness/fakeWifiDevice.ts). */
  wifi: { identity: Identity; token: string }
  close(): Promise<void>
}

/** One signed-in machine and a phone paired with it, on the fake backend: what a phone reaches the
 *  machine through, end to end encrypted and relayed. */
export async function startPhoneMachine(options: { env?: Record<string, string>; wifiDevice?: boolean; scriptPath?: string } = {}): Promise<PhoneMachine> {
  const backend = await FakeBackend.start()
  const spec = { machineId: 'a1'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000a', name: 'machine-a', token: 'e2e-token-machine-a', identity: newIdentity() }
  backend.addMachine(spec)
  const phone = { identity: newIdentity(), token: 'e2e-token-phone' }
  backend.addUser(phone.token)
  const wifi = { identity: newIdentity(), token: 'e2e-token-wifi-device' }
  backend.addUser(wifi.token)
  let daemon: IsolatedDaemon | null = null
  try {
    daemon = await signedInDaemon(backend, spec, options.env, options.scriptPath)
    await writeE2ee(daemon, {
      'identity.json': { priv: b64e(spec.identity.priv), pub: b64e(spec.identity.pub) },
      'paired.json': [
        { identityPub: b64e(phone.identity.pub), label: 'phone', pairedAt: Date.now(), role: 'web' },
        ...(options.wifiDevice ? [{ identityPub: b64e(wifi.identity.pub), label: 'Wi-Fi device', pairedAt: Date.now(), role: 'device' }] : []),
      ],
    })
    await daemon.start()
    const started = daemon
    return {
      backend, machine: { ...spec, daemon: started }, phone, wifi,
      async close() {
        await started.close().catch(() => {})
        await backend.close()
      },
    }
  } catch (error) {
    await daemon?.close().catch(() => {})
    await backend.close()
    throw error
  }
}

export async function startFleet(options: FleetOptions = {}): Promise<Fleet> {
  const backend = await FakeBackend.start()
  const specs: Array<FakeMachine & { identity: Identity }> = [
    { machineId: 'a1'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000a', name: 'machine-a', token: 'e2e-token-machine-a', identity: newIdentity() },
    { machineId: 'b2'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000b', name: 'machine-b', token: 'e2e-token-machine-b', identity: newIdentity() },
  ]
  for (const spec of specs) backend.addMachine(spec)
  const dial = options.dialOnA ? await FakeDial.open() : null
  const created: IsolatedDaemon[] = []
  try {
    const machines: FleetMachine[] = []
    for (const [index, spec] of specs.entries()) {
      const own: DaemonOptions['env'] = index === 0
        ? { ...(dial ? { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: dial.path } : {}), ...options.envA }
        : { ...options.envB }
      const daemon = await signedInDaemon(backend, spec, own)
      created.push(daemon)
      machines.push({ ...spec, daemon })
    }
    const [a, b] = machines
    const linkedAt = Date.now()
    // A pinned B's key when it linked to B; B trusts A back, as a machine (lib/e2ee/manager.ts onPeerLinked).
    await writeE2ee(a.daemon, {
      'identity.json': { priv: b64e(a.identity.priv), pub: b64e(a.identity.pub) },
      'machinePeers.json': [{ machineId: b.machineId, pub: b64e(b.identity.pub), label: b.name, linkedAt }],
    })
    await writeE2ee(b.daemon, {
      'identity.json': { priv: b64e(b.identity.priv), pub: b64e(b.identity.pub) },
      'paired.json': [{ identityPub: b64e(a.identity.pub), label: a.name, pairedAt: linkedAt, role: 'web', machineId: a.machineId, kind: 'machine' }],
    })
    await Promise.all(machines.map((machine) => machine.daemon.start()))
    return {
      backend, a, b, dial,
      async close() {
        await dial?.close()
        await Promise.allSettled(machines.map((machine) => machine.daemon.close()))
        await backend.close()
      },
    }
  } catch (error) {
    await dial?.close()
    await Promise.allSettled(created.map((daemon) => daemon.close()))
    await backend.close()
    throw error
  }
}
