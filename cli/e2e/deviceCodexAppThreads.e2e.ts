/**
 * The ChatGPT app's Codex threads on the dial, with or without a process
 * (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md), on the real daemon: a Codex home of the app's own
 * written in the daemon's home (src/testing/codexAppFixture.ts) is what the ChatGPT app keeps, and a fake dial on the desk
 * lists its threads, idle, in the app's sidebar's order, and taps one open by the app's link.
 *
 * The real ChatGPT app, `~/.codex`, /Applications and `/usr/bin/open` are never touched: the Codex home is a fixture in
 * the daemon's throwaway home and the app a fake Info.plist in its `~/Applications`, both checked to be inside its root
 * before it starts; /Applications is a folder of the root (HARNESS_APPLICATIONS_DIR, harness/daemon.ts) that holds no
 * app; and `open` is the harness's fake (HARNESS_OPEN_BIN), which only records its arguments. No backend.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { NEVER_READ, codexAppFixture } from '../src/testing/codexAppFixture.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CODEX_APP = 'com.openai.codex'
/** Every line the source says: fixed words and counts, never a name, folder, path or id. */
const LINE = /^\[codex-app\] (watch · (on|none)|listed · \d+ threads · \d+ in projects|read · \d+ ms · \d+ rows · \d+ skipped|read · failed)$/
/** The app's bundle as the devices read it (`plutil`): its id and nothing else of the app. */
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${CODEX_APP}</string>
</dict>
</plist>
`

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
/** The list the dial shows now, once its rows are [ids] in that order. */
const showing = (dial: FakeDial, what: string, ids: readonly string[], since = 0, ms = 45_000): Promise<DialMessage[]> =>
  until(what, () => {
    const last = rosters(dial, since).at(-1)
    return last && JSON.stringify(last.map((row) => row.id)) === JSON.stringify(ids) ? last : null
  }, ms, 50)
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)
/** The source's lines, each from its `[codex-app]` on. */
const sourceLines = (d: IsolatedDaemon): string[] =>
  d.log().split('\n').filter((line) => line.includes('[codex-app]')).map((line) => line.slice(line.indexOf('[codex-app]')))
const inside = (root: string, path: string): boolean => isAbsolute(path) && !relative(root, path).startsWith('..')

describe.skipIf(process.platform !== 'darwin')("the ChatGPT app's threads on the dial, from a fixture ~/.codex", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  afterEach(async () => {
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  it("lists them idle in the sidebar's order, a tap opens one in the app, and an archive or a newer time is followed", async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    // Before anything runs: its open, its /Applications and its home, and so the app and the Codex home it reads, are
    // the root's; and its /Applications holds no ChatGPT app, so only the home's fake is found.
    const apps = d.env.HARNESS_APPLICATIONS_DIR ?? ''
    for (const path of [d.env.HARNESS_OPEN_BIN ?? '', apps, d.env.HOME ?? '']) expect(inside(d.root, path), path).toBe(true)
    expect(existsSync(join(apps, 'ChatGPT.app')), apps).toBe(false)
    const contents = join(d.env.HOME!, 'Applications', 'ChatGPT.app', 'Contents')
    mkdirSync(contents, { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), INFO_PLIST)
    // The app's Codex home, not the CODEX_HOME Harness runs Codex under (`<root>/codex`).
    const home = join(d.env.HOME!, '.codex')
    expect(inside(d.root, home), home).toBe(true)
    expect(home).not.toBe(d.env.CODEX_HOME)

    const now = Date.now()
    const [p1, p2, r1, r2, r3, a1, e1] = Array.from({ length: 7 }, () => randomUUID())
    const folder = (id: string) => `/work/e2e-${id.slice(0, 8)}`
    const fixture = codexAppFixture(home)
    fixture.threads([
      { id: p1, cwd: folder(p1), recencyAtMs: now - 5_000 },
      { id: p2, cwd: folder(p2), recencyAtMs: now - 6_000 },
      { id: r1, cwd: folder(r1), recencyAtMs: now - 1_000 },
      { id: r2, cwd: folder(r2), recencyAtMs: now - 2_000 },
      { id: r3, cwd: folder(r3), recencyAtMs: now - 3_000 },
      { id: a1, cwd: folder(a1), recencyAtMs: now, archived: 1 },
      { id: e1, cwd: folder(e1), recencyAtMs: now, source: 'exec' },
    ])
    const local = { projectKind: 'local', projectId: 'P' }
    fixture.state({ projectOrder: ['P'], assignments: { [p1]: local, [p2]: local } })
    fixture.name(p1, 'Fixture Named')
    const agent = (thread: string) => observedAgentId('codex', thread)

    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()

    // 1. The app found, its page shown: the project's two first, then Recent newest first, every one idle.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0d', FILTER)
    await dial.next((m) => m.t === 'apps' && m.shown === 'codex', 45_000, "the ChatGPT app's page")
    const rows = await showing(dial, 'the five threads', [p1, p2, r1, r2, r3].map(agent))
    expect(rows).toEqual([
      expect.objectContaining({ id: agent(p1), name: 'Fixture Named', host: 'codex', caps: 'sf' }),
      ...[p2, r1, r2, r3].map((id) => expect.objectContaining({ id: agent(id), name: folder(id).slice('/work/'.length), host: 'codex', caps: 'sf' })),
    ])
    expect(dial.messages.filter((m) => m.t === 'turn.started' || m.t === 'turn.done')).toEqual([])

    // 2. A rest on each runs no open, with nothing in front; 3. a tap opens one in the app, by its link. Step 6's last
    // check of the opens holds the rests: by then the tap's is still the only one.
    for (const id of [p1, p2, r1, r2, r3]) dial.send({ t: 'focus', agentId: agent(id) })
    dial.send({ t: 'agent.open', agentId: agent(r1) })
    await until("the tap's open", () => d.opens().length > 0, 30_000, 50)
    expect(d.opens()).toEqual([['-b', CODEX_APP, `codex://threads/${r1}`]])

    // 4. Archived in the app: its row goes.
    let since = dial.messages.length
    const written = performance.now()
    fixture.update(r2, { archived: 1 })
    await said(d, '[codex-app] listed · 4 threads · 2 in projects')
    const toLine = Math.round(performance.now() - written)
    await showing(dial, 'r2 gone', [p1, p2, r1, r3].map(agent), since)
    const toList = Math.round(performance.now() - written)
    console.log(`[codex-app e2e] store written → listed line: ${toLine} ms; → the dial's list: ${toList} ms`)

    // 5. A Recent thread given a newer time: the head of Recent.
    since = dial.messages.length
    fixture.update(r3, { recencyAtMs: Date.now() })
    await showing(dial, 'r3 at the head of Recent', [p1, p2, r3, r1].map(agent), since)

    // 6. Its lines: fixed words and counts, and nothing of a thread in the whole log.
    const lines = sourceLines(d)
    expect(lines).toEqual(expect.arrayContaining(['[codex-app] watch · on', '[codex-app] listed · 5 threads · 2 in projects',
      '[codex-app] listed · 4 threads · 2 in projects']))
    console.log(`[codex-app e2e] ${lines.filter((line) => line.startsWith('[codex-app] read · ')).join('; ')}`)
    for (const line of lines) expect(line).toMatch(LINE)
    const log = d.log()
    const threads = [p1, p2, r1, r2, r3, a1, e1]
    // A thread Codex gave no name is named by its folder's last part: the log holds that name no more than the folder.
    const names = threads.map((id) => folder(id).slice('/work/'.length))
    for (const secret of [NEVER_READ, 'Fixture Named', ...threads, ...threads.map(folder), ...names]) expect(log).not.toContain(secret)
    expect(d.opens()).toEqual([['-b', CODEX_APP, `codex://threads/${r1}`]])
  })
})
