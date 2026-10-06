/**
 * The Wi-Fi device with the dials, in the devices' process (services/wifi.ts, docs/design/2026-10-06-core-
 * boundary-next.md, step 9), on the real daemon: a device paired with the machine reaches it through the
 * fake relay (harness/fakeWifiDevice.ts), its session the gateway's (in a process of its own), its service
 * the devices', every answer passing through the core:
 * - it is answered as it was in the core's process: its hello, its agents, a prompt with its receipt and the
 *   turn's events, and the focus a window gives;
 * - the devices' process killed: its session stays, it is told to resync and served on, the receipt of a
 *   prompt it sent before is kept, a new prompt works, and the core never restarts;
 * - two dials and a Wi-Fi device are three devices: each hears its own, the desk's turn reaches all three,
 *   and a dial unplugged costs the other two nothing;
 * - its service failing to start costs it alone: the dials and the agents go on, and
 *   `harness device receipt` says it is not running;
 * - paired, it starts the devices' process with the daemon, with no dial (core/devicesWake.ts), and what it
 *   sends while that process starts again is held by the core and answered.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeWifiDevice } from './harness/fakeWifiDevice.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents).find((agent) => agent.id === agentId)
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
const restarts = (w: PhoneMachine) => w.machine.daemon.log().split('\n').filter((line) => /\[harnessd\] service devices started .* restart \d+/.test(line)).length
const wifiConnections = (w: PhoneMachine) => w.machine.daemon.log().split('\n').filter((line) => line.includes('[services] wifi connected')).length

describe('the Wi-Fi device with the dials', () => {
  let world: PhoneMachine | undefined
  let device: FakeWifiDevice | undefined
  let window: LocalClient | undefined
  let desk: Desk | undefined
  afterEach(async () => {
    device?.close()
    window?.close()
    await desk?.close()
    await world?.close()
    world = undefined; device = undefined; window = undefined; desk = undefined
  })

  const fresh = async (env: Record<string, string> = {}) => {
    const dials = join(mkdtempSync(join(tmpdir(), 'wifi-dials-')), 'dials.json')
    writeFileSync(dials, '[]')
    const w = await startPhoneMachine({ wifiDevice: true, env: {
      CABLE_DISABLE: 'false',
      HARNESSD_TEST_DIAL_PORT: dials,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    world = w
    desk = new Desk(dials)
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- the device heard\n${JSON.stringify(device?.events().slice(-20))}`)
    })
    window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'wifi')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the agent to bind its conversation', async () => (await row(window!, agentId))?.sessionId || null, 45_000, 500)
    device = new FakeWifiDevice({ backend, machineId: machine.machineId, identity: w.wifi.identity, machinePub: machine.identity.pub, token: w.wifi.token })
    await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    return { w, machine, window, agentId, device, desk: desk! }
  }
  /** The device's session and its application hello, retried until the service answers it. */
  const connect = async (d: FakeWifiDevice) => {
    await until('the device to open a session', async () => { await d.open(10_000); return true }, 60_000, 500)
    return until('the device\'s hello to be answered', async () => {
      const answer = await d.hello().catch(() => null)
      return answer?.proto === 1 ? answer : null
    }, 60_000, 500)
  }
  const windowTurn = async (client: LocalClient, agentId: string, content: string) => {
    const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
    client.send('message', { agentId, content })
    await ended
  }
  const heard = (dial: FakeDial, t: string, since = 0, agentId?: string, ms = 45_000): Promise<DialMessage> =>
    dial.next((m) => m.t === t && (agentId === undefined || m.agentId === agentId), ms, t, since)
  const onTab = (client: LocalClient, agentIds: string[]): void => {
    client.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds, panes: agentIds.length }], tiles: [] })
    client.send('app_panes', { agentIds, foreground: true })
  }
  /** A prompt from the device, to its turn's end as the device hears it. */
  const deviceTurn = async (d: FakeWifiDevice, machineId: string, agentId: string, key: string, text: string) => {
    const since = d.mark()
    const sent = await d.ask('turn.send', { machineId, agentId, idempotencyKey: key, text })
    expect(sent, JSON.stringify(sent)).toMatchObject({ status: 'accepted', receipt: { idempotencyKey: key } })
    await d.nextEvent((e) => e.kind === 'turn.started' && e.agentId === agentId, `turn.started (${text})`, since)
    await d.nextEvent((e) => (e.kind === 'turn.done' || e.kind === 'turn.summary') && e.agentId === agentId, `the turn's end (${text})`, since)
    return sent
  }

  // In the core's process too, with every service (`HARNESSD_SERVICES=none`): the same doors, called.
  it.each([['from the devices\' process', {}], ['from the core\'s own, with every service there', { HARNESSD_SERVICES: 'none' }]] as const)(
    'is answered %s as it was: its hello, its agents, a prompt and its receipt, a question, a window\'s focus', async (_where, env) => {
    const { w, machine, window, agentId, device } = await fresh(env)
    const hello = await connect(device)
    expect(hello).toMatchObject({ type: 'hello_result', proto: 1, machineId: machine.machineId })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['agents.list', 'turn.send', 'receipt.get', 'focus.step', 'agent.subscribe']))
    const listed = await device.ask('agents.list')
    expect(listed.agents).toEqual([expect.objectContaining({ agentId, machineId: machine.machineId, engine: 'claude', state: 'idle' })])
    // A prompt from the device: typed into the pane, its turn's events, and its receipt.
    await deviceTurn(device, machine.machineId, agentId, 'first', 'hello from the device')
    const receipt = await until('the prompt\'s receipt to settle', async () => {
      const answer = await device.ask('receipt.get', { idempotencyKey: 'first' })
      return answer.receipt && !['queued', 'delivered'].includes(answer.receipt.state) ? answer.receipt : null
    }, 30_000, 500)
    expect(receipt).toMatchObject({ idempotencyKey: 'first', agentId, machineId: machine.machineId })
    // The window, too, saw the turn the device sent.
    expect(window.frames.some((f) => f.type === 'turn_started' && f.agentId === agentId)).toBe(true)
    // A window moving to the agent moves the device's focus.
    const since = device.mark()
    window.send('app_focus', { agentId })
    const focus = await device.nextEvent((e) => e.kind === 'focus.changed' && e.payload?.focus?.agentId === agentId, 'focus.changed', since)
    expect(focus.payload.focus).toMatchObject({ machineId: machine.machineId, agentId })
    expect((await device.ask('focus.get')).focus).toMatchObject({ agentId })
    // A question the agent asks, answered from the device: through the core, into the pane.
    const asked = device.mark()
    window.send('message', { agentId, content: '!ask' })
    const open = await device.nextEvent((e) => e.kind === 'question.open' && e.agentId === agentId, 'question.open', asked)
    const question = (open.payload.questions as Array<Record<string, any>>)[0]
    const answered = await device.ask('question.answer', { machineId: machine.machineId, agentId, idempotencyKey: 'answer-1',
      questionRequestId: open.payload.questionRequestId, answers: { [question.key ?? question.q]: 'Coffee' } })
    expect(answered).toMatchObject({ status: 'accepted', receipt: { state: 'completed' } })
    await device.nextEvent((e) => e.kind === 'question.close' && e.agentId === agentId, 'question.close', asked)
    // `harness device receipt`, through the core's hook server, asks the service in its process.
    const credential = readFileSync(join(machine.daemon.dataDir, 'hook-credential'), 'utf8').trim()
    const deviceId = (await device.ask('receipt.get', { idempotencyKey: 'first' })).receipt
    expect(deviceId).toBeTruthy()
    const status = await fetch(`http://127.0.0.1:${machine.daemon.port}/api/autonomous-device/status`, { headers: { authorization: `Bearer ${credential}` } })
    expect(status.status).toBe(200)
    expect(w.machine.daemon.coresStarted()).toBe(1)
  })

  it('the devices\' process killed: its session stays, it is told to resync and served on, its receipts kept, and the core never restarts', async () => {
    const { w, machine, window, agentId, device } = await fresh()
    const hello = await connect(device)
    await deviceTurn(device, machine.machineId, agentId, 'before', 'before the kill')
    const sessions = device.link.sessions
    const since = device.mark()
    for (const pid of devicesPids(machine.daemon)) process.kill(pid, 'SIGKILL')
    // Every agent and window goes on meanwhile.
    await windowTurn(window, agentId, 'while the devices are down')
    await until('the master to restart the devices', () => restarts(w) >= 1 || null, 30_000, 200)
    await until('the Wi-Fi device to connect again', () => wifiConnections(w) >= 2 || null, 30_000, 200)
    // Told to resync on the session it had: the documented way back after the daemon's own restart.
    const resync = await device.nextEvent((e) => e.type === 'resync', 'resync', since)
    expect(resync).toMatchObject({ reason: 'instance_changed' })
    expect(resync.serverInstanceId).not.toBe(hello.serverInstanceId)
    expect(device.link.sessions).toBe(sessions)
    // Served on without a new hello: its agents, the receipt of the prompt it sent before, a new prompt.
    expect((await device.ask('agents.list')).agents).toEqual([expect.objectContaining({ agentId })])
    expect((await device.ask('receipt.get', { idempotencyKey: 'before' })).receipt).toMatchObject({ idempotencyKey: 'before', agentId })
    await deviceTurn(device, machine.machineId, agentId, 'after', 'after the kill')
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('paired, it starts the devices\' process with the daemon, and a hello it sends once while that process starts again is held and answered', async () => {
    const { machine, agentId, device } = await fresh()
    const log = () => machine.daemon.log()
    // No dial here: its pairing asks for the process (core/devicesWake.ts).
    await until('the Wi-Fi device\'s service to connect', () => wifiConnections(world!) >= 1 || null, 30_000, 200)
    expect(log()).toContain('[devices] a paired Wi-Fi device: asking for the devices\' process')
    await connect(device)
    for (const pid of devicesPids(machine.daemon)) process.kill(pid, 'SIGKILL')
    await until('the core to see the service go', () => log().includes('[services] wifi disconnected') || null, 15_000, 50)
    // One hello, no retry: held by the core while the process starts, handed on once its service is resumed.
    const hello = await device.hello()
    expect(hello).toMatchObject({ type: 'hello_result', proto: 1, machineId: machine.machineId })
    expect(wifiConnections(world!)).toBe(2)
    expect((await device.ask('agents.list')).agents).toEqual([expect.objectContaining({ agentId })])
    await deviceTurn(device, machine.machineId, agentId, 'held', 'the first prompt after the start')
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('two dials and a Wi-Fi device are three devices: each its own, the desk\'s turn on all three, and a dial unplugged costs the others nothing', async () => {
    const { machine, window, agentId, device, desk } = await fresh()
    onTab(window, [agentId])
    const a = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0b')
    await heard(a, 'agents.end')
    await heard(b, 'agents.end')
    await connect(device)
    // A turn from the device reaches both dials' tiles.
    const sinceA = a.messages.length, sinceB = b.messages.length
    await deviceTurn(device, machine.machineId, agentId, 'three', 'one turn, three devices')
    await heard(a, 'summary', sinceA, agentId)
    await heard(b, 'summary', sinceB, agentId)
    // Each dial its own settings, through the Devices tab; the Wi-Fi device hears none of theirs.
    const settingsA = a.messages.length, settingsB = b.messages.length
    expect(await window.request('harness_device_settings', { id: 'E2E-A', patch: { brightness: 10 } })).toMatchObject({ ok: true })
    await heard(a, 'settings.set', settingsA)
    expect(b.messages.slice(settingsB).some((m) => m.t === 'settings.set')).toBe(false)
    expect(device.events().some((e) => JSON.stringify(e).includes('brightness'))).toBe(false)
    // Dial A unplugged: dial B and the Wi-Fi device carry on.
    await desk.unplug('E2E-A')
    const sinceB2 = b.messages.length
    await deviceTurn(device, machine.machineId, agentId, 'two', 'after a dial left')
    await heard(b, 'summary', sinceB2, agentId)
    expect(machine.daemon.coresStarted()).toBe(1)
  })

  it('its service failing to start costs it alone: the dials and the agents go on, and its receipts say it is not running', async () => {
    const { machine, window, agentId, device, desk } = await fresh({ HARNESSD_TEST_FAULTS: 'wifi' })
    onTab(window, [agentId])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, 'agents.end')
    await until('the Wi-Fi device\'s service to be left off', () => machine.daemon.log().includes('[service wifi] did not start · injected fault: wifi') || null, 30_000, 200)
    await device.open(30_000)
    // Its requests go unanswered, as frames lost on the way: it asks again later, by the same keys.
    await expect(device.ask('hello', { proto: 1 }, 5_000)).rejects.toThrow()
    const since = dial.messages.length
    await windowTurn(window, agentId, 'the dial and the agent go on')
    await heard(dial, 'summary', since, agentId)
    const credential = readFileSync(join(machine.daemon.dataDir, 'hook-credential'), 'utf8').trim()
    const receipt = await fetch(`http://127.0.0.1:${machine.daemon.port}/api/autonomous-device/receipt?deviceId=${encodeURIComponent('A'.repeat(43) + '=')}&idempotencyKey=k`, { headers: { authorization: `Bearer ${credential}` } })
    expect(receipt.status).toBe(503)
    expect(machine.daemon.coresStarted()).toBe(1)
  })
})
