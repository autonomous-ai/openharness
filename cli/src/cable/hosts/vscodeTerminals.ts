/**
 * VS Code's integrated terminals, as Harness's own extension reports them
 * (docs/plans/2026-11-17-dial-vscode-extension-design.md): each window holds one `vscode` stream on the devices'
 * listener, keyed by the window's id, and reports its shells' pids on `vscode-state`. This module owns the open windows,
 * each one's latest state, each VS Code agent's parent chain, the match of the two, and the lines written to a window.
 * Cursor's windows, which run the same extension, hold the same streams: one pool serves both editors, and an agent is
 * the VS Code adapter's or Cursor's by its hook's bundle id (vscode.ts, docs/plans/2026-11-18-dial-cursor-design.md §1).
 *
 * A focused window whose active terminal changes, or that comes into focus on one, tells the devices the listed agent
 * running there, the nearest its shell when several, or none, when that state came and whether the window came into
 * focus on the terminal it had, so the dial can follow the person (devices.ts). A window's first state on its stream
 * follows nothing: a reload or a reopen must not pull the dial.
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
 *
 * A window whose state says `"types":true` takes the dial's words for its terminals
 * (docs/plans/2026-11-22-dial-vscode-cursor-voice-design.md). An older extension says nothing of it and ends its stream
 * on a line of 1 KiB, which a words line can pass: the devices write words only where a window says it types. A send
 * reaches exactly that agent or submits nothing: its words line goes only while the agent is in front of its terminal
 * and the caller says it is at its prompt, and its Enter line only once the same terminal, the same guard and the
 * caller's prompt check hold again after the settle. Any of them failing after the words leaves them in that agent's
 * own input, submitted nowhere.
 */
import { isAbsolute } from 'node:path'
import { REFUSED, type ListenerHandler, type ListenerStream, type ListenerStreamHandler } from '../../services/devicesListener.js'
import { processRows, type ProcessRow } from '../../lib/processTable.js'
import type { PageAgent } from './adapter.js'
import { execText, parentChain, PS_TIMEOUT_MS, type Exec, type ProcessName } from './scannedApp.js'
import { cleanWords, createTwoStep, type StepAnswer } from './twoStep.js'

export const VSCODE_WINDOWS = 8
export const VSCODE_TERMINALS = 32
/** Its message at the longest id, `{"type":"vscode","window":"<36>"}`, is 65 bytes. */
export const VSCODE_OPEN_MAX_BYTES = 96
/** One a second on a connection: the extension opens it again after it ends, backing off, and a loop cannot churn it. */
export const VSCODE_OPEN_PER_SECOND = 1
/** 32 terminals of the largest pid make a state of 473 bytes, 486 with `"types":true`. */
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
/** The longest line a window that types takes, its newline included: the extension's LINE_BYTES. MAX_TEXT characters
 *  of three bytes each make about 60 KB. */
export const VSCODE_LINE_MAX_BYTES = 65_536

/** How a send of the dial's words ended: typed and submitted; refused before the words, its agent not in front of its
 *  terminal; or failed, with nothing submitted. */
export type VscodeTyped = 'typed' | 'background' | 'failed'

const WINDOW_ID = /^[A-Za-z0-9-]{8,36}$/
const PID_MAX = 2 ** 31 - 1
const MINUTE_MS = 60_000
/** A tty's foreground group is -1 on Linux for a process with no terminal. */
const GROUPS_ROW = /^ *(\d+) +(\d+) +(-?\d+) *$/

/** `startMarker`: when it started, by which a parent on a reused pid ends its chain (parentChain). */
type ProcessParent = Pick<ProcessName, 'pid' | 'ppid'> & { startMarker?: string }

/** Each process's pid, parent and start, from one read of the process table; rejects when it could not be read. */
export async function readProcessParents(rows: () => Promise<ProcessRow[] | null> = processRows): Promise<ProcessParent[]> {
  const table = await rows()
  // A table lists its reader at the least: no row is a read that failed. The error names nothing it held.
  if (!table?.length) throw new Error('process table not read')
  return table.map(row => ({ pid: row.pid, ppid: row.parentPid, startMarker: row.startMarker }))
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
  /** Whether the agent with that pid has a terminal now, in a window whose latest state said `"types":true`. */
  canType(agentPid: number): boolean
  /** Types the dial's words into the terminal of the agent with that pid, then, after a settle, presses Enter there.
   *  Never rejects. `background` before any word when the agent is not in front of its terminal; `typed` once the Enter
   *  line went; else `failed`, and after the words nothing submits them. `atPrompt` is the caller's check that the agent
   *  is still at its prompt, asked once the guard has read, before the words, and last before the Enter. */
  type(agentPid: number, words: string, atPrompt: () => boolean): Promise<VscodeTyped>
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
  /** A person focused that terminal at `at` (now's clock): the pid of the listed agent running there, none when no
   *  listed agent does or while a chain that may be its agent's is read (it is told again once read). Each replaces the
   *  one before it, none too. `regained`: its window came into focus on the
   *  terminal it had, as it does when the dial's own tap brings the editor forward. */
  focused(agentPid: number | undefined, terminal: VscodeTerminal, at: number, regained: boolean): void
  /** The OS the devices run on (devices.ts passes the apps' own), never read from `process`. */
  platform: NodeJS.Platform
  /** Monotonic milliseconds. */
  now(): number
  after(ms: number, run: () => void): () => void
  log(line: string): void
}

interface Window {
  stream: ListenerStream
  /** Its latest state's shells; none until its first state. */
  shells?: ReadonlySet<number>
  /** Its latest state's active shell and whether the window was focused. */
  active?: number | null
  focused?: boolean
  /** Whether its latest state said `"types":true`: false until its first state. */
  types: boolean
  /** A show its stream has not taken yet: the latest wins. */
  show?: { shell: number; raise: boolean }
  /** Lines its stream has not taken yet, all for one shell: at most one page run and one plain run, in the order they
   *  began to wait, written after the show. */
  scroll: Run[]
}

interface Run { shell: number; lines: number; page: boolean }

/** An agent's pid and its parents' pids, nearest first, and the agent's start marker in the read they came from. */
interface Chain { pids: readonly number[]; startMarker?: string }

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
  /** Each listed agent's chain, once read. */
  const chains = new Map<number, Chain>()
  /** When each agent's last failed read began. */
  const failedAt = new Map<number, number>()
  let reading = false
  let again = false
  /** The latest focus not yet told, the window whose state made it and when that came: it waits while a chain that may
   *  be its agent's is read. */
  let focus: { terminal: VscodeTerminal; window: Window; at: number; regained: boolean } | undefined
  /** Each listed agent's terminal, as the devices were last told. */
  let told = new Map<number, string>()
  /** Each agent's guard still reading, by its pid: an ask meanwhile joins it rather than reading again. */
  const guards = new Map<number, Promise<Verdict>>()
  /** The sends of the dial's words, one at a time in each shell. */
  const twoStep = createTwoStep<number>(deps.after)
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
    for (const pid of chains.get(agentPid)?.pids ?? []) {
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
      // A window's typing changing changes what the dial may do with its terminals, as a terminal moving does.
      if (terminal) answers.set(pid, `${terminal.window} ${terminal.shell}${windows.get(terminal.window)!.types ? ' types' : ''}`)
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
      if (table?.has(pid)) chains.set(pid, { pids: parentChain(pid, table).map((row) => row.pid), startMarker: table.get(pid)!.startMarker })
      else failedAt.set(pid, start)
    }
    tell()
    if (again) {
      again = false
      ask()
    }
    place()
  }

  /** Tells the devices the agent in the focused terminal once no chain that could be its is still read. */
  const place = (): void => {
    if (!focus || (reading && [...listed].some((pid) => !chains.has(pid)))) return
    const { terminal, window, at, regained } = focus
    focus = undefined
    // A read takes up to ps's 3 s: a state since that left that terminal or the window's focus, or a newer stream of its
    // id, is where the person is now, and this focus is over.
    if (windows.get(terminal.window) !== window || !window.focused || window.active !== terminal.shell) return
    let nearest: { pid: number; depth: number } | undefined
    for (const pid of listed) {
      const its = terminalOf(pid)
      const depth = chains.get(pid)?.pids.indexOf(terminal.shell) ?? -1
      if (its?.window === terminal.window && its.shell === terminal.shell && (!nearest || depth < nearest.depth)) nearest = { pid, depth }
    }
    deps.focused(nearest?.pid, terminal, at, regained)
  }

  /** Whether the agent's group is its VS Code terminal's foreground group, of one read: none when that could not be read
   *  or the terminal has no foreground group. The page keys' guard and the typed words' share it. Never rejects. */
  const inFront = async (pid: number, shell: number): Promise<boolean | undefined> => {
    // A read that rejects, or throws as it is asked, is no answer.
    const groups = await (async () => deps.foreground(pid, shell))().catch(() => undefined)
    // No terminal: macOS prints a foreground group of 0, Linux -1.
    if (!groups || groups.tpgid <= 0) return undefined
    return groups.pgid === groups.tpgid
  }

  /** Whether the dial's words, or their Enter, may go to the agent's terminal now: none when they may, else why not.
   *  Never rejects. */
  const typeGuard = async (agentPid: number, shell: number, chain: Chain): Promise<'background' | 'failed' | undefined> => {
    if (deps.platform !== 'win32') {
      // A suspended (Ctrl+Z) or backgrounded agent leaves the shell in front, where the words would run as a command.
      const front = await inFront(agentPid, shell)
      return front === undefined ? 'failed' : front ? undefined : 'background'
    }
    // Windows has no process groups and no job control. A dead agent's pid may be a new shell's: the table read again
    // must still give it the start its chain was read with, and a chain that reaches the shell.
    const table = await (async () => deps.processes())().then((rows) => new Map(rows.map((row) => [row.pid, row])), () => undefined)
    const row = table?.get(agentPid)
    return table && row && row.startMarker === chain.startMarker && parentChain(agentPid, table).some(({ pid }) => pid === shell)
      ? undefined : 'failed'
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
      const front = await inFront(pid, terminal.shell)
      return front === undefined ? 'ps' : front ? 'pages' : 'background'
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
          const window: Window = { stream, types: false, scroll: [] }
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
        handle: ({ window: id, terminals, active, focused, types }) => {
          if (!isWindowId(id) || !windows.has(id) || !isShells(terminals) || (active !== null && !terminals.includes(active as number))
            || typeof focused !== 'boolean') {
            count('refused')
            return REFUSED
          }
          const window = windows.get(id)!
          const moved = window.shells !== undefined && focused && active !== null
            && (active !== window.active || !window.focused)
          // Of a move: the window came into focus on the terminal it had, as the dial's own tap brings it forward.
          const regained = active === window.active
          window.shells = new Set(terminals)
          window.active = active as number | null
          window.focused = focused
          // Anything but true is a window that does not type: no state is refused for it.
          window.types = types === true
          // Moved last: of two windows that list one shell, this one now holds it.
          windows.delete(id)
          windows.set(id, window)
          reindex()
          tell()
          ask()
          if (!moved) return
          focus = { terminal: { window: id, shell: active as number }, window, at: deps.now(), regained }
          place()
          // Waiting on a chain read, it is the person's latest all the same: told as none now, a focus the devices hold
          // for the settle is over, and not followed should the settle come during the read.
          if (focus) deps.focused(undefined, focus.terminal, focus.at, focus.regained)
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
    canType: (agentPid) => {
      const terminal = terminalOf(agentPid)
      return terminal !== undefined && windows.get(terminal.window)!.types
    },
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
    type: async (agentPid, text, atPrompt) => {
      const words = cleanWords(text)
      if (!words) return 'failed'
      const chain = chains.get(agentPid)
      const terminal = terminalOf(agentPid)
      const window = terminal && windows.get(terminal.window)
      if (!chain || !terminal || !window?.types) return 'failed'
      const { window: id, shell } = terminal
      const line = { type: words, pid: shell }
      if (Buffer.byteLength(JSON.stringify(line)) + 1 > VSCODE_LINE_MAX_BYTES) return 'failed'
      // The very window object, still typing, and the same chain still matched to that shell in it: a window reloaded
      // under its id is another stream, and an agent read anew on its pid another process.
      const same = (): boolean => {
        const now = terminalOf(agentPid)
        return windows.get(id) === window && window.types && chains.get(agentPid) === chain && now?.window === id && now.shell === shell
      }
      // An Enter that waited behind a line still draining would go after the checks it passed: no line waits.
      const written = (sent: unknown): StepAnswer<VscodeTyped> => (window.stream.write(sent) ? { ok: true } : { ok: false, why: 'failed' })
      const typed = await twoStep.send<VscodeTyped>(shell, words, {
        check: async (before) => {
          const refused = await typeGuard(agentPid, shell, chain)
          // After the words, an agent gone to the background still leaves them unsubmitted: the send failed.
          if (refused) return before === 'words' ? refused : 'failed'
          // Asked after the guard's read: a turn that started or a prompt that opened meanwhile would take the words as
          // its answer, and Codex's approval reads a typed `y` as a yes.
          return same() && atPrompt() ? undefined : 'failed'
        },
        words: async () => written(line),
        enter: async () => written({ enter: shell }),
      }, 'failed')
      return typed === true ? 'typed' : typed
    },
  }
}
