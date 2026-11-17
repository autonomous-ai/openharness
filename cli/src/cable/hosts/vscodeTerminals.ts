/**
 * VS Code's integrated terminals, as Harness's own extension reports them
 * (docs/plans/2026-11-17-dial-vscode-extension-design.md): each window holds one `vscode` stream on the devices'
 * listener, keyed by the window's id, and reports its shells' pids on `vscode-state`. This module owns the open windows,
 * each one's latest state, each VS Code agent's parent chain, the match of the two, and the lines written to a window.
 *
 * The match is the process tree: an agent runs under the shell VS Code started for its terminal, or is that terminal's
 * own process, so the window that lists a pid of its chain holds it. A process's name is outside text (a process can
 * write a prompt there) and its environment holds secrets (cli/AGENTS.md rule 4), so neither is read: one `ps` table
 * gives pids and parents. A running pid's parents never change, so an agent's chain is read once and kept until it
 * leaves, and one read serves every agent that needs one.
 */
import { REFUSED, type ListenerHandler, type ListenerStream, type ListenerStreamHandler } from '../../services/devicesListener.js'
import { parentChain, type ProcessName } from './scannedApp.js'

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

const WINDOW_ID = /^[A-Za-z0-9-]{8,36}$/
const PID_MAX = 2 ** 31 - 1
const MINUTE_MS = 60_000

/** A terminal of an open window: the window's id and its shell's pid. */
export interface VscodeTerminal { window: string; shell: number }

export interface VscodeTerminals {
  handlers: { vscode: ListenerStreamHandler; 'vscode-state': ListenerHandler }
  /** The pids of the VS Code agents listed now (at most observed.ts's 50). A new one may ask for a read; one that is gone drops its chain. */
  agents(pids: readonly number[]): void
  /** The window and shell that hold the agent with that pid, from its kept chain; none while unknown. */
  terminalOf(agentPid: number): VscodeTerminal | undefined
  /** Queues `{"show":<shell>}` on the window's stream, the latest winning; false when that stream is gone. `tap` chooses the count only. */
  show(terminal: VscodeTerminal, tap: boolean): boolean
  /** Adds whole lines for that terminal; false when its window's stream is gone. */
  scroll(terminal: VscodeTerminal, lines: number): boolean
}

export interface VscodeTerminalsDeps {
  /** One read of every process's pid and parent; rejects when `ps` could not be read. */
  processes(): Promise<readonly Pick<ProcessName, 'pid' | 'ppid'>[]>
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
  show?: number
  /** Lines its stream has not taken yet, all for one shell: written after the show. */
  scroll?: { shell: number; lines: number }
}

/** `scrolls` counts each scroll line written; `dropped` each wait of lines replaced by lines for another shell. */
const NONE_COUNTED = { shows: 0, taps: 0, refused: 0, reads: 0, scrolls: 0, dropped: 0 }

const isWindowId = (window: unknown): window is string => typeof window === 'string' && WINDOW_ID.test(window)

const isShells = (terminals: unknown): terminals is number[] =>
  Array.isArray(terminals) && terminals.length <= VSCODE_TERMINALS
  && terminals.every((pid) => Number.isInteger(pid) && pid >= 2 && pid <= PID_MAX)
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
  let counted = { ...NONE_COUNTED }
  let minute = false

  const count = (kind: keyof typeof NONE_COUNTED): void => {
    counted[kind]++
    if (minute) return
    minute = true
    deps.after(MINUTE_MS, () => {
      minute = false
      deps.log(`[devices] vscode · in the last minute: ${counted.shows} shows, ${counted.taps} taps, ${counted.refused} refused states, ${counted.reads} ps reads, ${counted.scrolls} scroll lines, ${counted.dropped} dropped`)
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
    let table: Map<number, Pick<ProcessName, 'pid' | 'ppid'>> | undefined
    try {
      table = new Map((await deps.processes()).map((row) => [row.pid, row]))
    } catch { /* Nothing read: each agent asked is due again CHAIN_RETRY_MS from this read's start. */ }
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

  /** One line at a time: the show first, then up to VSCODE_SCROLL_MAX of what waits to scroll. */
  const write = (window: Window): void => {
    if (window.show !== undefined) {
      if (!window.stream.write({ show: window.show })) return
      window.show = undefined
    }
    const waiting = window.scroll
    if (!waiting) return
    const lines = Math.max(-VSCODE_SCROLL_MAX, Math.min(VSCODE_SCROLL_MAX, waiting.lines))
    if (!window.stream.write({ scroll: lines, pid: waiting.shell })) return
    count('scrolls')
    waiting.lines -= lines
    if (!waiting.lines) window.scroll = undefined
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
          const window: Window = { stream }
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
      window.show = terminal.shell
      write(window)
      count(tap ? 'taps' : 'shows')
      return true
    },
    scroll: (terminal, lines) => {
      const window = windows.get(terminal.window)
      if (!window) return false
      if (!lines) return true
      if (window.scroll?.shell === terminal.shell) {
        window.scroll.lines += lines
        // Lines that cancel out leave nothing to write: no scroll line is 0.
        if (!window.scroll.lines) window.scroll = undefined
      } else {
        if (window.scroll) count('dropped')
        window.scroll = { shell: terminal.shell, lines }
      }
      write(window)
      return true
    },
  }
}
