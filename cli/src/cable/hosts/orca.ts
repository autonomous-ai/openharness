/**
 * Types into and switches to an Orca terminal, by the handle its hook sent (ORCA_TERMINAL_HANDLE). The handle came
 * from a hook and the text from the dial, so both are checked here, and `orca` runs with no shell: the text is one
 * argument, never a command line. Nothing here polls Orca. Orca itself comes forward as every app does (open.ts).
 *
 * Beside them, three reads of Orca's CLI (createOrcaReads): whether it has `watch-focus`, the terminals in tab order with
 * the agents Orca saw in them and their worktrees, and a watch of the focused terminal (docs/plans/2026-11-16-dial-orca-focus-order-design.md).
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import type { HostAdapter } from './adapter.js'
import { APP_BUNDLES } from './hostDetect.js'
import { observedTitle } from './observedTitle.js'
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

const GONE: OrcaChild = { onData: () => {}, exited: Promise.resolve(), kill: () => {} }

export function orcaDeps(): OrcaReadDeps {
  return {
    run: (file, args, timeoutMs) => new Promise((resolve) => {
      // The timeout's kill waits for the process to exit: one deaf to SIGTERM, or stuck where even SIGKILL waits, kept the
      // call and its terminal's one-command slot open for good. The deadline answers by itself.
      const deadline = setTimeout(() => resolve({ code: null, stdout: '' }), timeoutMs)
      try {
        execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
          clearTimeout(deadline)
          // A number is the exit code; a timeout's kill or a binary that could not start has none.
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout })
        })
      } catch {
        // A file or argument it refuses before starting (a NUL byte, a .cmd on Windows) throws rather than calls back.
        clearTimeout(deadline)
        resolve({ code: null, stdout: '' })
      }
    }),
    onPath: (name) => resolveBinaryOnPath(name),
    exists: existsSync,
    platform: process.platform,
    spawn: (file, args) => {
      let child: ChildProcess
      try {
        child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        // A file or argument it refuses before starting throws rather than emits: a child that has already gone.
        return GONE
      }
      // The close that follows says it: after an exit, and after a spawn that failed, which has no exit.
      child.on('error', () => {})
      // Out of descriptors (EMFILE) it returns with no pipes to read or drain: a child that has already gone.
      const { stdout, stderr } = child
      if (!stdout || !stderr) return GONE
      // Drained: a child that writes more to stderr than its pipe holds stalls before its next line. Never kept: it can
      // name paths.
      stderr.resume()
      return {
        onData: (listener) => { stdout.on('data', listener) },
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

/** What a switch reads beside its deps: each terminal's worktree, by its id in Orca, from the latest layout read, and
 *  where its outcome lines go. */
export interface OrcaWorktrees {
  worktreeOf(handle: string): string | undefined
  log(line: string): void
  /** Told as `terminal switch` starts after an activate: an activate can take long, and Orca's focus line for the pane
   *  follows the switch, so the dial's echo of it is kept from then too. */
  switching(handle: string): void
}

const NO_WORKTREES: OrcaWorktrees = { worktreeOf: () => undefined, log: () => {}, switching: () => {} }

function createOrcaActions(deps: OrcaDeps, worktrees: OrcaWorktrees): { send(handle: string, text: string): Promise<boolean>; switchTo(handle: string): Promise<PaneSwitch> } {
  // Per terminal, the switch under way: a second one is that same run. A swipe's rest runs a switch, and a tap 0.4 to 1 s
  // after it was refused as busy: on Linux the dial said Orca did not open the pane it had just shown.
  const switching = new Map<string, Promise<PaneSwitch>>()
  // Per terminal, the words being typed or waiting to be: two transcripts typed at once would mix in its prompt.
  const sending = new Set<string>()
  // `terminal switch` (Orca 1.4.256) only reveals the worktree, lightly: a parked or sleeping session showed once the
  // person pressed Back, which runs the full activation `worktree activate` runs. Its failure, a throw or a timeout too,
  // still lets the switch run. The id is one argument, never a shell's.
  const activate = async (orca: string, worktreeId: string): Promise<void> => {
    const { code } = await deps.run(orca, ['worktree', 'activate', '--worktree', `id:${worktreeId}`, '--json'], RUN_TIMEOUT_MS)
      .catch(() => ({ code: null }))
    if (code !== 0) worktrees.log('[device] orca activate · failed')
  }

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
    // Picks the terminal inside Orca, its worktree activated first when the latest read named it. Words being typed there
    // make it busy: it runs nothing and queues nothing.
    async switchTo(handle) {
      if (!ORCA_HANDLE.test(handle)) return 'failed'
      const under = switching.get(handle)
      if (under) return under
      if (sending.has(handle)) return 'busy'
      const orca = orcaBinary(deps)
      if (!orca) return 'failed'
      const switched = () => deps.run(orca, ['terminal', 'switch', '--terminal', handle, '--json'], RUN_TIMEOUT_MS)
      const worktreeId = worktrees.worktreeOf(handle)
      const run = (worktreeId === undefined ? switched() : activate(orca, worktreeId).then(() => {
        worktrees.switching(handle)
        return switched()
      }))
        .then(({ code }): PaneSwitch => (code === 0 ? 'ok' : 'failed'))
        .finally(() => switching.delete(handle))
      switching.set(handle, run)
      return run
    },
  }
}

/** An Orca terminal, by its handle: words are typed there, and a rest or a tap switches to it before Orca comes forward. */
export function createOrcaAdapter(deps: OrcaDeps, worktrees: OrcaWorktrees = NO_WORKTREES): HostAdapter & Required<Pick<HostAdapter, 'show' | 'type'>> {
  const orca = createOrcaActions(deps, worktrees)
  return {
    id: 'orca',
    tap: 'before',
    bundle: APP_BUNDLES.orca,
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

export interface OrcaTab {
  handle: string
  title?: string
  /** Its title is none of its panes' titles: the person set it. Orca marks no custom title, but a tab's own title is its
   *  active pane's. */
  renamed?: true
}

/** An Orca terminal an agent runs in, as Orca's flat list says it: its worktree's folder and the agent Orca saw start there. */
export interface OrcaTerminal {
  handle: string
  worktreePath: string
  agentIdentity: string
}

export interface OrcaTabs {
  /** The terminals' handles in tab order, each with its tab's title when it has one to show. */
  tabs: OrcaTab[]
  /** The terminals Orca lists an agent in, laid out or not. */
  terminals: OrcaTerminal[]
  /** Each terminal's worktree, by its id in Orca, for the activation before a switch. */
  worktrees: ReadonlyMap<string, string>
}

export interface OrcaReads {
  orcaWatchesFocus(): Promise<boolean>
  /** Its tabs and the terminals agents run in, from one `terminal list`; null when the read failed. */
  orcaTabs(): Promise<OrcaTabs | null>
  watchOrcaFocus(onHandle: (handle: string | null) => void): OrcaFocusWatch
}

// What Orca prints is outside text: another program's, and a newer Orca may print shapes this one does not know. So every
// handle is held to ORCA_HANDLE and every read has a bound. A list's stdout stops at execFile's 1 MiB. Its layouts are
// walked to 64 worktrees, 256 terminals and 32 levels: Orca 1.4.256 nests a tab's panes a few levels deep and the dial's
// ring holds 16, so a layout past those is not one to rank by, and a large or odd one costs a bounded walk. A focus line
// is `{"handle":"term_<uuid>"}`, 54 bytes: one past 512 is no line of Orca's and is dropped as it grows, never held.
// stderr is never kept: it can name paths.
const MAX_WORKTREES = 64
const MAX_HANDLES = 256
const MAX_DEPTH = 32
const MAX_FOCUS_LINE = 512
// A terminal row's folder and agent are compared, never shown: a folder past PATH_MAX, or an agent's name past 64, is no
// row of Orca's.
const MAX_PATH = 4096
const MAX_IDENTITY = 64
// A worktree's id is Orca's repo uuid, `::` and the worktree's folder: one past a folder's bound and 64 more is no id of
// Orca's. It is passed to `orca` as an argument, so none holds a control character.
const MAX_WORKTREE_ID = MAX_PATH + 64
const CONTROL_CHAR = /\p{Cc}/u
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

/** The handles of `orca terminal list`'s layouts in tab order, each with its tab's title: worktrees as listed, then by
 *  group, tab and pane, each split `first`, then `second`. A node of a type it does not know ends its branch; a handle
 *  named twice keeps its first place and title. A title is outside text, held to what a hook's is (observedTitle). */
function tabOrder(listed: unknown, worktrees: Map<string, string>): OrcaTab[] {
  const tabs = new Map<string, OrcaTab>()
  // A tab's panes: `terminal` leaves and `pane-split`s, gathered with their own titles, the programs' in them.
  const panes = (node: unknown, depth: number, leaves: Array<{ handle: unknown; title: string | undefined }>): void => {
    if (depth > MAX_DEPTH || leaves.length === MAX_HANDLES || !isObject(node)) return
    if (node.type === 'terminal') {
      leaves.push({ handle: node.handle, title: observedTitle(node.title) })
    } else if (node.type === 'pane-split') {
      panes(node.first, depth + 1, leaves)
      panes(node.second, depth + 1, leaves)
    }
  }
  // A worktree's tab groups: `group`s of tabs and `split`s.
  const groups = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || tabs.size === MAX_HANDLES || !isObject(node)) return
    if (node.type === 'group' && Array.isArray(node.tabs)) {
      for (const tab of node.tabs) {
        if (!isObject(tab)) continue
        const leaves: Array<{ handle: unknown; title: string | undefined }> = []
        panes(tab.panes, depth + 1, leaves)
        // The tab's title names every pane in it.
        const title = observedTitle(tab.title)
        const named = title === undefined ? {} : leaves.some((leaf) => leaf.title === title) ? { title } : { title, renamed: true as const }
        for (const { handle } of leaves) {
          if (tabs.size === MAX_HANDLES) return
          if (typeof handle === 'string' && ORCA_HANDLE.test(handle) && !tabs.has(handle)) tabs.set(handle, { handle, ...named })
        }
      }
    } else if (node.type === 'split') {
      groups(node.first, depth + 1)
      groups(node.second, depth + 1)
    }
  }
  const layouts = isObject(listed) && isObject(listed.result) ? listed.result.visualLayouts : undefined
  if (Array.isArray(layouts)) {
    for (const layout of layouts.slice(0, MAX_WORKTREES)) {
      if (!isObject(layout)) continue
      const from = tabs.size
      groups(layout.root, 1)
      const worktreeId = worktreeIdOf(layout.worktreeId)
      if (worktreeId !== undefined) for (const handle of [...tabs.keys()].slice(from)) worktrees.set(handle, worktreeId)
    }
  }
  return [...tabs.values()]
}

/** A worktree id as Orca prints it, or none: outside text that becomes an argument. */
function worktreeIdOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_WORKTREE_ID && !CONTROL_CHAR.test(value) ? value : undefined
}

/** To the layouts' worktrees, those of the flat `terminals` rows laid out nowhere, a shell's too, up to 256 terminals in
 *  all. A list cut short still gives each row's: only placing an agent needs every row. */
function rowWorktrees(listed: unknown, worktrees: Map<string, string>): void {
  const rows = isObject(listed) && isObject(listed.result) ? listed.result.terminals : undefined
  if (!Array.isArray(rows)) return
  for (const row of rows.slice(0, MAX_HANDLES)) {
    if (worktrees.size === MAX_HANDLES) return
    if (!isObject(row) || typeof row.handle !== 'string' || !ORCA_HANDLE.test(row.handle) || worktrees.has(row.handle)) continue
    const worktreeId = worktreeIdOf(row.worktreeId)
    if (worktreeId !== undefined) worktrees.set(row.handle, worktreeId)
  }
}

/** The rows of `orca terminal list`'s flat `terminals` with an agent in them: a shell's has no `agentIdentity`. A handle
 *  named twice keeps its first row. A list cut short (Orca's, past its 200 rows by default, or one past 256) is none: an
 *  agent is placed by elimination over every terminal, and one left out could be the match. */
function agentTerminals(listed: unknown): OrcaTerminal[] {
  const result = isObject(listed) && isObject(listed.result) ? listed.result : undefined
  const rows = result?.terminals
  if (!Array.isArray(rows) || result?.truncated === true || rows.length > MAX_HANDLES) return []
  const terminals = new Map<string, OrcaTerminal>()
  for (const row of rows) {
    if (!isObject(row)) continue
    const { handle, worktreePath, agentIdentity } = row
    if (typeof handle !== 'string' || !ORCA_HANDLE.test(handle) || terminals.has(handle)) continue
    if (typeof worktreePath !== 'string' || worktreePath.length > MAX_PATH) continue
    if (typeof agentIdentity !== 'string' || agentIdentity.length > MAX_IDENTITY) continue
    terminals.set(handle, { handle, worktreePath, agentIdentity })
  }
  return [...terminals.values()]
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

/** What the devices read of Orca's CLI: whether it watches focus, its tabs in order, and a watch of its focused terminal. */
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
        // A run that rejects is one that failed.
        answer: deps.run(orca, ['terminal', '--help'], RUN_TIMEOUT_MS).catch(() => ({ code: null, stdout: '' })).then(({ code, stdout }) => {
          if (code === 0) return listsWatchFocus(stdout)
          // A run that failed or timed out says nothing of the CLI: the next ask runs it again.
          if (probe === asked) probe = undefined
          return false
        }),
      }
      probe = asked
      return asked.answer
    },

    async orcaTabs() {
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
      const worktrees = new Map<string, string>()
      const tabs = tabOrder(listed, worktrees)
      rowWorktrees(listed, worktrees)
      return { tabs, terminals: agentTerminals(listed), worktrees }
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
