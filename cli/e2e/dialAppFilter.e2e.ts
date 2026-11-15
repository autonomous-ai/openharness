/**
 * The dial's app filter (docs/specs/2026-11-14-dial-app-filter.md), on the real daemon: fake Claude Codes started outside
 * Harness in the apps their hints name, or under a fake of the app (harness/outsideAgent.ts), a fake dial that greets
 * with `appFilter: 'v1'`, and the real `harness hardware watch`, written the app in front on its stdin as the Harness
 * Device app writes it.
 * - The dial with no window holds one app's ring, is sent `apps`, and picks with `app.pick`.
 * - The app in front takes the real path: the watch's stdin → the devices process's own socket (`devices.sock`, opened
 *   when a dial starts that process) → the filter, which follows it once it has settled. The core's socket carries none.
 * - A dial without `appFilter` keeps the single ring, and the log names no app.
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside, type FakeApp } from './harness/outsideAgent.js'

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']
/** What the round dial with the filter says in its greeting. */
const FILTER = { appFilter: 'v1' }
const GHOSTTY = { TERM_PROGRAM: 'ghostty' }
const VSCODE = { TERM_PROGRAM: 'vscode' }
const VSCODE_BUNDLE = 'com.microsoft.VSCode'
const GHOSTTY_BUNDLE = 'com.mitchellh.ghostty'

interface Roster { rows: DialMessage[]; end: DialMessage }
interface AppEntry { id: string; name: string; count: number; waiting: number }
interface Apps { shown: string; apps: AppEntry[] }

/** Each list the dial was sent after [since]: its rows, between `agents.begin` and `agents.end`, and the end. */
function rosters(dial: FakeDial, since = 0): Roster[] {
  const out: Roster[] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push({ rows, end: m }); rows = null }
  }
  return out
}
const appsFrames = (dial: FakeDial, since = 0): Apps[] => dial.messages.slice(since).filter((m) => m.t === 'apps') as unknown as Apps[]
const ids = (roster: Roster): unknown[] => roster.rows.map((r) => r.id)
const idsOf = (agents: Outside[]): string[] => agents.map((a) => a.id)
/** Each app's count, in a form that compares whole. */
const counts = (apps: Apps): Record<string, number> => Object.fromEntries(apps.apps.map((a) => [a.id, a.count]))
/** Lists in their order, an object's keys in any: apps found in one scan come in the order of their session records'
 *  names (`<pid>.json`, read sorted as text), so VS Code's came first once its agent's pid had a digit more (10073 after
 *  9962), and a comparison by key order missed counts that were right. */
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b)

/** The last `apps` and the last list the dial was sent after [since], once both pass [test]. */
const showing = (dial: FakeDial, what: string, test: (apps: Apps, roster: Roster) => boolean, since = 0, ms = 45_000): Promise<{ apps: Apps; roster: Roster }> =>
  until(what, () => {
    const apps = appsFrames(dial, since).at(-1)
    const roster = rosters(dial, since).at(-1)
    return apps && roster && test(apps, roster) ? { apps, roster } : null
  }, ms, 100)
/** The dial shows [app]'s ring, [agents] in that order, under an `apps` that says so. */
const shows = (dial: FakeDial, app: string, agents: Outside[], since = 0, ms?: number): Promise<{ apps: Apps; roster: Roster }> =>
  showing(dial, `the dial to show ${app}'s ring`, (apps, roster) => apps.shown === app && same(ids(roster), idsOf(agents)) && roster.end.view === 'machine', since, ms)

const switches = (d: IsolatedDaemon, cause: string): number => d.log().split('\n').filter((line) => line.includes(`[device] app filter: switched · ${cause}`)).length

/**
 * Past the time a front line written at [from] could have moved the dial: its tell, the 1 s settle, the machine list's 1 s
 * push gap and a tick, with room for a loaded machine. Waited for as a frame the dial heard after it (the daemon pings
 * it every 5 s), so a front that changes nothing is shown to have changed nothing.
 */
const settleWindowPassed = (dial: FakeDial, from: number): Promise<unknown> =>
  until('a frame after the settle window', () => dial.arrivedAt.some((at) => at >= from + 3_000), 30_000, 100)

describe('the dial\'s app filter', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  const watches: ReturnType<typeof spawn>[] = []
  const windows: LocalClient[] = []
  afterEach(async () => {
    for (const child of watches.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill()
    for (const window of windows.splice(0)) window.close()
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
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
    return { d, desk: theDesk }
  }
  const startOutside = async (d: IsolatedDaemon, folder: string, hints: Record<string, string>, app?: FakeApp): Promise<Outside> => {
    const engine = await Outside.start(d, folder, hints, app)
    outside.push(engine)
    return engine
  }
  /** A dial with the filter, plugged in and greeted, with its first list in hand. */
  const plugged = async (theDesk: Desk, capabilities: Record<string, string> = FILTER, serial = 'E2E-A', mac = 'e2:e0:00:00:00:0a'): Promise<FakeDial> => {
    const dial = await theDesk.plug(serial, mac, capabilities)
    onTestFailed(() => {
      console.log(`---- ${serial}'s apps\n${appsFrames(dial).map((apps) => JSON.stringify(apps)).join('\n')}`)
      console.log(`---- ${serial}'s lists\n${rosters(dial).map((r) => JSON.stringify({ end: r.end, rows: r.rows.map((row) => `${row.name} ${row.host}`) })).join('\n')}`)
    })
    await dial.next((m) => m.t === 'agents.end', 60_000, 'the first list')
    return dial
  }
  /** The first agent, seen shown before another starts: two apps first read in the same second tie, and a tie is drawn. */
  const startFirst = async (d: IsolatedDaemon, dial: FakeDial, app: string, folder: string, hints: Record<string, string>): Promise<Outside> => {
    const engine = await startOutside(d, folder, hints)
    await shows(dial, app, [engine])
    return engine
  }
  /** Ghostty's three, then VS Code's two, each started once the one before had run its first hook: the dial shows Ghostty,
   *  the app with the most agents. */
  const fiveAgents = async (d: IsolatedDaemon, dial: FakeDial, vscodeHints: Record<string, string>[] = [VSCODE, VSCODE]): Promise<{ ghostty: Outside[]; vscode: Outside[] }> => {
    const ghostty = [await startFirst(d, dial, 'ghostty', 'a1', GHOSTTY), await startOutside(d, 'a2', GHOSTTY), await startOutside(d, 'a3', GHOSTTY)]
    const vscode = [await startOutside(d, 'a4', vscodeHints[0]), await startOutside(d, 'a5', vscodeHints[1])]
    await showing(dial, 'Ghostty 3 and VS Code 2', (apps, roster) =>
      same(counts(apps), { ghostty: 3, vscode: 2 }) && apps.shown === 'ghostty' && same(ids(roster), idsOf(ghostty)))
    return { ghostty, vscode }
  }

  /** `harness hardware watch --json` as the Harness Device app runs it, under the daemon's environment so it finds the
   *  daemon's data folder and the devices' socket in it; `front` writes what the app writes when the app in front changes. */
  const watch = (d: IsolatedDaemon): { lines: string[]; front(value: string): void } => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    watches.push(child)
    const lines: string[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => { lines.push(line) })
    return { lines, front: (value) => { child.stdin!.write(`${JSON.stringify({ front: value })}\n`) } }
  }
  /** The devices process's listener is open: a front line written from now on reaches it. */
  const listening = (d: IsolatedDaemon): Promise<unknown> =>
    until('[devices] listener open', () => d.log().includes('[devices] listener open'), 60_000, 100)
  /** A Harness window with an empty tab, as the desktop says it. */
  const openWindow = async (d: IsolatedDaemon): Promise<LocalClient> => {
    const window = await LocalClient.connect(d)
    windows.push(window)
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [], foreground: true })
    return window
  }

  it('Ghostty 3 and VS Code 2: the dial is sent apps with both counts and Ghostty\'s three agents', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { ghostty } = await fiveAgents(d, dial)
    const { apps, roster } = await shows(dial, 'ghostty', ghostty)
    expect(apps.apps).toEqual(expect.arrayContaining([
      { id: 'ghostty', name: 'Ghostty', count: 3, waiting: 0 },
      { id: 'vscode', name: 'VS Code', count: 2, waiting: 0 },
    ]))
    expect(apps.apps).toHaveLength(2)
    expect(roster.end).toMatchObject({ tab: '', view: 'machine', total: 3 })
    for (const row of roster.rows) expect(row).toMatchObject({ engine: 'claude', host: 'ghostty' })
  })

  it('app.pick vscode: apps says vscode, and the ring is VS Code\'s two, in the order they started', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { vscode } = await fiveAgents(d, dial)
    const since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'vscode' })
    const { roster } = await shows(dial, 'vscode', vscode, since)
    expect(roster.end).toMatchObject({ view: 'machine', total: 2 })
    expect(roster.rows.map((r) => r.name)).toEqual(['a4', 'a5'])
    // The apps frame comes before the ring the dial draws under it.
    const order = dial.messages.slice(since).map((m) => m.t)
    expect(order.indexOf('apps')).toBeLessThan(order.indexOf('agents.begin'))
    await until('the pick logged', () => switches(d, 'pick') === 1 && d.log().includes('[device] app filter: picker'), 10_000)
  })

  it('Claude Code in zellij inside Ghostty is in Ghostty\'s ring, and its row\'s host is zellij', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const plain = await startOutside(d, 'a1', GHOSTTY)
    const inZellij = await startOutside(d, 'a2', { ...GHOSTTY, ZELLIJ: 'e2e' })
    const { apps, roster } = await shows(dial, 'ghostty', [plain, inZellij])
    expect(same(counts(apps), { ghostty: 2 })).toBe(true)
    expect(roster.rows.find((r) => r.id === inZellij.id)).toMatchObject({ host: 'zellij' })
    expect(roster.rows.find((r) => r.id === plain.id)).toMatchObject({ host: 'ghostty' })
  })

  it('the watch is written {"front":"com.microsoft.VSCode"}: the dial is sent VS Code\'s ring', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { vscode } = await fiveAgents(d, dial)
    await listening(d)
    const since = dial.messages.length
    watch(d).front(VSCODE_BUNDLE)
    await shows(dial, 'vscode', vscode, since)
    expect(switches(d, 'front')).toBe(1)
  })

  // The PM's D1 (2026-11-15): an app that settled in front with no agents is shown once it gets one (Review Focus 7).
  it('an agent started in the app in front turns the dial to it', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    await startFirst(d, dial, 'ghostty', 'a1', GHOSTTY)
    await listening(d)
    const run = watch(d)
    let since = dial.messages.length
    const written = Date.now()
    run.front(VSCODE_BUNDLE)
    await settleWindowPassed(dial, written)
    // Settled in front with no agents: nothing moved.
    expect(appsFrames(dial, since).every((apps) => apps.shown === 'ghostty')).toBe(true)
    expect(switches(d, 'front')).toBe(0)
    since = dial.messages.length
    const started = await startOutside(d, 'a2', VSCODE)
    started.type('in the app in front')
    await until('its UserPromptSubmit hook to run', () => started.ran(d, 'UserPromptSubmit'), 30_000, 100)
    const { apps } = await shows(dial, 'vscode', [started], since)
    expect(same(counts(apps), { ghostty: 1, vscode: 1 })).toBe(true)
    expect(switches(d, 'front')).toBe(1)
  })

  it('Finder\'s bundle id changes nothing', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { vscode } = await fiveAgents(d, dial)
    await listening(d)
    const run = watch(d)
    const since = dial.messages.length
    const written = Date.now()
    run.front('com.apple.finder')
    await settleWindowPassed(dial, written)
    expect(appsFrames(dial, since).every((apps) => apps.shown === 'ghostty')).toBe(true)
    expect(switches(d, 'front')).toBe(0)
    // The same watch is still heard: the next app in front is followed.
    run.front(VSCODE_BUNDLE)
    await shows(dial, 'vscode', vscode, since)
  })

  it('a front line written before a dial is plugged in is dropped, and the next app in front is followed', async () => {
    const { d, desk } = await fresh()
    const path = devicesListenerPath(d.dataDir, process.platform, d.env.HOME)
    const run = watch(d)
    await until('the watch\'s first line', () => run.lines.length > 0, 60_000)
    expect(run.lines[0]).toBe('{"attached":false}')
    // No dial, so no devices process: nothing listens for it.
    run.front(GHOSTTY_BUNDLE)
    expect(path === null || !existsSync(path)).toBe(true)
    const dial = await plugged(desk)
    await listening(d)
    const { vscode } = await fiveAgents(d, dial)
    const since = dial.messages.length
    run.front(VSCODE_BUNDLE)
    await shows(dial, 'vscode', vscode, since)
  })

  it.skipIf(process.platform === 'win32')('while a dial is plugged in the devices\' socket is in the data folder with mode 0600, and it is gone once the daemon has stopped', async () => {
    const { d, desk } = await fresh()
    const path = devicesListenerPath(d.dataDir, process.platform, d.env.HOME)!
    expect(path).toBe(join(d.dataDir, 'devices.sock'))
    expect(existsSync(path)).toBe(false)
    await plugged(desk)
    await listening(d)
    const socket = statSync(path)
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
    expect(socket.uid).toBe(process.getuid!())
    await d.stop()
    expect(existsSync(path)).toBe(false)
  })

  it('an agent in an unknown terminal is in the app named Other, beside Apple\'s Terminal', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const apple = await startFirst(d, dial, 'terminal-app', 'a1', { TERM_PROGRAM: 'Apple_Terminal' })
    await startOutside(d, 'a2', { TERM_PROGRAM: 'tmux' })
    const { apps } = await showing(dial, 'Terminal 1 and Other 1', (apps, roster) =>
      same(counts(apps), { 'terminal-app': 1, terminal: 1 }) && apps.shown === 'terminal-app' && same(ids(roster), [apple.id]))
    expect(apps.apps).toEqual(expect.arrayContaining([
      { id: 'terminal-app', name: 'Terminal', count: 1, waiting: 0 },
      { id: 'terminal', name: 'Other', count: 1, waiting: 0 },
    ]))
  })

  it('an unknown terminal in front ({"front":"org.alacritty"}) does not turn the dial to Other', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const apple = await startFirst(d, dial, 'terminal-app', 'a1', { TERM_PROGRAM: 'Apple_Terminal' })
    const other = await startOutside(d, 'a2', { TERM_PROGRAM: 'tmux' })
    await shows(dial, 'terminal-app', [apple])
    await listening(d)
    const run = watch(d)
    let since = dial.messages.length
    const written = Date.now()
    run.front('org.alacritty')
    await settleWindowPassed(dial, written)
    expect(appsFrames(dial, since).every((apps) => apps.shown === 'terminal-app')).toBe(true)
    expect(switches(d, 'front')).toBe(0)
    // Other is reached by a pick, and Apple's Terminal settling in front after it turns the dial back.
    since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'terminal' })
    await shows(dial, 'terminal', [other], since)
    since = dial.messages.length
    run.front('com.apple.Terminal')
    await shows(dial, 'terminal-app', [apple], since)
    expect(switches(d, 'front')).toBe(1)
  })

  it('kitty\'s bundle id in front turns the dial to kitty\'s agents', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const ghostty = await startFirst(d, dial, 'ghostty', 'a1', GHOSTTY)
    const kitty = await startOutside(d, 'a2', { __CFBundleIdentifier: 'net.kovidgoyal.kitty' })
    await showing(dial, 'Ghostty 1 and kitty 1', (apps, roster) =>
      same(counts(apps), { ghostty: 1, kitty: 1 }) && apps.shown === 'ghostty' && same(ids(roster), [ghostty.id]))
    await listening(d)
    const since = dial.messages.length
    watch(d).front('net.kovidgoyal.kitty')
    await shows(dial, 'kitty', [kitty], since)
  })

  it('the front is followed while a window is open: when it closes the dial is sent the app that came to the front meanwhile', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { vscode } = await fiveAgents(d, dial)
    await listening(d)
    let since = dial.messages.length
    const window = await openWindow(d)
    await until('the tab\'s list', () => rosters(dial, since).find((r) => r.end.tab === 't1'), 45_000)
    watch(d).front(VSCODE_BUNDLE)
    await until('the switch to the app in front, with the window open', () => switches(d, 'front') === 1, 30_000)
    since = dial.messages.length
    window.close()
    await shows(dial, 'vscode', vscode, since)
  })

  it('a pick holds while the same app is in front, and ends when another settles', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { ghostty, vscode } = await fiveAgents(d, dial)
    await listening(d)
    const run = watch(d)
    // Ghostty settles in front, seen as a switch: VS Code first, then Ghostty.
    let since = dial.messages.length
    run.front(VSCODE_BUNDLE)
    await shows(dial, 'vscode', vscode, since)
    since = dial.messages.length
    run.front(GHOSTTY_BUNDLE)
    await shows(dial, 'ghostty', ghostty, since)
    // VS Code picked on the dial with Ghostty in front: it holds.
    since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'vscode' })
    await shows(dial, 'vscode', vscode, since)
    const picked = Date.now()
    await settleWindowPassed(dial, picked)
    expect(appsFrames(dial, since).every((apps) => apps.shown === 'vscode')).toBe(true)
    // Finder, then Ghostty, in front: the dial returns to Ghostty. Finder is told before Ghostty is written, as the watch
    // tells only the newest of the lines written while a tell is under way.
    const finder = Date.now()
    run.front('com.apple.finder')
    await settleWindowPassed(dial, finder)
    since = dial.messages.length
    run.front(GHOSTTY_BUNDLE)
    await shows(dial, 'ghostty', ghostty, since)
    expect(switches(d, 'front')).toBe(3)
  })

  it('an agent in VS Code needs the person while Ghostty is shown: apps says waiting 1, and agent.open for it turns the dial to VS Code and focuses it', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    // The one asking runs in zellij inside VS Code: a tap has no app to bring forward there (no bundle id, no pane), so
    // opening it moves no window on the computer running the test.
    const { vscode } = await fiveAgents(d, dial, [VSCODE, { ...VSCODE, ZELLIJ: 'e2e' }])
    const asking = vscode[1]
    asking.type('!permit printf hi')
    await until('its Notification hook to run', () => asking.ran(d, 'Notification'), 30_000, 100)
    await showing(dial, 'VS Code waiting 1', (apps) => apps.shown === 'ghostty' && apps.apps.find((a) => a.id === 'vscode')?.waiting === 1)
    const since = dial.messages.length
    dial.send({ t: 'agent.open', agentId: asking.id })
    await showing(dial, 'VS Code\'s ring', (apps, roster) => apps.shown === 'vscode' && same(ids(roster).sort(), idsOf(vscode).sort()), since)
    await dial.next((m) => m.t === 'focus' && m.agentId === asking.id, 20_000, 'the focus on the agent', since)
    expect(switches(d, 'notice')).toBe(1)
  })

  it('a window opens: the tab\'s list and no apps; it closes: apps again', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const ghostty = await startFirst(d, dial, 'ghostty', 'a1', GHOSTTY)
    await startOutside(d, 'a2', VSCODE)
    await showing(dial, 'Ghostty 1 and VS Code 1', (apps, roster) =>
      same(counts(apps), { ghostty: 1, vscode: 1 }) && apps.shown === 'ghostty' && same(ids(roster), [ghostty.id]))
    let since = dial.messages.length
    const window = await openWindow(d)
    const tab = await until('the tab\'s list', () => rosters(dial, since).find((r) => r.end.tab === 't1'), 45_000)
    expect(tab.rows).toEqual([])
    expect(tab.end.view).toBeUndefined()
    expect(appsFrames(dial, since)).toEqual([])
    since = dial.messages.length
    window.close()
    await shows(dial, 'ghostty', [ghostty], since)
  })

  it('unplugged and plugged in again, the dial is sent the app it had picked', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { vscode } = await fiveAgents(d, dial)
    const since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'vscode' })
    await shows(dial, 'vscode', vscode, since)
    await desk.unplug('E2E-A')
    const again = await plugged(desk)
    await shows(again, 'vscode', vscode)
  })

  // Windows learns no app at the scan: its agents wait for their first hook.
  it.skipIf(process.platform === 'win32')('a dial plugged in while VS Code is already in front (the watch started first) is sent VS Code\'s ring', async () => {
    const { d, desk } = await fresh()
    const run = watch(d)
    await until('the watch\'s first line', () => run.lines.length > 0, 60_000)
    run.front(VSCODE_BUNDLE)
    // Started before the dial, each under a fake of its app, and each a turn done: no devices process hears their hooks,
    // and nobody types once the dial is in, so only the scan the dial's attach runs can name their apps, from their
    // parent processes. The turn gives each its transcript's first line, without which the scan has no row to list.
    const ghostty = [await startOutside(d, 'a1', GHOSTTY, 'ghostty'), await startOutside(d, 'a2', GHOSTTY, 'ghostty'), await startOutside(d, 'a3', GHOSTTY, 'ghostty')]
    const vscode = [await startOutside(d, 'a4', VSCODE, 'vscode'), await startOutside(d, 'a5', VSCODE, 'vscode')]
    for (const engine of [...ghostty, ...vscode]) {
      engine.type('before the dial')
      await until(`${engine.folder}'s Stop hook to run`, () => engine.ran(d, 'Stop'), 30_000, 100)
    }
    const dial = await plugged(desk)
    await listening(d)
    await until('the watch to hear the dial attached', () => run.lines.some((line) => line.startsWith('{"attached":true')), 60_000)
    // With the most agents Ghostty would be shown: VS Code is, as the watch told the devices when the dial attached.
    await showing(dial, 'VS Code\'s ring', (apps, roster) =>
      same(counts(apps), { ghostty: 3, vscode: 2 }) && apps.shown === 'vscode' && same(ids(roster).sort(), idsOf(vscode).sort()))
    // The five were never on Other's page: the scan knew each one's app.
    expect(appsFrames(dial).filter((apps) => apps.apps.some((a) => a.id === 'terminal'))).toEqual([])
    expect(d.log()).toMatch(/\[observed\] scan · 5 found · 5 app known · \d+ ms/)
  })

  // The same, with the five known only by the hooks of prompts typed once the dial is in: the shape that flaked (Review
  // Focus 7) when VS Code's hooks came after the front had settled, the case the PM's D1 settles.
  it('a dial plugged in while VS Code is already in front, its agents known only by hooks after the attach, ends on VS Code\'s ring', async () => {
    const { d, desk } = await fresh()
    const run = watch(d)
    await until('the watch\'s first line', () => run.lines.length > 0, 60_000)
    run.front(VSCODE_BUNDLE)
    // Started before the dial with no turn: no devices process hears their first hooks, and the scan the dial's attach
    // runs has no transcript of theirs to list.
    const ghostty = [await startOutside(d, 'a1', GHOSTTY), await startOutside(d, 'a2', GHOSTTY), await startOutside(d, 'a3', GHOSTTY)]
    const vscode = [await startOutside(d, 'a4', VSCODE), await startOutside(d, 'a5', VSCODE)]
    const dial = await plugged(desk)
    await listening(d)
    await until('the watch to hear the dial attached', () => run.lines.some((line) => line.startsWith('{"attached":true')), 60_000, 10)
    for (const engine of ghostty) engine.type('the dial is in')
    // A deliberate delay, not a wait for anything: VS Code's hooks reach the devices after the front's 1 s settle, as a
    // loaded machine delays them, which is what left the dial on Ghostty before D1.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    for (const engine of vscode) engine.type('the dial is in')
    await showing(dial, 'VS Code\'s ring', (apps, roster) =>
      same(counts(apps), { ghostty: 3, vscode: 2 }) && apps.shown === 'vscode' && same(ids(roster).sort(), idsOf(vscode).sort()))
  })

  it('a dial without appFilter beside it gets all five agents in one ring and no apps frame', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const old = await plugged(desk, {}, 'E2E-B', 'e2:e0:00:00:00:0b')
    const { ghostty, vscode } = await fiveAgents(d, dial)
    const all = [...ghostty, ...vscode]
    const roster = await until('all five on the older dial', () => {
      const last = rosters(old).at(-1)
      return last && same(ids(last), idsOf(all)) ? last : null
    }, 45_000)
    expect(roster.end).toMatchObject({ view: 'machine', total: 5 })
    expect(old.messages.some((m) => m.t === 'apps')).toBe(false)
    // A pick from it is not heard: the new dial keeps Ghostty. Its own next list is answered after the pick was handled.
    const oldSince = old.messages.length
    old.send({ t: 'app.pick', app: 'vscode' })
    old.send({ t: 'agents.list' })
    await until('the older dial\'s list asked for', () => rosters(old, oldSince).length > 0, 45_000)
    const since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await shows(dial, 'ghostty', ghostty, since)
    expect(switches(d, 'pick')).toBe(0)
    expect(d.log()).not.toContain('[device] app filter: picker')
  })

  it('the daemon\'s log has "app filter: switched" lines and no bundle id, no exe name and no app name', async () => {
    const { d, desk } = await fresh()
    const dial = await plugged(desk)
    const { ghostty, vscode } = await fiveAgents(d, dial)
    await listening(d)
    const run = watch(d)
    let since = dial.messages.length
    run.front(VSCODE_BUNDLE)
    await shows(dial, 'vscode', vscode, since)
    // An exe name, as Linux writes one: kitty has no agents here, so it moves nothing.
    const written = Date.now()
    run.front('kitty')
    await settleWindowPassed(dial, written)
    since = dial.messages.length
    dial.send({ t: 'app.pick', app: 'ghostty' })
    await shows(dial, 'ghostty', ghostty, since)
    await until('the pick logged', () => switches(d, 'pick') === 1, 10_000)
    const log = d.log()
    expect(log).toContain('[devices] listener open')
    expect(switches(d, 'front')).toBe(1)
    expect(log).toContain('[device] app filter: picker')
    for (const line of log.split('\n').filter((line) => line.includes('app filter') || line.includes('[devices] listener'))) {
      expect(line).toMatch(/(\[devices\] listener open|\[devices\] listener in the last minute: \d+ unknown, \d+ oversized, \d+ over rate, \d+ refused, \d+ failed|\[device\] app filter: (switched · (front|pick|notice|empty)|picker))$/)
    }
    for (const word of [VSCODE_BUNDLE, GHOSTTY_BUNDLE, 'kitty', 'vscode', 'VS Code', 'ghostty', 'Ghostty']) expect(log).not.toContain(word)
  })
})
