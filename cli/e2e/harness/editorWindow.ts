/**
 * Harness's VS Code extension's loop over a fake window (vscodeWindow.ts), in a process of its own, as VS Code or Cursor
 * would start it: what it prints is parsed into an `EditorWindow`, and a failed test dumps all of it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { expect, onTestFailed } from 'vitest'
import { devicesListenerPath } from '../../src/devices/listenerPath.js'
import { CLI_ROOT, type IsolatedDaemon, until } from './daemon.js'
import type { WindowState } from '../../../plugins/harness-device-vscode/src/window.ts'

// How the real CLI is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** The everyday daemon's port: a `link` under test that reached it would hand the loop this computer's devices' socket. */
const EVERYDAY_PORT = '18473'

/** One line the window printed (vscodeWindow.ts). */
export interface Printed {
  state?: string; show?: number; raise?: true; scroll?: 'up' | 'down'; key?: 'up' | 'down'; pid?: number; took?: WindowState; log?: string
}

/** The extension's loop over a fake window, running. */
export interface EditorWindow {
  /** Its process's. */
  pid: number
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
  /** Each line it prints from now on, with when it came (ms since the epoch). */
  onLine(listener: (line: Printed, at: number) => void): void
  /** The window's terminals change, as VS Code tells it. */
  set(state: Partial<WindowState>): void
  /** Ends its stdin, which stops it; its exit code, once it exits within 10 s. */
  stop(): Promise<number | null>
}

/** The daemon's environment names its own data folder, port and devices' socket, never this computer's. */
const isolated = (d: IsolatedDaemon): void => {
  expect(d.env.ADAPTER_DATA_DIR).toBe(d.dataDir)
  expect(d.dataDir.startsWith(d.root + sep)).toBe(true)
  expect(d.env.PORT).not.toBe(EVERYDAY_PORT)
  expect(devicesListenerPath(d.dataDir, process.platform, d.env.HOME)).toBe(join(d.dataDir, 'devices.sock'))
}

/** A word the shell takes as it is. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The extension's loop, started as VS Code would start it for someone whose launcher is `~/.local/bin/harness`: the
 * home is the throwaway one, and the launcher there starts this checkout's CLI under the daemon's environment and
 * nothing else. `/usr/bin:/bin` holds no `harness`: with no launcher the loop would say `noHarness`, never find this
 * computer's. Its process goes in [children], for the test to end.
 */
export function startEditorWindow(d: IsolatedDaemon, children: ChildProcess[]): EditorWindow {
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
  const listeners: Array<(line: Printed, at: number) => void> = []
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
    const at = Date.now()
    const said = JSON.parse(line) as Printed
    if (said.state !== undefined) states.push(said.state)
    if (said.show !== undefined) shows.push(said.show)
    if (said.raise) raised.push(shows.length)
    if (said.scroll !== undefined) scrolls.push(said.scroll)
    if (said.key !== undefined) keys.push({ key: said.key, pid: said.pid! })
    if (said.took !== undefined) took.push(said.took)
    if (said.log !== undefined) logs.push(said.log)
    for (const listener of listeners) listener(said, at)
  })
  lines(child.stderr, (line) => logs.push(line))
  let exited: { code: number | null } | undefined
  child.once('close', (code) => { exited = { code } })
  onTestFailed(() => { console.log(`---- the window's states\n${states.join('\n')}\n---- its shows\n${shows.join('\n')}\n---- its raises, after so many shows\n${raised.join(' ')}\n---- its scrolls\n${scrolls.join(' ')}\n---- its page keys\n${keys.map(({ key, pid }) => `${key} ${pid}`).join(' ')}\n---- its log\n${logs.join('\n')}`) })
  return {
    pid: child.pid!, states, shows, raised, scrolls, keys, took, logs,
    onLine: (listener) => { listeners.push(listener) },
    set: (state) => { child.stdin.write(`${JSON.stringify(state)}\n`) },
    stop: async () => {
      child.stdin.end()
      return (await until('the window to exit', () => exited, 10_000, 50)).code
    },
  }
}
