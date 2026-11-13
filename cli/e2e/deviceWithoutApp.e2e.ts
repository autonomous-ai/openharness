/**
 * The device without the app (docs/specs/2026-11-13-device-without-the-app.md), on the real daemon: a fake Claude Code
 * started outside tmux, on a pseudo-terminal of its own as a terminal app starts one, runs its hooks, and a fake dial
 * (harness/fakeDial.ts) on the desk lists it beside a Harness agent in a tmux pane, with no window open:
 * - the machine list, each agent with where it lives and what the dial can do with it;
 * - the agent outside a pane goes idle, working, done with its answer, and waits for the person;
 * - it goes when its process does, and one already running when the dial is plugged in is listed;
 * - a window brings back its tab's list, and closing it the machine's;
 * - talking to it is refused kindly, and `HARNESS_DEVICE_OBSERVED=off` leaves only the Harness agent.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

/**
 * A terminal app's tab: a fresh pseudo-terminal with the engine as its child (pty.fork + exec, as ptyRoundTrip.py), and
 * the test as the person at the keyboard. Prints the engine's pid first, on stderr.
 */
const PTY = `
import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
sys.stderr.write('%d\\n' % pid)
sys.stderr.flush()
inputs = [fd, sys.stdin.fileno()]
while True:
    ready, _, _ = select.select(inputs, [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(sys.stdout.fileno(), data)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(fd, data)
        else:
            inputs = [fd]
`

/** The values the hook reads to name the app an agent runs in (hook/notify.mjs HOST_HINTS): none of the developer's own. */
const HOST_HINTS = ['TERM_PROGRAM', '__CFBundleIdentifier', 'HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'KITTY_WINDOW_ID',
  'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID', 'ORCA_APP_VERSION', 'ORCA_PAIRING_CODE', 'ORCA_AGENT_SESSION_SPAWN_TOKEN']

/** Claude Code in a terminal app outside Harness: no tmux pane, no Harness pane. */
class Outside {
  private constructor(private readonly tab: ChildProcess, readonly pid: number, readonly sessionId: string, readonly folder: string) {}

  /** The dial's id for it. */
  get id(): string { return observedAgentId('claude', this.sessionId) }

  static async start(d: IsolatedDaemon, folder: string, hints: Record<string, string>): Promise<Outside> {
    const cwd = join(d.projectsDir, folder)
    mkdirSync(cwd, { recursive: true })
    const env: NodeJS.ProcessEnv = { ...d.env, TERM: 'xterm-256color' }
    for (const name of HOST_HINTS) delete env[name]
    delete env.TMUX
    delete env.TMUX_PANE
    delete env.HARNESS_PANE
    const tab = spawn('python3', ['-c', PTY, d.env.CLAUDE_PATH!], { cwd, env: { ...env, ...hints }, stdio: ['pipe', 'pipe', 'pipe'] })
    tab.stdout!.resume()
    const pid = await new Promise<number>((resolve, reject) => {
      let said = ''
      tab.stderr!.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        if (said.includes('\n')) resolve(Number(said.split('\n')[0]))
      })
      tab.once('exit', (code) => reject(new Error(`the terminal tab exited (${code}): ${said}`)))
    })
    // Its conversation, as its SessionStart hook named it once that hook had run.
    const started = new RegExp(`claude pid=${pid} SessionStart\\(startup\\) session=(\\S+) ran`)
    const sessionId = await until(`${folder} to run its SessionStart hook`, () => d.hookLog().match(started)?.[1], 30_000, 100)
    return new Outside(tab, pid, sessionId, folder)
  }

  /** Typed at its prompt, then Enter, as a person does. */
  type(text: string): void {
    this.tab.stdin!.write(text)
    this.tab.stdin!.write('\r')
  }

  /** Whether its hook for [event] has run since the engine started, as the engine noted it. */
  ran(d: IsolatedDaemon, event: string, times = 1): boolean {
    const line = new RegExp(`claude pid=${this.pid} ${event}\\S* session=${this.sessionId} ran`, 'g')
    return (d.hookLog().match(line)?.length ?? 0) >= times
  }

  /** The process gone at once, with no hook: a crash, a closed terminal. */
  kill(): void {
    try { process.kill(this.pid, 'SIGKILL') } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    this.kill()
    if (this.tab.exitCode !== null || this.tab.signalCode !== null) return
    const exited = new Promise<void>((done) => this.tab.once('exit', () => done()))
    this.tab.kill('SIGKILL')
    await exited
  }
}

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
    expect(roster.rows.find((r) => r.id === harness)).toMatchObject({ host: 'harness', caps: 'sva' })
    expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ name: 'in-ghostty', engine: 'claude', host: 'ghostty', caps: 's' })
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
    // It asks the person's permission to run a command, as Claude Code does in a turn: its Notification hook says so.
    engine.type('!permit printf hi')
    await until('its Notification hook to run', () => engine.ran(d, 'Notification'), 30_000, 100)
    await heard(dial, (m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === engine.id && m.text === 'Waiting for you · Orca',
      'the waiting line', since)
    // Allowed in its own terminal, the turn goes on to its end.
    engine.type('')
    await heard(dial, (m) => m.t === 'turn.done' && m.agentId === engine.id, 'its turn done', since)
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
    expect(roster.rows.find((r) => r.id === engine.id)).toMatchObject({ engine: 'claude', host: 'terminal', caps: 's' })
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
