/**
 * Types into and switches to an Orca terminal, by the handle its hook sent (ORCA_TERMINAL_HANDLE). The handle came
 * from a hook and the text from the dial, so both are checked here, and `orca` runs with no shell: the text is one
 * argument, never a command line. Nothing here polls Orca. Orca itself comes forward as every app does (open.ts).
 *
 * Beside them, three reads of Orca's CLI (createOrcaReads): whether it has `watch-focus`, the terminals in tab order,
 * and a watch of the focused terminal (docs/plans/2026-11-16-dial-orca-focus-order-design.md).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import type { HostAdapter } from './adapter.js'
import type { PaneSwitch } from './types.js'

export const ORCA_HANDLE = /^term_[0-9a-f-]{36}$/

const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
/** How long any app's command may run (open.ts too). */
export const RUN_TIMEOUT_MS = 10_000
/** The longest text typed into a terminal; the mod's prompt takes no more either (observed.ts). */
export const MAX_TEXT = 2000
// A newline would submit part of the text and an escape would steer the agent's screen: the text is typed as one line,
// and --enter submits it.
export const CONTROL = /\p{Cc}/gu
// detectHost's multiplexers. Each keeps the environment of the terminal it was started in, so the handle names that
// terminal, not where the agent is: words typed there land in whichever pane it shows, another agent's or a shell's. So
// an agent in one has no Orca pane: no words, no rest, no tap through Orca.
const MULTIPLEXERS: ReadonlySet<string> = new Set(['herdr', 'rex', 'zellij', 'tmux'])

export interface OrcaDeps {
  /** Its stdout too: tmux's answer is what it printed (tmux.ts). */
  run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string }>
  onPath(name: string): string | null
  exists(path: string): boolean
  platform: NodeJS.Platform
}

/** A long-lived child of a read: stdin ignored, stderr drained and never read. */
export interface OrcaChild {
  /** Its stdout as it comes. */
  onData(listener: (chunk: Buffer) => void): void
  /** Resolves once it has exited or could not start. Never rejects. */
  readonly exited: Promise<void>
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface OrcaReadDeps extends OrcaDeps {
  spawn(file: string, args: string[]): OrcaChild
  /** The binary's real path and that file's mtime; null when either cannot be read. */
  mtime(path: string): { realPath: string; mtimeMs: number } | null
}

export function orcaDeps(): OrcaReadDeps {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit: one deaf to SIGTERM, or stuck where even SIGKILL waits, kept the
      // call and its terminal's one-command slot open for good. The deadline answers by itself.
      const deadline = setTimeout(() => resolve({ code: null, stdout: '' }), timeoutMs)
      execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
        clearTimeout(deadline)
        // A number is the exit code; a timeout's kill or a binary that could not start has none.
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout })
      })
    }),
    onPath: (name) => resolveBinaryOnPath(name),
    exists: existsSync,
    platform: process.platform,
    spawn: (file, args) => {
      const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      // Drained: a child that writes more to stderr than its pipe holds stalls before its next line. Never kept: it can
      // name paths.
      child.stderr.resume()
      // The close that follows says it: after an exit, and after a spawn that failed, which has no exit.
      child.on('error', () => {})
      return {
        onData: (listener) => { child.stdout.on('data', listener) },
        exited: new Promise((resolve) => { child.once('close', () => resolve()) }),
        kill: (signal) => { child.kill(signal) },
      }
    },
    mtime: (path) => {
      try {
        const realPath = realpathSync(path)
        return { realPath, mtimeMs: statSync(realPath).mtimeMs }
      } catch {
        return null
      }
    },
  }
}

/** Orca's CLI: the one on PATH, else, on macOS, the app's own. */
function orcaBinary(deps: OrcaDeps): string | null {
  return deps.onPath('orca') ?? (deps.platform === 'darwin' && deps.exists(APP_ORCA) ? APP_ORCA : null)
}

function createOrcaActions(deps: OrcaDeps): { send(handle: string, text: string): Promise<boolean>; switchTo(handle: string): Promise<PaneSwitch> } {
  // Per terminal, the switch under way: a second one is that same run. A swipe's rest runs a switch, and a tap 0.4 to 1 s
  // after it was refused as busy: on Linux the dial said Orca did not open the pane it had just shown.
  const switching = new Map<string, Promise<PaneSwitch>>()
  // Per terminal, the words being typed or waiting to be: two transcripts typed at once would mix in its prompt.
  const sending = new Set<string>()

  return {
    async send(handle, text) {
      if (text === '' || text.length > MAX_TEXT || !ORCA_HANDLE.test(handle)) return false
      // Busy queues nothing: the dial asks again, never stacked behind.
      if (sending.has(handle)) return false
      const orca = orcaBinary(deps)
      if (!orca) return false
      const line = text.replace(CONTROL, ' ')
      sending.add(handle)
      try {
        // A switch types nothing: the words wait for one under way, then are typed, never beside it.
        const shown = switching.get(handle)
        if (shown) await shown
        // Joined to its flag: orca reads a separate argument that starts with -- as the next flag, not as the text.
        return (await deps.run(orca, ['terminal', 'send', '--terminal', handle, `--text=${line}`, '--enter', '--wait-submit', '5', '--json'], RUN_TIMEOUT_MS)).code === 0
      } finally {
        sending.delete(handle)
      }
    },
    // Picks the terminal inside Orca. Words being typed there make it busy: it runs nothing and queues nothing.
    async switchTo(handle) {
      if (!ORCA_HANDLE.test(handle)) return 'failed'
      const under = switching.get(handle)
      if (under) return under
      if (sending.has(handle)) return 'busy'
      const orca = orcaBinary(deps)
      if (!orca) return 'failed'
      const run = deps.run(orca, ['terminal', 'switch', '--terminal', handle, '--json'], RUN_TIMEOUT_MS)
        .then(({ code }): PaneSwitch => (code === 0 ? 'ok' : 'failed'))
        .finally(() => switching.delete(handle))
      switching.set(handle, run)
      return run
    },
  }
}

/** An Orca terminal, by its handle: words are typed there, and a rest or a tap switches to it before Orca comes forward. */
export function createOrcaAdapter(deps: OrcaDeps): HostAdapter & Required<Pick<HostAdapter, 'show' | 'type'>> {
  const orca = createOrcaActions(deps)
  return {
    id: 'orca',
    tap: 'before',
    paneOf: (place) => {
      if (MULTIPLEXERS.has(place.host)) return undefined
      const handle = place.hints.ORCA_TERMINAL_HANDLE
      return handle && ORCA_HANDLE.test(handle) ? { adapter: 'orca', id: handle } : undefined
    },
    // `orca terminal switch` runs on every platform.
    canFocus: () => true,
    focus: async (pane) => (await orca.switchTo(pane.id)) === 'ok',
    show: (pane) => orca.switchTo(pane.id),
    type: (pane, text) => orca.send(pane.id, text),
  }
}

export interface OrcaFocusWatch {
  /** SIGTERM, then SIGKILL after 1 s if it has not gone. No line is told after it. */
  stop(): void
  /** Resolves once the child has gone, stopped or by itself. */
  readonly ended: Promise<void>
}

export interface OrcaReads {
  orcaWatchesFocus(): Promise<boolean>
  /** The terminals' handles in tab order; null when the read failed. */
  orcaTabOrder(): Promise<string[] | null>
  watchOrcaFocus(onHandle: (handle: string | null) => void): OrcaFocusWatch
}

// What Orca prints is outside text: another program's, and a newer Orca may print shapes this one does not know. So every
// handle is held to ORCA_HANDLE and every read has a bound. A list's stdout stops at execFile's 1 MiB. Its layouts are
// walked to 64 worktrees, 256 terminals and 32 levels: Orca 1.4.256 nests a tab's panes a few levels deep and the dial's
// ring holds 16, so a layout past those is not one to rank by, and a large or odd one costs a bounded walk. A focus line
// is `{"handle":"term_<uuid>"}`, 53 bytes: one past 512 is no line of Orca's and is dropped as it grows, never held.
// stderr is never kept: it can name paths.
const MAX_WORKTREES = 64
const MAX_HANDLES = 256
const MAX_DEPTH = 32
const MAX_FOCUS_LINE = 512
/** How long a stopped watch has to go before it is killed. */
const STOP_KILL_MS = 1000

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `orca terminal --help` lists watch-focus: the first word of a line of its Commands list, which ends at the
 *  first empty line. The word in a description, or past the list, names no command. */
function listsWatchFocus(help: string): boolean {
  const lines = help.split('\n').map((line) => line.trim())
  const commands = lines.indexOf('Commands:')
  if (commands === -1) return false
  for (const line of lines.slice(commands + 1)) {
    if (line === '') break
    if (line.split(/\s/, 1)[0] === 'watch-focus') return true
  }
  return false
}

/** The handles of `orca terminal list`'s layouts in tab order: worktrees as listed, then by group, tab and pane, each
 *  split `first`, then `second`. A node of a type it does not know ends its branch; a handle named twice keeps its first
 *  place. */
function tabOrder(listed: unknown): string[] {
  const handles = new Set<string>()
  // A tab's panes: `terminal` leaves and `pane-split`s.
  const panes = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || handles.size === MAX_HANDLES || !isObject(node)) return
    if (node.type === 'terminal') {
      if (typeof node.handle === 'string' && ORCA_HANDLE.test(node.handle)) handles.add(node.handle)
    } else if (node.type === 'pane-split') {
      panes(node.first, depth + 1)
      panes(node.second, depth + 1)
    }
  }
  // A worktree's tab groups: `group`s of tabs and `split`s.
  const groups = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || handles.size === MAX_HANDLES || !isObject(node)) return
    if (node.type === 'group' && Array.isArray(node.tabs)) {
      for (const tab of node.tabs) if (isObject(tab)) panes(tab.panes, depth + 1)
    } else if (node.type === 'split') {
      groups(node.first, depth + 1)
      groups(node.second, depth + 1)
    }
  }
  const layouts = isObject(listed) && isObject(listed.result) ? listed.result.visualLayouts : undefined
  if (Array.isArray(layouts)) {
    for (const layout of layouts.slice(0, MAX_WORKTREES)) if (isObject(layout)) groups(layout.root, 1)
  }
  return [...handles]
}

/** A focus line's handle, null for no terminal in focus, undefined for a line that is neither. */
function focusOf(line: string): string | null | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isObject(value)) return undefined
  if (value.handle === null) return null
  return typeof value.handle === 'string' && ORCA_HANDLE.test(value.handle) ? value.handle : undefined
}

/** What the devices read of Orca's CLI: whether it watches focus, its tab order, and a watch of its focused terminal. */
export function createOrcaReads(deps: OrcaReadDeps): OrcaReads {
  // The latest binary's answer, or the run that gives it: an ask meanwhile is that same run.
  let probe: { realPath: string; mtimeMs: number; answer: Promise<boolean> } | undefined

  return {
    // Per binary, by its real path and mtime: every file of Orca's bundle carries its release's time, so an update is
    // asked again, and nothing else is.
    orcaWatchesFocus() {
      const orca = orcaBinary(deps)
      const stamp = orca === null ? null : deps.mtime(orca)
      if (orca === null || stamp === null) return Promise.resolve(false)
      if (probe?.realPath === stamp.realPath && probe.mtimeMs === stamp.mtimeMs) return probe.answer
      const asked = {
        ...stamp,
        answer: deps.run(orca, ['terminal', '--help'], RUN_TIMEOUT_MS).then(({ code, stdout }) => {
          if (code === 0) return listsWatchFocus(stdout)
          // A run that failed or timed out says nothing of the CLI: the next ask runs it again.
          if (probe === asked) probe = undefined
          return false
        }),
      }
      probe = asked
      return asked.answer
    },

    async orcaTabOrder() {
      const orca = orcaBinary(deps)
      if (orca === null) return null
      const { code, stdout } = await deps.run(orca, ['terminal', 'list', '--json', '--include-visual-layouts'], RUN_TIMEOUT_MS)
      if (code !== 0) return null
      let listed: unknown
      try {
        listed = JSON.parse(stdout)
      } catch {
        return null
      }
      return tabOrder(listed)
    },

    watchOrcaFocus(onHandle) {
      const orca = orcaBinary(deps)
      if (orca === null) return { stop: () => {}, ended: Promise.resolve() }
      const child = deps.spawn(orca, ['terminal', 'watch-focus', '--json'])
      let stopped = false
      let gone = false
      let kill: ReturnType<typeof setTimeout> | undefined
      const ended = child.exited.then(() => {
        gone = true
        clearTimeout(kill)
      })
      // The line so far. A stdout chunk is no line: one line can come in several, and several in one. Past the bound
      // the line is dropped, and the rest of it, up to its newline, is skipped.
      let held: Buffer[] = []
      let size = 0
      let skipping = false
      child.onData((chunk) => {
        let from = 0
        while (!stopped && from < chunk.length) {
          const newline = chunk.indexOf(0x0a, from)
          const end = newline === -1 ? chunk.length : newline
          if (!skipping) {
            size += end - from
            if (size > MAX_FOCUS_LINE) {
              held = []
              skipping = true
            } else {
              held.push(chunk.subarray(from, end))
            }
          }
          if (newline === -1) return
          const handle = skipping ? undefined : focusOf(Buffer.concat(held).toString('utf8'))
          held = []
          size = 0
          skipping = false
          from = newline + 1
          if (handle !== undefined) onHandle(handle)
        }
      })
      return {
        stop() {
          if (stopped) return
          stopped = true
          if (gone) return
          child.kill('SIGTERM')
          // Left referenced: a devices process on its way out still kills a child deaf to SIGTERM.
          kill = setTimeout(() => child.kill('SIGKILL'), STOP_KILL_MS)
        },
        ended,
      }
    },
  }
}
