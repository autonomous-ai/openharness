/**
 * The Claude app's Code sessions on the dial, with or without a process
 * (docs/plans/2026-11-19-dial-claude-app-sessions-design.md), on the real daemon: a store of the app's own written in
 * the daemon's home (src/testing/claudeAppFixture.ts) is what the Claude app writes, and a fake dial on the desk lists
 * its sessions that are not archived, idle, and taps one open by the app's link.
 *
 * The real Claude app, its Application Support folder, `~/.claude` and `/usr/bin/open` are never touched: the store is a
 * fixture in the daemon's throwaway home, checked to be inside its root before it starts; the session with a process is
 * the suite's fake Claude Code, given the Claude app's hints in its own environment only; and `open` is the harness's
 * fake (HARNESS_OPEN_BIN, harness/daemon.ts), which only records its arguments. No backend: nothing is spoken.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { ACCOUNT, ORG, claudeAppFixture, type FixtureSession } from '../src/testing/claudeAppFixture.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CLAUDE_APP = 'com.anthropic.claudefordesktop'
const continued = (localId: string): string[] => ['-b', CLAUDE_APP, `claude://code/continue?session=${localId}`]
/** Every line the source says (Global Constraints): fixed words and counts, never a title, folder, path or id. */
const LINE = /^\[claude-app\] (watch · (on|none)|listed · \d+ sessions|read · \d+ ms · \d+ parsed · \d+ skipped|over · \d+)$/

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
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)
/** The source's lines, each from its `[claude-app]` on. */
const sourceLines = (d: IsolatedDaemon): string[] =>
  d.log().split('\n').filter((line) => line.includes('[claude-app]')).map((line) => line.slice(line.indexOf('[claude-app]')))
const session = (over: Partial<FixtureSession> & { cwd: string }): FixtureSession =>
  ({ localId: `local_${randomUUID()}`, cliSessionId: randomUUID(), ...over })

describe.skipIf(process.platform !== 'darwin')("the Claude app's Code sessions on the dial, from a fixture store and a fake process", () => {
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

  /** A daemon of its own, a desk, and the Claude app's store in its home holding [sessions], written before it starts. */
  const fresh = async (sessions: Array<{ session: FixtureSession; mtime: number }>) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    // Before anything runs: its open, its home and so the store it reads are the root's, and no session it starts carries
    // the Claude app's host session id.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)
    expect(relative(d.root, d.env.HOME!).startsWith('..'), d.env.HOME).toBe(false)
    expect(d.env.CLAUDE_CODE_HOST_SESSION_ID).toBeUndefined()
    const root = join(d.env.HOME!, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
    expect(relative(d.root, root).startsWith('..'), root).toBe(false)
    const store = claudeAppFixture(root)
    store.org()
    for (const { session: one, mtime } of sessions) store.write(one, { mtime })
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
    const rows = await showing(dial, 'both sessions listed', (r) => r.length === 2)
    expect(rows).toEqual([
      expect.objectContaining({ id: alphaId, name: 'Fixture Alpha', engine: 'claude', host: 'claude', caps: 'sf' }),
      expect.objectContaining({ id: betaId, name: 'e2e-beta', engine: 'claude', host: 'claude', caps: 'sf' }),
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

    // 1. Its hooked copy, on the Claude app's page: the hints are the fake's alone.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0c', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    const engine = await Outside.start(d, 'e2e-live', { __CFBundleIdentifier: CLAUDE_APP, CLAUDE_CODE_HOST_SESSION_ID: LIVE })
    outside.push(engine)
    expect(await showing(dial, 'its hooked copy', (r) => r.length === 1 && r[0].id === engine.id))
      .toEqual([expect.objectContaining({ id: engine.id, host: 'claude' })])

    // 2. The app's store names the same session: still one row, the same id.
    store.write({ localId: LIVE, cliSessionId: engine.sessionId, title: 'Fixture Live', cwd: join(d.projectsDir, 'e2e-live'),
      lastActivityAt: Date.now() })
    await said(d, '[claude-app] listed · 1 sessions')
    const asked = dial.messages.length
    dial.send({ t: 'agents.list' })
    expect((await showing(dial, 'the list it asked for', () => true, asked)).map((row) => row.id)).toEqual([engine.id])

    // 3. Its real state, which a store row has not.
    let since = dial.messages.length
    engine.type('hello from the Claude app')
    await dial.next((m) => m.t === 'turn.started' && m.agentId === engine.id, 45_000, 'its turn started', since)
    await dial.next((m) => m.t === 'turn.done' && m.agentId === engine.id, 45_000, 'its turn done', since)
    expect(d.opens()).toEqual([])

    // 4. Its process ends, its SessionEnd hook run: the store's idle row, under the same id.
    since = dial.messages.length
    engine.type('!exit')
    await until('its SessionEnd hook', () => engine.ran(d, 'SessionEnd'), 30_000, 50)
    const rested = await showing(dial, "the store's row", (r) => r.length === 1 && r[0].id === engine.id && r[0].name === 'Fixture Live', since)
    expect(rested).toEqual([expect.objectContaining({ id: engine.id, name: 'Fixture Live', host: 'claude', caps: 'sf' })])
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
})
