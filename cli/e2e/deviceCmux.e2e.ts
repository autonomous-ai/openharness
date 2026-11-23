/**
 * cmux's agents on the dial (docs/plans/2026-11-17-dial-cmux-design.md), on the real daemon: a fake cmux of the test's
 * own (src/testing/fakeCmux.ts) answers `sessions list`, `socket-status`, `rpc surface.input_state` and `paste` from
 * the records the test sets, and a store written in the daemon's home is what a cmux hook does. A fake dial on the desk
 * lists those agents with no hook, follows their state, speaks to them, taps them, and picks cmux.
 *
 * cmux is never run, and the person's own `~/.cmuxterm` is never read. The daemon's `cmux` is the fake, linked first on
 * its PATH from a `cmux.app/Contents/Resources/bin` folder in the daemon's root, checked to be the one it resolves before
 * the daemon starts: with no `cmux` on its PATH it would run /Applications/cmux.app's own. Its HOME is the root's, and its
 * `open` is the harness's fake (HARNESS_OPEN_BIN, harness/daemon.ts), so a tap or a pick brings nothing forward. It
 * carries a mode and a stores' folder of cmux's, as a daemon started from a cmux terminal does, and no run of cmux gets
 * them.
 *
 * A record's pid is a live process the test starts and ends: the source lists only agents whose process is alive.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'
import { fakeCmux, touchStore, type FakeCmux, type FakeCmuxSession } from '../src/testing/fakeCmux.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c3'.repeat(16), computerId: 'e2e-device-cmux-computer', name: 'Fixture', token: 'e2e-device-cmux-token' }
/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CMUX = 'com.cmuxterm.app'
/** cmux's ids are Swift's UUID strings: upper case. */
const cmuxId = (): string => randomUUID().toUpperCase()
const link = (workspace: string, surface: string): string => `cmux://workspace/${workspace}/surface/${surface}`

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
  }, ms, 50)
const cmuxRows = (rows: DialMessage[]): DialMessage[] => rows.filter((row) => row.host === 'cmux')
/** The row of cmux's agent [name], once the dial shows it. */
const rowOf = async (dial: FakeDial, name: string, since = 0): Promise<DialMessage> =>
  cmuxRows(await showing(dial, `${name} listed`, (rows) => cmuxRows(rows).some((row) => row.name === name), since)).find((row) => row.name === name)!
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

describe.skipIf(process.platform !== 'darwin')("cmux's agents on the dial, from a fake cmux", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const children: ChildProcess[] = []
  const outside: Outside[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })

  /** A daemon of its own signed in for the speech, a desk, and a fake cmux in its root, first on its PATH. */
  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk; relay: FakeBackend; fake: FakeCmux }> => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    // A cmux terminal's own variables, but its two ids: those would make the Ghostty agent below one of cmux's.
    const d = await IsolatedDaemon.create({
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
        CMUX_SOCKET_MODE: 'allowAll' },
    })
    daemon = d
    d.env.CMUX_AGENT_HOOK_STATE_DIR = join(d.root, 'other')
    const fake = fakeCmux(d.root)
    d.env.PATH = `${fake.dir}:${d.env.PATH}`
    // Before anything runs: the cmux the daemon resolves is the fake, where cmux's app keeps its own (the client runs
    // /Applications/cmux.app's otherwise), and its home and its open are the root's.
    const resolved = realpathSync(resolveBinaryOnPath('cmux', d.env)!)
    expect(resolved).toBe(realpathSync(fake.binary))
    expect(resolved).toMatch(/\/cmux\.app\/Contents\/Resources\/bin\/cmux$/)
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    expect(relative(d.root, d.env.HOME!).startsWith('..'), d.env.HOME).toBe(false)
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
      console.log(`---- cmux runs\n${fake.calls().map((call) => JSON.stringify(call.args)).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    return { d, desk: theDesk, relay, fake }
  }

  /** A process of the test's own that waits until it is ended: a record's pid. */
  const live = (): ChildProcess => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
    children.push(child)
    return child
  }

  /** The dial speaks [words] to [agentId], and the fake backend transcribes them: what the dial hears back. */
  const speak = (dial: FakeDial, relay: FakeBackend, agentId: unknown, words: string, uploadId: string): Promise<DialMessage> => {
    relay.speech = words
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId })
    return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
  }

  it("cmux's agents are on the dial with their state and no hook, and take the dial's words only with Automation mode", async () => {
    const { d, desk, relay, fake } = await fresh()
    const home = d.env.HOME!
    const W = cmuxId()
    const S = cmuxId()

    // 1. No .cmuxterm in its home: the source waits for the folder, and runs no cmux.
    expect(existsSync(join(home, '.cmuxterm'))).toBe(false)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0b')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    await said(d, '[cmux] watch · none')
    expect(fake.calls()).toEqual([])

    // 2. One Claude Code in a cmux terminal, its hook writing its store: listed, named by its folder.
    const agent = live()
    const record = (agent_lifecycle: string): FakeCmuxSession =>
      ({ agent: 'claude', surface_id: S, workspace_id: W, pid: agent.pid!, agent_lifecycle })
    fake.set({ sessions: [record('idle')] })
    const written = performance.now()
    touchStore(home, 'claude')
    const row = await rowOf(dial, 'api')
    const toRow = Math.round(performance.now() - written)
    expect(row).toMatchObject({ name: 'api', engine: 'claude', host: 'cmux', caps: 'svf' })
    const id = row.id
    const read = d.log().split('\n').find((line) => line.includes('[cmux] read · all · '))
    console.log(`[cmux e2e] store written → row on the dial: ${toRow} ms; ${read?.slice(read.indexOf('[cmux]'))}`)
    expect(read).toBeDefined()

    // 3. Its state, as its hooks write it: working, waiting on the person, done.
    let since = dial.messages.length
    fake.set({ sessions: [record('running')] })
    const working = performance.now()
    touchStore(home, 'claude')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its turn started', since)
    console.log(`[cmux e2e] store written → card: ${Math.round(performance.now() - working)} ms`)
    since = dial.messages.length
    fake.set({ sessions: [record('needsInput')] })
    touchStore(home, 'claude')
    await dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === id && m.text === 'Waiting for you · cmux',
      45_000, 'the waiting line', since)
    since = dial.messages.length
    fake.set({ sessions: [record('idle')] })
    touchStore(home, 'claude')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)

    // 4. cmux's default mode lets no process outside cmux in: the dial says how to turn it on, and only the mode is read.
    // A store's change heard twice reads the list again: the words' runs are the rest.
    const spoken = (from: number) => fake.calls().slice(from).filter((run) => run.args[0] !== 'sessions')
    let calls = fake.calls().length
    expect(await speak(dial, relay, id, 'run the spoken tests', 'spoken-1'))
      .toMatchObject({ t: 'voice.error', message: 'Turn on Automation mode in cmux.' })
    expect(spoken(calls)).toEqual([{ args: ['socket-status', '--json'], stdin: '', env: [] }])
    await said(d, '[device] voice · refused (cmux)')

    // 5. With Automation mode the words are its next prompt: on the paste's stdin, never an argument, never forced.
    fake.set({ sessions: [record('idle')], mode: 'automation' })
    calls = fake.calls().length
    expect(await speak(dial, relay, id, 'run the spoken tests', 'spoken-2'))
      .toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: id })
    await said(d, '[device] voice · cmux')
    expect(spoken(calls)).toEqual([
      { args: ['socket-status', '--json'], stdin: '', env: [] },
      { args: ['--json', 'rpc', 'surface.input_state', JSON.stringify({ surface_id: S })], stdin: '', env: [] },
      { args: ['--json', 'paste', '--workspace', W, '--surface', S, '--submit', '-'], stdin: 'run the spoken tests', env: [] },
    ])
    for (const run of fake.calls()) {
      expect(run.env).toEqual([])
      expect(run.args).not.toContain('--force')
      expect(run.args.join(' ')).not.toContain('run the spoken tests')
    }

    // 6. Working, it takes none, and nothing is pasted.
    since = dial.messages.length
    fake.set({ sessions: [record('running')], mode: 'automation' })
    touchStore(home, 'claude')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its next turn started', since)
    const pastes = () => fake.calls().filter((run) => run.args.includes('paste')).length
    expect(await speak(dial, relay, id, 'not now', 'spoken-3'))
      .toMatchObject({ t: 'voice.error', message: 'api is busy. Say it when it is done.' })
    expect(pastes()).toBe(1)

    // 7. Its process ended: the next read leaves it out, and the row goes.
    since = dial.messages.length
    const ended = new Promise<void>((done) => agent.once('exit', () => done()))
    agent.kill('SIGKILL')
    await ended
    touchStore(home, 'claude')
    await showing(dial, 'api gone', (rows) => cmuxRows(rows).length === 0, since)
    expect(d.log()).not.toContain('run the spoken tests')
  })

  it("a pick of cmux brings cmux forward, and a tap opens the agent's tab by cmux's link", async () => {
    const { d, desk, fake } = await fresh()
    const W = cmuxId()
    const S = cmuxId()
    // 1. Ghostty's ring first: a pick of the ring the dial already shows changes nothing and brings nothing.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0b', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    outside.push(await Outside.start(d, 'web', { TERM_PROGRAM: 'ghostty' }))
    await dial.next((m) => m.t === 'apps' && m.shown === 'ghostty', 45_000, "Ghostty's ring")

    // 2. cmux's agent, counted behind it.
    const agent = live()
    fake.set({ sessions: [{ agent: 'claude', surface_id: S, workspace_id: W, pid: agent.pid! }] })
    touchStore(d.env.HOME!, 'claude')
    await dial.next((m) => m.t === 'apps' && m.shown === 'ghostty'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'cmux' && app.count === 1), 45_000, 'cmux counted')

    // 3. The pick shows cmux's ring and brings cmux, by its bundle id alone.
    const since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'cmux' })
    const row = await rowOf(dial, 'api', since)
    await until('the pick\'s open', () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([['-b', CMUX]])

    // 4. The tap opens its tab by cmux's link.
    dial.send({ t: 'agent.open', agentId: row.id })
    await until('the tap\'s open', () => d.opens().length > 1, 30_000, 50)
    expect(d.opens()).toEqual([['-b', CMUX], ['-b', CMUX, link(W, S)]])
  })

  it("a hooked agent in cmux is one row on cmux's page, and its tap is the same link", async () => {
    const { d, desk, fake } = await fresh()
    const W2 = cmuxId()
    const S2 = cmuxId()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0b', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. Its hook names cmux's ids: on cmux's page, never Ghostty's.
    const web = await Outside.start(d, 'web', { TERM_PROGRAM: 'ghostty', CMUX_SURFACE_ID: S2, CMUX_WORKSPACE_ID: W2 })
    outside.push(web)
    const hooked = (await showing(dial, 'web listed', (rows) => rows.some((row) => row.id === web.id))).find((row) => row.id === web.id)!
    expect(hooked).toMatchObject({ host: 'cmux' })
    const apps = await dial.next((m) => m.t === 'apps' && (m.apps as Array<{ id: string }>).some((app) => app.id === 'cmux'),
      45_000, "cmux's page")
    expect((apps.apps as Array<{ id: string }>).map((app) => app.id)).not.toContain('ghostty')

    // 2. cmux lists the same session: still one row, the hooked one.
    fake.set({ sessions: [{ agent: 'claude', surface_id: S2, workspace_id: W2, pid: web.pid, session_id: web.sessionId,
      cwd: join(d.projectsDir, 'web') }] })
    const since = dial.messages.length
    touchStore(d.env.HOME!, 'claude')
    await said(d, '[cmux] listed · 1 agents')
    // Working, once cmux listed it: the list the dial asks for then is folded from both.
    const turn = dial.messages.length
    web.type('hello from cmux')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === web.id, 45_000, 'its turn started', turn)
    const asked = dial.messages.length
    dial.send({ t: 'agents.list' })
    expect(cmuxRows(await showing(dial, 'the list it asked for', () => true, asked)).map((row) => row.id)).toEqual([web.id])
    expect(rosters(dial, since).every((rows) => isDeepStrictEqual(cmuxRows(rows).map((row) => row.id), [web.id]))).toBe(true)

    // 3. Its tap opens its tab.
    dial.send({ t: 'agent.open', agentId: web.id })
    await until('the tap\'s open', () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([['-b', CMUX, link(W2, S2)]])
  })
})
