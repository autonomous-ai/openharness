/**
 * The gateway — the relay and its end-to-end encryption — in a process of its own (docs/design/
 * 2026-10-06-core-boundary-next.md, step 10, R2), on the real daemon, signed in on the fake backend, with a
 * phone paired and reaching it through the fake relay (harness/relayPhone.ts) and the desktop window on the
 * machine itself. Whatever happens to the gateway's process — killed outright, hung, leaking memory, crashing
 * on every start — costs the remote clients alone: the window on this computer and every agent go on, the
 * core never restarts, and once the master has the gateway back the phone opens a new session and works.
 *
 * Nothing here reaches beyond this machine: the daemon's every server setting is the fake backend's.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { startFleet, startPhoneMachine, type Fleet, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone, type PhoneFrame } from './harness/relayPhone.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)

const isTurn = (type: string, agentId: string) => (frame: Frame | PhoneFrame) => frame.type === type && frame.agentId === agentId

/** This daemon's gateway: titled `harnessd-gateway` AND started by its own master, by the pid it logged. */
function gatewayPids(d: IsolatedDaemon): number[] {
  const ours = new Set([...d.log().matchAll(/\[harnessd\] service gateway started \(pid (\d+)\)/g)].map((match) => Number(match[1])))
  const table = execFileSync('ps', ['-A', '-o', 'pid=,command=']).toString().trim().split('\n')
  return table.map((line) => line.trim().match(/^(\d+)\s+(.*)$/)).filter((match): match is RegExpMatchArray => !!match)
    .filter(([, pid, command]) => command.trim() === 'harnessd-gateway' && ours.has(Number(pid))).map(([, pid]) => Number(pid))
}
/** ⌘K on a machine: its pick for a task (`route_task`), and its send to an agent anywhere (`route_send`). */
async function routeTask(client: LocalClient, text: string): Promise<Record<string, any>> {
  const requestId = randomUUID()
  const answered = client.next((frame) => frame.type === 'route_result' && frame.payload?.requestId === requestId, 30_000, 'route_result')
  client.send('route_task', { requestId, text })
  return (await answered).payload as Record<string, any>
}
const routeSend = (client: LocalClient, agentId: string, text: string) => client.request('route_send', { agentId, text }, 30_000)

const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service gateway started .* restart \d+/.test(line)).length
const connections = (d: IsolatedDaemon) => d.log().split('[services] gateway connected').length - 1

describe('the gateway in its own process', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  let desk: LocalClient | undefined
  afterEach(async () => {
    phone?.close()
    desk?.close()
    await world?.close()
    world = undefined; phone = undefined; desk = undefined
  })

  const fresh = async (env: Record<string, string> = {}, opts: { phone?: boolean } = {}) => {
    const w = await startPhoneMachine({ env: {
      HARNESSD_SERVICES: 'gateway',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    world = w
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-150).join('\n')}`)
      console.log(`---- fake backend saw\n${backend.seen.slice(-40).join('\n')}`)
    })
    desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'gateway')
    mkdirSync(cwd, { recursive: true })
    const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the agent to bind its conversation', async () => (await row(desk!, agentId))?.sessionId || null, 45_000, 500)
    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    if (opts.phone !== false) {
      await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
      await phone.open(30_000)
    }
    return { w, backend, machine, desk, phone, agentId }
  }
  /** A turn from the window on this computer, to its end: what the gateway's troubles must never touch. */
  const deskTurn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  /** A turn from the phone, to its end, as the phone sees it. */
  const phoneTurn = async (p: RelayPhone, agentId: string, content: string) => {
    const ended = p.next(isTurn('turn_ended', agentId), 45_000, `turn_ended on the phone (${content})`)
    expect(p.send('message', { agentId, content })).toBe(true)
    await ended
  }
  /** The phone back: once the machine is on the relay again, a new session, retried until it opens. */
  const reopen = async (w: PhoneMachine, p: RelayPhone) => {
    await until('the machine to be back on the relay', () => w.backend.nodeUp(w.machine.machineId) || null, 60_000, 200)
    await until('the phone to open a new session', async () => { await p.open(10_000); return true }, 60_000, 500)
  }

  it('serves the reported machine list during a gateway restart, and keeps account HTTP outside the core', async () => {
    const { machine, backend, desk, agentId } = await fresh({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '10000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '10000' }, { phone: false })
    const d = machine.daemon
    const machines = async () => {
      const response = await fetch(`http://127.0.0.1:${d.port}/api/machines`, { signal: AbortSignal.timeout(10_000) })
      return { status: response.status, body: await response.json() as Record<string, any> }
    }
    const first = await machines()
    expect(first.status).toBe(200)
    expect(first.body.data.machines.some((row: { machineId: string }) => row.machineId === machine.machineId)).toBe(true)
    expect(backend.seen).toContain('GET /api/machines')
    const pids = gatewayPids(d)
    expect(pids.length).toBe(1)
    for (const pid of pids) process.kill(pid, 'SIGKILL')
    await until('the gateway link to go away', () => !backend.nodeUp(machine.machineId) && gatewayPids(d).length === 0 || null, 5000, 50)
    const pairings = await desk.request('e2ee_pairings_list', {}, 5000)
    expect(pairings).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'gateway', retryable: true })
    const cached = await machines()
    expect(cached.status).toBe(200)
    expect(cached.body.data).toMatchObject({ machines: first.body.data.machines, stale: true, staleSince: expect.any(String) })
    await deskTurn(desk, agentId, 'the local core works while account HTTP restarts')
    await until('the gateway to reconnect', () => backend.nodeUp(machine.machineId) || null, 30_000)
    expect((await machines()).body.data.stale).not.toBe(true)
    backend.goDown()
    expect((await machines()).body.data.stale).toBe(true)
    expect(d.coresStarted()).toBe(1)
  })

  it('carries the phone from a process of its own: sealed both ways, with the core speaking to it in the clear', async () => {
    const { backend, machine, phone, desk, agentId } = await fresh()
    expect(gatewayPids(machine.daemon)).toHaveLength(1)
    expect(machine.daemon.log()).toContain('[services] gateway connected')
    await phoneTurn(phone, agentId, 'from the phone, through the gateway')
    await deskTurn(desk, agentId, 'from the desk, beside it')
    const relayed = [...(backend.webSent.get(phone.connId!) ?? []), ...(backend.webReceived.get(phone.connId!) ?? [])]
    expect(relayed.filter((f) => f.type === 'message' || f.type === 'turn_started').every((f) => (f.payload as any)?.__e2e)).toBe(true)
    expect(JSON.stringify(relayed)).not.toContain('through the gateway')
    // The machine's E2EE fingerprint and pairings, which the core asks the gateway for.
    const status = await (await fetch(`http://127.0.0.1:${machine.daemon.port}/api/status`)).json() as Record<string, any>
    expect(status.fingerprint).toEqual(expect.any(String))
    expect(status.pairs).toEqual([expect.objectContaining({ label: 'phone', role: 'web' })])
    expect(status.connected).toBe(true)
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('killed outright: the phone loses the machine and gets it back; the window and the agents never notice', async () => {
    const { w, machine, phone, desk, agentId } = await fresh()
    const before = gatewayPids(machine.daemon)
    expect(before).toHaveLength(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    await until('the phone to know it has no session', () => !phone.ready || null, 20_000, 50)
    // The window on this computer works on, and so does the agent.
    await deskTurn(desk, agentId, 'while the gateway was gone')
    await until('the master to restart the gateway', () => restarts(machine.daemon) >= 1 || null, 30_000, 200)
    await until('the gateway to connect again', () => connections(machine.daemon) >= 2 || null, 30_000, 200)
    await reopen(w, phone)
    await phoneTurn(phone, agentId, 'after the gateway came back')
    expect(gatewayPids(machine.daemon).some((pid) => !before.includes(pid))).toBe(true)
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('hung: the master finds it by its heartbeat and starts it again; the core never waited on it', async () => {
    const { w, machine, phone, desk, agentId } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    for (const pid of gatewayPids(machine.daemon)) process.kill(pid, 'SIGSTOP')
    // Stopped, it reads nothing: the window's turns and their every event go on regardless.
    await deskTurn(desk, agentId, 'the core does not wait on a hung gateway')
    await until('the master to find the gateway hung', () => machine.daemon.log().includes('[harnessd] service gateway sent no heartbeat') || null, 30_000, 200)
    await until('the gateway to be started again', () => restarts(machine.daemon) >= 1 || null, 30_000, 200)
    await reopen(w, phone)
    await phoneTurn(phone, agentId, 'after the hang')
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('leaking: restarted at its memory budget, before it can hurt anything else', async () => {
    const { machine, desk, agentId } = await fresh({ HARNESSD_TEST_FAULTS: 'gateway.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' }, { phone: false })
    await until('the master to restart the gateway for memory', () => /\[harnessd\] service gateway: (its heap is at|it is using)/.test(machine.daemon.log()) || null, 60_000, 250)
    await until('the gateway to be started again', () => restarts(machine.daemon) >= 1 || null, 30_000, 200)
    await deskTurn(desk, agentId, 'the leak was the gateway\'s alone')
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('crashing on every start: parked, the phone cannot reach the machine, and the window and agents go on', async () => {
    const { w, machine, desk, agentId } = await fresh({ HARNESSD_TEST_FAULTS: 'gateway.crash', HARNESSD_SERVICE_PARK_CRASHES: '3' }, { phone: false })
    await until('the master to park the gateway', () => machine.daemon.log().includes('[harnessd] service gateway ended 3 times') || null, 60_000, 250)
    // Nothing dials the backend for this machine meanwhile: the phone cannot open a session.
    await expect(phone!.open(5_000)).rejects.toThrow()
    expect(w.backend.nodeUp(machine.machineId)).toBe(false)
    await deskTurn(desk, agentId, 'the gateway is parked and nothing else cares')
    // The pairings are the gateway's to tell: refused plainly, not hung.
    const pairs = await fetch(`http://127.0.0.1:${machine.daemon.port}/api/status`)
    expect(pairs.ok).toBe(true)
    expect(((await pairs.json()) as Record<string, any>).pairs).toEqual([])
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  describe('the fleet\'s lane from A to B, sealed by A\'s gateway', () => {
    let fleet: Fleet | undefined
    const clients: LocalClient[] = []
    afterEach(async () => {
      for (const client of clients.splice(0)) client.close()
      await fleet?.close()
      fleet = undefined
    })

    it('the relay never reads it; A\'s gateway killed costs the lane its sessions and nothing else, and they open again', async () => {
      const f = await startFleet({ dialOnA: true, envA: { HARNESSD_SERVICES: 'gateway', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
      fleet = f
      onTestFailed(() => {
        console.log(`---- daemon A log\n${f.a.daemon.log().split('\n').slice(-120).join('\n')}`)
        console.log(`---- daemon B log\n${f.b.daemon.log().split('\n').slice(-60).join('\n')}`)
      })
      await until('both machines connected to the backend', () => f.backend.nodeUp(f.a.machineId) && f.backend.nodeUp(f.b.machineId), 30_000)
      const onB = await LocalClient.connect(f.b.daemon, { machineId: f.b.machineId })
      const onA = await LocalClient.connect(f.a.daemon, { machineId: f.a.machineId })
      clients.push(onB, onA)
      const cwd = join(f.b.daemon.projectsDir, 'lane-b')
      mkdirSync(cwd, { recursive: true })
      const created = await onB.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agentId: string = created.agent.id
      await until('the agent on B to bind', async () => (await row(onB, agentId))?.sessionId || null, 45_000, 500)
      // The dial on A opens A's lane; its session with B is the gateway's, under A's identity.
      await f.dial!.greet()
      await until('A to list the agent on B', async () => (await routeTask(onA, 'anything')).agentId === agentId || null, 60_000, 1_000)
      expect(f.a.daemon.log()).toContain(`[device] device: e2e session ready ${f.b.machineId}`)
      const started = onB.next(isTurn('turn_started', agentId), 30_000, 'turn_started on B')
      expect(await routeSend(onA, agentId, 'sealed by the gateway')).toMatchObject({ ok: true })
      expect((await started).payload?.userMessage).toBe('sealed by the gateway')
      // What A's lane sent B went sealed: the relay saw sealed frames, and never the turn.
      const toB = () => f.backend.deviceSent.filter((frame) => frame.machineId === f.b.machineId && !String(frame.type).startsWith('e2e_'))
      expect(toB().some((frame) => (frame.payload as any)?.__e2e)).toBe(true)
      expect(JSON.stringify(f.backend.deviceSent)).not.toContain('sealed by the gateway')

      // A's gateway killed: the lane's sessions went with it. A's own window and agents never notice.
      const before = gatewayPids(f.a.daemon)
      expect(before).toHaveLength(1)
      for (const pid of before) process.kill(pid, 'SIGKILL')
      expect((await onA.request('agents_list', {}, 30_000)).error).toBeUndefined()
      await until('A\'s gateway to connect again', () => connections(f.a.daemon) >= 2 || null, 30_000, 200)
      // The lane starts a session with B again, through the new gateway, and delivers.
      const delivered = await until('A to deliver to B again', async () => {
        if ((await routeTask(onA, 'anything')).agentId !== agentId) return null
        const again = onB.next(isTurn('turn_started', agentId), 10_000, 'turn_started on B')
        const sent = await routeSend(onA, agentId, 'after the gateway came back')
        if (!sent.ok) { again.catch(() => {}); return null }
        return (await again.catch(() => null))?.payload?.userMessage === 'after the gateway came back' ? sent : null
      }, 120_000, 1_000)
      expect(delivered).toMatchObject({ ok: true })
      expect(f.a.daemon.log().split(`[device] device: e2e session ready ${f.b.machineId}`).length - 1).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(f.backend.deviceSent)).not.toContain('after the gateway came back')
      expect(f.a.daemon.coresStarted()).toBe(1)
    })
  })

  describe('a window on this computer working on another machine, through the gateway', () => {
    let fleet: Fleet | undefined
    const clients: LocalClient[] = []
    afterEach(async () => {
      for (const client of clients.splice(0)) client.close()
      await fleet?.close()
      fleet = undefined
    })

    it('keeps a remote pane connected when its agent list exceeds the desktop request limit', async () => {
      const f = await startFleet({ envA: { HARNESSD_SERVICES: 'gateway' } })
      fleet = f
      await until('both machines connected to the backend', () => f.backend.nodeUp(f.a.machineId) && f.backend.nodeUp(f.b.machineId), 30_000)
      const onB = await LocalClient.connect(f.b.daemon, { machineId: f.b.machineId })
      clients.push(onB)
      const agentIds: string[] = []
      for (const index of [0, 1]) {
        const cwd = join(f.b.daemon.projectsDir, `large-list-${index}`)
        mkdirSync(cwd, { recursive: true })
        const created = await onB.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
        expect(created.error, JSON.stringify(created)).toBeUndefined()
        agentIds.push(created.agent.id)
        await until('the agent on B to bind', async () => (await row(onB, created.agent.id))?.sessionId || null, 45_000, 500)
        // Each update fits the desktop request limit; the combined reply does
        // not, as a real remote machine's larger agent roster did.
        expect((await onB.request('agent_update', { agentId: created.agent.id, name: `${index}-${'a'.repeat(300 * 1024)}` })).error).toBeUndefined()
      }
      const before = connections(f.a.daemon)
      const viaA = await LocalClient.connect(f.a.daemon, { machineId: f.b.machineId })
      clients.push(viaA)
      for (let read = 0; read < 3; read++) {
        const list = await viaA.request<{ agents: Array<{ id: string }> }>('agents_list', {}, 10_000)
        expect(Buffer.byteLength(JSON.stringify(list))).toBeGreaterThan(512 * 1024)
        expect(list.agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(agentIds))
      }
      const ended = viaA.next(isTurn('turn_ended', agentIds[0]), 30_000, 'a turn after the large agent list')
      viaA.send('message', { agentId: agentIds[0], content: 'still connected after the large roster' })
      await ended
      expect(viaA.closed).toBe(false)
      expect(connections(f.a.daemon)).toBe(before)
      expect(f.a.daemon.coresStarted()).toBe(1)
    })

    it('reaches B through A\'s gateway, sealed by it, and opens again once A\'s gateway is back', async () => {
      const f = await startFleet({ envA: { HARNESSD_SERVICES: 'gateway', HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
      fleet = f
      onTestFailed(() => {
        console.log(`---- daemon A log\n${f.a.daemon.log().split('\n').slice(-120).join('\n')}`)
        console.log(`---- daemon B log\n${f.b.daemon.log().split('\n').slice(-60).join('\n')}`)
      })
      await until('both machines connected to the backend', () => f.backend.nodeUp(f.a.machineId) && f.backend.nodeUp(f.b.machineId), 30_000)
      const onB = await LocalClient.connect(f.b.daemon, { machineId: f.b.machineId })
      clients.push(onB)
      const cwd = join(f.b.daemon.projectsDir, 'on-b')
      mkdirSync(cwd, { recursive: true })
      const created = await onB.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
      expect(created.error, JSON.stringify(created)).toBeUndefined()
      const agentId: string = created.agent.id
      await until('the agent on B to bind', async () => (await row(onB, agentId))?.sessionId || null, 45_000, 500)
      // The window on A selects B: A's local socket hands it to A's gateway, which holds the session to B.
      const viaA = await LocalClient.connect(f.a.daemon, { machineId: f.b.machineId })
      clients.push(viaA)
      await until('B\'s agents through A', async () => ((await viaA.request<{ agents: Array<{ id: string }> }>('agents_list', {}, 30_000)).agents ?? []).some((a) => a.id === agentId) || null, 60_000, 1_000)
      const ended = viaA.next(isTurn('turn_ended', agentId), 45_000, 'a turn on B from A\'s window')
      viaA.send('message', { agentId, content: 'from A\'s window, on B' })
      await ended
      // What A's gateway sent B went sealed: the relay never read the message.
      const relayed = [...f.backend.webSent.values(), ...f.backend.webReceived.values()].flat()
      expect(relayed.some((frame) => frame.type === 'message')).toBe(true)
      expect(JSON.stringify(relayed)).not.toContain('from A\'s window, on B')
      // A's gateway killed: the window's session to B ends with it, and A's own window never notices.
      const before = gatewayPids(f.a.daemon)
      expect(before).toHaveLength(1)
      const onA = await LocalClient.connect(f.a.daemon, { machineId: f.a.machineId })
      clients.push(onA)
      for (const pid of before) process.kill(pid, 'SIGKILL')
      await until('the window on B to be closed', () => viaA.closed || null, 20_000, 100)
      expect((await onA.request('agents_list', {}, 30_000)).error).toBeUndefined()
      await until('A\'s gateway to connect again', () => connections(f.a.daemon) >= 2 || null, 30_000, 200)
      await until('A\'s window to reach B again', async () => {
        const again = await LocalClient.connect(f.a.daemon, { machineId: f.b.machineId })
        clients.push(again)
        return ((await again.request<{ agents: Array<{ id: string }> }>('agents_list', {}, 15_000)).agents ?? []).some((a) => a.id === agentId) || null
      }, 90_000, 2_000)
      expect(f.a.daemon.coresStarted()).toBe(1)
    })
  })
})
