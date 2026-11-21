/**
 * The Claude app's Code sessions on the dial, with or without a process
 * (docs/plans/2026-11-19-dial-claude-app-sessions-design.md), on the real daemon: a store of the app's own written in
 * the daemon's home (src/testing/claudeAppFixture.ts) is what the Claude app writes, and a fake dial on the desk lists
 * its sessions that are not archived, idle, and taps one open by the app's link; words spoken to a resting one open it by
 * that link, then reach that session's mod alone once its process runs (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md).
 *
 * macOS and Linux. The real Claude app, its store folder, `~/.claude`, `/usr/bin/open` and `xdg-open` are never touched:
 * the store is a fixture in the daemon's throwaway home, checked to be inside its root before it starts; the session
 * with a process is the suite's fake Claude Code, given the Claude app's hints in its own environment only, and on Linux
 * run under a fake of the app (harness/outsideAgent.ts); `open`, and on Linux `xdg-open`, is the harness's fake
 * (HARNESS_OPEN_BIN, harness/daemon.ts), which only records its arguments; and on Linux the `claude` scheme's app is
 * named by a fake `xdg-mime` (harness/schemeApps.ts). The words spoken are an in-memory backend's transcript
 * (harness/fakeBackend.ts), and the woken session's process is the real hook run with the Claude app's hints
 * (harness/inOrca.ts), its mod this test's poll on the daemon's socket.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { claudeStoreRoots } from '../src/cable/hosts/appPlaces.js'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { ACCOUNT, ORG, claudeAppFixture, type FixtureSession } from '../src/testing/claudeAppFixture.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'
import { writeSchemeApps } from './harness/schemeApps.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const LINUX = process.platform === 'linux'
/** A tap's open: by the app's bundle on macOS; on Linux the link alone, as `xdg-open` takes it. */
const continued = (localId: string): string[] => {
  const url = `claude://code/continue?session=${localId}`
  return LINUX ? [url] : ['-b', CLAUDE_APP, url]
}
/** Every line the source says (Global Constraints): fixed words and counts, never a title, folder, path or id. */
const LINE = /^\[claude-app\] (watch · (on|none)|listed · \d+ sessions|read · \d+ ms · \d+ parsed · \d+ skipped|over · \d+|wake · (too long|open failed|timeout|ended|busy|stopped|refused|sent · \d+ ms))$/
/** The machine a daemon signs in as, to hear its dial's words: the daemon asks its backend for each transcript. */
const ME: FakeMachine = { machineId: 'c6'.repeat(16), computerId: 'e2e-claude-app-sessions-computer', name: 'Fixture', token: 'e2e-claude-app-sessions-token' }

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
/** The list once the rows [ids] take voice. On Linux the first list that holds them starts the `xdg-mime` read and can
 *  still say `sf`, and no change is pushed when the read answers: each list that has them without voice is asked again,
 *  once, until one has them at `svf`. */
const voiced = (dial: FakeDial, what: string, ids: string[], since = 0): Promise<DialMessage[]> => {
  let asked = -1
  return until(what, () => {
    const all = rosters(dial, since)
    const last = all.at(-1)
    if (!last || last.length !== ids.length || !last.every((row, i) => row.id === ids[i])) return null
    if (last.every((row) => row.caps === 'svf')) return last
    if (asked !== all.length) {
      asked = all.length
      dial.send({ t: 'agents.list' })
    }
    return null
  }, 45_000, 50)
}
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)
/** The source's lines, each from its `[claude-app]` on. */
const sourceLines = (d: IsolatedDaemon): string[] =>
  d.log().split('\n').filter((line) => line.includes('[claude-app]')).map((line) => line.slice(line.indexOf('[claude-app]')))
const session = (over: Partial<FixtureSession> & { cwd: string }): FixtureSession =>
  ({ localId: `local_${randomUUID()}`, cliSessionId: randomUUID(), ...over })

describe.skipIf(process.platform === 'win32')("the Claude app's Code sessions on the dial, from a fixture store and a fake process", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let backend: FakeBackend | undefined
  const outside: Outside[] = []
  const children: ChildProcess[] = []
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

  /** A daemon of its own, a desk, and the Claude app's store in its home holding [sessions], written before it starts;
   *  with [relay], signed in to it as ME, for the dial's words. */
  const fresh = async (sessions: Array<{ session: FixtureSession; mtime: number }>, relay?: FakeBackend) => {
    const signIn: Record<string, string> = relay ? { BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId } : {}
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false', ...signIn } })
    daemon = d
    // Before anything runs: its open, its home and so the store it reads are the root's, and no session it starts carries
    // the Claude app's host session id.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    expect(relative(d.root, d.env.HOME!).startsWith('..'), d.env.HOME).toBe(false)
    expect(d.env.CLAUDE_CODE_HOST_SESSION_ID).toBeUndefined()
    const root = claudeStoreRoots(process.platform, d.env, d.env.HOME!)[0].root
    expect(relative(d.root, root).startsWith('..'), root).toBe(false)
    const store = claudeAppFixture(root)
    store.org()
    for (const { session: one, mtime } of sessions) store.write(one, { mtime })
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    // Both apps' links have their app, as on a desktop with both installed.
    if (LINUX) writeSchemeApps(d, { claude: 'com.anthropic.Claude.desktop', codex: 'chatgpt.desktop' })
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
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    return { d, desk: theDesk, store }
  }

  it("the Claude app's sessions that are not archived are on the dial, idle, a tap opens one, and archiving one takes its row away", async () => {
    const now = Date.now()
    const alpha = session({ title: 'Fixture Alpha', cwd: '/work/e2e-alpha', lastActivityAt: now - 1_000 })
    const beta = session({ cwd: '/work/e2e-beta', lastActivityAt: now - 2_000 })
    const gamma = session({ title: 'Fixture Gamma', cwd: '/work/e2e-gamma', lastActivityAt: now - 3_000, isArchived: true })
    const gone = session({ title: 'Fixture Gone', cwd: '/work/e2e-gone', lastActivityAt: now - 4_000 })
    const { d, desk, store } = await fresh([
      { session: alpha, mtime: now - 1_000 }, { session: beta, mtime: now - 2_000 }, { session: gamma, mtime: now - 3_000 },
    ])
    // A deleted session leaves its `deleted_<uuid>` beside the others.
    store.write(gone, { mtime: now - 4_000 })
    store.remove(gone.localId)
    const alphaId = observedAgentId('claude', alpha.cliSessionId)
    const betaId = observedAgentId('claude', beta.cliSessionId)

    // 1. Listed idle, newest first, on the Claude app's page.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0c', FILTER)
    await dial.next((m) => m.t === 'apps' && m.shown === 'claude', 45_000, "the Claude app's page")
    const rows = await voiced(dial, 'both sessions listed, with voice', [alphaId, betaId])
    expect(rows).toEqual([
      expect.objectContaining({ id: alphaId, name: 'Fixture Alpha', engine: 'claude', host: 'claude', caps: 'svf' }),
      expect.objectContaining({ id: betaId, name: 'e2e-beta', engine: 'claude', host: 'claude', caps: 'svf' }),
    ])
    expect(dial.messages.filter((m) => (m.t === 'turn.started' || m.t === 'turn.done')
      && (m.agentId === alphaId || m.agentId === betaId))).toEqual([])

    // 2. A tap opens it in the Claude app, by its link.
    dial.send({ t: 'agent.open', agentId: alphaId })
    await until("the tap's open", () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([continued(alpha.localId)])

    // 3. Archived in the app: its row goes.
    const since = dial.messages.length
    const written = performance.now()
    store.write({ ...beta, isArchived: true }, { mtime: Date.now() })
    await said(d, '[claude-app] listed · 1 sessions')
    const toLine = Math.round(performance.now() - written)
    await showing(dial, 'alpha alone', (r) => r.length === 1 && r[0].id === alphaId, since)
    const toList = Math.round(performance.now() - written)
    console.log(`[claude-app e2e] store written → listed line: ${toLine} ms; → the dial's list: ${toList} ms`)

    // 4. Its lines: fixed words and counts, and nothing of a session in the whole log.
    const lines = sourceLines(d)
    expect(lines).toEqual(expect.arrayContaining(['[claude-app] watch · on', '[claude-app] listed · 2 sessions',
      '[claude-app] listed · 1 sessions']))
    const reads = lines.filter((line) => line.startsWith('[claude-app] read · '))
    console.log(`[claude-app e2e] ${reads.join('; ')}`)
    expect(reads.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toMatch(LINE)
    const log = d.log()
    for (const secret of ['Fixture Alpha', 'Fixture Gamma', 'e2e-alpha', 'e2e-beta', ACCOUNT, ORG,
      ...[alpha, beta, gamma, gone].flatMap((one) => [one.localId, one.cliSessionId])]) expect(log).not.toContain(secret)
    expect(d.opens()).toEqual([continued(alpha.localId)])
  })

  it('a session the Claude app runs is one row with its real state while its process runs, and the store\'s idle row under the same id once it ends', async () => {
    const LIVE = 'local_6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c'
    const { d, desk, store } = await fresh([])

    // 1. Its hooked copy, on the Claude app's page: the hints are the fake's alone. Linux has no bundle id: there the
    // walk of its parents names the Claude app, a fake of it above the engine, and its host stays a terminal's
    // (hostDetect.ts agentPlaceName).
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0c', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    let since = dial.messages.length
    const engine = LINUX
      ? await Outside.start(d, 'e2e-live', { CLAUDE_CODE_HOST_SESSION_ID: LIVE }, 'claude-app')
      : await Outside.start(d, 'e2e-live', { __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LIVE })
    outside.push(engine)
    await dial.next((m) => m.t === 'apps' && m.shown === 'claude', 45_000, "the Claude app's page", since)
    expect(await showing(dial, 'its hooked copy', (r) => r.length === 1 && r[0].id === engine.id, since))
      .toEqual([expect.objectContaining({ id: engine.id, host: LINUX ? 'terminal' : 'claude' })])

    // 2. The app's store names the same session: still one row, the same id.
    store.write({ localId: LIVE, cliSessionId: engine.sessionId, title: 'Fixture Live', cwd: join(d.projectsDir, 'e2e-live'),
      lastActivityAt: Date.now() })
    await said(d, '[claude-app] listed · 1 sessions')
    const asked = dial.messages.length
    dial.send({ t: 'agents.list' })
    expect((await showing(dial, 'the list it asked for', () => true, asked)).map((row) => row.id)).toEqual([engine.id])

    // 3. Its real state, which a store row has not.
    since = dial.messages.length
    engine.type('hello from the Claude app')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', since)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === engine.id, 45_000, 'its turn done', since)
    expect(d.opens()).toEqual([])

    // 4. Its process ends, its SessionEnd hook run: the store's idle row, under the same id.
    since = dial.messages.length
    engine.type('!exit')
    await until('its SessionEnd hook', () => engine.ran(d, 'SessionEnd'), 30_000, 50)
    await showing(dial, "the store's row", (r) => r.length === 1 && r[0].id === engine.id && r[0].name === 'Fixture Live', since)
    const rested = await voiced(dial, "the store's row, with voice", [engine.id], since)
    expect(rested).toEqual([expect.objectContaining({ id: engine.id, name: 'Fixture Live', host: 'claude', caps: 'svf' })])
    expect(dial.messages.slice(since).filter((m) => m.t === 'turn.started' && m.agentId === engine.id)).toEqual([])

    // 5. A tap opens it in the Claude app, by its link.
    dial.send({ t: 'agent.open', agentId: engine.id })
    await until("the tap's open", () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([continued(LIVE)])

    // No list held it twice, nor any other row; and the source's lines say nothing of it.
    for (const rows of rosters(dial)) expect(rows.every((row) => row.id === engine.id) && rows.length <= 1, JSON.stringify(rows)).toBe(true)
    for (const line of sourceLines(d)) {
      expect(line).toMatch(LINE)
      for (const secret of ['Fixture Live', LIVE, engine.sessionId]) expect(line).not.toContain(secret)
    }
  })

  it('words to a resting session open it in the Claude app, then reach that session alone once its process runs and its mod polls; another dial\'s words meanwhile are refused in plain words', async () => {
    const LOCAL = 'local_2b7e4c1d-9a3f-4e5b-8c6d-0f1a2b3c4d5e'
    const relay = await FakeBackend.start()
    backend = relay
    relay.addMachine(ME)
    const { d, desk, store } = await fresh([], relay)
    // The session's process once the app runs it: the real hook with the app's hints, and no Orca terminal named.
    const app = new InOrca(d, 'e2e-wake', children, { ORCA_AGENT_SESSION_ID: '', __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LOCAL })
    store.write({ localId: LOCAL, cliSessionId: app.sessionId, title: 'Fixture Wake', cwd: app.cwd, lastActivityAt: Date.now() })

    // 1. Two dials on the desk, a Pro and a round, each showing the resting session with voice.
    const a = await desk.plug('E2E-A', 'e2:e0:00:00:00:0c', FILTER)
    const b = await desk.plug('E2E-B', 'e2:e0:00:00:00:0d', FILTER)
    for (const dial of [a, b]) {
      await dial.next((m) => m.t === 'apps' && m.shown === 'claude', 45_000, "the Claude app's page")
      expect(await voiced(dial, 'the resting session, with voice', [app.id]))
        .toEqual([expect.objectContaining({ id: app.id, name: 'Fixture Wake', host: 'claude', caps: 'svf' })])
    }
    const speak = (dial: FakeDial, uploadId: string): Promise<DialMessage> => {
      const since = dial.messages.length
      dial.send({ t: 'voice.begin', agentId: app.id, uploadId, sr: 16_000, lang: 'en' })
      dial.audio(Buffer.alloc(3_200, 1))
      dial.send({ t: 'voice.end', uploadId })
      return dial.next((m) => (m.t === 'voice.transcript' || m.t === 'voice.error') && m.uploadId === uploadId, 65_000,
        'the answer to its words', since)
    }

    // 2. A's words open that very session by its link.
    const first = 'run the wake tests'
    relay.speech = first
    const answered = speak(a, 'e2e-voice-a')
    await until("the wake's open", () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([continued(LOCAL)])

    // 3. B's words while it opens: refused at once, in plain words, never queued.
    const second = 'words from the second dial'
    relay.speech = second
    expect(await speak(b, 'e2e-voice-b'))
      .toMatchObject({ t: 'voice.error', message: 'Still opening Fixture Wake. Try again in a moment.' })

    // 4. The app runs the session and its mod polls: A's words, and only A's, reach it, and A hears they were sent.
    await app.hook('SessionStart', { source: 'resume' })
    expect(await inboxPoll(d, app.sessionId)).toEqual({ status: 200, body: { text: first } })
    expect(await answered).toMatchObject({ t: 'voice.transcript', agentId: app.id, text: first })
    expect(d.opens()).toEqual([continued(LOCAL)])

    // 5. Its lines and counts: fixed words, the time it took, and nothing of the session or either dial's words.
    await said(d, '[device] voice · wake-sent')
    const lines = sourceLines(d)
    expect(lines).toContain('[claude-app] wake · busy')
    const sent = lines.find((line) => line.startsWith('[claude-app] wake · sent · '))
    expect(sent, lines.join('\n')).toBeDefined()
    console.log(`[claude-app e2e] words → its mod: ${sent}`)
    for (const line of lines) expect(line).toMatch(LINE)
    const log = d.log()
    expect(log).toContain('[device] voice · wake-busy')
    for (const secret of ['Fixture Wake', 'e2e-wake', LOCAL, app.sessionId, first, second]) expect(log).not.toContain(secret)
  })
})
