/**
 * The devices in a process of their own (services/devicesProcess.ts, docs/design/2026-10-06-core-boundary-
 * next.md, step 9), on the real daemon, with fake dials on pseudo-terminals (harness/fakeDial.ts) that greet
 * on the firmware's own cadence. One device failing never fails the core, another device or a running agent:
 * - the devices' process killed, hung, leaking or crashing on every start costs the dials alone, the core
 *   never restarts, ⌘K says so at once, and when the master brings the process back the dial comes back to
 *   its open question and its working tile;
 * - two dials are two devices: each its own settings and its own fate, the desk's cards on both;
 * - a dial unplugged and plugged in again and again, a dial whose session throws on every call, and a dial
 *   flooding its port with what no dial sends are each dropped alone, and come back.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk, devicesPids } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'


const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
async function create(daemon: IsolatedDaemon, client: LocalClient, folder: string): Promise<string> {
  const cwd = join(daemon.projectsDir, folder)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(created.error, `${folder}: ${JSON.stringify(created)}`).toBeUndefined()
  await until(`${folder} to bind its conversation`, async () => {
    const agent = await row(client, created.agent.id)
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 500)
  return created.agent.id
}
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId
async function turn(client: LocalClient, agentId: string, content: string): Promise<void> {
  const ended = client.next(isTurn('turn_ended', agentId), 45_000, `turn_ended (${content})`)
  client.send('message', { agentId, content })
  await ended
}
const restarts = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => /\[harnessd\] service devices started .* restart \d+/.test(line)).length
const connections = (d: IsolatedDaemon) => d.log().split('\n').filter((line) => line.includes('[services] devices connected')).length
/** ⌘K's pick for a typed task: `route_task` answers as `route_result`, under the asker's request id. */
async function routeTask(client: LocalClient, text: string): Promise<Record<string, any>> {
  const requestId = `route-${Math.random().toString(36).slice(2)}`
  const answered = client.next((frame) => frame.type === 'route_result' && frame.payload?.requestId === requestId, 40_000, 'route_result')
  client.send('route_task', { requestId, text })
  return (await answered).payload as Record<string, any>
}

describe('the devices in their own process', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  afterEach(async () => {
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  const fresh = async (env: Record<string, string> = {}): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: {
      CABLE_DISABLE: 'false',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200',
      HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000',
      ...env,
    } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    desk = new Desk(file)
    writeFileSync(file, '[]')
    const theDesk = desk
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    // No process until there is a device (core/devicesWake.ts): each test plugs its dials in, or asks for them.
    return { d, desk: theDesk }
  }
  /** A window with a tab holding these agents, as the desktop says it on every change. */
  const onTab = (window: LocalClient, agentIds: string[]): void => {
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds, panes: agentIds.length }], tiles: [] })
    window.send('app_panes', { agentIds, foreground: true })
  }
  const heard = (dial: FakeDial, t: string, since = 0, agentId?: string, ms = 45_000): Promise<DialMessage> =>
    dial.next((m) => m.t === t && (agentId === undefined || m.agentId === agentId), ms, t, since)

  it('runs the dial: a turn\'s cards, a hand on the dial, and the Devices tab, from a process of its own', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-dial')
    onTab(window, [agentId])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, 'agents.end')
    const since = dial.messages.length
    await turn(window, agentId, 'hello from the window')
    await heard(dial, 'turn.started', since, agentId)
    await heard(dial, 'summary', since, agentId)
    dial.send({ t: 'focus', agentId })
    await window.waitFor((f) => f.type === 'dial_focus' && f.payload?.agentId === agentId, 15_000, 'dial_focus')
    const listed = await window.request('harness_devices_list', {})
    expect(listed).toMatchObject({ protocol: 1, status: { attached: true } })
    expect(listed.status.devices).toHaveLength(1)
    // It is its own process, under the core's master.
    const [pid] = devicesPids(d)
    expect(pid).toBeGreaterThan(0)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('keeps the selected pane on the dial when another desktop connection closes', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const otherConnection = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-desk-connections')
    onTab(window, [agentId])
    onTab(otherConnection, [agentId])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, 'agents.end')
    let since = dial.messages.length
    window.send('app_focus', { agentId })
    await heard(dial, 'focus', since, agentId)
    since = dial.messages.length
    otherConnection.close()
    await until('the extra connection to close', () => otherConnection.closed || null, 5000, 50)
    // A forced list read passes behind connection cleanup and proves the
    // devices process still holds the surviving window's tab and selection.
    dial.send({ t: 'agents.list' })
    const roster = await heard(dial, 'agents.end', since)
    expect(roster.tab).toBe('t1')
    expect(dial.messages.slice(since).filter(m => m.t === 'agent').map(m => m.id)).toEqual([agentId])
    expect(dial.messages.slice(since).filter(m => m.t === 'agents.end').every(m => m.tab === 't1')).toBe(true)
    await heard(dial, 'focus', since, agentId)
    window.close()
    since = dial.messages.length
    await heard(dial, 'agents.end', since)
    await until('the last window to clear the dial', () => dial.messages.slice(since).some(m => m.t === 'agents.end' && m.tab === '') || null, 5000, 50)
  })

  it('restores a non-first focused pane on late attachment and after the devices process restarts', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    try {
      const first = await create(d, window, 'devices-first-pane')
      const focused = await create(d, window, 'devices-focused-pane')
      onTab(window, [first, focused])
      window.send('app_focus', { agentId: focused })
      // The socket has processed the selection before there is a device service to hear it.
      await window.request('agents_list', {})
      const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
      await heard(dial, 'focus', 0, focused, 20_000)
      const beforeRestart = dial.messages.length
      for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
      await until('the devices to reconnect', () => connections(d) >= 2 || null, 30_000, 200)
      await dial.welcomeAfter(beforeRestart, 30_000)
      await heard(dial, 'focus', beforeRestart, focused, 20_000)
      // No repeat app_focus was needed; the running window kept its original selection.
      expect(d.coresStarted()).toBe(1)
    } finally { window.close() }
  })

  it('killed outright: agents and windows go on, ⌘K says so at once, and the dial comes back to its question and its working tile', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const asking = await create(d, window, 'devices-asking')
    const other = await create(d, window, 'devices-other')
    onTab(window, [asking, other])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, 'agents.end')
    // A question, mid-turn: the tile is working and the dial is asked.
    window.send('message', { agentId: asking, content: '!ask' })
    const question = await heard(dial, 'question', 0, asking)
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGKILL')
    // Asked while they are down: an answer, not a hang.
    const started = Date.now()
    const sent = await window.request('route_send', { agentId: other, text: 'while the devices are down' }, 15_000)
    expect(sent.ok === false || sent.ok === true, JSON.stringify(sent)).toBe(true)
    expect(Date.now() - started).toBeLessThan(8_000)
    // The agents never noticed.
    await turn(window, other, 'the devices are gone and nothing else cares')
    await until('the master to restart the devices', () => restarts(d) >= 1 || null, 30_000, 200)
    await until('the devices to connect again', () => connections(d) >= 2 || null, 30_000, 200)
    // The dial greets on its own cadence, is welcomed by the new process, and is shown what was open.
    const back = dial.messages.length
    await dial.welcomeAfter(back, 45_000)
    const again = await heard(dial, 'question', back, asking)
    expect(again.id).toBe(question.id)
    await heard(dial, 'turn.started', back, asking)
    // Answered on the dial, as before the restart: the agent gets it.
    const shaped = (again.questions as Array<{ q: string }>)[0]
    const ended = window.next(isTurn('turn_ended', asking), 45_000, 'the asking turn ending')
    dial.send({ t: 'answer', agentId: asking, requestId: again.id, answers: { [shaped.q]: 'Coffee' } })
    await ended
    await heard(dial, 'question.close', back, asking)
    expect(await d.capture(String((await row(window, asking))?.tmuxPane))).toContain('you chose Coffee')
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('hung: the core never waits on it, the master kills it, and the dial comes back', async () => {
    const { d, desk } = await fresh({ HARNESSD_SERVICE_HEARTBEAT_TIMEOUT_MS: '2000' })
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-hung')
    onTab(window, [agentId])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, 'agents.end')
    for (const pid of devicesPids(d)) process.kill(pid, 'SIGSTOP')
    // ⌘K is the devices' to answer: it says it cannot, within its deadline, and typing never waited on it.
    const started = Date.now()
    expect(await window.request('route_send', { agentId, text: 'not delivered' }, 15_000)).toMatchObject({ ok: false, reason: 'the devices service is unavailable' })
    expect(Date.now() - started).toBeLessThan(8_000)
    await turn(window, agentId, 'the core never waited on the devices')
    await until('the master to find the devices hung', () => d.log().includes('[harnessd] service devices sent no heartbeat') || null, 30_000, 200)
    await until('the devices to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    const back = dial.messages.length
    await dial.welcomeAfter(back, 45_000)
    await turn(window, agentId, 'and the dial is back')
    await heard(dial, 'summary', back, agentId)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('leaking: restarted at its memory budget, before it can hurt anything else', async () => {
    const { d, desk } = await fresh({ HARNESSD_TEST_FAULTS: 'devices.leak', HARNESSD_SERVICE_HEAP_LIMIT_MIB: '128' })
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-leaking')
    await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await until('the master to restart the devices for memory', () => /\[harnessd\] service devices: (its heap is at|it is using)/.test(d.log()) || null, 60_000, 250)
    await until('the devices to be started again', () => restarts(d) >= 1 || null, 30_000, 200)
    await turn(window, agentId, 'the leak was the devices\' alone')
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('crashing on every start: parked, its requests say so at once, and the agents go on', async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', HARNESSD_TEST_FAULTS: 'devices.crash', HARNESSD_SERVICE_PARK_CRASHES: '3',
      HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '200', HARNESSD_SERVICE_MAX_BACKOFF_MS: '1000' } })
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    await d.start()
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-crash-loop')
    // The Devices tab's first request starts them; whatever it is answered, it is an answer.
    await window.request('harness_devices_list', {}, 45_000)
    await until('the master to park the devices', () => d.log().includes('[harnessd] service devices ended 3 times') || null, 60_000, 250)
    // Down now: each request is answered at once, ⌘K's too, not after its own 25 s.
    const asked = Date.now()
    expect(await window.request('harness_devices_list', {}, 10_000)).toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'devices', retryable: true })
    expect(await routeTask(window, 'fix the parser')).toMatchObject({ agentId: '', reason: 'the devices service is unavailable' })
    expect(Date.now() - asked).toBeLessThan(5_000)
    await turn(window, agentId, 'the devices are parked and nothing else cares')
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('two dials are two devices: each its own settings and fate, the desk\'s cards on both', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-two')
    onTab(window, [agentId])
    const a = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0b')
    await heard(a, 'agents.end')
    await heard(b, 'agents.end')
    const listed = await until('both dials on the Devices tab', async () => {
      const answer = await window.request('harness_devices_list', {})
      return (answer.status?.devices as unknown[] | undefined)?.length === 2 ? answer : null
    }, 30_000, 500)
    expect((listed.status.devices as Array<{ id: string }>).map((device) => device.id).sort()).toEqual(['E2E-A', 'E2E-B'])
    // A setting belongs to the glass it is set on.
    const sinceA = a.messages.length
    const sinceB = b.messages.length
    expect(await window.request('harness_device_settings', { id: 'E2E-B', patch: { brightness: 20 } })).toMatchObject({ ok: true })
    await heard(b, 'settings.set', sinceB)
    // The desk's work reaches both: they show the same desktop.
    await turn(window, agentId, 'both dials hear this')
    await heard(a, 'summary', sinceA, agentId)
    await heard(b, 'summary', sinceB, agentId)
    expect(a.messages.slice(sinceA).some((m) => m.t === 'settings.set')).toBe(false)
    // One unplugged: the other goes on, and the tab still names the one that left.
    await desk.unplug('E2E-A')
    await until('A to read as unplugged', async () => {
      const answer = await window.request('harness_devices_list', {})
      return (answer.status?.devices as Array<{ id: string; attached: boolean }> | undefined)?.find((device) => device.id === 'E2E-A')?.attached === false || null
    }, 30_000, 500)
    const stillB = b.messages.length
    await turn(window, agentId, 'b alone now')
    await heard(b, 'summary', stillB, agentId)
    // Plugged in again: welcomed as a dial that knows nothing.
    const again = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(again, 'agents.end')
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('unplugged and plugged in again and again: the other dial, the agents and the devices\' process carry on', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-storm')
    onTab(window, [agentId])
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0b')
    await heard(b, 'agents.end')
    for (let i = 0; i < 12; i++) {
      await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
      await new Promise((resolve) => setTimeout(resolve, 150 + (i % 3) * 400))
      await desk.unplug('E2E-A')
    }
    const since = b.messages.length
    await turn(window, agentId, 'after the storm')
    await heard(b, 'summary', since, agentId)
    const a = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(a, 'agents.end')
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('a dial whose session throws on every call is dropped alone, and its port looked at again', async () => {
    const { d, desk } = await fresh({ HARNESSD_TEST_FAULTS: 'dial.E2E-A' })
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-throwing')
    onTab(window, [agentId])
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0b')
    await heard(b, 'agents.end')
    await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await until('A to be dropped', () => /cable: \S+ dropped \(\d+ faults in a minute: injected fault: dial\.E2E-A\) — this dial alone/.test(d.log()) || null, 60_000, 250)
    const opened = () => d.log().split('\n').filter((line) => /cable: open on .* \[usb E2E-A\]/.test(line)).length
    const first = opened()
    await until('A\'s port to be looked at again', () => opened() > first || null, 30_000, 250)
    // The other dial never noticed.
    const since = b.messages.length
    await turn(window, agentId, 'b carries on')
    await heard(b, 'summary', since, agentId)
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })

  it('a dial flooding its port with what no dial sends is dropped alone, and comes back once it stops', async () => {
    const { d, desk } = await fresh()
    const window = await LocalClient.connect(d)
    const agentId = await create(d, window, 'devices-flooding')
    onTab(window, [agentId])
    const a = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0b')
    await heard(a, 'agents.end')
    await heard(b, 'agents.end')
    const flooded = Date.now()
    const pingsFrom = b.messages.length
    a.flood(Buffer.alloc(256 * 1024, 0x55))
    await until('A to be dropped for flooding', () => /dropped \(flooding the port: .*\) — this dial alone.*\[usb E2E-A\]/.test(d.log()) || null, 30_000, 250)
    const since = b.messages.length
    await turn(window, agentId, 'b carries on through the flood')
    await heard(b, 'summary', since, agentId)
    // The other dial's keepalive kept its beat through the flood: what a dial reads as its daemon alive.
    await heard(b, 'ping', b.messages.length, undefined, 15_000)
    const pings = b.messages.map((m, at) => ({ m, at: b.arrivedAt[at] })).slice(pingsFrom).filter(({ m }) => m.t === 'ping').map(({ at }) => at)
    const gaps = pings.slice(1).map((at, i) => at - pings[i])
    const dropped = d.log().match(/(\d\d:\d\d:\d\d\.\d{3}) \[cable\] cable: \S+ dropped \(flooding/)
    // `E2E_MEASURE=<file>`: what the pull request reports of the flood, kept.
    if (process.env.E2E_MEASURE) appendFileSync(process.env.E2E_MEASURE, `flood: dropped at ${dropped?.[1]} (sent ${new Date(flooded).toISOString().slice(11, 23)} UTC); the other dial's ping gaps ${gaps.join(', ')} ms\n`)
    expect(Math.max(...gaps)).toBeLessThan(10_000)
    // Quiet again, it is welcomed again on its next greeting once its wait is over.
    const back = a.messages.length
    await a.welcomeAfter(back, 60_000)
    expect(restarts(d)).toBe(0)
    expect(d.coresStarted()).toBe(1)
    window.close()
  })
})
