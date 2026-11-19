/**
 * The dial reaches an agent in a Zellij pane (docs/plans/2026-11-19-dial-linux-design.md § 3.2), on the real daemon: a
 * background Zellij session of the test's own (harness/zellijSession.ts) runs the suite's hooked fake Claude Code in a
 * pane beside a shell, and a fake dial on the desk lists it as able to take words and be brought forward, speaks to it,
 * taps it, and speaks again once its pane is closed. Zellij 0.44 reports no focus change (testing/recordedZellij.ts),
 * so focusing the pane in Zellij does not turn the dial.
 *
 * Skipped where Zellij is not installed. CI's `e2e (dial hosts)` job installs it, and there a missing one fails the
 * file (harness/dialHosts.ts). No `zellij` the daemon runs reaches any other session.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { PrivateZellij, zellijBinary } from './harness/zellijSession.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c4'.repeat(16), computerId: 'e2e-dial-zellij-computer', name: 'Fixture', token: 'e2e-dial-zellij-token' }

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
/** The dial speaks [words] to [agentId], and the fake backend transcribes them: what the dial hears back. */
const speak = (dial: FakeDial, relay: FakeBackend, agentId: string, words: string, uploadId: string): Promise<DialMessage> => {
  relay.speech = words
  const since = dial.messages.length
  dial.send({ t: 'voice.begin', agentId, uploadId, sr: 16_000, lang: 'en' })
  dial.audio(Buffer.alloc(3_200, 1))
  dial.send({ t: 'voice.end', uploadId })
  return dial.next((m) => m.t === 'voice.transcript' || m.t === 'voice.error', 45_000, 'the answer to its words', since)
}
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

describe.skipIf(!zellijBinary)('an agent in a Zellij pane is on the dial', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  let zellij: PrivateZellij | undefined
  afterEach(async () => {
    // Zellij first: its panes hold the daemon's engine.
    await zellij?.stop()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    zellij = undefined
    desk = undefined
    daemon = undefined
    backend = undefined
  })

  it("a hooked Claude Code in a Zellij pane takes the dial's words, a tap focuses its pane, and once closed it takes none", async () => {
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
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
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    const session = await PrivateZellij.start(d)
    zellij = session
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0c')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. The fake Claude Code in a pane of its own beside the focused shell: its hook runs with Zellij's variables.
    const pane = await session.agent('api')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    const row = (await showing(dial, 'the hooked agent listed', (rows) => rows.some((r) => r.id === id))).find((r) => r.id === id)!
    expect(row).toMatchObject({ engine: 'claude', host: 'zellij' })
    expect(row.caps).toContain('v')
    expect(row.caps).toContain('f')

    // 2. The dial's words are its next prompt, typed by `write-chars` and `send-keys`. Short: the pane is half of
    //    Zellij's 50 columns, and longer words would wrap.
    const since = dial.messages.length
    expect(await speak(dial, relay, id, 'run the tests', 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: 'run the tests', agentId: id })
    await until('the words in its pane', async () => (await session.screen(pane)).includes('run the tests'), 30_000, 100)
    await until('its turn in the engine', () => d.hookLog().includes(`UserPromptSubmit session=${sessionId} ran`), 30_000, 100)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)
    await said(d, '[device] voice · zellij')

    // 3. A tap runs `focus-pane-id` for its pane; its focus is read once that has run (PrivateZellij.ran).
    expect(await session.focused()).toBe(session.shell)
    const focuses = session.ran('focus-pane-id')
    dial.send({ t: 'agent.open', agentId: id })
    await until('the tap to focus its pane', () => session.ran('focus-pane-id') > focuses, 30_000, 100)
    expect(await session.focused()).toBe(pane)

    // 4. Its pane closed, the dial's words are refused and typed nowhere.
    await session.close(pane)
    expect(await speak(dial, relay, id, 'echo closed', 'spoken-2')).toMatchObject({ t: 'voice.error' })
    expect(await session.screen(session.shell)).not.toContain('echo closed')

    // 5. No folder or words in the log.
    for (const secret of [join(d.projectsDir, 'api'), 'run the tests', 'echo closed']) expect(d.log()).not.toContain(secret)
  })
})
