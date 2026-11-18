/**
 * Herdr's agents on the dial (docs/plans/2026-11-16-herdr-app-design.md), on the real daemon: a Herdr Core of the
 * test's own (harness/hcCore.ts) runs a fake agent in a terminal Herdr's window would show, reporting its status as
 * Claude Code, and a fake dial on the desk lists it with no hook, follows its state, speaks to it, and switches Herdr's
 * window to it with a swipe and a tap. A core started after the dial comes with no daemon restart, and goes when it stops.
 * A Claude Code session the scan finds in a Herdr terminal is paired with it, and listed once there, with its last answer.
 * With Herdr in front, a stroke scrolls Herdr's view of the shown agent's terminal while Herdr shows its tab on screen
 * (docs/plans/2026-11-17-dial-herdr-scroll-design.md), or over Claude Code, which draws on the alternate screen,
 * presses its own page keys through hc; it goes to Harness's windows otherwise.
 *
 * Herdr's real window is never driven. The daemon's `herdr-app` is a fake first on its PATH that records its arguments
 * and answers `status` with the tab the test put on its screen and the terminal it names as its agent
 * (`herdr-app.screen`), or none; its `open` is the
 * harness's fake (HARNESS_OPEN_BIN, harness/daemon.ts): each is checked to be the one the daemon finds before anything
 * runs, since with no `herdr-app` on PATH it would run Herdr.app's own binary. The daemon finds the private core's socket
 * as hcClient.ts does, from the HC_SOCKET and XDG_RUNTIME_DIR it is given, both in the core's root: it inherits no HC_*
 * and no XDG_* (testing/daemonEnvironment.ts), so it never reaches the person's own core.
 *
 * Skipped where Herdr Core is not installed, as on every GitHub runner, and off macOS.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'
import { herdrAppStatus } from '../src/testing/herdrAppStatus.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { hcBinary, PrivateHc, type PlannedHc } from './harness/hcCore.js'
import { InOrca } from './harness/inOrca.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c2'.repeat(16), computerId: 'e2e-device-herdr-app-computer', name: 'Fixture', token: 'e2e-device-herdr-app-token' }
// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const ORCA = 'com.stablyai.orca'
const HERDR = 'dev.herdr.app'

/** One list the dial was sent: its rows, between `agents.begin` and `agents.end`. */
function rosters(dial: FakeDial, since = 0): DialMessage[][] {
  const out: DialMessage[][] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push(rows); rows = null }
  }
  return out
}
/** The list the dial shows now, once it passes [test]. */
const showing = (dial: FakeDial, what: string, test: (rows: DialMessage[]) => boolean, since = 0, ms = 45_000): Promise<DialMessage[]> =>
  until(what, () => {
    const last = rosters(dial, since).at(-1)
    return last && test(last) ? last : null
  }, ms, 100)
const named = (name: string) => (rows: DialMessage[]) => rows.some((row) => row.host === 'herdr' && row.name === name)
/** The row of Herdr's agent [name], once the dial shows it. */
const rowOf = async (dial: FakeDial, name: string, since = 0): Promise<DialMessage> =>
  (await showing(dial, `${name} listed`, named(name), since)).find((row) => row.name === name)!
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)
/** Each run of the daemon's fake `herdr-app`: its arguments, one line a run. */
const herdrApps = (d: IsolatedDaemon): string[] => {
  try { return readFileSync(join(d.root, 'herdr-app.log'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
/** The tab of Herdr's window that holds a stroke's terminal: its `herdr.tab` label in hc. */
const TAB = 'tbaaaa'
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
/** The tallies the Herdr adapter said of its scroll queues, once each was quiet (herdrApp.ts). */
const drained = (d: IsolatedDaemon) => d.log().split('\n').flatMap((line) => {
  const counts = /\[herdr-app\] scroll · (\d+) lines · (\d+) runs · (\d+) failed$/.exec(line)
  return counts ? [{ lines: Number(counts[1]), failed: Number(counts[3]) }] : []
})

describe.skipIf(!hcBinary)("Herdr's agents on the dial, from a private Herdr Core", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const cores: PrivateHc[] = []
  const children: ChildProcess[] = []
  const clients: LocalClient[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    // Each core through its own session, before the daemon, and whatever the test did: a check that fails here fails the
    // test once everything else is closed.
    const stops = await Promise.allSettled(cores.splice(0).map((core) => core.stop()))
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
    for (const stop of stops) if (stop.status === 'rejected') throw stop.reason
  })

  /** A daemon of its own that finds [planned]'s socket, signed in for the speech, with the fake `herdr-app` first on its
   *  PATH, and a desk. */
  const fresh = async (planned: PlannedHc): Promise<{ d: IsolatedDaemon; desk: Desk; relay: FakeBackend }> => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await IsolatedDaemon.create({
      // XDG_RUNTIME_DIR puts the default session's socket in the private root too: a core planned there is the session
      // this daemon follows, as the person's daemon follows theirs (PrivateHc.planDefault).
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
        HC_SOCKET: planned.socket, XDG_RUNTIME_DIR: planned.root },
    })
    daemon = d
    // Before anything runs: with no herdr-app on its PATH the daemon runs Herdr.app's own, which drives the real window.
    const fake = join(dirname(d.env.CLAUDE_PATH!), 'herdr-app')
    // `status` prints what Herdr 0.1.16 prints, its `tab` and its `agent` the screen file's two words: the tab on screen,
    // and the terminal it names, which is not what is on screen (Diego's first check, 2026-11-18). Shell built-ins
    // alone, so the daemon's PATH is not relied on; `read` answers false for a line with no newline.
    const [head, rest] = herdrAppStatus('@tab', '@agent').split('"@tab"')
    const [between, tail] = rest.split('"@agent"')
    const screen = join(d.root, 'herdr-app.screen')
    writeFileSync(fake, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(d.root, 'herdr-app.log')}'`,
      '[ "$1" = status ] || exit 0',
      'tab=null agent=null',
      `[ -s '${screen}' ] && read -r shown address < '${screen}' && tab="\\"$shown\\"" agent="\\"$address\\""`,
      `printf '%s%s%s%s%s\\n' '${head}' "$tab" '${between}' "$agent" '${tail}'`,
    ].join('\n') + '\n', { mode: 0o755 })
    expect(resolveBinaryOnPath('herdr-app', d.env)).toBe(fake)
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- herdr-app runs\n${herdrApps(d).join('\n')}`)
    })
    await d.start()
    return { d, desk: theDesk, relay }
  }

  /** A private core, in `cores` from its first command on, so afterEach stops it whatever its start did. */
  const coreFor = (planned: PlannedHc): Promise<PrivateHc> => PrivateHc.start(planned, cores)

  /** The dial speaks [words] to [agentId], and the fake backend transcribes them: what the dial hears back. */
  const speak = (dial: FakeDial, relay: FakeBackend, agentId: unknown, words: string, uploadId: string): Promise<DialMessage> => {
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId })
    return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
  }

  it("Herdr's agents are on the dial with their state and no hook, and take the dial's words", async () => {
    const planned = PrivateHc.plan()
    const { d, desk, relay } = await fresh(planned)
    const hc = await coreFor(planned)
    const t = await hc.agent('api')

    // 1. Listed with no hook: its name is its folder's.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const row = await rowOf(dial, 'api')
    expect(row).toMatchObject({ name: 'api', engine: 'claude', host: 'herdr', caps: 'svf' })
    const id = row.id

    // 2. Its state, as it reports it to hc: working, waiting on the person, done, and a turn that ends idle.
    let since = dial.messages.length
    await hc.report(t, 'working')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its turn started', since)
    since = dial.messages.length
    await hc.report(t, 'blocked')
    await dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === id && m.text === 'Waiting for you · herdr',
      45_000, 'the waiting line', since)
    since = dial.messages.length
    await hc.report(t, 'working')
    await hc.report(t, 'done')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)
    since = dial.messages.length
    await hc.report(t, 'working')
    await hc.report(t, 'idle')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done, idle', since)

    // 3. The dial's words are its next prompt: hc types them after its quiet pause.
    expect(await speak(dial, relay, id, 'run the spoken tests', 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: id })
    await until('the words in its terminal', async () => (await hc.screen(t)).includes('GOT[run the spoken tests]'), 90_000, 100)
    await said(d, '[device] voice · herdr-app')

    // 4. Working, it takes none.
    since = dial.messages.length
    await hc.report(t, 'working')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its next turn started', since)
    expect(await speak(dial, relay, id, 'not now', 'spoken-2')).toMatchObject({ t: 'voice.error' })
    await said(d, '[device] voice · busy')
    expect(await hc.screen(t)).not.toContain('not now')

    // 5. No address, folder or words in the log.
    const log = d.log()
    expect(log).toContain('[herdr-app] socket · live')
    expect(log).toContain('[herdr-app] listed · 1 agents')
    expect(log).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'm'))
    for (const secret of [planned.root, 'run the spoken tests', 'not now']) expect(log).not.toContain(secret)
  })

  it("a swipe with Herdr in front switches Herdr's window, through herdr-app alone", async () => {
    const planned = PrivateHc.plan()
    const { d, desk } = await fresh(planned)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. Orca holds more agents than Herdr until Herdr settles in front, so the ring's switch to Herdr is the settle.
    for (const folder of ['a', 'b']) {
      const session = new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
      const since = dial.messages.length
      await session.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === session.id, 45_000, `${folder} listed`, since)
    }

    // 2. Herdr's agent, counted behind Orca's ring.
    let since = dial.messages.length
    const hc = await coreFor(planned)
    const t = await hc.agent('api')
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'herdr' && app.count === 1), 45_000, 'Herdr counted', since)

    // 3. Herdr in front, as the Harness Device app's watch says it.
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    since = dial.messages.length
    watch.stdin!.write(`${JSON.stringify({ front: HERDR })}\n`)
    const ring = await dial.next((m) => m.t === 'apps' && m.shown === 'herdr', 45_000, "Herdr's ring", since)
    const row = await rowOf(dial, 'api', dial.messages.indexOf(ring))

    // 4. The dial turns to it and rests there: Herdr's window switches to its terminal, and nothing is opened.
    dial.send({ t: 'focus', agentId: row.id })
    await said(d, '[device] swipe · ok')
    expect(herdrApps(d)).toEqual([`do agent.focus --terminal ${t}`])
    expect(d.opens()).toEqual([])
    expect(d.log()).not.toContain('[herdr-app] focus · failed')
  })

  it('a tap opens Herdr through the test\'s fake open, then switches its window, through herdr-app', async () => {
    const planned = PrivateHc.plan()
    const { d, desk } = await fresh(planned)
    // 1. Before any tap: the open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)

    // 2. Listed, and tapped.
    const hc = await coreFor(planned)
    const t = await hc.agent('api')
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const row = await rowOf(dial, 'api')
    dial.send({ t: 'agent.open', agentId: row.id })

    // 3. Herdr opened, then its window switched to the terminal.
    await until('the tap\'s runs', () => d.opens().length > 0 && herdrApps(d).length > 0, 30_000, 50)
    expect(d.opens()).toEqual([['-b', HERDR]])
    expect(herdrApps(d)).toEqual([`do agent.focus --terminal ${t}`])
    expect(d.log()).not.toContain('[herdr-app] focus · failed')
  })

  it('a core started after the dial is listed with no daemon restart, and goes when it stops', async () => {
    const planned = PrivateHc.plan()
    const { d, desk } = await fresh(planned)

    // 1. No core yet: the source waits on the folder its socket will be in.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await said(d, '[herdr-app] socket · none')

    // 2. Started on the same daemon.
    const hc = await coreFor(planned)
    await hc.agent('api')
    await rowOf(dial, 'api')

    // 3. Stopped through its own session: the row goes.
    const since = dial.messages.length
    await hc.stop()
    await showing(dial, 'api gone', (rows) => !rows.some((row) => row.host === 'herdr'), since)
    await said(d, '[herdr-app] closed · ended')
  })

  it('a session started in a Herdr terminal before the dial is listed once, on Herdr\'s page, with its last answer, and takes words there', async () => {
    const planned = PrivateHc.planDefault()
    const { d, desk, relay } = await fresh(planned)
    const hc = await coreFor(planned)
    const projectsDir = d.env.CLAUDE_PROJECTS_DIR!
    const sessionId = randomUUID()
    const t = await hc.agent('api', { projectsDir, sessionId, answer: 'answer 1: before the dial' })
    const id = observedAgentId('claude', sessionId)

    // 1. What the pairing rests on, from the real hc: the terminal's foreground is the pid of the session's one record.
    const sessions = join(dirname(projectsDir), 'sessions')
    const records = readdirSync(sessions)
    expect(records).toHaveLength(1)
    const foreground = await until('hc to report the terminal\'s foreground', async () =>
      ((await hc.rpc('terminal.get', { terminal: t })).foreground as { pid?: unknown } | null)?.pid, 10_000, 50)
    expect(foreground).toBe(JSON.parse(readFileSync(join(sessions, records[0]), 'utf8')).pid)

    // 2. The dial's attach scans: the session is restored with its last answer, as history.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    const restored = await dial.next((m) => m.t === 'summary' && m.agentId === id && m.restore === true, 45_000, 'its last answer restored')
    expect(String(restored.text)).toContain('answer 1: before the dial')

    // 3. Counted once, on Herdr's page: its own copy holds Herdr's terminal, and Herdr's row of it is folded in.
    await until('Herdr alone counted, once', () => {
      const apps = dial.messages.filter((m) => m.t === 'apps').at(-1)?.apps as Array<{ id: string; count: number }> | undefined
      return apps?.length === 1 && apps[0].id === 'herdr' && apps[0].count === 1
    }, 45_000, 100)
    const ring = await showing(dial, 'its copy on Herdr\'s page', (rows) => rows.some((row) => row.id === id && row.host === 'herdr'))
    const herdrs = ring.filter((row) => row.host === 'herdr')
    expect(herdrs).toHaveLength(1)
    expect(herdrs[0]).toMatchObject({ id, name: 'api', caps: 'svf' })
    expect(dial.messages.filter((m) => m.agentId === id && (m.t === 'turn.done' || (m.t === 'summary' && m.restore !== true))))
      .toEqual([])

    // 4. The dial's words reach its terminal, through Herdr.
    expect(await speak(dial, relay, id, 'run the paired words', 'paired-1')).toMatchObject({ t: 'voice.transcript', text: 'run the paired words', agentId: id })
    await until('the words in its terminal', async () => (await hc.screen(t)).includes('GOT[run the paired words]'), 90_000, 100)
    await said(d, '[device] voice · herdr-app')

    // 5. Counts only: no address, folder, session, answer or words in the log.
    await said(d, '[observed] herdr · 1 paired')
    const log = d.log()
    expect(log).toMatch(/\[observed\] scan · 1 found · \d+ app known · 0 named · 1 answered · \d+ ms/)
    expect(log).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'm'))
    for (const secret of [planned.root, sessionId, 'answer 1', 'run the paired words']) expect(log).not.toContain(secret)
  })

  /**
   * A stroke's desk: a dial that holds one app's ring and Orca holding more agents than Herdr, as the swipe's case, so
   * each change of the app in front is seen as a ring; Herdr's agent `api`, its program reporting as [app], in tab TAB
   * of Herdr's window, which Herdr shows; Herdr in front, and the dial on that agent. A local window listens for
   * `dial_scroll`. Its `stroke` sends a down, a move of each dy and an up, taken once the devices logged its up.
   */
  const strokeDesk = async (app: string) => {
    const planned = PrivateHc.plan()
    const { d, desk } = await fresh(planned)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    for (const folder of ['a', 'b']) {
      const session = new InOrca(d, folder, children, { ORCA_TERMINAL_HANDLE: `term_${randomUUID()}`, __CFBundleIdentifier: ORCA })
      const since = dial.messages.length
      await session.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === session.id, 45_000, `${folder} listed`, since)
    }
    let since = dial.messages.length
    const hc = await coreFor(planned)
    // Herdr's window labels each terminal it holds with its tab, the id its `status` names for the tab on screen. Labeled
    // from its start, so every fact of it the daemon reads holds the tab: Herdr counting it below says it is known.
    const t = await hc.agent('api', undefined, { 'herdr.tab': TAB }, app)
    /** Herdr shows that tab, and its `status` names t as its agent whatever the tab. */
    const shown = (tab: string) => writeFileSync(join(d.root, 'herdr-app.screen'), `${tab} ${t}\n`)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca'
      && (m.apps as Array<{ id: string; count: number }>).some((one) => one.id === 'herdr' && one.count === 1), 45_000, 'Herdr counted', since)
    const window = await LocalClient.connect(d, { machineId: ME.machineId })
    clients.push(window)
    shown(TAB)

    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(watch)
    since = dial.messages.length
    watch.stdin!.write(`${JSON.stringify({ front: HERDR })}\n`)
    const ring = await dial.next((m) => m.t === 'apps' && m.shown === 'herdr', 45_000, "Herdr's ring", since)
    const row = await rowOf(dial, 'api', dial.messages.indexOf(ring))
    dial.send({ t: 'focus', agentId: row.id })
    await said(d, '[device] swipe · ok')

    const ups = () => d.log().split('\n').filter((line) => line.includes('cable: scroll ↑')).length
    let strokes = 0
    const stroke = async (moves: number[]): Promise<void> => {
      dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
      for (const dy of moves) dial.send({ t: 'scroll', phase: 'move', dy, v: 0 })
      dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
      strokes += 1
      await until('the stroke taken to its up', () => ups() === strokes, 30_000, 10)
    }
    const dialScrolls = () => window.frames.filter((f) => f.type === 'dial_scroll').map((f) => f.payload as { phase: string; dy: number })
    return { d, dial, hc, t, window, watch, shown, stroke, dialScrolls }
  }

  it("a stroke with Herdr in front scrolls Herdr's view of the shown agent's terminal, and Harness's windows hear none of it", async () => {
    // 1. Codex draws on the main screen, whose history Herdr's view scrolls.
    const { d, dial, t, window, watch, shown, stroke, dialScrolls } = await strokeDesk('codex')

    // 2. Each stroke: three moves of 8, 60 px, three lines of 16 toward older ones (scrollLines.ts).
    const prefix = `do terminal.scroll --terminal ${t} --lines `
    const scrolls = () => herdrApps(d).filter((run) => run.startsWith(prefix)).map((run) => Number(run.slice(prefix.length)))
    const statuses = () => herdrApps(d).filter((run) => run === 'status').length

    // 3. On screen: the lines go to herdr-app, however many runs carry them. The number of runs depends on how many frames
    // came while a run was under way, so it is printed, not held.
    const started = performance.now()
    await stroke([8, 8, 8])
    await until('three lines scrolled', () => sum(scrolls()) === -3, 30_000, 5)
    console.log(`[herdr scroll] stroke 1 · ${scrolls().length} runs · ${Math.round(performance.now() - started)} ms`)
    await until('the queue drained', () => sum(drained(d).map((tally) => tally.lines)) === 3, 30_000, 50)
    const firstRuns = scrolls()

    // 4. Herdr shows another tab, its status still naming t as its agent: the whole stroke goes to the windows, and
    // herdr-app scrolls nothing.
    shown('tbzzzz')
    await stroke([8, 8, 8])
    await said(d, '[device] scroll · herdr-app · not on screen')
    await window.waitFor((f) => f.type === 'dial_scroll' && f.payload?.phase === 'up', 30_000, "stroke 2's up in Harness's window")

    // 5. Orca in front: the stroke goes to the windows as it came, and herdr-app is not asked.
    shown(TAB)
    const since = dial.messages.length
    watch.stdin!.write(`${JSON.stringify({ front: ORCA })}\n`)
    await dial.next((m) => m.t === 'apps' && m.shown === 'orca', 45_000, "Orca's ring", since)
    const before = dialScrolls().length
    await stroke([8, 8, 8])
    await until("stroke 3's up in Harness's window", () => dialScrolls().slice(before).some((f) => f.phase === 'up'), 30_000, 50)

    // 6. Harness's window hears the devices' frames in order: stroke 1 reached none of it, stroke 2 came as its down, its
    // held travel and its up, stroke 3 as it came.
    const heard = dialScrolls()
    const second = heard.slice(0, heard.findIndex((f) => f.phase === 'up') + 1)
    expect(second[0].phase).toBe('down')
    expect(second.at(-1)!.phase).toBe('up')
    const moves = second.slice(1, -1)
    expect(moves.length).toBeGreaterThanOrEqual(1)
    expect(moves.length).toBeLessThanOrEqual(3)
    expect(moves.every((f) => f.phase === 'move')).toBe(true)
    expect(sum(moves.map((f) => f.dy))).toBe(24)
    expect(heard.slice(second.length).map((f) => f.phase)).toEqual(['down', 'move', 'move', 'move', 'up'])
    expect(scrolls()).toEqual(firstRuns)
    expect(statuses()).toBe(2)
    const tallies = drained(d)
    expect(tallies.every((tally) => tally.failed === 0)).toBe(true)
    expect(sum(tallies.map((tally) => tally.lines))).toBe(3)
    const log = d.log()
    expect(log.split('\n').filter((line) => line.endsWith('[device] scroll · herdr-app · not on screen'))).toHaveLength(1)
    expect(log).not.toContain('[herdr-app] scroll · failed')
    expect(log).not.toContain('[herdr-app] status · failed')
    expect(log).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'm'))
  }, 180_000)

  // Claude Code draws on the alternate screen, where Herdr's view has no history: its own page keys move it.
  it("a stroke over Claude Code presses its own pageup and pagedown through hc, and Herdr's view is not asked to move", async () => {
    const { d, hc, t, stroke, dialScrolls } = await strokeDesk('claude-code')
    /** The keys the fake program read, in order. */
    const keys = async () => (await hc.screen(t)).match(/KEY\[\^\[\[[56]~\]/g) ?? []

    // 1. Two moves of 64, 320 px: twenty lines toward older ones, a page up. Then as far back: a page down.
    const started = performance.now()
    await stroke([64, 64])
    await until('pageup read by the program', async () => (await keys()).length === 1, 30_000, 50)
    console.log(`[herdr scroll] pageup read ${Math.round(performance.now() - started)} ms after the stroke began`)
    await stroke([-64, -64])
    await until('pagedown read by the program', async () => (await keys()).length === 2, 30_000, 50)
    expect(await keys()).toEqual(['KEY[^[[5~]', 'KEY[^[[6~]'])

    // 2. Each stroke asked which tab is on screen, and none ran terminal.scroll or reached Harness's window.
    await until('the queue drained', () => sum(drained(d).map((tally) => tally.lines)) === 40, 30_000, 50)
    expect(drained(d).every((tally) => tally.failed === 0)).toBe(true)
    expect(herdrApps(d).filter((run) => run !== `do agent.focus --terminal ${t}`)).toEqual(['status', 'status'])
    expect(dialScrolls()).toEqual([])
    const log = d.log()
    expect(log).not.toContain('[herdr-app] scroll · failed')
    expect(log).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'm'))
  }, 180_000)
})
