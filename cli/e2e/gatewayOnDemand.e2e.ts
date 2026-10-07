/**
 * The gateway's process on demand (core/gatewayWake.ts, core/gatewayLink.ts, harnessd/services.ts `gateway`), on
 * the real daemon: a computer signed out with nothing paired runs no gateway, about 75 MiB it never pays, since
 * it would dial nothing and nothing could reach it; the first thing that needs it starts it.
 * - Signed out, nothing paired: no process, and `/api/status` is answered without it.
 * - A window's E2EE request and a key command: the first starts it, waits for it and is answered by it; killed, it
 *   comes back.
 * - Something paired here: asked for as the core starts, signed out too.
 * - Signed in: asked for as the core starts, before it binds, so the relay comes up beside it and a phone reaches
 *   the machine as it did when the gateway started with every other process.
 * - Named in `HARNESSD_SERVICES` (tests, support), it starts with the daemon, as before.
 * A core too old to ask has it started as it binds: e2e/reexec.e2e.ts, under a released core.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { b64e, newIdentity } from '../src/lib/e2ee/core.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { remoteSettings, signIn, writeE2ee } from './harness/fleet.js'
import { RelayPhone, type PhoneFrame } from './harness/relayPhone.js'

const starts = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service gateway started/g)].length
const connections = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => line.includes('[services] gateway connected')).length
const pidsOf = (d: IsolatedDaemon) => [...d.log().matchAll(/\[harnessd\] service gateway started \(pid (\d+)\)/g)].map((match) => Number(match[1]))
const status = async (d: IsolatedDaemon) => await (await fetch(`http://127.0.0.1:${d.port}/api/status`)).json() as Record<string, any>
const isTurn = (type: string, agentId: string) => (frame: Frame | PhoneFrame) => frame.type === type && frame.agentId === agentId

describe('the gateway\'s process, once it is needed', () => {
  let daemon: IsolatedDaemon | undefined
  let backend: FakeBackend | undefined
  let phone: RelayPhone | undefined
  afterEach(async () => {
    phone?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined; backend = undefined; phone = undefined
  })
  const settled = async (d: IsolatedDaemon) => {
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    // The others are up, and the core has had time to ask for anything it would ask for as it starts.
    await until('the services to connect', () => d.log().includes('[services] search connected') || null, 30_000, 200)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  const fresh = async (env: Record<string, string> = {}, before?: (d: IsolatedDaemon) => void) => {
    const d = await IsolatedDaemon.create({ env: { HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', ...env } })
    daemon = d
    before?.(d)
    await settled(d)
    return d
  }

  it('runs no gateway signed out with nothing paired, answers its status without it, and a window\'s E2EE request starts it', async () => {
    const d = await fresh()
    expect(starts(d), 'a gateway signed out with nothing paired').toBe(0)
    expect(d.log()).not.toContain('asking for the gateway\'s process')
    // `/api/status`, which everything asks: answered, and no gateway for it.
    expect(await status(d)).toMatchObject({ signedIn: false, fingerprint: null, pairs: [], pending: null })
    expect(starts(d)).toBe(0)
    // A window's E2EE request: it starts the gateway, waits for its start, and is the gateway's answer.
    const window = await LocalClient.connect(d)
    const [first, second] = await Promise.all([
      window.request('e2ee_pairings_list', {}, 30_000),
      window.request('e2ee_pairings_list', {}, 30_000),
    ])
    expect(first).toMatchObject({ pairs: [] })
    expect(second).toMatchObject({ pairs: [] })
    expect(starts(d)).toBe(1)
    expect(connections(d)).toBe(1)
    // Started, it answers the status from then on.
    expect((await status(d)).fingerprint).toEqual(expect.any(String))
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('a key command starts it and is answered by it; killed, it comes back and answers again', async () => {
    const d = await fresh()
    const pairs = async () => await (await fetch(`http://127.0.0.1:${d.port}/api/pairs`)).json() as Record<string, any>
    expect(await pairs()).toEqual({ pairs: [] })
    expect(starts(d)).toBe(1)
    const [pid] = pidsOf(d)
    process.kill(pid, 'SIGKILL')
    await until('the master to start the gateway again', () => starts(d) >= 2 || null, 30_000, 200)
    await until('the gateway to connect again', () => connections(d) >= 2 || null, 30_000, 200)
    expect(await pairs()).toEqual({ pairs: [] })
    expect(d.coresStarted()).toBe(1)
  })

  it('asks for it as the core starts with anything paired here, signed out too', async () => {
    const d = await fresh({}, (d) => {
      mkdirSync(join(d.dataDir, 'e2e'), { recursive: true })
      writeFileSync(join(d.dataDir, 'e2e', 'paired.json'), JSON.stringify([{ identityPub: b64e(newIdentity().pub), label: 'browser', pairedAt: 1, role: 'web' }]))
    })
    expect(d.log()).toContain('[gateway] a pairing: asking for the gateway\'s process')
    await until('the gateway to connect', () => connections(d) >= 1 || null, 30_000, 200)
    expect((await status(d)).pairs).toEqual([expect.objectContaining({ label: 'browser' })])
  })

  it('signing in starts it as the core starts, before it binds, and a phone reaches the machine', async () => {
    const fake = await FakeBackend.start()
    backend = fake
    const machine = { machineId: 'a1'.repeat(16), computerId: 'e2e-computer-0000-0000-00000000000a', name: 'machine-a', token: 'e2e-token-machine-a', identity: newIdentity() }
    fake.addMachine(machine)
    const phoneUser = { identity: newIdentity(), token: 'e2e-token-phone' }
    fake.addUser(phoneUser.token)
    const d = await IsolatedDaemon.create({ env: { ...remoteSettings(fake), ADAPTER_COMPUTER_ID: machine.computerId } })
    daemon = d
    await settled(d)
    expect(starts(d), 'a gateway before the sign-in').toBe(0)
    // `harness login` signs the computer in and restarts the daemon on it; the phone was paired with it.
    await d.stop()
    await signIn(d, machine)
    await writeE2ee(d, {
      'identity.json': { priv: b64e(machine.identity.priv), pub: b64e(machine.identity.pub) },
      'paired.json': [{ identityPub: b64e(phoneUser.identity.pub), label: 'phone', pairedAt: Date.now(), role: 'web' }],
    })
    const from = d.log().length
    const startedAt = Date.now()
    await d.start()
    const after = () => d.log().slice(from)
    expect(after()).toContain('[gateway] signed in: asking for the gateway\'s process')
    await until('the machine to be on the relay', () => fake.nodeUp(machine.machineId) || null, 30_000, 50)
    const onRelayMs = Date.now() - startedAt
    // Asked before the core bound: started beside it, not after it.
    const lines = after().split('\n')
    expect(lines.findIndex((line) => line.includes('[harnessd] service gateway started'))).toBeLessThan(lines.findIndex((line) => line.includes('[harnessd] core bound')))
    if (process.env.E2E_MEASURE) appendFileSync(process.env.E2E_MEASURE, `start to on the relay: ${onRelayMs} ms\n`)
    phone = new RelayPhone({ backend: fake, machineId: machine.machineId, identity: phoneUser.identity, machinePub: machine.identity.pub, token: phoneUser.token })
    await phone.open(30_000)
    const window = await LocalClient.connect(d, { machineId: machine.machineId })
    const cwd = join(d.projectsDir, 'signed-in')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    await until('the agent to bind', async () => {
      const rows = (await window.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      return rows.find((row) => row.id === created.agent.id)?.sessionId || null
    }, 45_000, 500)
    const ended = phone.next(isTurn('turn_ended', created.agent.id), 45_000, 'turn_ended on the phone')
    expect(phone.send('message', { agentId: created.agent.id, content: 'from the phone, after signing in' })).toBe(true)
    await ended
    window.close()
  })

  it('named in HARNESSD_SERVICES, it starts with the daemon, signed out with nothing paired', async () => {
    const d = await fresh({ HARNESSD_SERVICES: 'search,gateway' })
    await until('the gateway to connect', () => connections(d) >= 1 || null, 30_000, 200)
    expect(d.log()).not.toContain('asking for the gateway\'s process')
  })
})
