/**
 * The Wi-Fi device with the dials, in the devices' process (services/wifi.ts, docs/design/2026-10-06-core-
 * boundary-next.md, step 9), on the real daemon: a device paired with the machine reaches it through the
 * fake relay (harness/fakeWifiDevice.ts), its session the gateway's (in a process of its own), its service
 * the devices', with requests and answers crossing their authenticated gateway peer:
 * - it is answered as it was in the core's process: its hello, its agents, a prompt with its receipt and the
 *   turn's events, and the focus a window gives;
 * - the devices' process killed: its session stays, it is told to resync and served on, the receipt of a
 *   prompt it sent before is kept, a new prompt works, and the core never restarts;
 * - two dials and a Wi-Fi device are three devices: each hears its own, the desk's turn reaches all three,
 *   and a dial unplugged costs the other two nothing;
 * - its service failing to start costs it alone: the dials and the agents go on, and
 *   `harness device receipt` says it is not running;
 * - paired, it starts the devices' process with the daemon, with no dial (core/devicesWake.ts), and what it
 *   sends while that process starts again is held by the gateway and answered.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
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
  let scriptPath: string
  beforeAll(() => {
    const bundle = process.env.E2E_BUNDLE_PATH
    if (!bundle) throw new Error('wifiDevice requires E2E_BUNDLE=1 or E2E_BUNDLE_PATH')
    scriptPath = bundle
  })
  let world: PhoneMachine | undefined
  let device: FakeWifiDevice | undefined
  let window: LocalClient | undefined
  let control: LocalClient | undefined
  let desk: Desk | undefined
  let dialsRoot: string | undefined
  let master: ChildProcess | undefined
  let masterClosed: { code: number | null; signal: NodeJS.Signals | null } | undefined
  afterEach(async () => {
    try {
      device?.close()
      window?.close()
      control?.close()
    } finally {
      try {
        await desk?.close()
      } finally {
        try {
          if (world) {
            // The fleet convenience closer suppresses daemon cleanup failures; acceptance must surface them.
            await world.machine.daemon.close()
            expect(await until('the fixture master to close', () => masterClosed ?? null, 5_000, 50))
              .toEqual({ code: 0, signal: null })
            expect(master?.stdout?.readableEnded).toBe(true)
            expect(master?.stderr?.readableEnded).toBe(true)
            expect(existsSync(world.machine.daemon.root)).toBe(false)
          }
        }
        finally {
          try { await world?.backend.close() }
          finally {
            if (dialsRoot) rmSync(dialsRoot, { recursive: true, force: true })
            world = undefined; device = undefined; window = undefined; control = undefined; desk = undefined; dialsRoot = undefined
            master = undefined; masterClosed = undefined
          }
        }
      }
    }
  })

  const createAgent = async (w: PhoneMachine, client: LocalClient, name: string) => {
    const cwd = join(w.machine.daemon.projectsDir, name)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    await until('the agent to bind its conversation', async () => (await row(client, created.agent.id))?.sessionId || null, 45_000, 500)
    return created.agent as { id: string; tmuxPane: string }
  }

  const fresh = async (env: Record<string, string> = {}) => {
    // Owned before startup: startPhoneMachine cleans its resources if it fails, then this test removes ours.
    dialsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'wifi-dials-')))
    const dials = join(dialsRoot, 'dials.json')
    writeFileSync(dials, '[]')
    const w = await startPhoneMachine({ wifiDevice: true, scriptPath, env: {
      CABLE_DISABLE: 'false',
      HARNESSD_TEST_DIAL_PORT: dials,
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    world = w
    master = w.machine.daemon.child!
    master.once('close', (code, signal) => { masterClosed = { code, signal } })
    desk = new Desk(dials)
    const { backend, machine } = w
    onTestFailed(() => {
      console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- the device heard\n${JSON.stringify(device?.events().slice(-20))}`)
    })
    window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const agent = await createAgent(w, window, 'wifi'), agentId = agent.id
    device = new FakeWifiDevice({ backend, machineId: machine.machineId, identity: w.wifi.identity, machinePub: machine.identity.pub, token: w.wifi.token })
    await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    return { w, machine, window, agent, agentId, device, desk: desk! }
  }
  /** The device's session and its application hello, retried until the service answers it. */
  const connect = async (d: FakeWifiDevice) => {
    await until('the device to open a session', async () => { await d.open(10_000); return true }, 60_000, 500)
    return until('the device\'s hello to be answered', async () => {
      const answer = await d.hello().catch(() => null)
      return answer?.proto === 1 ? answer : null
    }, 60_000, 500)
  }

  it.each(['supervised', 'inline'] as const)('prepares one Store agent through the WiFi protocol in %s composition and refuses occupied workspaces', async mode => {
    const { machine, window, device, agent } = await fresh(mode === 'inline' ? { HARNESSD_SERVICES: 'none' } : {})
    const packageId = 'e2e/wifi-store-create', source = join(machine.daemon.root, 'wifi-store-package')
    mkdirSync(join(source, 'template'), { recursive: true })
    writeFileSync(join(source, 'harness.json'), JSON.stringify({ spec: 1, id: packageId, name: 'WiFi Store Fixture', engine: 'claude',
      toolchain: { setup: './setup.sh', doctor: './doctor.sh' }, workspace: { template: 'template', marker: 'fixture.txt' } }))
    writeFileSync(join(source, 'setup.sh'), '#!/bin/sh\nprintf ready > dependency\n', { mode: 0o755 })
    writeFileSync(join(source, 'doctor.sh'), '#!/bin/sh\ntest -f dependency || exit 1\nprintf "ok fixture\\n"\n', { mode: 0o755 })
    writeFileSync(join(source, 'template', 'fixture.txt'), 'local package fixture\n')
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], {
      timeout: 10_000, env: { ...machine.daemon.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })
    git('init', '-q', '-b', 'main'); git('add', '.')
    git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'local fixture')
    expect(await window.request('dsh_install', { url: source }, 180_000)).toMatchObject({ ok: true, id: packageId })
    await connect(device)
    expect(await device.ask('store.inspect', { packageId })).toMatchObject({ package: { installed: true } })
    const cwd = join(machine.daemon.projectsDir, 'wifi-prepared'); mkdirSync(cwd)
    const prepare = { machineId: machine.machineId, packageId, workspace: { kind: 'existing', path: cwd }, idempotencyKey: 'store-create' }
    const accepted = await device.ask('agent.prepare', prepare)
    expect(accepted).toMatchObject({ status: 'accepted', operation: { packageId, taskDispatched: false } })
    const completed = await until('the WiFi Store creation to settle', async () => {
      const answer = await device.ask('operation.get', { operationId: accepted.operation.operationId })
      expect(answer.error).toBeUndefined()
      return ['ready', 'failed', 'needs_user_action'].includes(answer.operation.state) ? answer.operation : null
    }, 90_000, 250)
    expect(completed).toMatchObject({ state: 'ready', phase: 'complete', packageId, workspace: realpathSync(cwd), taskDispatched: false, error: null })
    expect(completed.agentId).toEqual(expect.any(String))
    const made = await until('the prepared agent conversation to bind', async () => {
      const found = await row(window, completed.agentId)
      return found?.sessionId ? found : null
    }, 45_000, 250)
    // Registry stores only enabled bypass; the public agent frame has always emitted its absence as null.
    expect(made).toMatchObject({ project: { cwd: realpathSync(cwd) }, dsh: packageId, engine: 'claude',
      bypassPermission: null, permissionMode: null, grid: null, codexHome: null, claudeHome: null, namedAgent: null })
    expect(readFileSync(join(cwd, 'fixture.txt'), 'utf8')).toBe('local package fixture\n')
    expect(await device.ask('agent.prepare', prepare)).toMatchObject({ status: 'duplicate', operation: { operationId: completed.operationId, agentId: completed.agentId } })
    const occupied = await device.ask('agent.prepare', { ...prepare, workspace: { kind: 'existing', path: join(machine.daemon.projectsDir, 'wifi') }, idempotencyKey: 'occupied-workspace' })
    const refused = await until('the occupied workspace preparation to refuse', async () => {
      const answer = await device.ask('operation.get', { operationId: occupied.operation.operationId })
      expect(answer.error).toBeUndefined()
      return ['ready', 'failed', 'needs_user_action'].includes(answer.operation.state) ? answer.operation : null
    }, 30_000, 250)
    expect(refused).toMatchObject({ state: 'needs_user_action', agentId: null, taskDispatched: false, error: { code: 'WORKSPACE_IN_USE' } })
    const listed = await window.request<{ agents: Array<{ id: string }> }>('agents_list', {}, 30_000)
    expect(listed.agents.map(item => item.id).sort()).toEqual([agent.id, completed.agentId].sort())
    expect(existsSync(join(machine.daemon.projectsDir, 'wifi', 'fixture.txt'))).toBe(false)
    await deviceTurn(device, machine.machineId, completed.agentId, 'store-created-turn', 'the prepared agent works')
    await windowTurn(window, agent.id, 'the occupied agent remains unchanged')
  }, 240_000)
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
  /** One agent makes the requested step unambiguous; still observe the actual window mutation. */
  const gestures = async (client: LocalClient, d: FakeWifiDevice, agentId: string, key: string) => {
    onTab(client, [agentId])
    // This reply follows the desk notices on the devices link: no sleep guesses whether the tab arrived.
    expect((await client.request('harness_devices_list')).error).toBeUndefined()
    if ((await d.ask('focus.get')).focus?.agentId !== agentId) {
      const since = d.mark()
      client.send('app_focus', { agentId })
      // The app echo is an actual focus observation, not a guessed revision in the test.
      await d.nextEvent(e => e.kind === 'focus.changed' && e.payload?.focus?.agentId === agentId, 'gesture focus', since)
    }
    const focus = await d.ask('focus.get')
    const fromFocus = client.frames.length
    const step = { direction: 'next', idempotencyKey: key, focusRevision: focus.focusRevision }
    const stepped = await d.ask('focus.step', step)
    expect(stepped).toMatchObject({ focus: { agentId } })
    await client.waitFor(f => f.type === 'dial_focus' && f.payload?.agentId === agentId, 15_000, 'gesture dial_focus', fromFocus)
    expect(await d.ask('focus.step', step)).toMatchObject({ focus: stepped.focus, focusRevision: stepped.focusRevision })
    // The sentinel is on the same physical window stream as a repeated focus effect would be.
    expect((await client.request('harness_devices_list')).error).toBeUndefined()
    expect(client.frames.slice(fromFocus).filter(frame => frame.type === 'dial_focus')).toHaveLength(1)
    const fromScroll = client.frames.length
    const strokes = [{ phase: 'down', dy: 0, velocity: 0 }, { phase: 'move', dy: 7, velocity: 2 }, { phase: 'up', dy: 0, velocity: 0 }]
    for (const stroke of strokes) {
      const since = client.frames.length
      expect((await d.ask('scroll', stroke)).error).toBeUndefined()
      await client.waitFor(f => f.type === 'dial_scroll' && f.payload?.phase === stroke.phase && f.payload?.dy === stroke.dy,
        15_000, `gesture ${stroke.phase}`, since)
    }
    expect(client.frames.slice(fromScroll).filter(frame => frame.type === 'dial_scroll').map(frame => frame.payload)).toEqual(strokes)
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
  /** The receipt alone cannot prove a stop: observe the key in its engine and then a fresh successful turn. */
  const deviceStop = async (w: PhoneMachine, client: LocalClient, d: FakeWifiDevice, agent: { id: string; tmuxPane: string }) => {
    const { daemon, machineId } = w.machine, agentId = agent.id
    const path = join(daemon.engineConfig.root, 'interrupts')
    const interrupts = () => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []
    const before = interrupts().length, since = d.mark()
    expect(await d.ask('turn.send', { machineId, agentId, idempotencyKey: 'held-for-stop', text: '!hold' }))
      .toMatchObject({ status: 'accepted' })
    await d.nextEvent(e => e.kind === 'turn.started' && e.agentId === agentId, 'the held turn to start', since)
    await until('the held agent to read as working', async () => (await row(client, agentId))?.activity?.state === 'working' || null, 15_000, 100)
    const stop = { machineId, agentId, idempotencyKey: 'confirmed-stop' }
    expect(await d.ask('turn.stop', stop)).toMatchObject({ receipt: { idempotencyKey: 'confirmed-stop', state: 'completed' } })
    await until('the exact agent pane to take its interrupt', async () =>
      interrupts().length > before && (await daemon.capture(agent.tmuxPane)).includes('(interrupted)') || null, 15_000, 100)
    expect(interrupts().slice(before).map(line => line.split(' ')[0])).toEqual(['C-c'])
    expect(await d.ask('turn.stop', stop)).toMatchObject({ receipt: { idempotencyKey: 'confirmed-stop', state: 'completed' } })
    await deviceTurn(d, machineId, agentId, 'after-confirmed-stop', 'a fresh turn after Stop')
    expect(interrupts().slice(before).map(line => line.split(' ')[0])).toEqual(['C-c'])
  }
  const askQuestion = async (d: FakeWifiDevice, machineId: string, agentId: string, key: string) => {
    const since = d.mark()
    expect(await d.ask('turn.send', { machineId, agentId, idempotencyKey: key, text: '!ask' })).toMatchObject({ status: 'accepted' })
    return d.nextEvent(e => e.kind === 'question.open' && e.agentId === agentId, 'nonfocused question.open', since)
  }
  const answerQuestion = async (d: FakeWifiDevice, machineId: string, open: Record<string, any>, key: string) => {
    const since = d.mark(), question = open.payload.questions[0]
    const answer = await d.ask('question.answer', { machineId, agentId: open.agentId, idempotencyKey: key,
      questionRequestId: open.payload.questionRequestId, answers: { [question.key ?? question.q]: 'Coffee' } })
    expect(answer).toMatchObject({ status: 'accepted', receipt: { state: 'completed' } })
    await d.nextEvent(e => e.kind === 'question.close' && e.agentId === open.agentId, 'question.close', since)
  }

  // In the core's process too, with every service (`HARNESSD_SERVICES=none`): the same doors, called.
  it.each([['from the devices\' process', {}], ['from the core\'s own, with every service there', { HARNESSD_SERVICES: 'none' }]] as const)(
    'is answered %s as it was: its hello, its agents, a prompt and its receipt, a question, a window\'s focus', async (_where, env) => {
    const { w, machine, window, agent, agentId, device } = await fresh(env)
    const others = [await createAgent(w, window, 'question-b'), await createAgent(w, window, 'question-c')]
    const hello = await connect(device)
    expect(hello).toMatchObject({ type: 'hello_result', proto: 1, machineId: machine.machineId })
    expect(hello.capabilities).toEqual(expect.arrayContaining(['agents.list', 'turn.send', 'receipt.get', 'focus.step', 'agent.subscribe']))
    const listed = await device.ask('agents.list')
    expect(listed.agents).toHaveLength(3)
    expect(listed.agents).toEqual(expect.arrayContaining([agentId, ...others.map(agent => agent.id)]
      .map(agentId => expect.objectContaining({ agentId, machineId: machine.machineId, engine: 'claude', state: 'idle' }))))
    // A prompt from the device: typed into the pane, its turn's events, and its receipt.
    await deviceTurn(device, machine.machineId, agentId, 'first', 'hello from the device')
    const receipt = await until('the prompt\'s receipt to settle', async () => {
      const answer = await device.ask('receipt.get', { idempotencyKey: 'first' })
      return answer.receipt && !['queued', 'delivered'].includes(answer.receipt.state) ? answer.receipt : null
    }, 30_000, 500)
    expect(receipt).toMatchObject({ idempotencyKey: 'first', agentId, machineId: machine.machineId })
    // The window, too, saw the turn the device sent.
    expect(window.frames.some((f) => f.type === 'turn_started' && f.agentId === agentId)).toBe(true)
    await deviceStop(w, window, device, agent)
    // A window moving to the agent moves the device's focus.
    const since = device.mark()
    window.send('app_focus', { agentId })
    const focus = await device.nextEvent((e) => e.kind === 'focus.changed' && e.payload?.focus?.agentId === agentId, 'focus.changed', since)
    expect(focus.payload.focus).toMatchObject({ machineId: machine.machineId, agentId })
    expect((await device.ask('focus.get')).focus).toMatchObject({ agentId })
    await gestures(window, device, agentId, 'cohost-step')
    // No window, remote app or dial may supply question interest for this device.
    window.close()
    await until('the only window to close', () => window.closed || null, 10_000)
    // Both other agents ask together: observing only the former focus cannot satisfy this.
    const pending = []
    for (const [index, other] of others.entries()) pending.push(await askQuestion(device, machine.machineId, other.id, `ask-${index}`))
    expect(others.map(agent => agent.id)).not.toContain((await device.ask('focus.get')).focus?.agentId)
    for (const [index, open] of pending.entries()) {
      await answerQuestion(device, machine.machineId, open, `answer-${index}`)
      await until('the engine to show its chosen answer', async () =>
        (await machine.daemon.capture(others[index].tmuxPane)).includes('you chose Coffee') || null, 15_000, 100)
    }
    // `harness device receipt`, through the core's hook server, asks the service in its process.
    const credential = readFileSync(join(machine.daemon.dataDir, 'hook-credential'), 'utf8').trim()
    const deviceId = (await device.ask('receipt.get', { idempotencyKey: 'first' })).receipt
    expect(deviceId).toBeTruthy()
    const status = await fetch(`http://127.0.0.1:${machine.daemon.port}/api/autonomous-device/status`, { headers: { authorization: `Bearer ${credential}` } })
    expect(status.status).toBe(200)
    expect(w.machine.daemon.coresStarted()).toBe(1)
  })

  it('the devices\' process killed: both nonfocused questions return without a window, its receipts stay, and core sessions keep working', async () => {
    const { w, machine, window, agent, agentId, device } = await fresh({
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '20000', HARNESSD_SERVICE_MAX_BACKOFF_MS: '20000',
    })
    const others = [await createAgent(w, window, 'question-b'), await createAgent(w, window, 'question-c')]
    const hello = await connect(device)
    await deviceTurn(device, machine.machineId, agentId, 'before', 'before the kill')
    const focused = device.mark()
    window.send('app_focus', { agentId })
    await device.nextEvent(e => e.kind === 'focus.changed' && e.payload?.focus?.agentId === agentId, 'focus A', focused)
    window.close()
    await until('the only window to close', () => window.closed || null, 10_000)
    const pending = []
    for (const [index, other] of others.entries()) pending.push(await askQuestion(device, machine.machineId, other.id, `pending-${index}`))
    expect(others.map(agent => agent.id)).not.toContain((await device.ask('focus.get')).focus?.agentId)
    const corePid = machine.daemon.corePid()
    // An ordinary local tool does not observe questions or register an agents_watch interest.
    control = await LocalClient.connect(machine.daemon, { machineId: machine.machineId, tool: true })
    const sessions = device.link.sessions
    const since = device.mark()
    const before = devicesPids(machine.daemon)
    expect(before).toHaveLength(1)
    for (const pid of before) process.kill(pid, 'SIGKILL')
    await until('the devices process to end', () => devicesPids(machine.daemon).length === 0 || null, 10_000, 50)
    // The restart backoff leaves a bounded window for a real core input, with no component available.
    const absentDeadline = Date.now() + 15_000
    const remainingAbsentTime = (): number => {
      const remaining = absentDeadline - Date.now()
      expect(remaining, 'the full absent-component core check must finish within 15s').toBeGreaterThan(0)
      expect(devicesPids(machine.daemon), 'the component must not have restarted during the core check').toEqual([])
      return remaining
    }
    expect((await control.request('agents_list', {}, remainingAbsentTime())).agents).toHaveLength(3)
    control.send('message', { agentId, content: 'core input while devices are down' })
    await until('the core input to reach its agent while the component is down', async () =>
      /answer \d+: core input while devices are down/.test(await machine.daemon.capture(agent.tmuxPane)) || null, remainingAbsentTime(), 100)
    remainingAbsentTime()
    expect(machine.daemon.corePid()).toBe(corePid)
    control.close()
    await until('the ordinary tool to close', () => control!.closed || null, 10_000)
    await until('the master to restart the devices', () => restarts(w) >= 1 || null, 30_000, 200)
    await until('the Wi-Fi device to connect again', () => wifiConnections(w) >= 2 || null, 30_000, 200)
    // Told to resync on the session it had: the documented way back after the daemon's own restart.
    const resync = await device.nextEvent((e) => e.type === 'resync', 'resync', since)
    expect(resync).toMatchObject({ reason: 'instance_changed' })
    expect(resync.serverInstanceId).not.toBe(hello.serverInstanceId)
    expect(device.link.sessions).toBe(sessions)
    // Served on without a new hello: its agents, the receipt of the prompt it sent before, a new prompt.
    expect((await device.ask('agents.list')).agents).toHaveLength(3)
    // A resync means re-read status; it does not promise repeated question.open events to the device.
    for (const open of pending) {
      expect(await device.ask('status', { machineId: machine.machineId, agentId: open.agentId })).toMatchObject({
        openQuestion: { requestId: open.payload.questionRequestId, questions: open.payload.questions },
      })
    }
    for (const [index, open] of pending.entries()) {
      await answerQuestion(device, machine.machineId, open, `restored-answer-${index}`)
      await until('the engine to show its restored answer', async () =>
        (await machine.daemon.capture(others[index].tmuxPane)).includes('you chose Coffee') || null, 15_000, 100)
      expect(await device.ask('status', { machineId: machine.machineId, agentId: open.agentId })).toMatchObject({ openQuestion: null })
    }
    expect((await device.ask('receipt.get', { idempotencyKey: 'before' })).receipt).toMatchObject({ idempotencyKey: 'before', agentId })
    await deviceTurn(device, machine.machineId, agentId, 'after', 'after the kill')
    expect(machine.daemon.coresStarted()).toBe(1)
    expect(machine.daemon.corePid()).toBe(corePid)
  })

  it('paired, it starts the devices\' process with the daemon, and a hello it sends once while that process starts again is held and answered', async () => {
    // Explicit mixed composition: this worker owns only Wi-Fi; devices remain inline in the core.
    const { machine, window, agentId, device } = await fresh({ HARNESSD_SERVICES: 'wifi' })
    const log = () => machine.daemon.log()
    // No dial here: its pairing asks for the process (core/devicesWake.ts).
    await until('the Wi-Fi device\'s service to connect', () => wifiConnections(world!) >= 1 || null, 30_000, 200)
    expect(log()).toContain('[devices] a paired Wi-Fi device: asking for the devices\' process')
    await connect(device)
    expect(log()).not.toContain('[services] devices connected')
    await gestures(window, device, agentId, 'mixed-wifi-external')
    for (const pid of devicesPids(machine.daemon)) process.kill(pid, 'SIGKILL')
    await until('the core to see the service go', () => log().includes('[services] wifi disconnected') || null, 15_000, 50)
    // One hello, no retry: held by the gateway while the process starts, handed on once its service is resumed.
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
