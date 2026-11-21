/**
 * A tap, a swipe and a stroke on the glass reach Claude Code in VS Code's integrated terminal
 * (docs/plans/2026-11-17-dial-vscode-extension-design.md), on the real daemon. Two sessions run each under a shell of its own under a fake VS Code (harness/outsideAgent.ts), so
 * the parent chain the devices read from `ps` is this computer's own; Harness's extension's loop
 * (plugins/harness-device-vscode/src/loop.ts) runs with a fake window in a process of its own (harness/vscodeWindow.ts),
 * reports both shells on the real devices' socket and prints each terminal it is asked to show, each raise of its window,
 * each line it scrolls and each page key it presses;
 * a fake dial on the desk taps, rests and scrolls. The app in front is a line on the stdin of the real `harness hardware watch --json`, as the Harness
 * Device app writes it.
 *
 * In Cursor too (docs/plans/2026-11-18-dial-cursor-design.md): one session runs under a fake Cursor, a bundle under the
 * throwaway home that carries Cursor's id, the same loop's window shows, raises and scrolls its terminal, and once the
 * window goes a tap opens Cursor's window for the session's folder.
 *
 * The real VS Code and Cursor, their CLIs and `/usr/bin/open` never run: the daemon's `open` is the harness's fake
 * (HARNESS_OPEN_BIN, harness/daemon.ts), checked to be inside the test's own root before anything is tapped, and the
 * loop finds the daemon through a launcher in the throwaway home alone, never this computer's own daemon or `harness`.
 *
 * The match follows the window's report and a `ps` read, and nothing says when it is done: the dial turns to the agent
 * again every 2 s until the window shows it (`FakeDial.turnUntil`), which also outlasts the 750 ms after the dial's landing
 * on A and each re-assert of it, when a turn is dropped. Every later wait is a frame or a line, never a fixed time.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { MANAGED_SETTINGS, readSettings } from '../src/cable/hosts/claudeRenderer.js'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { InOrca } from './harness/inOrca.js'
import { Outside } from './harness/outsideAgent.js'
import type { WindowState } from '../../plugins/harness-device-vscode/src/window.ts'

// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring, which follows the app in front. */
const FILTER = { appFilter: 'v1' }
const VSCODE = 'com.microsoft.VSCode'
const GHOSTTY = 'com.mitchellh.ghostty'
const mac = process.platform === 'darwin'
/** What VS Code's integrated terminal gives the processes in it, as Claude Code's hook reads them. */
const IN_VSCODE: Record<string, string> = { TERM_PROGRAM: 'vscode', ...(mac ? { __CFBundleIdentifier: VSCODE } : {}) }
const CURSOR = 'com.todesktop.230313mzl4w4u92'
/** What Cursor's integrated terminal gives the processes in it. Its bundle id on every platform: only that names Cursor,
 *  a VS Code fork that says TERM_PROGRAM=vscode too. No Cursor off macOS sets it, so there the case checks the code path,
 *  not a Linux Cursor. */
const IN_CURSOR: Record<string, string> = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: CURSOR }
/** A Cursor session's folder's name: the person's own path, which no line of the devices may hold (#4458). */
const FOLDER_MARKER = 'SECRET-FOLDER-MARKER'
/** The everyday daemon's port: a `link` under test that reached it would hand the loop this computer's devices' socket. */
const EVERYDAY_PORT = '18473'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** The extension's loop over a fake window, running. */
interface Window {
  /** Each state it told, in order. */
  states: string[]
  /** Each shell's pid it was asked to show, in order. */
  shows: number[]
  /** For each raise of the window, how many shows came before it. */
  raised: number[]
  /** Each line it scrolled its active terminal, in order. */
  scrolls: ('up' | 'down')[]
  /** Each page key it pressed, and the shell whose terminal it was for, in order. */
  keys: { key: 'up' | 'down'; pid: number }[]
  /** Each state it took from set(), as it then said it was, in order. */
  took: WindowState[]
  /** Its channel's lines, then anything it wrote on stderr. */
  logs: string[]
  /** The window's terminals change, as VS Code tells it. */
  set(state: Partial<WindowState>): void
  /** Ends its stdin, which stops it; its exit code, once it exits within 10 s. */
  stop(): Promise<number | null>
}

describe.skipIf(process.platform === 'win32')("a tap, a swipe and a stroke reach an agent in VS Code's or Cursor's terminal", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const outside: Outside[] = []
  const clients: LocalClient[] = []
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close()
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  /** A daemon of its own and a dial on the desk that holds one app's ring, shown its first list. */
  const fresh = async () => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    // Claude Code started by hand reads its hooks once, as it starts: they must be in by then.
    await d.hooksInstalled(['claude'])
    const dial = await desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')
    return { d, dial }
  }

  /** The daemon's environment names its own data folder, port and devices' socket, never this computer's. */
  const isolated = (d: IsolatedDaemon): void => {
    expect(d.env.ADAPTER_DATA_DIR).toBe(d.dataDir)
    expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
    expect(d.env.PORT).not.toBe(EVERYDAY_PORT)
    expect(devicesListenerPath(d.dataDir, process.platform, d.env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
  }

  /** Claude Code in a VS Code terminal: its shell in the terminal under the fake VS Code, and the engine the shell's
   *  foreground job. */
  const inVscode = async (d: IsolatedDaemon, folder: string): Promise<Outside> => {
    const engine = await Outside.start(d, folder, IN_VSCODE, 'vscode', { shell: true })
    outside.push(engine)
    return engine
  }

  /** The watch the Harness Device app runs, its stdin held open: each [bundle] written is the next app in front. */
  const watch = (d: IsolatedDaemon): ((bundle: string) => void) => {
    const child = spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
      cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
    })
    children.push(child)
    return (bundle) => { child.stdin!.write(`${JSON.stringify({ front: bundle })}\n`) }
  }

  /** A word the shell takes as it is. */
  const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

  /**
   * The extension's loop, started as VS Code would start it for someone whose launcher is `~/.local/bin/harness`: the
   * home is the throwaway one, and the launcher there starts this checkout's CLI under the daemon's environment and
   * nothing else. `/usr/bin:/bin` holds no `harness`: with no launcher the loop would say `noHarness`, never find this
   * computer's.
   */
  const vscodeWindow = (d: IsolatedDaemon): Window => {
    isolated(d)
    const bin = join(d.env.HOME!, '.local', 'bin')
    const shim = join(bin, 'harness')
    expect(shim.startsWith(d.root + sep)).toBe(true)
    const env = Object.entries(d.env).flatMap(([name, value]) => (value === undefined ? [] : [quoted(`${name}=${value}`)]))
    mkdirSync(bin, { recursive: true })
    writeFileSync(shim, `#!/bin/sh\ncd ${quoted(CLI_ROOT)} && exec /usr/bin/env -i ${env.join(' ')} ${[process.execPath, ...CLI_ENTRY].map(quoted).join(' ')} "$@"\n`, { mode: 0o700 })
    const child = spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/vscodeWindow.ts'], {
      cwd: CLI_ROOT, env: { HOME: d.env.HOME, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const states: string[] = []
    const shows: number[] = []
    const raised: number[] = []
    const scrolls: ('up' | 'down')[] = []
    const keys: { key: 'up' | 'down'; pid: number }[] = []
    const took: WindowState[] = []
    const logs: string[] = []
    const lines = (from: NodeJS.ReadableStream, take: (line: string) => void): void => {
      let rest = ''
      from.setEncoding('utf8')
      from.on('data', (chunk: string) => {
        const parts = (rest + chunk).split('\n')
        rest = parts.pop()!
        for (const part of parts) take(part)
      })
    }
    lines(child.stdout, (line) => {
      const said = JSON.parse(line) as {
        state?: string; show?: number; raise?: true; scroll?: 'up' | 'down'; key?: 'up' | 'down'; pid?: number; took?: WindowState; log?: string
      }
      if (said.state !== undefined) states.push(said.state)
      if (said.show !== undefined) shows.push(said.show)
      if (said.raise) raised.push(shows.length)
      if (said.scroll !== undefined) scrolls.push(said.scroll)
      if (said.key !== undefined) keys.push({ key: said.key, pid: said.pid! })
      if (said.took !== undefined) took.push(said.took)
      if (said.log !== undefined) logs.push(said.log)
    })
    lines(child.stderr, (line) => logs.push(line))
    let exited: { code: number | null } | undefined
    child.once('close', (code) => { exited = { code } })
    onTestFailed(() => { console.log(`---- the window's states\n${states.join('\n')}\n---- its shows\n${shows.join('\n')}\n---- its raises, after so many shows\n${raised.join(' ')}\n---- its scrolls\n${scrolls.join(' ')}\n---- its page keys\n${keys.map(({ key, pid }) => `${key} ${pid}`).join(' ')}\n---- its log\n${logs.join('\n')}`) })
    return {
      states, shows, raised, scrolls, keys, took, logs,
      set: (state) => { child.stdin.write(`${JSON.stringify(state)}\n`) },
      stop: async () => {
        child.stdin.end()
        return (await until('the window to exit', () => exited, 10_000, 50)).code
      },
    }
  }

  /** The daemon's lines that hold any of [words], each from its tag on. */
  const linesWith = (d: IsolatedDaemon, ...words: string[]): string[] =>
    d.log().split('\n').filter((line) => words.some((word) => line.includes(word))).map((line) => line.slice(line.indexOf('[')))
  const swipes = (d: IsolatedDaemon): string[] => linesWith(d, '[device] swipe ·')
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)
  /** The daemon's lines about VS Code or Cursor (Cursor's adapters' ids and its tally say `cursor`) that hold a shell's or
   *  an engine's pid of [agents], a window's id, the root's path or the word `fullscreen`, and the devices' own lines that
   *  hold a folder's marker: each a leak. */
  const leaks = (d: IsolatedDaemon, agents: Outside[]): string[] => {
    const pids = agents.flatMap((agent) => [agent.shellPid!, agent.pid]).map((pid) => new RegExp(`\\b${pid}\\b`))
    return [
      ...linesWith(d, 'vscode', 'cursor').filter((line) => pids.some((pid) => pid.test(line)) || UUID.test(line)
        || line.includes(d.root) || line.includes('fullscreen')),
      ...linesWith(d, '[device', '[observed]').filter((line) => line.includes(FOLDER_MARKER)),
    ]
  }

  /** A stroke toward older lines: each move's 8 is 20 px, one line of 16 (scrollLines.ts) and the rest kept; the up lifts
   *  the finger with too little left for a line. It is taken once the devices logged its up. */
  const stroke = async (d: IsolatedDaemon, dial: FakeDial): Promise<void> => {
    const taken = linesWith(d, 'cable: scroll ↑').length
    dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
    for (let move = 0; move < 3; move++) dial.send({ t: 'scroll', phase: 'move', dy: 8, v: 0 })
    dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
    await until('the stroke taken to its up', () => linesWith(d, 'cable: scroll ↑').length === taken + 1, 30_000, 50)
  }

  /** The `apps` frame after [since] that shows [app]'s ring. */
  const ring = (dial: FakeDial, app: string, since: number): Promise<DialMessage> =>
    dial.next((m) => m.t === 'apps' && m.shown === app, 45_000, `${app}'s ring`, since)

  /**
   * A and B in VS Code's terminals, and W in Ghostty, so that Ghostty's ring tells Ghostty is in front: VS Code's ring is
   * shown, with both. Then the window's loop connects and reports both shells, A's active.
   */
  const twoTerminals = async (d: IsolatedDaemon, dial: FakeDial): Promise<{ a: Outside; b: Outside; window: Window }> => {
    const a = await inVscode(d, 'a')
    const b = await inVscode(d, 'b')
    const w = new InOrca(d, 'w', children, { TERM_PROGRAM: 'ghostty' })
    await w.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'apps' && m.shown === 'vscode'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'vscode' && app.count === 2)
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'ghostty' && app.count === 1), 45_000, 'VS Code 2 and Ghostty 1')
    for (const agent of [a, b]) expect(agent.shellPid).not.toBe(agent.pid)

    const window = vscodeWindow(d)
    window.set({ terminals: [a.shellPid!, b.shellPid!], active: a.shellPid!, focused: true })
    await until('the window connected', () => window.states.at(-1) === 'connected', 60_000)
    await said(d, '[devices] vscode stream · open · windows 1')
    if (!mac) {
      // Elsewhere a tap has no other way in: the terminal is what gives each its f.
      for (const agent of [a, b]) {
        await dial.next((m) => m.t === 'agent' && m.id === agent.id && String(m.caps).includes('f'), 45_000, 'its terminal found')
      }
    }
    return { a, b, window }
  }

  it('a tap shows its terminal and raises its window, a rest shows it while VS Code is in front, and neither once the window goes', async () => {
    const { d, dial } = await fresh()
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)

    // 1. A and B in VS Code's terminals, and W in Ghostty, and the window holds A's and B's, A's active.
    const { a, b, window } = await twoTerminals(d, dial)

    // 2. Swipe: with VS Code in front, a rest on A shows A's terminal, and raises no window.
    const front = watch(d)
    front(VSCODE)
    await dial.turnUntil(a.id, "A's terminal shown", () => window.shows[0])
    expect(window.shows).toEqual([a.shellPid])
    expect(window.raised).toEqual([])
    await said(d, '[device] swipe · ok')
    expect(new Set(swipes(d))).toEqual(new Set(['[device] swipe · ok']))

    // 3. Tap: B's terminal is shown, then its window raised, and on macOS VS Code is brought forward by its own open,
    // once; elsewhere none runs.
    dial.send({ t: 'agent.open', agentId: b.id })
    await until("B's window raised", () => window.raised.length === 1, 30_000, 50)
    expect(window.shows).toEqual([a.shellPid, b.shellPid])
    expect(window.raised).toEqual([2])
    if (mac) await until('VS Code brought forward', () => d.opens().length === 1, 30_000, 50)
    expect(d.opens()).toEqual(mac ? [['-b', VSCODE]] : [])
    expect(d.log()).not.toContain('[device] open · vscode · fallback')

    // 4. With another app in front, a rest shows nothing. The dial's frames and the watch's line race to the daemon, so
    // the rest is sent once Ghostty's ring is shown; the list asked for after it is answered after the rest was taken, and
    // VS Code's settle back (a second) outlasts a rest (400 ms), so its ring shown again means the rest had its chance.
    const shownBefore = [...window.shows]
    const swipesBefore = swipes(d).length
    let since = dial.messages.length
    front(GHOSTTY)
    await ring(dial, 'ghostty', since)
    dial.send({ t: 'focus', agentId: b.id })
    since = dial.messages.length
    dial.send({ t: 'agents.list' })
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the list asked for after the rest', since)
    since = dial.messages.length
    front(VSCODE)
    await ring(dial, 'vscode', since)
    expect(d.log()).not.toContain(`cable: dropped dial focus ${b.id}`)
    expect(window.shows).toEqual(shownBefore)
    expect(window.raised).toEqual([2])
    expect(swipes(d)).toHaveLength(swipesBefore)

    // 5. The window goes: its loop ends by itself once its stdin ends, and the daemon says the stream ended.
    expect(await window.stop()).toBe(0)
    await said(d, '[devices] vscode stream · ended · gone · windows 0')
    if (mac) {
      // A tap on B then brings VS Code forward alone.
      dial.send({ t: 'agent.open', agentId: b.id })
      await until('VS Code brought forward again', () => d.opens().length === 2, 30_000, 50)
      expect(d.opens()).toEqual([['-b', VSCODE], ['-b', VSCODE]])
    } else {
      // B's tap is gone with its terminal.
      since = dial.messages.length
      await dial.next((m) => m.t === 'agent' && m.id === b.id && !String(m.caps).includes('f'), 45_000, "B's f gone", since)
      expect(d.opens()).toEqual([])
    }
    expect(window.shows).toEqual(shownBefore)

    // 6. No line about VS Code holds a shell's pid, an engine's pid, the window's id or the root's path.
    expect(leaks(d, [a, b])).toEqual([])
  })

  /** The window's minute lines' counts of scroll lines and of lines dropped, summed: a stroke may fall either side of a minute. */
  const scrollCounts = (window: Window): { scrollLines: number; dropped: number } => {
    let scrollLines = 0
    let dropped = 0
    for (const line of window.logs) {
      const counted = /^in the last minute: .*, (\d+) scroll lines, (\d+) dropped$/.exec(line)
      if (!counted) continue
      scrollLines += Number(counted[1])
      dropped += Number(counted[2])
    }
    return { scrollLines, dropped }
  }

  // Longer than the file's other case: the loop writes its counts a minute after a minute's first event, and step 2 waits
  // for them.
  it("a stroke scrolls the shown agent's terminal while VS Code is in front and it is the active one, and Harness's windows hear none of it", async () => {
    const { d, dial } = await fresh()
    const { a, b, window } = await twoTerminals(d, dial)
    const harness = await LocalClient.connect(d)
    clients.push(harness)
    const front = watch(d)
    front(VSCODE)
    await dial.turnUntil(a.id, "A's terminal shown", () => window.shows[0])
    const shown = [...window.shows]

    // 1. On A, its terminal active: three lines toward older ones.
    await stroke(d, dial)
    await until('three lines scrolled', () => window.scrolls.length === 3, 30_000, 50)

    // 2. B's terminal active: the lines for A's run nothing, and the loop's minute line counts them dropped.
    window.set({ active: b.shellPid! })
    await until("B's terminal active", () => window.took.at(-1)?.active === b.shellPid, 10_000, 50)
    await stroke(d, dial)
    const counted = await until('the stroke counted dropped', () => {
      const counts = scrollCounts(window)
      return counts.dropped > 0 && counts
    }, 150_000, 200)
    expect(counted.scrollLines).toBe(3)

    // 3. A's terminal active again, and Ghostty in front: A is another app's agent, so the stroke goes nowhere.
    window.set({ active: a.shellPid! })
    await until("A's terminal active again", () => window.took.at(-1)?.active === a.shellPid, 10_000, 50)
    const since = dial.messages.length
    front(GHOSTTY)
    await ring(dial, 'ghostty', since)
    await stroke(d, dial)
    // Harness's window hears the devices' frames in order, so a tab the dial picks after the stroke, heard there, comes
    // after any dial_scroll of the three strokes. Resent until the devices hold the window's tab.
    harness.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    await until('the tab the dial picked, in Harness\'s window', () => {
      dial.send({ t: 'swarm.select', swarmId: 't1' })
      return harness.frames.some((f) => f.type === 'dial_swarm')
    }, 30_000, 200)

    // The window scrolled the first stroke's three lines alone and showed nothing more, and Harness's window heard none.
    expect(window.scrolls).toEqual(['up', 'up', 'up'])
    expect(window.shows).toEqual(shown)
    expect(harness.frames.filter((f) => f.type === 'dial_scroll')).toEqual([])
  }, 300_000)

  /** The devices' minute lines' page strokes and guard refusals, summed: a stroke may fall either side of a minute. */
  const guardCounts = (d: IsolatedDaemon): Record<'pages' | 'renderer' | 'asking' | 'background' | 'ps' | 'slow', number> => {
    const sums = { pages: 0, renderer: 0, asking: 0, background: 0, ps: 0, slow: 0 }
    for (const line of linesWith(d, '[devices] vscode · in the last minute:')) {
      const counted = /, (\d+) page strokes, guard refused: (\d+) renderer, (\d+) asking, (\d+) background, (\d+) ps, (\d+) slow$/.exec(line)
      if (!counted) continue
      const [pages, renderer, asking, background, ps, slow] = counted.slice(1).map(Number)
      sums.pages += pages
      sums.renderer += renderer
      sums.asking += asking
      sums.background += background
      sums.ps += ps
      sums.slow += slow
    }
    return sums
  }

  // As long as the scroll case: the devices write their counts a minute after a minute's first stroke, and step 5 waits
  // for them.
  it("a stroke on Claude Code's fullscreen view in its terminal's foreground carries page keys, and none for the default renderer or in the background", async () => {
    // 0. The devices read this computer's managed settings file, which outranks the session's own: one that sets a tui
    // would decide every stroke here.
    const managed = MANAGED_SETTINGS[process.platform]
    const text = managed === undefined ? undefined : await readSettings(managed)
    let managedTui = false
    try {
      managedTui = text !== undefined && Object.hasOwn(JSON.parse(text) as object, 'tui')
    } catch { /* not a JSON object: it decides nothing */ }
    expect(managedTui, `${managed} sets a tui, which outranks this test's own settings`).toBe(false)

    // 1. A in a VS Code terminal, its project's settings fullscreen, the window connected, VS Code in front, the dial on
    // A and A's terminal active. Its user settings are in the throwaway Claude home its transcript names, which holds none.
    const { d, dial } = await fresh()
    const { a, b, window } = await twoTerminals(d, dial)
    const settings = join(d.projectsDir, a.folder, '.claude', 'settings.json')
    expect(settings.startsWith(d.root + sep)).toBe(true)
    mkdirSync(dirname(settings), { recursive: true })
    const tui = (value: string): void => writeFileSync(settings, JSON.stringify({ tui: value }))
    tui('fullscreen')
    const front = watch(d)
    front(VSCODE)
    await dial.turnUntil(a.id, "A's terminal shown", () => window.shows[0])

    // A stroke toward older lines: 128 is 320 px, 20 lines of 16 (scrollLines.ts), two pages of 8. The loop presses a line's
    // keys before it scrolls its lines, so once the window scrolled the stroke's 20 lines, any key of it came.
    let strokes = 0
    const stroke = async (): Promise<void> => {
      dial.send({ t: 'scroll', phase: 'down', dy: 0, v: 0 })
      dial.send({ t: 'scroll', phase: 'move', dy: 128, v: 0 })
      dial.send({ t: 'scroll', phase: 'up', dy: 0, v: 0 })
      strokes += 1
      await until(`stroke ${strokes}'s lines scrolled`, () => window.scrolls.length >= 20 * strokes, 30_000, 50)
    }

    // 2. Fullscreen, its terminal's foreground program: two PageUps, in A's terminal.
    await stroke()
    expect(window.keys).toEqual([{ key: 'up', pid: a.shellPid }, { key: 'up', pid: a.shellPid }])

    // 3. The default renderer: lines alone.
    tui('default')
    await stroke()
    expect(window.keys).toHaveLength(2)

    // 4. Fullscreen again, suspended with Ctrl+Z, its shell in front of it in its terminal: lines alone.
    tui('fullscreen')
    await a.background()
    await stroke()
    expect(window.keys).toHaveLength(2)
    expect(window.scrolls).toEqual(Array(60).fill('up'))

    // 5. The devices counted one page stroke, and a refusal for each other reason.
    const counted = await until('the three strokes counted', () => {
      const counts = guardCounts(d)
      return Object.values(counts).reduce((sum, n) => sum + n, 0) >= 3 && counts
    }, 150_000, 200)
    expect(counted).toEqual({ pages: 1, renderer: 1, asking: 0, background: 1, ps: 0, slow: 0 })

    // 6. No line about VS Code holds a pid, a window's id, the root's path or the renderer's name.
    expect(leaks(d, [a, b])).toEqual([])
  }, 300_000)

  it('in Cursor: a rest shows its terminal, a tap raises its window and brings Cursor, a stroke scrolls it, and once the window goes a tap opens its folder', async () => {
    // 1. A in a Cursor terminal, its folder named by the marker, and W in Ghostty.
    const { d, dial } = await fresh()
    const a = await Outside.start(d, FOLDER_MARKER, IN_CURSOR, 'cursor', { shell: true })
    outside.push(a)
    const w = new InOrca(d, 'w', children, { TERM_PROGRAM: 'ghostty' })
    await w.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'apps'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'cursor' && app.count === 1)
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'ghostty' && app.count === 1), 45_000, 'Cursor 1 and Ghostty 1')
    expect(a.shellPid).not.toBe(a.pid)
    // Cursor in front shows Cursor's ring, whose agents alone the dial is sent. With one agent each the two apps tie, and
    // the dial keeps the first it showed, by which agent it knew of first or a draw (appFilter.ts): Ghostty's, on Linux
    // CI, held back A's frames. Its ring is looked for from the dial's first frame: one shown already stays, and the
    // front's settle on it sends none.
    const front = watch(d)
    front(CURSOR)
    await ring(dial, 'cursor', 0)

    // 2. The window holds A's terminal, active.
    const window = vscodeWindow(d)
    window.set({ terminals: [a.shellPid!], active: a.shellPid!, focused: true })
    await until('the window connected', () => window.states.at(-1) === 'connected', 60_000)
    await said(d, '[devices] vscode stream · open · windows 1')
    // Elsewhere a tap has no other way in: the terminal is what gives A its f.
    if (!mac) await dial.next((m) => m.t === 'agent' && m.id === a.id && String(m.caps).includes('f'), 45_000, 'its terminal found')

    // 3. Swipe: with Cursor in front, a rest on A shows A's terminal, and raises no window.
    await dial.turnUntil(a.id, "A's terminal shown", () => window.shows[0])
    expect(window.shows).toEqual([a.shellPid])
    expect(window.raised).toEqual([])
    await said(d, '[device] swipe · ok')

    // 4. Tap: A's terminal is shown, then its window raised, and on macOS Cursor is brought forward by its own open, once;
    // elsewhere none runs.
    dial.send({ t: 'agent.open', agentId: a.id })
    await until("A's window raised", () => window.raised.length === 1, 30_000, 50)
    expect(window.shows).toEqual([a.shellPid, a.shellPid])
    expect(window.raised).toEqual([2])
    if (mac) await until('Cursor brought forward', () => d.opens().length === 1, 30_000, 50)
    expect(d.opens()).toEqual(mac ? [['-b', CURSOR]] : [])
    expect(d.log()).not.toContain('[device] open · cursor · fallback')

    // 5. A stroke: three lines toward older ones, in A's terminal.
    await stroke(d, dial)
    await until('three lines scrolled', () => window.scrolls.length === 3, 30_000, 50)
    expect(window.scrolls).toEqual(['up', 'up', 'up'])

    // 6. The window goes: its loop ends by itself once its stdin ends, and the daemon says the stream ended.
    const since = dial.messages.length
    expect(await window.stop()).toBe(0)
    await said(d, '[devices] vscode stream · ended · gone · windows 0')

    if (mac) {
      // 7. A tap on A, whose terminal is gone, opens Cursor's window for its folder, the path one argument.
      dial.send({ t: 'agent.open', agentId: a.id })
      await until("A's folder opened", () => d.opens().length === 2, 30_000, 50)
      const [brought, opened] = d.opens()
      expect(brought).toEqual(['-b', CURSOR])
      expect(opened.slice(0, 2)).toEqual(['-b', CURSOR])
      // opens() splits each run's line on its spaces: joined back, the folder as `open` was given it.
      expect(realpathSync(opened.slice(2).join(' '))).toBe(realpathSync(join(d.projectsDir, FOLDER_MARKER)))
    } else {
      // 7. A's tap is gone with its terminal: no folder window opens off macOS.
      await dial.next((m) => m.t === 'agent' && m.id === a.id && !String(m.caps).includes('f'), 45_000, "A's f gone", since)
      expect(d.opens()).toEqual([])
    }

    // 8. No line about VS Code or Cursor holds a pid, the window's id or a path under the root, which A's folder is, and no
    // line of the devices holds the folder's name.
    expect(leaks(d, [a])).toEqual([])
  }, 300_000)
})
