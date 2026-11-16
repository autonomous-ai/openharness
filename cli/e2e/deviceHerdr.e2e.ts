/**
 * herdr's agents on the dial (docs/specs/2026-11-16-device-herdr.md), on the real daemon: a herdr server of the test's
 * own (harness/herdrServer.ts) holds a fake agent in a pane, told to herdr as `claude`, and a fake dial on the desk lists
 * it with no hook, follows its state, taps it and speaks to it. herdr started after the dial comes with no restart, and
 * a hooked Claude Code in a herdr pane is one row, its hook's.
 *
 * Skipped where herdr or `cc` is not installed, as on every GitHub runner. It never starts herdr against the developer's
 * own config, and no `herdr` the daemon runs reaches any other server.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { herdrBinary, PrivateHerdr } from './harness/herdrServer.js'

/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c1'.repeat(16), computerId: 'e2e-device-herdr-computer', name: 'Fixture', token: 'e2e-device-herdr-token' }

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
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

describe.skipIf(!herdrBinary)("herdr's agents on the dial, from a private herdr server", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const servers: PrivateHerdr[] = []
  afterEach(async () => {
    // herdr first: its panes are the daemon's root's, and the daemon's close sweeps what names the root.
    for (const server of servers.splice(0)) await server.stop()
    await desk?.close()
    await daemon?.close()
    await backend?.close()
    daemon = undefined
    desk = undefined
    backend = undefined
  })

  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk; relay: FakeBackend }> => {
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
    const theDesk = new Desk(file)
    desk = theDesk
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
    return { d, desk: theDesk, relay }
  }
  const herdrFor = async (d: IsolatedDaemon): Promise<PrivateHerdr> => {
    const server = await PrivateHerdr.start(d)
    servers.push(server)
    return server
  }
  const stopped = async (server: PrivateHerdr): Promise<void> => {
    servers.splice(servers.indexOf(server), 1)
    await server.stop()
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

  it("herdr's agents are on the dial with their state and no hook, and take a tap and the dial's words", async () => {
    const { d, desk, relay } = await fresh()
    const herdr = await herdrFor(d)
    const pane = await herdr.agent('api', 'idle')

    // 1. Listed with no hook: herdr's name for it is its folder's.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    const rows = await showing(dial, 'api listed', named('api'))
    const row = rows.find((r) => r.name === 'api')!
    expect(row).toMatchObject({ name: 'api', engine: 'claude', host: 'herdr', caps: 'svf' })
    const id = row.id

    // 2. Its state, as herdr tells it: working, waiting on the person, and a turn that ends in an unfocused pane.
    let since = dial.messages.length
    await herdr.report(pane, 'working')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its turn started', since)
    since = dial.messages.length
    await herdr.report(pane, 'blocked')
    await dial.next((m) => (m.t === 'turn.started' || m.t === 'turn.activity') && m.agentId === id && m.text === 'Waiting for you · herdr',
      45_000, 'the waiting line', since)
    since = dial.messages.length
    await herdr.report(pane, 'working')
    await herdr.report(pane, 'idle')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', since)

    // 3. A tap runs `herdr agent focus` through the daemon's wrapper, which reaches this server alone.
    dial.send({ t: 'agent.open', agentId: id })
    await until('its pane focused', async () => ((await herdr.rpc('agent.get', { target: pane })).agent as { focused?: boolean }).focused === true,
      30_000, 100)

    // 4. The dial's words are its next prompt.
    expect(await speak(dial, relay, id, 'run the spoken tests', 'spoken-1')).toMatchObject({ t: 'voice.transcript', text: 'run the spoken tests', agentId: id })
    await until('the words in its pane', async () => (await herdr.screen(pane)).includes('GOT[run the spoken tests]'), 30_000, 100)
    await said(d, '[device] voice · herdr')

    // 5. Working, it takes none; a turn that ends idle in the focused pane is done all the same (Q10).
    since = dial.messages.length
    await herdr.report(pane, 'working')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === id, 45_000, 'its second turn started', since)
    expect(await speak(dial, relay, id, 'not now', 'spoken-2')).toMatchObject({ t: 'voice.error' })
    await said(d, '[device] voice · busy')
    expect(await herdr.screen(pane)).not.toContain('not now')
    since = dial.messages.length
    await herdr.report(pane, 'idle')
    expect(((await herdr.rpc('agent.get', { target: pane })).agent as { agent_status?: string }).agent_status).toBe('idle')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its second turn done', since)

    // 6. A pane told to herdr as an agent that holds only its shell is listed, and herdr types nothing into it.
    const ops = await herdr.pane('ops')
    await herdr.report(ops, 'idle')
    const opsRow = (await showing(dial, 'ops listed', named('ops'))).find((r) => r.name === 'ops')!
    expect(await speak(dial, relay, opsRow.id, 'ls', 'spoken-3')).toMatchObject({ t: 'voice.error' })
    await said(d, '[device] voice · no-answer')
    expect(await herdr.screen(ops)).not.toMatch(/(^|\s)ls(\s|$)/m)

    // 7. No pane id, folder or words in the log.
    const log = d.log()
    expect(log).toContain('[herdr] listed · 1 agents')
    for (const secret of [pane, ops, join(d.projectsDir, 'api'), join(d.projectsDir, 'ops'), 'run the spoken tests', 'not now']) {
      expect(log).not.toContain(secret)
    }
  })

  it('herdr started after the dial, and stopped: its agents come with no daemon restart, and go', async () => {
    const { d, desk } = await fresh()
    // Installed, not running: the devices look for herdr on PATH as the dial attaches.
    await PrivateHerdr.install(d)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. No herdr server yet: the source waits on the folder its socket will be in.
    const first = await herdrFor(d)
    await first.agent('api', 'idle')
    await showing(dial, 'api listed', named('api'))

    // 2. Stopped: the row goes.
    const since = dial.messages.length
    await stopped(first)
    await showing(dial, 'api gone', (rows) => !rows.some((row) => row.host === 'herdr'), since)
    await said(d, '[herdr] closed · ended')

    // 3. Started again, on the same daemon.
    const again = await herdrFor(d)
    await again.agent('api', 'idle')
    await showing(dial, 'api listed again', named('api'), since)
  })

  it("a hooked Claude Code in a herdr pane is one row, its hook's, and gets each card once", async () => {
    const { d, desk } = await fresh()
    const herdr = await herdrFor(d)
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a')
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    // 1. The suite's fake Claude Code in a herdr pane: its hook runs with herdr's own HERDR_PANE_ID.
    const pane = await herdr.pane('hooked')
    await until('the shell in its pane', async () => /\S/.test(await herdr.screen(pane)), 20_000, 100)
    await herdr.type(pane, '"$CLAUDE_PATH"')
    const sessionId = await until('its SessionStart hook to run',
      () => d.hookLog().match(/claude pid=\d+ SessionStart\(startup\) session=(\S+) ran/)?.[1], 30_000, 100)
    const id = observedAgentId('claude', sessionId)
    await showing(dial, 'the hooked agent listed', (rows) => rows.some((row) => row.id === id))

    // 2. Told to herdr too: herdr lists it, and the dial still has one row for that pane, the hook's.
    await herdr.report(pane, 'idle')
    await said(d, '[herdr] listed · 1 agents')
    const since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const rows = await showing(dial, 'the list asked for', () => true, since)
    expect(rows.map((row) => ({ id: row.id, host: row.host }))).toEqual([{ id, host: 'herdr' }])

    // 3. A turn: one card for each of its moves, and none for any other id.
    const turn = dial.messages.length
    await herdr.type(pane, 'hello from herdr')
    await dial.next((m) => m.t === 'turn.done' && m.agentId === id, 45_000, 'its turn done', turn)
    // Its answer comes after its done card: a second card for the turn would be heard by then.
    await dial.next((m) => m.t === 'summary' && m.agentId === id, 45_000, 'its answer', turn)
    const cards = dial.messages.slice(turn).filter((m) => m.t === 'turn.started' || m.t === 'turn.done')
    expect(cards.map((m) => [m.t, m.agentId])).toEqual([['turn.started', id], ['turn.done', id]])
  })
})
