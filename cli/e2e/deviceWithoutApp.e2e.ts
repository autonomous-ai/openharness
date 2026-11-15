/**
 * The device without the app (docs/specs/2026-11-13-device-without-the-app.md), on the real daemon: a fake Claude Code
 * started outside tmux, on a pseudo-terminal of its own as a terminal app starts one, runs its hooks, and a fake dial
 * (harness/fakeDial.ts) on the desk lists it beside a Harness agent in a tmux pane, with no window open:
 * - the machine list, each agent with where it lives and what the dial can do with it;
 * - the agent outside a pane goes idle, working, done with its answer, and waits for the person;
 * - the machine list keeps its order while an agent works, and a new agent comes last;
 * - it goes when its process does, and one already running when the dial is plugged in is listed;
 * - one the scan finds reads the name the person gave it in its own record, and its folder for a name Claude Code made up;
 * - a window brings back its tab's list, and closing it the machine's;
 * - talking to it is refused kindly, and `HARNESS_DEVICE_OBSERVED=off` leaves only the Harness agent.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
/** A Harness agent in a tmux pane, created as the desktop creates one. */
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

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`, and the end. */
interface Roster { rows: DialMessage[]; end: DialMessage }
function rosters(dial: FakeDial, since = 0): Roster[] {
  const out: Roster[] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push({ rows, end: m }); rows = null }
  }
  return out
}
/** The list the dial shows now, once it passes [test]. */
const showing = (dial: FakeDial, what: string, test: (roster: Roster) => boolean, since = 0, ms = 45_000): Promise<Roster> =>
  until(what, () => {
    const last = rosters(dial, since).at(-1)
    return last && test(last) ? last : null
  }, ms, 100)
const ids = (roster: Roster): unknown[] => roster.rows.map((r) => r.id)

describe('the device without the app', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  afterEach(async () => {
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })
  const fresh = async (env: Record<string, string> = {}): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...env } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    return { d, desk: theDesk }
  }
  const startOutside = async (d: IsolatedDaemon, folder: string, hints: Record<string, string>): Promise<Outside> => {
    const engine = await Outside.start(d, folder, hints)
    outside.push(engine)
    return engine
  }
  /** A window with a tab holding these agents, as the desktop says it on every change. */
  const onTab = (window: LocalClient, agentIds: string[]): void => {
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds, panes: agentIds.length }], tiles: [] })
    window.send('app_panes', { agentIds, foreground: true })
  }
  const heard = (dial: FakeDial, test: (m: DialMessage) => boolean, what: string, since = 0, ms = 45_000): Promise<DialMessage> =>
    dial.next(test, ms, what, since)

  it('with no window the dial lists a paneless claude and a tmux harness agent, with host and caps', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await showing(dial, 'the harness agent listed', (r) => ids(r).includes(harness))
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    const roster = await showing(dial, 'both agents on the machine list', (r) => ids(r).includes(harness) && ids(r).includes(engine.id))
    expect(roster.end).toMatchObject({ tab: '', view: 'machine', total: 2 })
    // On macOS a tap would start Harness Desktop: no test here taps it, as that would start the developer's own.
    expect(roster.rows.find((r) => r.id === harness)).toMatchObject({ host: 'harness', caps: process.platform === 'darwin' ? 'svfa' : 'sva' })
    // On macOS a tap brings Ghostty forward by its bundle id (cable/hosts/open.ts); elsewhere it has no way in.
    const caps = process.platform === 'darwin' ? 'sf' : 's'
    expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ name: 'in-ghostty', engine: 'claude', host: 'ghostty', caps })
    client.close()
  })

  it('the paneless agent goes idle → working → done with its last answer', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the agent listed', (r) => ids(r).includes(engine.id))
    // Idle: listed, and no turn told of it.
    const since = dial.messages.length
    expect(dial.messages.some((m) => m.agentId === engine.id)).toBe(false)
    engine.type('hello from ghostty')
    await heard(dial, (m) => m.t === 'turn.started' && m.agentId === engine.id, 'its turn started', since)
    const done = await heard(dial, (m) => m.t === 'turn.done' && m.agentId === engine.id, 'its turn done', since)
    const summary = await heard(dial, (m) => m.t === 'summary' && m.agentId === engine.id, 'its answer', since)
    expect(String(summary.text)).toContain('answer 1: hello from ghostty')
    expect(dial.messages.indexOf(summary)).toBeGreaterThan(dial.messages.indexOf(done))
  })

  it('a Notification makes it needs-you', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await startOutside(d, 'in-orca', { ORCA_AGENT_SESSION_ID: 'e2e-orca-session' })
    await showing(dial, 'the agent listed', (r) => ids(r).includes(engine.id))
    const since = dial.messages.length
    // It asks the person's permission to run a command, as Claude Code does in a turn: its Notification hook says so once
    // the prompt has waited 6 s.
    engine.type('!permit printf hi')
    await until('its Notification hook to run', () => engine.ran(d, 'Notification'), 30_000, 100)
    await heard(dial, (m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === engine.id && m.text === 'Waiting for you · Orca',
      'the waiting line', since)
    // Allowed in its own terminal: the line goes, and the turn goes on to its end.
    const answered = dial.messages.length
    engine.type('')
    await heard(dial, (m) => m.agentId === engine.id && (m.t === 'turn.done' || ((m.t === 'turn.started' || m.t === 'turn.activity') && m.text === '')),
      'the waiting line gone', answered)
    await heard(dial, (m) => m.t === 'turn.done' && m.agentId === engine.id, 'its turn done', answered)
  })

  it('the machine list keeps its order while an agent works, and a new agent comes last', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    // Listed with the app its hook named: a row the open scan found first is sent again once that hook comes.
    const settled = (id: string) => (r: Roster) => r.rows.find((row) => row.id === id)?.host === 'ghostty'
    const first = await startOutside(d, 'ring-a', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the first agent listed', settled(first.id))
    const second = await startOutside(d, 'ring-b', { TERM_PROGRAM: 'ghostty' })
    const two = await showing(dial, 'both agents listed', settled(second.id))
    expect(ids(two)).toEqual([first.id, second.id])
    const lists = rosters(dial).length
    const since = dial.messages.length
    // A whole turn: working, then done and not yet seen. Each used to move it and send the list again.
    first.type('hello from the ring')
    await heard(dial, (m) => m.t === 'turn.done' && m.agentId === first.id, 'its turn done', since)
    const third = await startOutside(d, 'ring-c', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the new agent listed', (r) => ids(r).includes(third.id))
    // Every list sent since the turn began holds all three, in the order they came: none was sent for the turn itself.
    const sent = rosters(dial).slice(lists).map(ids)
    expect(sent.length).toBeGreaterThan(0)
    for (const order of sent) expect(order).toEqual([first.id, second.id, third.id])
  })

  it('it disappears when its process exits', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    const since = rosters(dial).length
    await showing(dial, 'the agent listed', (r) => ids(r).includes(engine.id))
    engine.kill()
    // Its pid is looked at every 30 s.
    await showing(dial, 'the agent gone', (r) => !ids(r).includes(engine.id) && r.end.view === 'machine', 0, 60_000)
    expect(rosters(dial).length).toBeGreaterThan(since)
  })

  it('an agent started before the dial connects is listed', async () => {
    const { d, desk } = await fresh()
    // No device yet, so no devices process: its hooks reach nobody. A turn, so its conversation is on disk.
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    engine.type('before the dial')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    // Found by the scan the dial's attach runs (4-6 s after the plug here), not the next one a minute later.
    const roster = await showing(dial, 'the agent already running listed', (r) => ids(r).includes(engine.id), 0, 15_000)
    // Named by its folder, read from its transcript as a terminal's Claude Code writes it.
    expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ name: 'in-ghostty', engine: 'claude', host: 'terminal', caps: 's' })
  })

  it('an agent found by the scan reads the name the person gave it in its own record, one Claude Code made up reads its folder, and no log holds either', async () => {
    const { d, desk } = await fresh()
    // No device yet, so no devices process: their hooks reach nobody. A turn each, so their conversations are on disk.
    const mine = await startOutside(d, 'scratch-2016a', { TERM_PROGRAM: 'ghostty' })
    const made = await startOutside(d, 'scratch-2016b', { TERM_PROGRAM: 'ghostty' })
    for (const engine of [mine, made]) {
      engine.type('before the dial')
      await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    }
    mine.named(d, 'Tho 7f3a91c2', 'user')
    made.named(d, 'Fix login 5d2e8c41', 'derived')
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const roster = await showing(dial, 'both agents already running listed', (r) => ids(r).includes(mine.id) && ids(r).includes(made.id), 0, 15_000)
    expect(roster.rows.find((r) => r.id === mine.id)).toMatchObject({ name: 'Tho 7f3a91c2' })
    expect(roster.rows.find((r) => r.id === made.id)).toMatchObject({ name: 'scratch-2016b' })
    // A count, and neither name.
    expect(d.log()).toMatch(/\[observed\] scan · 2 found · \d+ app known · 1 named · \d+ ms/)
    expect(d.log()).not.toContain('7f3a91c2')
    expect(d.log()).not.toContain('5d2e8c41')
    // Its next prompt's hook says no name: the hook has the last word.
    const since = dial.messages.length
    mine.type('again')
    await showing(dial, 'mine named by its folder', (r) => r.rows.find((row) => row.id === mine.id)?.name === 'scratch-2016a', since)
  })

  it('opening a window brings back the tab\'s list; closing it brings the machine list', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await showing(dial, 'the harness agent listed', (r) => ids(r).includes(harness))
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    await showing(dial, 'the machine list', (r) => r.end.view === 'machine' && ids(r).includes(harness) && ids(r).includes(engine.id))
    const window = await LocalClient.connect(d)
    let since = dial.messages.length
    onTab(window, [harness])
    const tab = await showing(dial, 'the tab\'s list', (r) => r.end.tab === 't1', since)
    expect(ids(tab)).toEqual([harness])
    expect(tab.end.view).toBeUndefined()
    since = dial.messages.length
    window.close()
    const machine = await showing(dial, 'the machine list again', (r) => r.end.tab === '' && r.end.view === 'machine', since)
    expect(ids(machine)).toEqual(expect.arrayContaining([harness, engine.id]))
    client.close()
  })

  it('voice to the paneless agent gets voice.error on voice.end', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await startOutside(d, 'in-orca', { ORCA_AGENT_SESSION_ID: 'e2e-orca-session' })
    await showing(dial, 'the agent listed', (r) => ids(r).includes(engine.id))
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: engine.id, uploadId: 'e2e-voice-1', sr: 16_000 })
    dial.send({ t: 'voice.end', uploadId: 'e2e-voice-1' })
    const refused = await heard(dial, (m) => m.t === 'voice.error', 'the refusal', since)
    expect(refused).toMatchObject({
      uploadId: 'e2e-voice-1',
      message: 'This agent is in Orca. Talking to it from the device comes in an update.',
    })
  })

  it('HARNESS_DEVICE_OBSERVED=off lists only the harness agent', async () => {
    const { d, desk } = await fresh({ HARNESS_DEVICE_OBSERVED: 'off' })
    const client = await LocalClient.connect(d)
    const harness = await create(d, client, 'in-harness')
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await showing(dial, 'the harness agent listed', (r) => ids(r).includes(harness))
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    engine.type('hello from ghostty')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    // A Harness turn after it: its hooks' requests were long handled by the time this one ends.
    const ended = client.next(isTurn('turn_ended', harness), 45_000, 'the harness turn ending')
    client.send('message', { agentId: harness, content: 'after the outside turn' })
    await ended
    const since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const roster = await showing(dial, 'the list asked for', () => true, since)
    expect(ids(roster)).toEqual([harness])
    expect(roster.end).toMatchObject({ view: 'machine', total: 1 })
    expect(dial.messages.some((m) => m.agentId === engine.id || m.id === engine.id)).toBe(false)
    client.close()
  })
})
