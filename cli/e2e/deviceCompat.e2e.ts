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
 * Skipped unless COMPAT_FROM names a bundle, as e2e/compat.e2e.ts is. `COMPAT_REPORT=<file>` writes both
 * sides, for reading.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeDial, type DialMessage } from './harness/fakeDial.js'

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

describe.skipIf(!FROM)('the devices\' frames, against another build\'s', () => {
  afterEach(() => {})

  it('the dial and the windows hear the same frames, in the same shapes', async () => {
    const before = await scenario(FROM, 'released')
    const after = await scenario(process.env.E2E_BUNDLE_PATH, 'this build')
    if (process.env.COMPAT_REPORT) {
      const side = (heard: Heard) => ({ shapes: Object.fromEntries([...heard.shapes].map(([key, set]) => [key, [...set].map((s) => JSON.parse(s))])), values: heard.values, order: heard.order })
      writeFileSync(process.env.COMPAT_REPORT, JSON.stringify({ before: side(before), after: side(after) }, null, 2))
    }
    const differences: string[] = []
    for (const key of new Set([...before.shapes.keys(), ...after.shapes.keys()])) {
      if (CHANGED[key] || TIMING[key]) continue
      const was = before.shapes.get(key)
      const is = after.shapes.get(key)
      if (!was) { differences.push(`${key}: only in this build`); continue }
      if (!is) { differences.push(`${key}: not in this build`); continue }
      const lost = [...was].filter((s) => !is.has(s))
      const added = [...is].filter((s) => !was.has(s))
      if (lost.length || added.length) differences.push(`${key}: shapes ${JSON.stringify({ lost, added })}`)
    }
    expect(differences).toEqual([])
    expect(after.values).toEqual(before.values)
  })
})
