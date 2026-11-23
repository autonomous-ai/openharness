/**
 * The `orca` an end-to-end daemon finds first on its PATH, and on Linux its `orca-ide`, the same file, in place of the
 * stub that exits 1 (harness/daemon.ts): it notes every run, prints a layout and a focus watch a test tells it, echoes
 * on that watch each switch it takes a moment later, as Orca does, answers `terminal --help` as Orca 1.4.256 does, or
 * as an Orca with `watch-focus`, takes every `worktree activate`, and lists the accounts a test tells it. It answers
 * `agent --help` as Orca 1.4.271 does, or as an Orca whose `agent` has no `list`, and lists the agents and worktrees a
 * test tells it, in the envelope Orca's CLI prints (testing/recordedOrca.ts). The real Orca never runs: every session
 * here runs inside it.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCA_ECHO_MS } from '../../src/testing/dialAppEval/types.js'
import { RECORDED_ORCA_AGENTS, RECORDED_ORCA_WORKTREES } from '../../src/testing/recordedOrca.js'
import type { IsolatedDaemon } from './daemon.js'

/** A tab's panes, first to last: one handle is a leaf, more are pane splits (`first`, then `second`). With no title of
 *  its own a tab is titled `made up`. */
export type FakeTab = string[] | { title: string; panes: string[] }

/** Orca 1.4.256's `orca terminal --help`, whole. */
const HELP = `orca terminal

Usage: orca terminal <command> [options]

Commands:
  list               List live Orca-managed terminals
  show               Show terminal metadata and preview
  read               Read bounded terminal output
  send               Send input to a live terminal
  wait               Wait for a terminal condition
  create             Create a terminal session in the current worktree
  switch             Switch to a terminal tab in the UI
  close              Close one terminal, its whole tab, or every terminal in a workspace
  rename             Set or clear the title of a terminal tab
  set-pane-title     Set or clear the title of one terminal pane
  split              Split an existing terminal pane

Run \`orca terminal <command> --help\` for command-specific usage.
`
/** The same with `watch-focus`. Its words after the command are made up: only the command's own word is read. */
const HELP_WATCH = HELP.replace(
  '  switch             Switch to a terminal tab in the UI\n',
  '  switch             Switch to a terminal tab in the UI\n  watch-focus        Print the focused terminal, then each change\n',
)

/** Orca 1.4.271's `orca agent --help`, whole (2026-11-23, as cable/hosts/orcaChatSource.spec.ts holds it). */
const AGENT_HELP = `orca agent

Usage: orca agent <command> [options]

Commands:
  hooks prepare-codex Prepare a WSL pane's Orca-managed Codex home before a shell launch
  hooks status       Show whether Orca-managed agent status hooks are enabled
  hooks off          Disable Orca-managed agent status hooks and remove local hook entries
  hooks on           Enable Orca-managed agent status hooks
  launch             Start an agent in an existing workspace, as a chat or a terminal
  installed          List the agent CLIs installed on this host, with the IDs --agent takes
  list               List agents, chats and terminals, with their Orca session IDs
  show               Show where an agent is, by its Orca session ID
  read               Read what an agent said, by its Orca session ID

Run \`orca agent <command> --help\` for command-specific usage.
`
/** The same with no `list`, as an Orca that lists no chats: the word stays in other commands' descriptions. */
const AGENT_HELP_NO_LIST = AGENT_HELP.replace(/^ {2}list .*\n/m, '')

/** What the fake answers as: an Orca whose `terminal` has `watch-focus`, and whose `agent` has `list`. */
interface Speaks { watchFocus: boolean; agentList: boolean }

// A run's note: its exit, then the name it was run by and each argument, one a line (the devices pass Orca no control
// character, cable/hosts/orca.ts). Renamed into place, so it is read whole; its time is its mtime.
// `exec tail` makes the daemon's child the `tail` itself, so its SIGTERM ends it; `-n 1` prints the last line told before
// the watch started, as Orca prints the focus of that moment first. A switch Orca takes moves its focus: one that exits 0
// is told on every watch ORCA_ECHO_MS later, as tier A's Orca tells it, by a job of its own that holds none of the
// run's output, so the switch itself returns at once. The job is named by its `echo` path, which no watch's command
// holds, so endWatch drops it as Orca's quit drops that pane, and watching() never counts it. An Orca whose `agent` has no
// `list` exits 1 for it, as for any command it lacks.
const script = (dir: string, { watchFocus, agentList }: Speaks): string => `#!/bin/sh
note() {
  file=$(mktemp '${dir}/log/.XXXXXX')
  printf '%s\\n' "$@" > "$file"
  mv "$file" '${dir}/log/'"run\${file##*/}"
}
code=1
case "$1 $2" in
  'terminal --help') cat <<'HELP'
${watchFocus ? HELP_WATCH : HELP}HELP
    code=0 ;;
  'terminal list') cat '${dir}/layout.json' 2>/dev/null && code=0 ;;
  'agent --help') cat <<'HELP'
${agentList ? AGENT_HELP : AGENT_HELP_NO_LIST}HELP
    code=0 ;;
${agentList ? `  'agent list') cat '${dir}/agents.json' 2>/dev/null && code=0 ;;\n` : ''}  'worktree list') cat '${dir}/worktrees.json' 2>/dev/null && code=0 ;;
${watchFocus ? `  'terminal watch-focus') note 0 "\${0##*/}" "$@"; exec tail -n 1 -f '${dir}/focus' ;;\n` : ''}  'worktree activate') code=0 ;;
  'account list') cat '${dir}/accounts.json' 2>/dev/null && code=0 ;;
  'terminal switch'|'terminal send')
    code=$(cat '${dir}/exit' 2>/dev/null); code=\${code:-0}
    if [ "$code $2" = '0 switch' ]; then
      handle= prev=
      for arg in "$@"; do [ "$prev" = --terminal ] && handle=$arg; prev=$arg; done
      sh -c 'sleep ${ORCA_ECHO_MS / 1000}; printf "{\\"handle\\":\\"%s\\"}\\n" "$1" >> "\${0%/echo}/focus"' '${dir}/echo' "$handle" </dev/null >/dev/null 2>&1 &
    fi ;;
esac
note "$code" "\${0##*/}" "$@"
exit "$code"
`

/** A pane tree in Orca 1.4.256's shapes: the first handle, then the rest split off as `second`. */
const paneTree = ([handle, ...rest]: string[], tabId: string, ids: { leaf: number }): unknown => {
  const leaf = { type: 'terminal', handle, tabId, leafId: `l${++ids.leaf}`, title: 'made up', connected: true, active: false }
  return rest.length === 0 ? leaf : { type: 'pane-split', direction: 'horizontal', first: leaf, second: paneTree(rest, tabId, ids) }
}

export class FakeOrca {
  private constructor(private readonly dir: string, private readonly launcher: string, private readonly speaks: Speaks) {}

  /** Writes `orca` into the daemon's `bin`, first on its PATH, before `d.start()`. `watchFocus` (default false): its
   *  `terminal --help` lists `watch-focus`, and `terminal watch-focus --json` runs. `agentList` (default true): its
   *  `agent --help` lists `list`, and `agent list --json` runs; else it is an Orca that lists no chats. */
  static install(d: IsolatedDaemon, { watchFocus = false, agentList = true }: { watchFocus?: boolean; agentList?: boolean } = {}): FakeOrca {
    // The daemon's own `bin` (beside its fake engines): a daemon `beside` another shares that one's root, not its bin.
    const bin = dirname(d.env.CLAUDE_PATH!)
    const dir = join(dirname(bin), 'orca')
    mkdirSync(join(dir, 'log'), { recursive: true })
    writeFileSync(join(dir, 'focus'), '')
    // Bin's link names the launcher in Orca's install the harness made, which is the Orca app's own too
    // (harness/daemon.ts): an `orca` anywhere else is not Orca's, and the daemon would run the app's, the stub.
    const fake = new FakeOrca(dir, realpathSync(join(bin, 'orca')), { watchFocus, agentList })
    fake.watchFocus(watchFocus)
    return fake
  }

  /** `terminal --help` lists watch-focus, and `terminal watch-focus` runs, or not. The launcher is rewritten, as an Orca
   *  update rewrites it, so its mtime moves and the devices ask `terminal --help` again. */
  watchFocus(on: boolean): void {
    const before = statSync(this.launcher).mtimeMs
    this.speaks.watchFocus = on
    // Renamed into place: a run that starts meanwhile reads the old script or the new, never half of one.
    writeFileSync(`${this.launcher}.new`, script(this.dir, this.speaks), { mode: 0o755 })
    renameSync(`${this.launcher}.new`, this.launcher)
    // A rewrite within the clock's tick of the last would keep its mtime, and the devices their old answer.
    if (statSync(this.launcher).mtimeMs <= before) {
      const at = new Date(before + 1)
      utimesSync(this.launcher, at, at)
    }
  }

  /** Every run since install: the name it was run by and its arguments, its exit, and its time, oldest first. */
  log(): Array<{ argv: string[]; ok: boolean; at: number }> {
    const log = join(this.dir, 'log')
    return readdirSync(log).filter((name) => name.startsWith('run')).map((name) => {
      const path = join(log, name)
      const [exit, ...argv] = readFileSync(path, 'utf8').split('\n').slice(0, -1)
      return { argv, ok: exit === '0', at: statSync(path).mtimeMs }
    }).sort((a, b) => a.at - b.at)
  }

  /** `terminal switch` and `terminal send` exit 1 from now on. */
  refuse(): void { writeFileSync(join(this.dir, 'exit'), '1') }

  /** What `terminal list` prints from now on: one worktree per entry, its tabs in the strip's order. Until then it exits 1. */
  layout(worktrees: FakeTab[][]): void {
    const ids = { leaf: 0 }
    const visualLayouts = worktrees.map((tabs, i) => ({
      worktreeId: `w${i}`, worktreePath: `/e2e/wt-${i}`,
      root: { type: 'group', groupId: `g${i}`, activeTabId: `t${i}-0`, tabs: tabs.map((tab, j) => {
        const tabId = `t${i}-${j}`
        const { title, panes } = Array.isArray(tab) ? { title: 'made up', panes: tab } : tab
        return { tabId, title, activeLeafId: `l${ids.leaf + 1}`, panes: paneTree(panes, tabId, ids) }
      }) },
    }))
    const totalCount = worktrees.flat().reduce((count, tab) => count + (Array.isArray(tab) ? tab : tab.panes).length, 0)
    this.listing({ id: 'e2e', ok: true, result: { terminals: [], visualLayouts, totalCount, truncated: false } })
  }

  /** What `terminal list` prints from now on, as given. */
  listing(json: object): void { this.put('layout.json', json) }

  /**
   * What `account list --json` prints from now on, in Orca 1.4.256's shape: an account per home, each with a made-up id
   * and an email at example.invalid beside it, which Harness must never keep or say. Until then it exits 1.
   */
  accounts(homes: { claude?: string[]; codex?: string[] }): void {
    let n = 0
    const engine = (list: string[] = []) => {
      const accounts = list.map((home) => {
        n += 1
        return { id: `acct-${n}-e2e`, email: `person${n}@example.invalid`, label: `Made up ${n}`, home, createdAt: 1763337600000 }
      })
      return { activeAccountId: accounts[0]?.id ?? null, accounts }
    }
    this.put('accounts.json', { id: 'e2e', ok: true, result: { claude: engine(homes.claude), codex: engine(homes.codex), gemini: engine() } })
  }

  /** What `agent list --json` prints from now on: [rows], Orca's chats and terminal agents, in the envelope Orca 1.4.271
   *  prints them in (RECORDED_ORCA_AGENTS). Until then it exits 1, as when Orca's runtime does not answer. */
  agents(rows: readonly object[]): void {
    this.put('agents.json', { ...RECORDED_ORCA_AGENTS, result: { ...RECORDED_ORCA_AGENTS.result, agents: rows } })
  }

  /** What `worktree list --json` prints from now on: [rows], each a worktree's `id` and, when it has one, its `identity`,
   *  in the same envelope (RECORDED_ORCA_WORKTREES). Until then it exits 1. */
  worktrees(rows: readonly object[]): void {
    this.put('worktrees.json', { ...RECORDED_ORCA_WORKTREES, result: { ...RECORDED_ORCA_WORKTREES.result, worktrees: rows, totalCount: rows.length } })
  }

  /** A line on the watch's stdout: the terminal with focus, or none. A watch prints the last line told since the last
   *  endWatch, then each new one. */
  focus(handle: string | null): void { appendFileSync(join(this.dir, 'focus'), `${JSON.stringify({ handle })}\n`) }

  /** Whether a `watch-focus` of this fake still runs: a process whose command names its focus file. */
  watching(): boolean { return spawnSync('pgrep', ['-f', join(this.dir, 'focus')]).status === 0 }

  /** Every `watch-focus` of this fake ends, as when Orca quits, and the focus told goes with them: the terminal it
   *  named went with Orca, so a watch after prints nothing until a focus is told. */
  endWatch(): void {
    spawnSync('pkill', ['-f', join(this.dir, 'echo')])
    spawnSync('pkill', ['-f', join(this.dir, 'focus')])
    writeFileSync(join(this.dir, 'focus'), '')
  }

  /** Renamed into place: a run that reads it meanwhile prints the old answer or the new, never half of one. */
  private put(name: string, json: object): void {
    const file = join(this.dir, name)
    writeFileSync(`${file}.new`, JSON.stringify(json))
    renameSync(`${file}.new`, file)
  }
}
