/**
 * The device without the app (docs/specs/2026-11-13-device-without-the-app.md), on the real daemon: a fake Claude Code
 * started outside tmux, on a pseudo-terminal of its own as a terminal app starts one, runs its hooks, and a fake dial
 * (harness/fakeDial.ts) on the desk lists it beside a Harness agent in a tmux pane, with no window open:
 * - the machine list, each agent with where it lives and what the dial can do with it;
 * - the agent outside a pane goes idle, working, done with its answer, and waits for the person;
 * - the machine list keeps its order while an agent works, and a new agent comes last;
 * - it goes when its process does, and one already running when the dial is plugged in is listed;
 * - one that answered before the dial is restored with its last answer, as history: nothing is told as done;
 * - one the scan finds reads the name the person gave it in its own record, the Claude app's own title, and its folder
 *   for a name Claude Code made up;
 * - a window brings back its tab's list, and closing it the machine's;
 * - talking to it is refused kindly, and `HARNESS_DEVICE_OBSERVED=off` leaves only the Harness agent;
 * - Claude Code in a tmux session the person opened (harness/ownTmux.ts) is listed with host tmux, takes the dial's words
 *   through its mod, and a tap moves the person's own tmux client to its pane, never one on a session Harness made;
 * - a ten-minute transcript, 10,000 characters, reaches Claude Code's mod whole in VS Code's terminal, and the dial hears
 *   it was sent;
 * - Claude Code in VS Code's extension panel, with no terminal, takes the dial's spoken words through its mod alone.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'
import { controlClient, InOwnTmux, type ControlClient } from './harness/ownTmux.js'

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
/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c5'.repeat(16), computerId: 'e2e-device-without-app-computer', name: 'Fixture', token: 'e2e-device-without-app-token' }
const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/** The mod's poll over the daemon's socket, as the mod sends it: its status and what it was answered. */
const inboxPoll = (d: IsolatedDaemon, sessionId: string): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: d.socketPath, path: '/api/hook/inbox', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let said = ''
        res.on('data', (chunk: Buffer) => { said += chunk.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(said) }))
      })
    req.on('error', reject)
    req.end(JSON.stringify({ sessionId }))
  })

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
  let backend: FakeBackend | undefined
  const outside: Outside[] = []
  const clients: ControlClient[] = []
  const children: ChildProcess[] = []
  afterEach(async () => {
    // Before any session goes: before tmux 3.7 a control client beside a closing session can crash the server.
    for (const client of clients.splice(0)) await client.close()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })
  /** A daemon of its own and a desk; with [relay], signed in to it as ME, for the dial's words. */
  const fresh = async (env: Record<string, string> = {}, relay?: FakeBackend): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const signIn = relay ? { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId } : {}
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...signIn, ...env } })
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
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    if (relay) writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
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
    // The dial held no agent until this list, so it is landed on its first, and the footer of the agent it shows is read.
    await heard(dial, (m) => m.t === 'focus' && m.agentId === engine.id, 'the dial landed on it')
    // Idle: listed, and no turn told of it: the landing and an empty footer only.
    const since = dial.messages.length
    expect(dial.messages.filter((m) => m.agentId === engine.id
      && m.t !== 'focus' && !(m.t === 'turn.activity' && m.text === ''))).toEqual([])
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

  it('an agent answered before the dial connects is restored with its last answer, and nothing is told as done', async () => {
    const { d, desk } = await fresh()
    // No device yet, so no devices process: its hooks reach nobody, and only the scan can find its answer.
    const engine = await startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })
    engine.type('before the dial')
    await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    await engine.idle(d)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const restored = await heard(dial, (m) => m.t === 'summary' && m.agentId === engine.id && m.restore === true,
      'its last answer restored', 0, 15_000)
    expect(String(restored.text)).toContain('answer 1: before the dial')
    // History, not news: no turn ended, and no answer told as new.
    expect(dial.messages.filter((m) => m.agentId === engine.id && (m.t === 'turn.done' || (m.t === 'summary' && m.restore !== true))))
      .toEqual([])
    // A count, and no answer.
    expect(d.log()).toMatch(/\[observed\] scan · 1 found · \d+ app known · 0 named · 1 answered · \d+ ms/)
    expect(d.log()).not.toContain('answer 1')
  })

  it('an agent found by the scan reads the name the person gave it in its own record, the Claude app\'s own title names it, one Claude Code made up reads its folder, and no log holds any', async () => {
    const { d, desk } = await fresh()
    // No device yet, so no devices process: their hooks reach nobody. A turn each, so their conversations are on disk.
    const mine = await startOutside(d, 'scratch-2016a', { TERM_PROGRAM: 'ghostty' })
    const made = await startOutside(d, 'scratch-2016b', { TERM_PROGRAM: 'ghostty' })
    const app = await startOutside(d, 'scratch-2016c', { TERM_PROGRAM: 'ghostty' })
    for (const engine of [mine, made, app]) {
      engine.type('before the dial')
      await until('its Stop hook to run', () => engine.ran(d, 'Stop'), 30_000, 100)
    }
    await mine.named(d, 'Tho 7f3a91c2', { nameSource: 'user' })
    await made.named(d, 'Fix login 5d2e8c41', { nameSource: 'derived' })
    // The Claude app's record: its title, with no nameSource.
    await app.named(d, 'Plan 9c4e1b07', { entrypoint: 'claude-desktop' })
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const roster = await showing(dial, 'the three agents already running listed',
      (r) => ids(r).includes(mine.id) && ids(r).includes(made.id) && ids(r).includes(app.id), 0, 15_000)
    expect(roster.rows.find((r) => r.id === mine.id)).toMatchObject({ name: 'Tho 7f3a91c2' })
    expect(roster.rows.find((r) => r.id === made.id)).toMatchObject({ name: 'scratch-2016b' })
    expect(roster.rows.find((r) => r.id === app.id)).toMatchObject({ name: 'Plan 9c4e1b07' })
    // A count, and no name.
    expect(d.log()).toMatch(/\[observed\] scan · 3 found · \d+ app known · 2 named · \d+ answered · \d+ ms/)
    expect(d.log()).not.toContain('7f3a91c2')
    expect(d.log()).not.toContain('5d2e8c41')
    expect(d.log()).not.toContain('9c4e1b07')
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

  it('Claude Code in a tmux session the person opened is listed with host tmux, works, and takes the dial\'s words through its mod', async () => {
    const { d, desk } = await fresh()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await InOwnTmux.start(d, 'own-claude', 'in-tmux')
    const roster = await showing(dial, 'the agent listed', (r) => r.rows.find((row) => row.id === engine.id)?.host === 'tmux')
    // No bundle id: a tap switches its pane and brings no app forward.
    expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ name: 'in-tmux', engine: 'claude', host: 'tmux', caps: 'sf' })
    // Nothing was registered for the pane.
    const client = await LocalClient.connect(d)
    expect(((await client.request('agents_list', { includeStopped: true }, 30_000)).agents as Array<{ tmuxPane?: string }>)
      .filter((agent) => agent.tmuxPane === engine.pane)).toEqual([])
    client.close()
    const since = dial.messages.length
    await engine.type('hello from tmux')
    await heard(dial, (m) => m.t === 'turn.started' && m.agentId === engine.id, 'its turn started', since)
    await heard(dial, (m) => m.t === 'turn.done' && m.agentId === engine.id, 'its turn done', since)
    const poll = inboxPoll(d, engine.sessionId)
    await showing(dial, 'voice once its mod polls', (r) => r.rows.find((row) => row.id === engine.id)?.caps === 'svf')
    dial.send({ t: 'turn.send', agentId: engine.id, text: 'from the dial' })
    expect(await poll).toEqual({ status: 200, body: { text: 'from the dial' } })
  })

  it('a ten-minute transcript, 10,000 characters, reaches Claude Code\'s mod whole, and the dial hears it was sent', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const { d, desk } = await fresh({}, relay)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    const engine = await startOutside(d, 'in-vscode', { TERM_PROGRAM: 'vscode' })
    await showing(dial, 'the agent listed', (r) => ids(r).includes(engine.id))
    const poll = inboxPoll(d, engine.sessionId)
    await showing(dial, 'voice once its mod polls', (r) => String(r.rows.find((row) => row.id === engine.id)?.caps ?? '').includes('v'))
    // About what ten minutes of speech transcribes to.
    const words = `${'word '.repeat(2_000).trim()}.`
    expect(words).toHaveLength(10_000)
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: engine.id, uploadId: 'e2e-long-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'e2e-long-1' })
    const answer = await heard(dial, (m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === 'e2e-long-1',
      'the answer to its words', since)
    // Sent, with no text: the dial's frame cannot hold 10,000 characters, and it has nothing to confirm.
    expect(answer).toMatchObject({ t: 'voice.transcript', agentId: engine.id, needsConfirm: false })
    expect(answer).not.toHaveProperty('text')
    expect(await poll).toEqual({ status: 200, body: { text: words } })
    expect(d.log()).not.toContain('word word')
  })

  it('Claude Code in VS Code\'s extension panel, with no terminal, takes the dial\'s spoken words through its mod alone', async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const { d, desk } = await fresh({}, relay)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await heard(dial, (m) => m.t === 'agents.end', 'the first list')
    // The panel's own hook, with no pseudo-terminal: the extension's word and the editor's bundle id are all it says, and
    // Orca's session id is cleared so nothing names an Orca terminal.
    const panel = new InOrca(d, 'in-vscode-panel', children,
      { __CFBundleIdentifier: 'com.microsoft.VSCode', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', ORCA_AGENT_SESSION_ID: '' })
    await panel.hook('SessionStart', { source: 'startup' })
    const listed = await showing(dial, 'the panel session listed', (r) => ids(r).includes(panel.id))
    // Seen as VS Code's, from its hints alone, with nothing to type into until its mod polls.
    const first = listed.rows.find((row) => row.id === panel.id)
    expect(first).toMatchObject({ name: 'in-vscode-panel', engine: 'claude', host: 'vscode', caps: expect.any(String) })
    expect(first?.caps).not.toContain('v')
    const poll = inboxPoll(d, panel.sessionId)
    await showing(dial, 'voice once its mod polls', (r) => String(r.rows.find((row) => row.id === panel.id)?.caps ?? '').includes('v'))
    const words = 'run the panel tests'
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: panel.id, uploadId: 'e2e-panel-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'e2e-panel-1' })
    const answer = await heard(dial, (m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === 'e2e-panel-1',
      'the answer to its words', since)
    expect(answer).toMatchObject({ t: 'voice.transcript', text: words, agentId: panel.id })
    expect(await poll).toEqual({ status: 200, body: { text: words } })
    expect(d.log()).not.toContain(words)
  })

  it('a tap on it switches the person\'s tmux client to its pane, never one on a Harness session, and brings no app forward', async () => {
    const { d, desk } = await fresh()
    const client = await LocalClient.connect(d)
    // A session Harness made: an agent's, tagged and named as the daemon does both.
    const harness = await create(d, client, 'in-harness')
    const harnessPane = String((await row(client, harness))?.tmuxPane)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await showing(dial, 'the harness agent listed', (r) => ids(r).includes(harness))
    const engine = await InOwnTmux.start(d, 'own-claude', 'in-tmux')
    await d.tmux.run('new-session', '-d', '-s', 'own-other', 'sleep 600')
    await showing(dial, 'the agent listed', (r) => r.rows.find((row) => row.id === engine.id)?.caps === 'sf')
    // Every session is made; now the clients. The person's first, then one as Desktop's terminal on the Harness agent is:
    // it attached later, so it is the client used last, the one a bare switch-client moves.
    const person = await controlClient(d, 'own-other')
    clients.push(person)
    const terminal = await controlClient(d, harnessPane)
    clients.push(terminal)
    expect(await person.where()).toMatch(/^own-other /)
    const stays = await terminal.where()
    expect(stays.startsWith('harness-') && stays.endsWith(` ${harnessPane}`), stays).toBe(true)
    const since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: engine.id })
    await until('the person\'s client on the agent\'s pane', async () => (await person.where()) === `own-claude ${engine.pane}`, 30_000, 100)
    await heard(dial, (m) => m.t === 'focus' && m.agentId === engine.id, 'the dial on the agent', since)
    expect(await terminal.where()).toBe(stays)
    expect(dial.messages.slice(since).some((m) => m.t === 'toast')).toBe(false)
    // No app to bring forward and no pane refused: nothing was said.
    expect(d.log()).not.toContain('[device] open · tmux')
    client.close()
  })
})
