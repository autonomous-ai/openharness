/** Paired owner commands belong to the optional devices process. Every daemon, relay and engine is private to
 * this test. OWNER_COMMANDS_FROM=<old bundle>/cli.js also checks a kept master's already-running worker: the new
 * core refuses visibly until a full restart, while an old core can use the new worker's dated private aliases. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { devicesPids } from './harness/desk.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

const FROM = process.env.OWNER_COMMANDS_FROM
const NO_EXECVE = fileURLToPath(new URL('./harness/noExecve.cjs', import.meta.url))
const body = ({ requestId: _requestId, ...answer }: Record<string, unknown>) => answer
const connections = (world: PhoneMachine) => world.machine.daemon.log().split('[services] devices connected').length - 1

describe('paired owner commands in the devices service', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  let window: LocalClient | undefined
  let installDir: string | undefined
  afterEach(async () => {
    phone?.close(); window?.close()
    await world?.close()
    if (installDir) rmSync(installDir, { recursive: true, force: true })
    world = undefined; phone = undefined; window = undefined; installDir = undefined
  })

  const connect = async (w: PhoneMachine) => {
    phone?.close(); window?.close()
    const { backend, machine } = w
    await until('the test machine on its private relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await phone.open()
    window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    return { phone, window }
  }
  const fresh = async (env: Record<string, string> = {}, scriptPath?: string) => {
    const w = world = await startPhoneMachine({ env, scriptPath })
    onTestFailed(() => console.log(`---- owner command daemon\n${w.machine.daemon.log().split('\n').slice(-150).join('\n')}`))
    return { w, ...await connect(w) }
  }
  const agent = async (w: PhoneMachine, client: LocalClient) => {
    const cwd = join(w.machine.daemon.projectsDir, 'owner-commands')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const id = created.agent.id as string
    await until('the isolated agent to bind', async () => {
      const listed = await client.request('agents_list', {})
      return listed.agents.find((row: Record<string, unknown>) => row.id === id && row.sessionId && row.status === 'active') || null
    }, 60_000, 250)
    return id
  }
  const localTask = async (client: LocalClient, text: string) => {
    const requestId = 'local-route'
    const reply = client.next(frame => frame.type === 'route_result' && frame.payload?.requestId === requestId)
    client.send('route_task', { requestId, text })
    return body((await reply).payload!)
  }
  const send = async (client: RelayPhone, agentId: string) => {
    const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, 'the routed turn to end')
    const result = await client.request('route_send', { agentId, text: 'owner command fixture' })
    expect(body(result)).toEqual({ ok: true })
    await ended
  }

  it('keeps sealed owner replies and local window shapes, and refuses forged private wrappers', async () => {
    const { w, phone, window } = await fresh()
    const id = await agent(w, window)
    expect(body(await phone.request('devices_ws', { frame: 'route_task', payload: { text: 'fixture' }, rpc: true, rpcRoute: true }, 30_000, true))).toEqual({ error: 'LOCAL_ONLY' })
    expect(body(await phone.request('route_task', { text: '  ' }))).toEqual({ error: 'INVALID_REQUEST' })
    const picked = body(await phone.request('route_task', { text: 'fixture' }))
    expect(picked).toMatchObject({ agentId: id, confidence: 1, weighed: 1, machines: 1 })
    expect(await localTask(window, 'fixture')).toEqual(picked)
    expect(await localTask(window, '  ')).toMatchObject({ agentId: '', reason: 'empty task' })
    await send(phone, id)
    expect(devicesPids(w.machine.daemon)).toHaveLength(1)
    expect(w.machine.daemon.coresStarted()).toBe(1)
  })

  it('answers a devices handler failure without executing owner commands in core, while ordinary turns continue', async () => {
    const { w, phone, window } = await fresh({ HARNESSD_TEST_FAULTS: 'devices.devices_ws' })
    const id = await agent(w, window)
    const core = w.machine.daemon.corePid()
    expect(body(await phone.request('route_task', { text: 'fixture' }))).toMatchObject({ agentId: '', reason: 'the devices service is unavailable', candidates: [] })
    expect(body(await phone.request('route_send', { agentId: id, text: 'not delivered' }))).toEqual({ ok: false, machine: '', reason: 'the devices service is unavailable' })
    const ended = phone.next(frame => frame.type === 'turn_ended' && frame.agentId === id, 45_000, 'an ordinary turn with the optional handler down')
    phone.send('message', { agentId: id, content: 'ordinary turn fixture' })
    await ended
    expect(w.machine.daemon.corePid()).toBe(core)
    expect(w.machine.daemon.coresStarted()).toBe(1)
  })

  const install = (bundle: string) => {
    copyFileSync(bundle, join(installDir!, 'cli.js'))
    copyFileSync(join(dirname(bundle), 'notify.mjs'), join(installDir!, 'notify.mjs'))
  }
  for (const oldWorker of [true, false]) it.skipIf(!FROM)(oldWorker
    ? 'reports an old worker refusal under a kept master, then recovers after a full daemon restart'
    : 'lets an old core use the new worker private aliases with the same replies', async () => {
    const current = process.env.E2E_BUNDLE_PATH
    if (!current) throw new Error('E2E_BUNDLE_PATH must name the retained current bundle')
    installDir = mkdtempSync(join(tmpdir(), 'owner-command-skew-'))
    writeFileSync(join(installDir, 'package.json'), '{"type":"module"}\n')
    install(oldWorker ? FROM! : current)
    const { w, phone: first, window: firstWindow } = await fresh({ NODE_OPTIONS: `--require=${JSON.stringify(NO_EXECVE)}` }, join(installDir, 'cli.js'))
    const id = await agent(w, firstWindow)
    const picked = body(await first.request('route_task', { text: 'fixture' }))
    expect(picked).toMatchObject({ agentId: id, confidence: 1 })
    const workers = devicesPids(w.machine.daemon)
    expect(workers).toHaveLength(1)
    const before = connections(w), core = w.machine.daemon.corePid()!
    install(oldWorker ? current : FROM!)
    process.kill(core, 'SIGKILL')
    await until('the kept devices worker to reach the replacement core', () => connections(w) > before || null, 60_000, 100)
    expect(w.machine.daemon.log()).toContain('this Node cannot re-execute a process: the master keeps its code')
    expect(w.machine.daemon.corePid()).not.toBe(core)
    expect(devicesPids(w.machine.daemon)).toEqual(workers)
    const next = await connect(w)
    if (oldWorker) {
      for (const type of ['route_task', 'route_send']) expect(body(await next.phone.request(type, { agentId: id, text: 'fixture' }))).toEqual({ error: 'LOCAL_ONLY' })
      expect(await localTask(next.window, 'fixture')).toEqual(picked)
      await w.machine.daemon.restart()
      const restarted = await connect(w)
      expect(body(await restarted.phone.request('route_task', { text: 'fixture' }))).toEqual(picked)
      await send(restarted.phone, id)
      expect(devicesPids(w.machine.daemon)).not.toEqual(workers)
    } else {
      expect(body(await next.phone.request('route_task', { text: 'fixture' }))).toEqual(picked)
      await send(next.phone, id)
    }
  })
})
