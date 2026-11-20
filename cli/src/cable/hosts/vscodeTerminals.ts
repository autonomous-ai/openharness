/**
 * VS Code's integrated terminals, as Harness's own extension reports them
 * (docs/plans/2026-11-17-dial-vscode-extension-design.md): each window holds one `vscode` stream on the devices'
 * listener, keyed by the window's id, and reports its shells' pids on `vscode-state`. This module owns the open windows,
 * each one's latest state, each VS Code agent's parent chain, the match of the two, and the lines written to a window.
 * Cursor's windows, which run the same extension, hold the same streams: one pool serves both editors, and an agent is
 * the VS Code adapter's or Cursor's by its hook's bundle id (vscode.ts, docs/plans/2026-11-18-dial-cursor-design.md §1).
 *
 * The match is the process tree: an agent runs under the shell VS Code started for its terminal, or is that terminal's
 * own process, so the window that lists a pid of its chain holds it. A process's name is outside text (a process can
 * write a prompt there) and its environment holds secrets (cli/AGENTS.md rule 4), so neither is kept: of the one
 * process table every OS reads (processTable.ts processRows, harness-pty's on Windows), pids and parents alone. A
 * running pid's parents never change, so an agent's chain is read once and kept until it leaves, and one read serves
 * every agent that needs one.
 *
 * A page line's lines also press Claude Code's page keys in the extension
 * (docs/plans/2026-11-18-dial-vscode-claude-fullscreen-scroll-design.md), a plain line's do not: lines that wait keep
 * their kind, as two runs, so a stroke's guard decides its own lines alone and never turns another's into keys.
 *
 * The guard lets a stroke carry those keys only while Claude Code draws fullscreen and is its VS Code terminal's
 * foreground program: a key written while a shell or another program holds the terminal is typed there. It reads two
 * things, one after the other, both within VSCODE_GUARD_MS: the `tui` key alone of the session's settings
 * (claudeRenderer.ts), then, only when that says fullscreen, numbers from `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>`.
 * The foreground is the shell's tpgid, never the agent's own: under screen, script, asciinema or sudo's use_pty the
 * agent leads a pseudo-terminal of its own and is always in front there, while the VS Code terminal shows that program.
 * Never a name, an environment or arguments. Windows has no `ps` and no process groups: no stroke there carries keys.
 */
import { isAbsolute } from 'node:path'
import { REFUSED, type ListenerHandler, type ListenerStream, type ListenerStreamHandler } from '../../services/devicesListener.js'
import { processRows, type ProcessRow } from '../../lib/processTable.js'
import type { PageAgent } from './adapter.js'
import { execText, parentChain, PS_TIMEOUT_MS, type Exec, type ProcessName } from './scannedApp.js'

export const VSCODE_WINDOWS = 8
export const VSCODE_TERMINALS = 32
/** Its message at the longest id, `{"type":"vscode","window":"<36>"}`, is 65 bytes. */
export const VSCODE_OPEN_MAX_BYTES = 96
/** One a second on a connection: the extension opens it again after it ends, backing off, and a loop cannot churn it. */
export const VSCODE_OPEN_PER_SECOND = 1
/** 32 terminals of the largest pid make a state of 473 bytes. */
export const VSCODE_STATE_MAX_BYTES = 1024
/** The extension sends at most 4 a second; twice that leaves room for a window's reload. */
export const VSCODE_STATE_PER_SECOND = 8
/** Whole lines in one scroll line: the extension runs no more of one, and what is over goes in the line after it. */
export const VSCODE_SCROLL_MAX = 100
/** An agent whose read failed is not asked again sooner: one whose pid no table holds costs a read no more often. */
export const CHAIN_RETRY_MS = 5_000
/** The longest a stroke waits on its guard, of wall time: then its lines go out plain. */
export const VSCODE_GUARD_MS = 500
/** The read prints two rows of three numbers of at most 10 digits and a sign, with ps's padding. */
export const GROUPS_MAX_BYTES = 128

const WINDOW_ID = /^[A-Za-z0-9-]{8,36}$/
const PID_MAX = 2 ** 31 - 1
const MINUTE_MS = 60_000
/** A tty's foreground group is -1 on Linux for a process with no terminal. */
const GROUPS_ROW = /^ *(\d+) +(\d+) +(-?\d+) *$/

type ProcessParent = Pick<ProcessName, 'pid' | 'ppid'>

/** Each process's pid and parent, from one read of the process table; rejects when it could not be read. */
export async function readProcessParents(rows: () => Promise<ProcessRow[] | null> = processRows): Promise<ProcessParent[]> {
  const table = await rows()
  // A table lists its reader at the least: no row is a read that failed. The error names nothing it held.
  if (!table?.length) throw new Error('process table not read')
  return table.map(row => ({ pid: row.pid, ppid: row.parentPid }))
}

export interface ProcessGroups { pgid: number; tpgid: number }

/** The agent's group and its VS Code terminal's foreground group, the tpgid of the shell VS Code started there, from
 *  one `ps -o pid=,pgid=,tpgid= -p <agent>,<shell>` through scannedApp.ts's patient exec. None when `ps` failed, either
 *  process is gone, or it printed anything but one row of three numbers for each. */
export async function readForeground(agent: number, shell: number, exec: Exec = execText,
  platform: NodeJS.Platform = process.platform): Promise<ProcessGroups | undefined> {
  // Windows has no `ps` and no foreground process group to read (docs/windows-rules.md §3).
  if (platform === 'win32') return undefined
  // An agent that is its terminal's own process is named once: ps lists a process once however often it is named.
  const pids = [...new Set([agent, shell])]
  const out = await exec('ps', ['-o', 'pid=,pgid=,tpgid=', '-p', pids.join(',')], { timeout: PS_TIMEOUT_MS, maxBuffer: GROUPS_MAX_BYTES })
  const lines = (out ?? '').trimEnd().split('\n')
  const rows = new Map<number, ProcessGroups>()
  for (const line of lines) {
    const row = GROUPS_ROW.exec(line)
    if (!row) return undefined
    rows.set(Number(row[1]), { pgid: Number(row[2]), tpgid: Number(row[3]) })
  }
  const ofAgent = rows.get(agent)
  const ofShell = rows.get(shell)
  return lines.length === pids.length && ofAgent && ofShell ? { pgid: ofAgent.pgid, tpgid: ofShell.tpgid } : undefined
}

/** A terminal of an open window: the window's id and its shell's pid. */
export interface VscodeTerminal { window: string; shell: number }

export interface VscodeTerminals {
  handlers: { vscode: ListenerStreamHandler; 'vscode-state': ListenerHandler }
  /** The pids of the VS Code and Cursor agents listed now (at most observed.ts's 50). A new one may ask for a read; one that is gone drops its chain. */
  agents(pids: readonly number[]): void
  /** The window and shell that hold the agent with that pid, from its kept chain; none while unknown. */
  terminalOf(agentPid: number): VscodeTerminal | undefined
  /** Queues `{"show":<shell>}` on the window's stream, the latest winning; false when that stream is gone. A tap's has
   *  `"raise":true`: the extension then brings its window forward, which an older one ignores. */
  show(terminal: VscodeTerminal, tap: boolean): boolean
  /** Adds whole lines for that terminal; false when its window's stream is gone. `page`: they are written with
   *  `"page":true`, and the extension presses Claude Code's page keys beside them. */
  scroll(terminal: VscodeTerminal, lines: number, page?: boolean): boolean
  /** Whether a stroke on the terminal of the agent with that pid may carry page keys. `false` at once, with nothing read,
   *  when the agent asks or has no absolute folder; else a promise, never rejected, settled within VSCODE_GUARD_MS: true
   *  when its settings say fullscreen and its process group is its VS Code terminal's foreground group. Every answer is
   *  counted in the minute's line. */
  pageKeys(agentPid: number, agent: PageAgent): false | Promise<boolean>
}

export interface VscodeTerminalsDeps {
  /** One read of every process's pid and parent; rejects when the table could not be read (readProcessParents). */
  processes(): Promise<readonly ProcessParent[]>
  /** Whether Claude Code's settings for that absolute folder, and the home its transcript path names, draw it fullscreen
   *  (claudeRenderer.ts readFullscreen). */
  fullscreen(cwd: string, transcriptPath: string | undefined): Promise<boolean>
  /** The agent's process group and the foreground group of the terminal whose shell has that pid (readForeground). */
  foreground(agent: number, shell: number): Promise<ProcessGroups | undefined>
  /** Which agents have a terminal changed. */
  changed(): void
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
  log(line: string): void
}

interface Window {
  stream: ListenerStream
  /** Its latest state's shells; none until its first state. */
  shells?: ReadonlySet<number>
  /** A show its stream has not taken yet: the latest wins. */
  show?: { shell: number; raise: boolean }
  /** Lines its stream has not taken yet, all for one shell: at most one page run and one plain run, in the order they
   *  began to wait, written after the show. */
  scroll: Run[]
}

interface Run { shell: number; lines: number; page: boolean }

/** A guard's read: a page stroke, or the reason it refused. */
type Verdict = 'pages' | 'renderer' | 'background' | 'ps'

/** `failed` counts each `ps` read that failed, of `reads`; `scrolls` each scroll line written; `dropped` each run of
 *  waiting lines replaced by lines for another shell; `pages` each ask whose guard passed, and the five after it each one
 *  refused, by its reason. */
const NONE_COUNTED = {
  shows: 0, taps: 0, refused: 0, reads: 0, failed: 0, scrolls: 0, dropped: 0,
  pages: 0, renderer: 0, asking: 0, background: 0, ps: 0, slow: 0,
}

const held = (lines: number): number => Math.max(-VSCODE_SCROLL_MAX, Math.min(VSCODE_SCROLL_MAX, lines))

const isWindowId = (window: unknown): window is string => typeof window === 'string' && WINDOW_ID.test(window)

/** A pid a shell or an agent can have: 2..2^31-1, never launchd's or init's 1. */
export const isPid = (pid: unknown): pid is number =>
  typeof pid === 'number' && Number.isInteger(pid) && pid >= 2 && pid <= PID_MAX

const isShells = (terminals: unknown): terminals is number[] =>
  Array.isArray(terminals) && terminals.length <= VSCODE_TERMINALS && terminals.every(isPid)
  && new Set(terminals).size === terminals.length

export function vscodeStreams(deps: VscodeTerminalsDeps): VscodeTerminals {
  /** The open windows, in the order their states came, the latest last: a state moves its window there. */
  const windows = new Map<string, Window>()
  /** Each listed shell's window: of two that list it, the one whose state came last. */
  const holders = new Map<number, string>()
  const listed = new Set<number>()
  /** Each listed agent's pid and its parents' pids, nearest first, once read. */
  const chains = new Map<number, readonly number[]>()
  /** When each agent's last failed read began. */
  const failedAt = new Map<number, number>()
  let reading = false
  let again = false
  /** Each listed agent's terminal, as the devices were last told. */
  let told = new Map<number, string>()
  /** Each agent's guard still reading, by its pid: an ask meanwhile joins it rather than reading again. */
  const guards = new Map<number, Promise<Verdict>>()
  let counted = { ...NONE_COUNTED }
  let minute = false

  const count = (kind: keyof typeof NONE_COUNTED): void => {
    counted[kind]++
    if (minute) return
    minute = true
    deps.after(MINUTE_MS, () => {
      minute = false
      deps.log(`[devices] vscode · in the last minute: ${counted.shows} shows, ${counted.taps} taps, ${counted.refused} refused states, ${counted.reads} ps reads, ${counted.failed} failed, ${counted.scrolls} scroll lines, ${counted.dropped} dropped, ${counted.pages} page strokes, guard refused: ${counted.renderer} renderer, ${counted.asking} asking, ${counted.background} background, ${counted.ps} ps, ${counted.slow} slow`)
      counted = { ...NONE_COUNTED }
    })
  }

  const reindex = (): void => {
    holders.clear()
    for (const [id, { shells }] of windows) for (const shell of shells ?? []) holders.set(shell, id)
  }

  const terminalOf = (agentPid: number): VscodeTerminal | undefined => {
    for (const pid of chains.get(agentPid) ?? []) {
      const window = holders.get(pid)
      if (window !== undefined) return { window, shell: pid }
    }
    return undefined
  }

  /** Tells the devices when any listed agent's terminal differs from what they were last told. */
  const tell = (): void => {
    const answers = new Map<number, string>()
    for (const pid of listed) {
      const terminal = terminalOf(pid)
      if (terminal) answers.set(pid, `${terminal.window} ${terminal.shell}`)
    }
    const same = answers.size === told.size && [...answers].every(([pid, at]) => told.get(pid) === at)
    told = answers
    if (!same) deps.changed()
  }

  const due = (pid: number, at: number): boolean => {
    const failed = failedAt.get(pid)
    return !chains.has(pid) && (failed === undefined || at - failed >= CHAIN_RETRY_MS)
  }

  /** One read for every agent due, while some window lists a shell its chain could reach; during a read, once more after
   *  it. */
  const ask = (): void => {
    const at = deps.now()
    const asked = new Set([...listed].filter((pid) => due(pid, at)))
    if (!asked.size || !holders.size) return
    if (reading) {
      again = true
      return
    }
    void read(asked, at)
  }

  const read = async (asked: ReadonlySet<number>, start: number): Promise<void> => {
    reading = true
    count('reads')
    let table: Map<number, ProcessParent> | undefined
    try {
      table = new Map((await deps.processes()).map((row) => [row.pid, row]))
    } catch {
      // Nothing read, counted in the minute's line: each agent asked is due again CHAIN_RETRY_MS from this read's start.
      count('failed')
    }
    reading = false
    // Only the agents it was asked for: one listed during the read may have started after its table was taken.
    for (const pid of asked) {
      if (!listed.has(pid)) continue
      if (table?.has(pid)) chains.set(pid, parentChain(pid, table).map((row) => row.pid))
      else failedAt.set(pid, start)
    }
    tell()
    if (!again) return
    again = false
    ask()
  }

  /** The agent's guard still reading, or a new one. The settings first, and `ps` only when they say fullscreen: most
   *  sessions draw the default renderer and cost no `ps`. Never rejects. */
  const guardOf = (pid: number, cwd: string, transcriptPath: string | undefined): Promise<Verdict> => {
    const reading = guards.get(pid)
    if (reading) return reading
    const verdict = (async (): Promise<Verdict> => {
      // A read that rejects, or throws as it is asked, is a refusal by its reason: the verdict itself never rejects.
      const fullscreen = await (async () => deps.fullscreen(cwd, transcriptPath))().catch(() => false)
      if (!fullscreen) return 'renderer'
      // Its terminal now: a window that went meanwhile leaves no shell whose foreground could be read.
      const terminal = terminalOf(pid)
      if (!terminal) return 'ps'
      const groups = await (async () => deps.foreground(pid, terminal.shell))().catch(() => undefined)
      // No terminal: macOS prints a foreground group of 0, Linux -1.
      if (!groups || groups.tpgid <= 0) return 'ps'
      return groups.pgid === groups.tpgid ? 'pages' : 'background'
    })()
    guards.set(pid, verdict)
    void verdict.then(() => guards.delete(pid))
    return verdict
  }

  /** One line at a time: the show first, then up to VSCODE_SCROLL_MAX of what waits to scroll. */
  const write = (window: Window): void => {
    if (window.show !== undefined) {
      const { shell, raise } = window.show
      if (!window.stream.write(raise ? { show: shell, raise } : { show: shell })) return
      window.show = undefined
    }
    const waiting = window.scroll[0]
    if (!waiting) return
    const lines = held(waiting.lines)
    if (!window.stream.write(waiting.page ? { scroll: lines, pid: waiting.shell, page: true } : { scroll: lines, pid: waiting.shell })) return
    count('scrolls')
    waiting.lines -= lines
    if (!waiting.lines) window.scroll.shift()
  }

  return {
    handlers: {
      vscode: {
        maxBytes: VSCODE_OPEN_MAX_BYTES,
        perSecond: VSCODE_OPEN_PER_SECOND,
        keyed: { key: ({ window }) => (isWindowId(window) ? window : REFUSED), limit: VSCODE_WINDOWS },
        open: (message, stream) => {
          const id = message.window as string
          // A reused id's newer stream starts with no state: its extension sends one as it opens.
          const window: Window = { stream, scroll: [] }
          windows.set(id, window)
          reindex()
          deps.log(`[devices] vscode stream · open · windows ${windows.size}`)
          stream.ended.addEventListener('abort', () => {
            // A newer stream of the same id is the open one by the time the older ends.
            if (windows.get(id) === window) {
              windows.delete(id)
              reindex()
              tell()
            }
            deps.log(`[devices] vscode stream · ended · ${stream.ended.reason} · windows ${windows.size}`)
          })
          stream.onWritable(() => write(window))
          tell()
        },
      },
      'vscode-state': {
        maxBytes: VSCODE_STATE_MAX_BYTES,
        perSecond: VSCODE_STATE_PER_SECOND,
        handle: ({ window: id, terminals, active, focused }) => {
          if (!isWindowId(id) || !windows.has(id) || !isShells(terminals) || (active !== null && !terminals.includes(active as number))
            || typeof focused !== 'boolean') {
            count('refused')
            return REFUSED
          }
          const window = windows.get(id)!
          window.shells = new Set(terminals)
          // Moved last: of two windows that list one shell, this one now holds it.
          windows.delete(id)
          windows.set(id, window)
          reindex()
          tell()
          ask()
        },
      },
    },
    agents: (pids) => {
      const next = new Set(pids)
      for (const pid of [...listed].filter((pid) => !next.has(pid))) {
        // Its pid may name another process next: that one's chain is read anew. The list that dropped it is the
        // devices' own, so nothing is told.
        listed.delete(pid)
        chains.delete(pid)
        failedAt.delete(pid)
        told.delete(pid)
      }
      const added = [...next].some((pid) => !listed.has(pid))
      for (const pid of next) listed.add(pid)
      if (added) ask()
    },
    terminalOf,
    show: (terminal, tap) => {
      const window = windows.get(terminal.window)
      if (!window) return false
      // A rest on the shell a tap waits to show keeps the tap's raise: the window holding it still comes forward.
      window.show = { shell: terminal.shell, raise: tap || (window.show?.shell === terminal.shell && window.show.raise) }
      write(window)
      count(tap ? 'taps' : 'shows')
      return true
    },
    scroll: (terminal, lines, page = false) => {
      const window = windows.get(terminal.window)
      if (!window) return false
      if (!lines) return true
      if (window.scroll[0] && window.scroll[0].shell !== terminal.shell) {
        window.scroll.forEach(() => count('dropped'))
        window.scroll = []
      }
      let run = window.scroll.find((waiting) => waiting.page === page)
      if (!run) window.scroll.push(run = { shell: terminal.shell, lines: 0, page })
      run.lines += lines
      // Pages that piled up while the stream was busy wait as one line: at most its 5 keys once the stream frees, never
      // a burst of them.
      if (page) run.lines = held(run.lines)
      // Lines that cancel out leave nothing to write: no scroll line is 0.
      if (!run.lines) window.scroll.splice(window.scroll.indexOf(run), 1)
      write(window)
      return true
    },
    pageKeys: (agentPid, { asking, cwd, transcriptPath }) => {
      // With no absolute folder, the project's settings, which outrank the user's, cannot be found.
      if (asking || cwd === undefined || !isAbsolute(cwd)) {
        count(asking ? 'asking' : 'renderer')
        return false
      }
      const verdict = guardOf(agentPid, cwd, transcriptPath)
      return new Promise((resolve) => {
        let answered = false
        const answer = (reason: Verdict | 'slow'): void => {
          if (answered) return
          answered = true
          count(reason)
          resolve(reason === 'pages')
        }
        // Wall time, each ask its own: a read that lands later answers nothing for this ask.
        const cancel = deps.after(VSCODE_GUARD_MS, () => answer('slow'))
        void verdict.then((reason) => {
          cancel()
          answer(reason)
        })
      })
    },
  }
}
