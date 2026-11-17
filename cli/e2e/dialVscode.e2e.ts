/**
 * A tap and a swipe reach Claude Code in VS Code's integrated terminal (docs/plans/2026-11-17-dial-vscode-extension-design.md),
 * on the real daemon. Two sessions run each under a shell of its own under a fake VS Code (harness/outsideAgent.ts), so
 * the parent chain the devices read from `ps` is this computer's own; Harness's extension's loop
 * (plugins/harness-device-vscode/src/loop.ts) runs with a fake window in a process of its own (harness/vscodeWindow.ts),
 * reports both shells on the real devices' socket and prints each terminal it is asked to show; a fake dial on the desk
 * taps and rests. The app in front is a line on the stdin of the real `harness hardware watch --json`, as the Harness
 * Device app writes it.
 *
 * The real VS Code, its `code` and `/usr/bin/open` never run: the daemon's `open` is the harness's fake
 * (HARNESS_OPEN_BIN, harness/daemon.ts), checked to be inside the test's own root before anything is tapped, and the
 * loop finds the daemon through a launcher in the throwaway home alone, never this computer's own daemon or `harness`.
 *
 * The match follows the window's report and a `ps` read, and nothing says when it is done: the dial turns to the agent
 * again every 2 s until the window shows it. Every later wait is a frame or a line, never a fixed time.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../src/devices/listenerPath.js'
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
/** The everyday daemon's port: a `link` under test that reached it would hand the loop this computer's devices' socket. */
const EVERYDAY_PORT = '18473'
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/** The extension's loop over a fake window, running. */
interface Window {
  /** Each state it told, in order. */
  states: string[]
  /** Each shell's pid it was asked to show, in order. */
  shows: number[]
  /** Its channel's lines, then anything it wrote on stderr. */
  logs: string[]
  /** The window's terminals change, as VS Code tells it. */
  set(state: Partial<WindowState>): void
  /** Ends its stdin, which stops it; its exit code, once it exits within 10 s. */
  stop(): Promise<number | null>
}

describe.skipIf(process.platform === 'win32')("a tap and a swipe reach an agent in VS Code's terminal", () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const children: ChildProcess[] = []
  const outside: Outside[] = []
  afterEach(async () => {
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

  /** Claude Code in a VS Code terminal: its shell under the fake VS Code, and the engine under the shell's tab. */
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
      const said = JSON.parse(line) as { state?: string; show?: number; log?: string }
      if (said.state !== undefined) states.push(said.state)
      if (said.show !== undefined) shows.push(said.show)
      if (said.log !== undefined) logs.push(said.log)
    })
    lines(child.stderr, (line) => logs.push(line))
    let exited: { code: number | null } | undefined
    child.once('close', (code) => { exited = { code } })
    onTestFailed(() => { console.log(`---- the window's states\n${states.join('\n')}\n---- its shows\n${shows.join('\n')}\n---- its log\n${logs.join('\n')}`) })
    return {
      states, shows, logs,
      set: (state) => { child.stdin.write(`${JSON.stringify(state)}\n`) },
      stop: async () => {
        child.stdin.end()
        return (await until('the window to exit', () => exited, 10_000, 50)).code
      },
    }
  }

  /** The daemon's lines that hold [word], each from its tag on. */
  const linesWith = (d: IsolatedDaemon, word: string): string[] =>
    d.log().split('\n').filter((line) => line.includes(word)).map((line) => line.slice(line.indexOf('[')))
  const swipes = (d: IsolatedDaemon): string[] => linesWith(d, '[device] swipe ·')
  const said = (d: IsolatedDaemon, line: string): Promise<true> =>
    until(`"${line}" in the daemon's log`, () => d.log().includes(line), 30_000, 50)

  /** [dial] turns to [agent], again every 2 s until [probe] gives a value; that value. */
  const turned = <T>(dial: FakeDial, agent: Outside, what: string, probe: () => T | undefined): Promise<T> => {
    let sent = 0
    return until(what, () => {
      const got = probe()
      if (got !== undefined) return got
      if (Date.now() - sent >= 2_000) {
        dial.send({ t: 'focus', agentId: agent.id })
        sent = Date.now()
      }
      return undefined
    }, 60_000, 50)
  }

  /** The `apps` frame after [since] that shows [app]'s ring. */
  const ring = (dial: FakeDial, app: string, since: number): Promise<DialMessage> =>
    dial.next((m) => m.t === 'apps' && m.shown === app, 45_000, `${app}'s ring`, since)

  it('a tap shows its terminal and brings VS Code forward, a rest shows it while VS Code is in front, and neither once the window goes', async () => {
    const { d, dial } = await fresh()
    // The open the daemon runs is the harness's fake in its root, never the real one.
    const open = d.env.HARNESS_OPEN_BIN ?? ''
    expect(isAbsolute(open), open).toBe(true)
    expect(relative(d.root, open).startsWith('..'), open).toBe(false)

    // 1. A and B in VS Code's terminals, and W in Ghostty: VS Code's ring is shown, with both.
    const a = await inVscode(d, 'a')
    const b = await inVscode(d, 'b')
    const w = new InOrca(d, 'w', children, { TERM_PROGRAM: 'ghostty' })
    await w.hook('SessionStart', { source: 'startup' })
    await dial.next((m) => m.t === 'apps' && m.shown === 'vscode'
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'vscode' && app.count === 2)
      && (m.apps as Array<{ id: string; count: number }>).some((app) => app.id === 'ghostty' && app.count === 1), 45_000, 'VS Code 2 and Ghostty 1')
    for (const agent of [a, b]) expect(agent.shellPid).not.toBe(agent.pid)

    // The window's loop connects and reports both shells, A's active.
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

    // 2. Swipe: with VS Code in front, a rest on A shows A's terminal.
    const front = watch(d)
    front(VSCODE)
    await turned(dial, a, "A's terminal shown", () => window.shows[0])
    expect(window.shows).toEqual([a.shellPid])
    await said(d, '[device] swipe · ok')
    expect(new Set(swipes(d))).toEqual(new Set(['[device] swipe · ok']))

    // 3. Tap: B's terminal is shown, and on macOS VS Code is brought forward by its own open, once; elsewhere none runs.
    dial.send({ t: 'agent.open', agentId: b.id })
    await until("B's terminal shown", () => window.shows.length === 2, 30_000, 50)
    expect(window.shows).toEqual([a.shellPid, b.shellPid])
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
    const pids = [a.shellPid!, b.shellPid!, a.pid, b.pid].map((pid) => new RegExp(`\\b${pid}\\b`))
    const leaks = linesWith(d, 'vscode').filter((line) => pids.some((pid) => pid.test(line)) || UUID.test(line) || line.includes(d.root))
    expect(leaks).toEqual([])
  })
})
