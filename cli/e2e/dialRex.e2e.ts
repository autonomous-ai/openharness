/**
 * The dial reaches an agent in a Rex block (docs/specs/2026-11-25-dial-rex.md), on the real daemon: a Rex server of the
 * test's own (harness/rexSession.ts) runs the suite's hooked fake Claude Code in a block of its own, in a window beside
 * the session's shell. A fake dial on the desk that says `appFilter` sees it on Rex's page, able to take words and be
 * brought forward. It speaks to it, taps it, and speaks again once its block is closed.
 *
 * The fake Claude Code runs no mod (the Claude Code plugin's), so its words are typed by Rex: `rex send`, the settle,
 * `rex send-key enter`. The test's server has no Rex app connected, so a tap's session switch finds none to ask.
 *
 * Skipped where the Rex app's server is not installed (macOS only). No `rex` the daemon or the test runs reaches the
 * person's own server: every one is told the test's.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { PrivateRex, rexBinary } from './harness/rexSession.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c7'.repeat(16), computerId: 'e2e-dial-rex-computer', name: 'Fixture', token: 'e2e-dial-rex-token' }

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

describe.skipIf(!rexBinary)('an agent in a Rex block is on the dial', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  let rex: PrivateRex | undefined
  afterEach(async () => {
    // Rex first: its blocks hold the daemon's engine.
    await rex?.stop()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    rex = undefined
    desk = undefined
    daemon = undefined
    backend = undefined
  })

  it("a hooked Claude Code in a Rex block is on Rex's page, takes the dial's words, a tap focuses its block, and once closed it takes none", async () => {
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
    const prepared = PrivateRex.prepare(d)
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const session = await PrivateRex.start(d, prepared)
    rex = session
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0d', { appFilter: 'v1' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. The fake Claude Code in a block of its own: its hook runs with Rex's variables, REX_SESSION among them.
    const block = await session.agent('api')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    // It takes words once the devices read that Rex's server made its terminal: until then its block only holds it.
    const row = (await showing(dial, 'the hooked agent listed, taking words',
      (rows) => rows.some((r) => r.id === id && String(r.caps).includes('v')))).find((r) => r.id === id)!
    expect(row).toMatchObject({ engine: 'claude', host: 'rex' })
    expect(row.caps).toContain('f')
    // Rex's page, no longer Other's.
    const apps = await dial.next((m) => m.t === 'apps' && Array.isArray(m.apps)
      && (m.apps as Array<{ id: string }>).some((a) => a.id === 'rex'), 45_000, "Rex's page")
    expect((apps.apps as Array<{ id: string; name: string }>).find((a) => a.id === 'rex')).toMatchObject({ name: 'Rex' })

    // 2. The dial's words are its next prompt, typed by `rex send`, then Enter after the settle.
    const since = dial.messages.length
    expect(await speak(dial, relay, id, 'run the tests', 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: 'run the tests', agentId: id })
    await until('the words in its block', async () => (await session.screen(block)).includes('run the tests'), 30_000, 100)
    await until('its turn in the engine', () => d.hookLog().includes(`UserPromptSubmit session=${sessionId} ran`), 30_000, 100)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)
    await said(d, '[device] voice · rex')

    // 3. A tap runs `rex block focus` for its block: the session's shell had the focus. No Rex app is connected to the
    //    test's server, so the session switch finds none, and says so once.
    await session.focus(session.shell)
    expect(await session.focused()).toBe(session.shell)
    dial.send({ t: 'agent.open', agentId: id })
    await until('the tap to focus its block', async () => (await session.focused()) === block || undefined, 30_000, 100)
    await said(d, '[device] open · rex · session not shown (no app)')

    // 4. Its block closed, the dial's words are refused and typed nowhere.
    await session.close(block)
    expect(await speak(dial, relay, id, 'echo closed', 'spoken-2')).toMatchObject({ t: 'voice.error' })
    expect(await session.screen(session.shell)).not.toContain('echo closed')

    // 5. No folder or words in the log.
    for (const secret of [join(d.projectsDir, 'api'), 'run the tests', 'echo closed']) expect(d.log()).not.toContain(secret)
  })
})
