/**
 * What the dial and the windows hear of the devices, compared with another build's. The dial's firmware
 * and hn's dial.rs were written against the frames a released daemon sends, and the devices moving out of
 * the core (docs/design/2026-10-06-core-boundary-next.md, step 9) must not change one of them. A daemon of
 * that build (`COMPAT_FROM`, its bundled `cli.js`) and one of this checkout's bundle run the same scenario
 * with a fake dial on a pseudo-terminal (harness/fakeDial.ts) and a window on the local socket: the dial
 * greets; the window opens a tab with an agent on it; a turn runs; the dial focuses, opens, scrolls,
 * picks the tab, sends a turn, answers a question and forks; the window lists the devices.
 *
 * Every frame the dial heard (but its keepalive) and every frame of the devices' a window heard (`dial_*`,
 * `harness_devices_changed`) is compared by type and by shape: the keys of each, all the way down, once
 * ids, times and counters are made comparable. A type or a key on one side and not the other is a
 * difference; one listed in CHANGED is on purpose, with why.
 *
 * The Wi-Fi device too (harness/fakeWifiDevice.ts): paired with a signed-in machine and reaching it through
 * the fake relay, it says hello, lists its agents, follows the window's focus, sends a prompt and reads its
 * receipt, subscribes to an agent's live text, answers a question, scrolls the window's terminal, steps
 * along the desk and lists the Store. Every answer and event it heard, and the window's frames it caused,
 * are compared the same way.
 *
 * Skipped unless COMPAT_FROM names a bundle, as e2e/compat.e2e.ts is. `COMPAT_REPORT=<file>` writes both
 * sides, for reading.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeDial, type DialMessage } from './harness/fakeDial.js'
import { FakeWifiDevice } from './harness/fakeWifiDevice.js'
import { startPhoneMachine } from './harness/fleet.js'

const FROM = process.env.COMPAT_FROM

/** Types or shapes that differ on purpose, each with why. */
const CHANGED: Record<string, string> = {}

/** Types that one run may hear and the other not, by timing alone, each with why. */
const TIMING: Record<string, string> = {
  // The working card's activity line is read from the pane's footer while a turn runs: a fast fake turn
  // can end before the first read.
  'dial turn.activity': 'read from the pane while a turn runs; a fast turn can end first',
  // A summary's recap is cut when the turn ends; the dial redraws the tile from it when it lands.
  'dial notif.replace': 'the drawer is replaced when the window says what is unread, which is timing',
  // The dial's own focus, said back to it when its session re-asserts the tile it wants in front: whether
  // that lands before the scenario ends is timing, in every build.
  'dial focus': 'the dial\'s own focus said back as its session re-asserts it, which is timing',
}

/** A value's shape: its keys, all the way down; arrays as the shapes of their items. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return [...new Set(value.map((item) => JSON.stringify(shape(item))))].sort()
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]))
  }
  return typeof value
}

interface Heard {
  /** By `dial <t>` or `window <type>`: every shape it came in. */
  shapes: Map<string, Set<string>>
  /** What the scenario checked by value, as it found it. */
  values: Record<string, unknown>
  /** Everything the dial and the window heard, in order, for reading a difference (COMPAT_REPORT). */
  order: string[]
}

function hear(into: Heard, key: string, value: unknown): void {
  const shapes = into.shapes.get(key) ?? new Set<string>()
  shapes.add(JSON.stringify(shape(value)))
  into.shapes.set(key, shapes)
}

/** One build's daemon, a dial and a window through the scenario; what both heard. */
async function scenario(scriptPath: string | undefined, label: string): Promise<Heard> {
  const dial = await FakeDial.open()
  const daemon = await IsolatedDaemon.create({ ...(scriptPath ? { scriptPath } : {}), env: { CABLE_DISABLE: 'false', HARNESSD_TEST_DIAL_PORT: dial.path } })
  onTestFailed(() => { console.log(`---- ${label} daemon log\n${daemon.log().split('\n').slice(-120).join('\n')}\n---- the dial heard\n${dial.messages.map((m) => m.t).join(' ')}`) })
  const heard: Heard = { shapes: new Map(), values: {}, order: [] }
  try {
    await daemon.start()
    const window = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, 'dial-compat')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    const agentId: string = created.agent.id
    await until('the agent to bind', async () => ((await window.request('agents_list', {})).agents as Array<Record<string, unknown>>)
      .find((agent) => agent.id === agentId)?.sessionId || null, 45_000, 500)
    // The window opens a tab with the agent on it, as the desktop does on every change.
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [agentId], panes: 1 }, { id: 't2', name: 'Other', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [agentId], foreground: true })
    // A moment for the tab to reach the devices, a process away from the window since step 9: a dial that
    // greets in the same millisecond is first shown the empty desk it was plugged into, then the tab. A dial
    // plugged in after the window opened its tab, as people do, is shown the tab.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await dial.greet()
    await dial.next((m) => m.t === 'agents.end', 30_000, 'the agent list')
    // A turn from the window: the dial is told it started and ended, and its recap.
    window.send('message', { agentId, content: 'hello dial' })
    await dial.next((m) => m.t === 'summary' && m.agentId === agentId, 45_000, 'the turn\'s summary')
    // What a hand on the dial does, as the window hears it.
    dial.send({ t: 'focus', agentId })
    await window.waitFor((f) => f.type === 'dial_focus', 15_000, 'dial_focus')
    dial.send({ t: 'agent.open', agentId })
    await window.waitFor((f) => f.type === 'dial_open', 15_000, 'dial_open')
    dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
    dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
    await window.waitFor((f) => f.type === 'dial_scroll' && f.payload?.phase === 'up', 15_000, 'dial_scroll')
    dial.send({ t: 'swarm.select', swarmId: 't2' })
    await window.waitFor((f) => f.type === 'dial_swarm', 15_000, 'dial_swarm')
    dial.send({ t: 'machines.list' })
    dial.send({ t: 'swarms.list' })
    await dial.next((m) => m.t === 'machines.end', 15_000, 'the machine list')
    // A turn from the dial runs in the agent's pane.
    const since = window.frames.length
    dial.send({ t: 'turn.send', agentId, text: 'from the dial' })
    await window.waitFor((f) => f.type === 'turn_started' && f.agentId === agentId && f.payload?.userMessage === 'from the dial', 30_000, 'the dial\'s turn', since)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === agentId, 45_000, 'the dial\'s turn ending', dial.messages.length - 1)
    // A question, answered on the dial.
    const asked = dial.messages.length
    window.send('message', { agentId, content: '!ask' })
    const question = await dial.next((m) => m.t === 'question' && m.agentId === agentId, 45_000, 'the question', asked)
    const q = (question.questions as Array<{ q: string; options: unknown[] }>)[0]
    dial.send({ t: 'question.read', agentId, requestId: 'read-1' })
    await dial.next((m) => m.t === 'question.state', 15_000, 'the question\'s state', asked)
    dial.send({ t: 'answer', agentId, requestId: question.id ?? question.requestId, answers: { [q.q]: 'Coffee' } })
    await dial.next((m) => m.t === 'question.close' && m.agentId === agentId, 45_000, 'the question closing', asked)
    // A fork from the dial: the window is told where it is.
    dial.send({ t: 'agent.fork', agentId })
    await window.waitFor((f) => f.type === 'dial_forked', 60_000, 'dial_forked')
    // The Devices tab.
    const listed = await window.request('harness_devices_list', {})
    hear(heard, 'reply harness_devices_list', { ...listed, requestId: 'r' })
    heard.values.devices = { protocol: listed.protocol, attached: listed.status?.attached, devices: (listed.status?.devices as unknown[] | undefined)?.length }
    // A window that connects now is told the dial is there.
    const late = await LocalClient.connect(daemon)
    const status = await late.waitFor((f) => f.type === 'dial_status', 15_000, 'dial_status at connect')
    heard.values.lateStatus = { attached: status.payload?.attached, fw: status.payload?.fw }
    late.close()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    for (const message of dial.messages as DialMessage[]) {
      if (message.t === 'ping') continue
      hear(heard, `dial ${message.t}`, message)
      heard.order.push(`dial ${JSON.stringify(message).slice(0, 160)}`)
    }
    for (const frame of window.frames as Frame[]) {
      if (!frame.type.startsWith('dial_') && frame.type !== 'harness_devices_changed' && frame.type !== 'voice_route_request') continue
      hear(heard, `window ${frame.type}`, frame)
    }
    heard.values.welcome = { product: dial.messages.find((m) => m.t === 'welcome')?.product }
    heard.values.open = window.frames.find((f) => f.type === 'dial_open')?.payload
    heard.values.focus = window.frames.find((f) => f.type === 'dial_focus')?.payload
    heard.values.swarm = window.frames.find((f) => f.type === 'dial_swarm')?.payload
    window.close()
    for (const value of [heard.values.open, heard.values.focus] as Array<Record<string, unknown> | undefined>) {
      if (value?.agentId === agentId) value.agentId = 'AGENT'
      if (value?.machineId) value.machineId = 'MACHINE'
    }
    return heard
  } finally {
    await daemon.close()
    await dial.close()
  }
}

/** Types the Wi-Fi device may hear in one run and not the other, by timing alone, each with why. */
const WIFI_TIMING: Record<string, string> = {
  // A summary's recap or a tool's card reaches the device as the core's mirror writes it; how many of a
  // fast fake turn's land before the scenario moves on is timing.
  'event turn.tool': 'a tool card of a fast fake turn, which lands or not before the scenario moves on',
  // The answer's text is flushed every few hundred milliseconds or at a size; a short fake answer may go in
  // one flush or in none before the final.
  'event stream.text': 'flushed on a timer or at a size: a short fake answer may land only in the final',
  'event stream.tool': 'the fake turn the subscription watched may call no tool',
}

/** One build's signed-in machine, a window and a Wi-Fi device through the scenario; what both heard. */
async function wifiScenario(scriptPath: string | undefined, label: string): Promise<Heard> {
  const world = await startPhoneMachine({ wifiDevice: true, ...(scriptPath ? { scriptPath } : {}) })
  const { backend, machine } = world
  const device = new FakeWifiDevice({ backend, machineId: machine.machineId, identity: world.wifi.identity, machinePub: machine.identity.pub, token: world.wifi.token })
  onTestFailed(() => { console.log(`---- ${label} daemon log\n${machine.daemon.log().split('\n').slice(-120).join('\n')}\n---- the device heard\n${JSON.stringify(device.events().slice(-30))}`) })
  const heard: Heard = { shapes: new Map(), values: {}, order: [] }
  try {
    const window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'wifi-compat')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    const agentId: string = created.agent.id
    await until('the agent to bind', async () => ((await window.request('agents_list', {})).agents as Array<Record<string, unknown>>)
      .find((agent) => agent.id === agentId)?.sessionId || null, 45_000, 500)
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [agentId], panes: 1 }], tiles: [] })
    window.send('app_panes', { agentIds: [agentId], foreground: true })
    await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    await until('the device to open a session', async () => { await device.open(10_000); return true }, 60_000, 500)
    const answers: Array<Record<string, any>> = []
    const ask = async (type: string, fields: Record<string, unknown> = {}) => {
      const answer = await device.ask(type, fields)
      answers.push(answer)
      return answer
    }
    const hello = await until('the hello to be answered', async () => (await device.ask('hello', { proto: 1 }).catch(() => null)) ?? null, 60_000, 500)
    answers.push(hello)
    const target = { machineId: machine.machineId, agentId }
    await ask('agents.list')
    await ask('status', target)
    await ask('recap', { ...target, n: 1 })
    // The window moves to the agent: the device's focus follows.
    let since = device.mark()
    window.send('app_focus', { agentId })
    await device.nextEvent((e) => e.kind === 'focus.changed' && e.payload?.focus?.agentId === agentId, 'focus.changed', since)
    const focus = await ask('focus.get')
    // A prompt from the device, its turn, and its receipt.
    since = device.mark()
    await ask('turn.send', { ...target, idempotencyKey: 'prompt-1', text: 'from the wifi device' })
    await device.nextEvent((e) => e.kind === 'turn.done' && e.agentId === agentId, 'the prompt\'s turn ending', since)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    await ask('receipt.get', { idempotencyKey: 'prompt-1' })
    // Its live text, while subscribed.
    const subscribed = await ask('agent.subscribe', { ...target, ttlSec: 60 })
    since = device.mark()
    window.send('message', { agentId, content: 'streamed to the device' })
    await device.nextEvent((e) => e.kind === 'stream.final' && e.agentId === agentId, 'stream.final', since)
    await ask('agent.unsubscribe', { subscriptionId: subscribed.subscriptionId })
    // A question, answered from the device.
    since = device.mark()
    window.send('message', { agentId, content: '!ask' })
    const open = await device.nextEvent((e) => e.kind === 'question.open' && e.agentId === agentId, 'question.open', since)
    const first = (open.payload.questions as Array<Record<string, any>>)[0]
    await ask('question.answer', { ...target, idempotencyKey: 'answer-1', questionRequestId: open.payload.questionRequestId,
      answers: { [first.question ?? first.q ?? first.header]: 'Coffee' } })
    await device.nextEvent((e) => e.kind === 'question.close' && e.agentId === agentId, 'question.close', since)
    // A stroke for the window's terminal, and a step along the desk.
    await ask('scroll', { phase: 'down', dy: 0, velocity: 0 })
    await ask('scroll', { phase: 'up', dy: 0, velocity: 0 })
    await window.waitFor((f) => f.type === 'dial_scroll' && f.payload?.phase === 'up', 15_000, 'dial_scroll')
    await ask('focus.step', { direction: 'next', idempotencyKey: 'step-1', focusRevision: focus.focusRevision })
    await ask('store.list')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    for (const answer of answers) hear(heard, `result ${answer.type}`, answer)
    for (const event of device.events()) {
      const key = `event ${event.kind ?? event.type}`
      hear(heard, key, event)
      heard.order.push(`${key} ${JSON.stringify(event).slice(0, 160)}`)
    }
    for (const frame of window.frames as Frame[]) {
      if (!frame.type.startsWith('dial_') && !frame.type.startsWith('device_')) continue
      hear(heard, `window ${frame.type}`, frame)
    }
    heard.values.hello = { proto: hello.proto, capabilities: [...(hello.capabilities as string[])].sort() }
    heard.values.agents = (answers[1].agents as Array<Record<string, unknown>>).map((agent) => ({ engine: agent.engine, state: agent.state, runtime: agent.runtime }))
    heard.values.focus = { agent: focus.focus?.agentId === agentId }
    window.close()
    return heard
  } finally {
    device.close()
    await world.close()
  }
}

/** What two runs heard that differs, but for what is listed as changed or timing. */
function differ(before: Heard, after: Heard, timing: Record<string, string>): string[] {
  const differences: string[] = []
  for (const key of new Set([...before.shapes.keys(), ...after.shapes.keys()])) {
    if (CHANGED[key] || timing[key]) continue
    const was = before.shapes.get(key)
    const is = after.shapes.get(key)
    if (!was) { differences.push(`${key}: only in this build`); continue }
    if (!is) { differences.push(`${key}: not in this build`); continue }
    const lost = [...was].filter((s) => !is.has(s))
    const added = [...is].filter((s) => !was.has(s))
    if (lost.length || added.length) differences.push(`${key}: shapes ${JSON.stringify({ lost, added })}`)
  }
  return differences
}

describe.skipIf(!FROM)('the devices\' frames, against another build\'s', () => {
  afterEach(() => {})

  it('the dial and the windows hear the same frames, in the same shapes', async () => {
    const before = await scenario(FROM, 'released')
    const after = await scenario(process.env.E2E_BUNDLE_PATH, 'this build')
    if (process.env.COMPAT_REPORT) {
      const side = (heard: Heard) => ({ shapes: Object.fromEntries([...heard.shapes].map(([key, set]) => [key, [...set].map((s) => JSON.parse(s))])), values: heard.values, order: heard.order })
      writeFileSync(process.env.COMPAT_REPORT, JSON.stringify({ before: side(before), after: side(after) }, null, 2))
    }
    expect(differ(before, after, TIMING)).toEqual([])
    expect(after.values).toEqual(before.values)
  })

  it('the Wi-Fi device and the windows hear the same answers and events, in the same shapes', async () => {
    const before = await wifiScenario(FROM, 'released')
    const after = await wifiScenario(process.env.E2E_BUNDLE_PATH, 'this build')
    if (process.env.COMPAT_REPORT) {
      const side = (heard: Heard) => ({ shapes: Object.fromEntries([...heard.shapes].map(([key, set]) => [key, [...set].map((s) => JSON.parse(s))])), values: heard.values, order: heard.order })
      writeFileSync(`${process.env.COMPAT_REPORT}.wifi.json`, JSON.stringify({ before: side(before), after: side(after) }, null, 2))
    }
    expect(differ(before, after, WIFI_TIMING)).toEqual([])
    expect(after.values).toEqual(before.values)
  })
})
