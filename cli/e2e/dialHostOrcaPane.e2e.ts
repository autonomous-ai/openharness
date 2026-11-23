/**
 * The dial's words reach only the pane Orca's terminal host made for the agent
 * (docs/plans/2026-11-21-dial-linux-followups-design.md § 1), on the real daemon: an agent whose hooks run on a pty of
 * Orca's terminal host stand-in (harness/orcaHost.ts) takes them through the fake `orca`; an agent started from that
 * terminal keeps its handle and Orca's variables, so its Orca terminal only holds it: in a WezTerm pane of the test's own
 * (harness/weztermMux.ts) WezTerm types them, and in a terminal tab where no app types nothing does. The real Orca never
 * runs, and no `orca` or `wezterm` the daemon runs reaches the developer's.
 *
 * The WezTerm case is skipped where WezTerm is not installed, the stand-in's where cc is not; CI's `e2e (dial hosts)` job
 * installs both, and there a missing one fails the file (harness/dialHosts.ts).
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { FakeOrca } from './harness/fakeOrca.js'
import { IN_ORCA, InOrca } from './harness/inOrca.js'
import { orcaHostCc } from './harness/orcaHost.js'
import { Outside } from './harness/outsideAgent.js'
import { PrivateWezterm, weztermBinary } from './harness/weztermMux.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c5'.repeat(16), computerId: 'e2e-dial-orca-pane-computer', name: 'Fixture', token: 'e2e-dial-orca-pane-token' }
const WORDS = 'run the spoken tests'
const HELD = '[device] orca · held'

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
/** The `terminal send` runs the fake `orca` was asked for. */
const sends = (orca: FakeOrca): string[] => orca.runs().map((run) => run.args).filter((args) => args.startsWith('terminal send'))

describe("the dial's words reach the agent's own pane, Orca", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  let wezterm: PrivateWezterm | undefined
  let outside: Outside | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    // The terminals first: they hold the daemon's engine.
    await wezterm?.stop()
    await outside?.close()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    wezterm = undefined
    outside = undefined
    desk = undefined
    daemon = undefined
    backend = undefined
  })

  /** A daemon of its own, signed in to a fake backend that transcribes, the fake `orca` in its `bin`, its hooks in, and
   *  the dial on the desk shown its first list. */
  const fresh = async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    relay.speech = WORDS
    const d = await IsolatedDaemon.create({
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    const orca = FakeOrca.install(d)
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial, orca }
  }

  /** The dial speaks to [id]: the transcript or the refusal it is answered with. */
  const speak = (dial: FakeDial, id: string, uploadId: string): Promise<DialMessage> => {
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: id, uploadId, sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId })
    return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
  }

  /** No folder, words, session, handle or terminal of the case's in the daemon's log. */
  const logNames = (d: IsolatedDaemon, ...secrets: string[]): void => {
    for (const secret of [WORDS, ...secrets]) expect(d.log()).not.toContain(secret)
  }

  it.skipIf(!orcaHostCc)("an agent in a terminal Orca's host made takes the dial's words through orca terminal send", async () => {
    const { d, dial, orca } = await fresh()
    const handle = `term_${randomUUID()}`
    const claude = new InOrca(d, 'api', children, { ORCA_TERMINAL_HANDLE: handle })

    // 1. Its hook runs on a pty of Orca's terminal host: once the devices read that maker, its row takes words.
    await claude.hook('SessionStart', { source: 'startup' })
    const row = (await showing(dial, 'the agent listed, taking words',
      (rows) => rows.some((r) => r.id === claude.id && String(r.caps).includes('v')))).find((r) => r.id === claude.id)!
    expect(row.caps).toContain('v')

    // 2. The dial's words go to its own terminal, by its handle.
    expect(await speak(dial, claude.id, 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: WORDS, agentId: claude.id })
    await said(d, '[device] voice · orca')
    expect(sends(orca)).toEqual([`terminal send --terminal ${handle} --text=${WORDS} --enter --wait-submit 5 --json`])

    // 3. Its terminal is its own: never held.
    expect(lines(d, HELD)).toEqual([])
    logNames(d, claude.cwd, claude.sessionId, handle)
  })

  it.skipIf(!weztermBinary)('an agent in a WezTerm pane started from that terminal takes them in WezTerm, and Orca gets none', async () => {
    const { d, dial, orca } = await fresh()
    const handle = `term_${randomUUID()}`
    // WezTerm started from the Orca terminal: its panes keep the terminal's handle and Orca's variables.
    const mux = await PrivateWezterm.start(d, { ...IN_ORCA, ORCA_TERMINAL_HANDLE: handle })
    wezterm = mux

    // 1. The fake Claude Code in a pane: its hook names both the WezTerm pane and the Orca terminal.
    const pane = await mux.spawn('api')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    const row = (await showing(dial, 'the agent listed, taking words',
      (rows) => rows.some((r) => r.id === id && String(r.caps).includes('v')))).find((r) => r.id === id)!
    expect(row).toMatchObject({ engine: 'claude', host: 'wezterm' })
    // WezTerm's mux server made its pty, not Orca's host: the Orca terminal only holds it.
    await said(d, HELD)

    // 2. The dial's words are typed into the WezTerm pane, and none through Orca.
    expect(await speak(dial, id, 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: WORDS, agentId: id })
    await until('the words in its pane', async () => (await mux.text(pane)).includes(WORDS), 30_000, 100)
    await said(d, '[device] voice · wezterm')
    expect(sends(orca)).toEqual([])
    expect(lines(d, HELD)).toEqual([HELD])

    const tty = (JSON.parse(await mux.cli('list', '--format', 'json')) as Array<{ pane_id: number; tty_name?: string }>)
      .find((p) => String(p.pane_id) === pane)?.tty_name
    expect(tty).toBeTruthy()
    logNames(d, join(d.projectsDir, 'api'), sessionId, handle, tty!)
  })

  it('an agent in a terminal started from that terminal, where no app types, gets no words, and Orca none', async () => {
    const { d, dial, orca } = await fresh()
    const handle = `term_${randomUUID()}`
    // A terminal app's tab opened from the Orca terminal: the handle and Orca's variables come along.
    const agent = await Outside.start(d, 'api', { ...IN_ORCA, ORCA_TERMINAL_HANDLE: handle }, 'terminal-app')
    outside = agent

    // 1. Its maker read: the Orca terminal only holds it, and its row takes no words.
    await said(d, HELD)
    const row = (await showing(dial, 'the agent listed', (rows) => rows.some((r) => r.id === agent.id))).find((r) => r.id === agent.id)!
    expect(row.caps ?? '').not.toContain('v')

    // 2. Words spoken to it anyway are refused before any route: none through Orca, and no turn in the engine.
    expect(await speak(dial, agent.id, 'spoken-1')).toMatchObject({ t: 'voice.error' })
    expect(lines(d, '[device] voice · ')).toEqual([])
    expect(sends(orca)).toEqual([])
    expect(agent.ran(d, 'UserPromptSubmit')).toBe(false)
    expect(lines(d, HELD)).toEqual([HELD])
    logNames(d, join(d.projectsDir, 'api'), agent.sessionId, handle)
  })
})
