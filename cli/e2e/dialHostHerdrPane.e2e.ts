/**
 * The dial's words reach only the pane herdr made for the agent (docs/plans/2026-11-21-dial-linux-followups-design.md
 * § 1), on the real daemon: an agent whose hooks run in a pane of a herdr server of the test's own
 * (harness/herdrServer.ts) takes them there; an agent in a WezTerm pane of the test's own (harness/weztermMux.ts)
 * started from that herdr pane keeps its HERDR_PANE_ID, so the herdr pane only holds it: WezTerm types the words, herdr
 * none, and no herdr client is looked for. No `herdr` or `wezterm` the daemon runs reaches the developer's, and the
 * daemon's process table hides every herdr outside the test's tree (ownHerdrsOnly).
 *
 * Skipped where herdr (or the cc that builds its agent) is not installed, the WezTerm case also where WezTerm is not;
 * CI's `e2e (dial hosts)` job installs both, and there a missing one fails the file (harness/dialHosts.ts).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { herdrBinary, ownHerdrsOnly, PrivateHerdr } from './harness/herdrServer.js'
import { PrivateWezterm, weztermBinary } from './harness/weztermMux.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c6'.repeat(16), computerId: 'e2e-dial-herdr-pane-computer', name: 'Fixture', token: 'e2e-dial-herdr-pane-token' }
const WORDS = 'run the spoken tests'
const HELD = '[device] herdr · held'

/** The last list the dial was sent, its rows between `agents.begin` and `agents.end`, once it passes [test]. */
const showing = (dial: FakeDial, what: string, test: (rows: DialMessage[]) => boolean): Promise<DialMessage[]> =>
  until(what, () => {
    let rows: DialMessage[] | null = null
    let last: DialMessage[] | null = null
    for (const m of dial.messages) {
      if (m.t === 'agents.begin') rows = []
      else if (m.t === 'agent' && rows) rows.push(m)
      else if (m.t === 'agents.end' && rows) { last = rows; rows = null }
    }
    return last && test(last) ? last : null
  }, 45_000, 100)
/** The daemon's lines that start with [prefix], each from its `[device]` on. */
const lines = (d: IsolatedDaemon, prefix: string): string[] =>
  d.log().split('\n').filter((line) => line.includes(prefix)).map((line) => line.slice(line.indexOf('[device]')))
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => lines(d, line).includes(line), 30_000, 50)

describe.skipIf(!herdrBinary)("the dial's words reach the agent's own pane, herdr", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  let herdr: PrivateHerdr | undefined
  let wezterm: PrivateWezterm | undefined
  afterEach(async () => {
    // The terminals first: they hold the daemon's engine, and the daemon's close sweeps what names its root.
    await wezterm?.stop()
    await herdr?.stop()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    wezterm = undefined
    herdr = undefined
    desk = undefined
    daemon = undefined
    backend = undefined
  })

  /** A daemon of its own, signed in to a fake backend that transcribes, its hooks in, a private herdr server, and the
   *  dial on the desk shown its first list. */
  const fresh = async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.speech = WORDS
    const d = await IsolatedDaemon.create({
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    })
    daemon = d
    ownHerdrsOnly(d)
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const server = await PrivateHerdr.start(d)
    herdr = server
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial, herdr: server }
  }

  /** The dial speaks to [id]: the transcript or the refusal it is answered with. */
  const speak = (dial: FakeDial, id: string, uploadId: string): Promise<DialMessage> => {
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: id, uploadId, sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId })
    return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
  }

  /** No folder, words, session, pane or terminal of the case's in the daemon's log. */
  const logNames = (d: IsolatedDaemon, ...secrets: string[]): void => {
    for (const secret of [WORDS, ...secrets]) expect(d.log()).not.toContain(secret)
  }

  it("an agent in a herdr pane takes the dial's words there", async () => {
    const { d, dial, herdr } = await fresh()

    // 1. The suite's fake Claude Code in a herdr pane: herdr's server made its terminal, so its row takes words once
    // the devices read that maker.
    const { pane, sessionId, id } = await herdr.hooked('api')
    const row = (await showing(dial, 'the agent listed, taking words',
      (rows) => rows.some((r) => r.id === id && String(r.caps).includes('v')))).find((r) => r.id === id)!
    expect(row).toMatchObject({ engine: 'claude', host: 'herdr' })
    // herdr types only into an agent it sees at its prompt, and its detection lags the hook by a moment (herdr 0.9.5).
    await until('herdr to see it at its prompt', async () => {
      // Not found until its detection runs.
      const read = await herdr.rpc('agent.get', { target: pane }).catch(() => undefined)
      return (read?.agent as { agent_status?: string } | undefined)?.agent_status === 'idle'
    }, 30_000, 100)

    // 2. The dial's words are typed into its own herdr pane.
    expect(await speak(dial, id, 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: WORDS, agentId: id })
    await until('the words on its pane', async () => (await herdr.screen(pane)).includes(WORDS), 30_000, 100)
    await said(d, '[device] voice · herdr')

    // 3. Its pane is its own: never held.
    expect(lines(d, HELD)).toEqual([])
    logNames(d, join(d.projectsDir, 'api'), sessionId, pane)
  })

  it.skipIf(!weztermBinary)('an agent in a WezTerm pane started from that herdr pane takes them in WezTerm, none in the herdr pane, and has no herdr client place', async () => {
    const { d, dial, herdr } = await fresh()
    // WezTerm started from a herdr pane: its panes keep that pane's HERDR_PANE_ID.
    const shell = await herdr.pane('ops')
    const mux = await PrivateWezterm.start(d, { HERDR_PANE_ID: shell })
    wezterm = mux

    // 1. The fake Claude Code in a WezTerm pane: its hook names both the WezTerm pane and the herdr pane.
    const from = d.hookLog().length
    const pane = await mux.spawn('api')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().slice(from).match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    await showing(dial, 'the agent listed, taking words', (rows) => rows.some((r) => r.id === id && String(r.caps).includes('v')))
    // WezTerm's mux server made its pty, not herdr's: the herdr pane only holds it.
    await said(d, HELD)

    // 2. The dial's words are typed into the WezTerm pane, and none into the herdr pane.
    expect(await speak(dial, id, 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: WORDS, agentId: id })
    await until('the words in its pane', async () => (await mux.text(pane)).includes(WORDS), 30_000, 100)
    await said(d, '[device] voice · wezterm')
    expect(await herdr.screen(shell)).not.toContain(WORDS)
    expect(lines(d, HELD)).toEqual([HELD])

    // 3. No herdr server made its terminal: no herdr client is its place.
    expect(lines(d, '[device] herdr client · found')).toEqual([])

    const tty = (JSON.parse(await mux.cli('list', '--format', 'json')) as Array<{ pane_id: number; tty_name?: string }>)
      .find((p) => String(p.pane_id) === pane)?.tty_name
    expect(tty).toBeTruthy()
    logNames(d, join(d.projectsDir, 'api'), sessionId, shell, tty!)
  })
})
