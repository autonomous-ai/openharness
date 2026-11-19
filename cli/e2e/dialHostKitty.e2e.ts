/**
 * The dial reaches an agent in a kitty window (docs/plans/2026-11-19-dial-linux-design.md § 3.3), on the real daemon:
 * kitty draws on an X11 desk of the test's own (harness/x11Desk.ts) and runs the suite's hooked fake Claude Code
 * (harness/kittyWindow.ts), and a fake dial on the desk lists it, speaks to it and taps it. kitty's remote control is
 * on for its socket alone, as docs/cli.md tells a person to set it; a kitty with it off, kitty's default, only says so.
 *
 * Skipped where kitty or the X11 programs are not installed, and off Linux: it would open a real window. CI's
 * `e2e (dial hosts)` job installs them, and there a missing one fails the file (harness/dialHosts.ts).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { KittyWindows, kittyInstalled } from './harness/kittyWindow.js'
import { X11Desk } from './harness/x11Desk.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c5'.repeat(16), computerId: 'e2e-dial-kitty-computer', name: 'Fixture', token: 'e2e-dial-kitty-token' }
const OFF = '[device] kitty · remote control off'

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
const logged = (d: IsolatedDaemon, line: string) => d.log().split('\n').filter((found) => found.endsWith(line)).length
const said = (d: IsolatedDaemon, line: string) => until(`"${line}" in the daemon's log`, () => logged(d, line) > 0, 30_000, 50)

describe.skipIf(!kittyInstalled)('the dial reaches an agent in a kitty window', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  let x11: X11Desk | undefined
  let kitty: KittyWindows | undefined
  afterEach(async () => {
    // kitty first: its windows hold the daemon's engines, and it draws on the X11 desk.
    await kitty?.stop()
    await x11?.stop()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    kitty = undefined
    x11 = undefined
    desk = undefined
    daemon = undefined
    backend = undefined
  })

  /** A daemon signed in as ME, kitty on its own X11 desk, and a dial attached that has its first list. */
  async function started(): Promise<{ d: IsolatedDaemon; relay: FakeBackend; windows: KittyWindows; dial: FakeDial }> {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const d = await IsolatedDaemon.create({
      env: { CABLE_DISABLE: 'false', BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId },
    })
    daemon = d
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    // Signed in as ME: the session `harness login` leaves, which the core reads at start.
    writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
      autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
      expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
    }), { mode: 0o600 })
    const x = await X11Desk.start(d)
    x11 = x
    const windows = new KittyWindows(d, x)
    kitty = windows
    await d.start()
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, relay, windows, dial }
  }

  it("a hooked Claude Code in a kitty window takes the dial's words as its next prompt, and a tap focuses its window", async () => {
    const { d, relay, windows, dial } = await started()

    // 1. The fake Claude Code in kitty's first window, a shell beside it the active one: its hook runs with
    // KITTY_WINDOW_ID and KITTY_LISTEN_ON.
    const agent = await windows.agent('api', true)
    const shell = await windows.beside(agent)
    const id = observedAgentId('claude', agent.sessionId)
    const row = (await showing(dial, 'the hooked agent listed', (rows) => rows.some((r) => r.id === id))).find((r) => r.id === id)!
    expect(row).toMatchObject({ engine: 'claude', host: 'kitty' })
    expect(row.caps).toContain('v')
    expect(row.caps).toContain('f')

    // 2. The dial's words are its next prompt, typed by `kitten @ send-text`, then `send-key enter`.
    relay.speech = 'run the spoken tests'
    const since = dial.messages.length
    dial.send({ t: 'voice.begin', agentId: id, uploadId: 'spoken-1', sr: 16_000, lang: 'en' })
    dial.audio(Buffer.alloc(3_200, 1))
    dial.send({ t: 'voice.end', uploadId: 'spoken-1' })
    expect(await dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since))
      .toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: id })
    await until('the words in its window', async () => (await windows.text(agent)).includes('run the spoken tests'), 30_000, 100)
    await until('its turn in the engine', () => d.hookLog().includes(`UserPromptSubmit session=${agent.sessionId} ran`), 30_000, 100)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)
    await said(d, '[device] voice · kitty')

    // 3. A tap runs `kitten @ focus-window` for its window.
    expect(await windows.active(agent)).toBe(false)
    expect(await windows.active(agent, shell)).toBe(true)
    dial.send({ t: 'agent.open', agentId: id })
    await until('its window active', () => windows.active(agent), 30_000, 100)

    // 4. No folder, socket or words in the log.
    for (const secret of [join(d.projectsDir, 'api'), agent.listenOn!, 'run the spoken tests']) expect(d.log()).not.toContain(secret)
  })

  it('a kitty with remote control off says so once, and its agents take no words', async () => {
    const { d, windows, dial } = await started()

    // Two kitties, neither listening: each agent's hooks run with KITTY_WINDOW_ID alone.
    const ids = [(await windows.agent('api', false)).sessionId, (await windows.agent('web', false)).sessionId]
      .map((sessionId) => observedAgentId('claude', sessionId))
    const rows = await showing(dial, 'both agents listed', (listed) => ids.every((id) => listed.some((r) => r.id === id)))
    for (const id of ids) expect(rows.find((r) => r.id === id)!.caps).not.toContain('v')
    expect(logged(d, OFF)).toBe(1)
  })
})
