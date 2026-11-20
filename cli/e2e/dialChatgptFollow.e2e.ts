/**
 * The dial follows the thread opened in the ChatGPT app (docs/plans/2026-11-20-dial-chatgpt-follow-ax-design.md), on the
 * real daemon: the title of ChatGPT's window, as Harness Device reads it, goes on the stdin of the real
 * `harness hardware watch --json`, and the devices match it to Codex's name of one thread of a fixture Codex home
 * (src/testing/codexAppFixture.ts) and turn a fake dial on the desk to it.
 *
 * The real ChatGPT app, `~/.codex`, /Applications and `/usr/bin/open` are never touched, as in
 * deviceCodexAppThreads.e2e.ts: the Codex home is a fixture in the daemon's throwaway home and the app a fake Info.plist
 * in its `~/Applications`, both checked to be inside its root before it starts. No Harness Device runs and nothing reads
 * a window: the test writes the lines it would. The watch runs under the daemon's environment only, as in
 * dialTerminalFollow.e2e.ts, so it never reaches this Mac's daemon. No backend.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { NEVER_READ, codexAppFixture } from '../src/testing/codexAppFixture.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const CODEX_APP = 'com.openai.codex'
/** The everyday daemon's port: a watch under test that reached it would tell this Mac's dial. */
const EVERYDAY_PORT = '18473'
/** Every thread line the devices say: an outcome, never a title, a name or a thread. */
const LINE = /^\[device\] thread · (moved|skipped · (echo|not in front|no match|ambiguous|no tile))$/
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

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

const inside = (root: string, path: string): boolean => isAbsolute(path) && !relative(root, path).startsWith('..')
const said = (d: IsolatedDaemon, line: string) =>
  until(`"${line}" in the daemon's log`, () => d.log().split('\n').some((logged) => logged.endsWith(line)), 30_000, 50)

describe.skipIf(process.platform !== 'darwin')('the dial follows the ChatGPT thread', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  it("the dial follows the thread opened in the ChatGPT app, from the window title on the watch's stdin", async () => {
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

    // Five Recent threads, newest first. The dial lands on the first row, and a follow to the agent shown moves nothing:
    // the named thread is the second.
    const now = Date.now()
    const threads = Array.from({ length: 5 }, () => randomUUID())
    const [, named, twiceA, twiceB] = threads
    const folder = (id: string) => `/work/e2e-${id.slice(0, 8)}`
    const fixture = codexAppFixture(home)
    fixture.threads(threads.map((id, i) => ({ id, cwd: folder(id), recencyAtMs: now - (i + 1) * 1_000 })))
    fixture.name(named, 'Fixture Named')
    fixture.name(twiceA, 'Twice')
    fixture.name(twiceB, 'Twice')
    const agent = (thread: string) => observedAgentId('codex', thread)

    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()

    // 1. The ChatGPT app's page and its five rows.
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0e', FILTER)
    await dial.next((m) => m.t === 'apps' && m.shown === 'codex', 45_000, "the ChatGPT app's page")
    const listed = JSON.stringify(threads.map(agent))
    await until('the five threads', () => {
      const ids: string[] = []
      for (const m of dial.messages) {
        if (m.t === 'agents.begin') ids.length = 0
        else if (m.t === 'agent') ids.push(String(m.id))
        else if (m.t === 'agents.end' && JSON.stringify(ids) === listed) return true
      }
      return undefined
    }, 45_000, 50)

    // 2. The watch as Harness Device runs it, under the daemon's environment only: this daemon's data folder and the
    // devices' socket in it, never this Mac's. ChatGPT is in front from its first line.
    const env = { ...d.env, TMUX_PANE: '' }
    expect(env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(devicesListenerPath(d.dataDir, process.platform, env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
    expect(env.PORT).not.toBe(EVERYDAY_PORT)
    const watch = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], { cwd: CLI_ROOT, env, stdio: ['pipe', 'ignore', 'ignore'] })
    children.push(watch)
    const write = (value: unknown): void => { watch.stdin!.write(`${JSON.stringify(value)}\n`) }
    write({ front: CODEX_APP })

    // 3. The window shows the named thread: the dial turns to it. The report waits for ChatGPT's settle by itself.
    let since = dial.messages.length
    write({ thread: 'Fixture Named' })
    await said(d, '[device] thread · moved')
    await dial.next((m) => m.t === 'focus' && m.agentId === agent(named), 30_000, "the named thread's focus", since)

    // 4. A name two threads have: neither is followed.
    since = dial.messages.length
    write({ thread: 'Twice' })
    await said(d, '[device] thread · skipped · ambiguous')
    expect(dial.messages.slice(since).filter((m) => m.t === 'focus' && (m.agentId === agent(twiceA) || m.agentId === agent(twiceB)))).toEqual([])

    // 5. Its lines: fixed words, and nothing of a thread in the whole log. A thread Codex gave no name is named by its
    // folder's last part: the log holds that name no more than the folder.
    const log = d.log()
    const lines = log.split('\n').filter((line) => line.includes('[device] thread')).map((line) => line.slice(line.indexOf('[device]')))
    for (const line of lines) expect(line).toMatch(LINE)
    const names = threads.map((id) => folder(id).slice('/work/'.length))
    for (const secret of [NEVER_READ, 'Fixture Named', 'Twice', ...threads, ...threads.map(folder), ...names]) expect(log).not.toContain(secret)
  })
})
