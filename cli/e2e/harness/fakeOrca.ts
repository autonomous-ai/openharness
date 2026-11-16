/**
 * The `orca` an end-to-end daemon finds first on its PATH, in place of the stub that exits 1 (harness/daemon.ts): it
 * notes every run, prints a layout and a focus watch a test tells it, and answers `terminal --help` as Orca 1.4.256
 * does, or as an Orca with `watch-focus`. The real Orca never runs: every session here runs inside it.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IsolatedDaemon } from './daemon.js'

export interface OrcaRun { args: string; at: number }
/** A tab's panes, first to last: one handle is a leaf, more are pane splits (`first`, then `second`). */
export type FakeTab = string[]

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

// `exec tail` makes the daemon's child the `tail` itself, so its SIGTERM ends it; `-n +1` prints the lines told before
// the watch started, so none is lost to a watch that starts late.
const script = (dir: string): string => `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/asked'
case "$1 $2" in
  'terminal --help') cat '${dir}/help' ;;
  'terminal list') [ -f '${dir}/layout.json' ] || exit 1; cat '${dir}/layout.json' ;;
  'terminal watch-focus') [ -f '${dir}/watches' ] || exit 1; exec tail -n +1 -f '${dir}/focus' ;;
  'terminal switch'|'terminal send')
    printf '%s' "$*" > "$(mktemp '${dir}/runs/run.XXXXXX')"
    code=$(cat '${dir}/exit' 2>/dev/null); exit "\${code:-0}" ;;
  *) exit 1 ;;
esac
`

/** A pane tree in Orca 1.4.256's shapes: the first handle, then the rest split off as `second`. */
const paneTree = ([handle, ...rest]: string[], tabId: string, ids: { leaf: number }): unknown => {
  const leaf = { type: 'terminal', handle, tabId, leafId: `l${++ids.leaf}`, title: 'made up', connected: true, active: false }
  return rest.length === 0 ? leaf : { type: 'pane-split', direction: 'horizontal', first: leaf, second: paneTree(rest, tabId, ids) }
}

export class FakeOrca {
  private constructor(private readonly dir: string) {}

  /** Writes `orca` into the daemon's `bin`, first on its PATH, before `d.start()`. `watchFocus` (default false): its
   *  `terminal --help` lists `watch-focus`, and `terminal watch-focus --json` runs. */
  static install(d: IsolatedDaemon, { watchFocus = false }: { watchFocus?: boolean } = {}): FakeOrca {
    const dir = join(d.root, 'orca')
    mkdirSync(join(dir, 'runs'), { recursive: true })
    writeFileSync(join(dir, 'help'), watchFocus ? HELP_WATCH : HELP)
    writeFileSync(join(dir, 'focus'), '')
    if (watchFocus) writeFileSync(join(dir, 'watches'), '')
    writeFileSync(join(d.root, 'bin', 'orca'), script(dir), { mode: 0o755 })
    return new FakeOrca(dir)
  }

  /** The `terminal switch` and `terminal send` runs. */
  runs(): OrcaRun[] {
    const runs = join(this.dir, 'runs')
    return readdirSync(runs).map((name) => {
      const path = join(runs, name)
      return { args: readFileSync(path, 'utf8'), at: statSync(path).mtimeMs }
    })
  }

  /** Every run's arguments, the reads' too, in the order they started. */
  asked(): string[] {
    let text: string
    try { text = readFileSync(join(this.dir, 'asked'), 'utf8') } catch { return [] }
    return text.split('\n').slice(0, -1)
  }

  /** `terminal switch` and `terminal send` exit 1 from now on. */
  refuse(): void { writeFileSync(join(this.dir, 'exit'), '1') }

  /** What `terminal list` prints from now on: one worktree per entry, its tabs in the strip's order. Until then it exits 1. */
  layout(worktrees: FakeTab[][]): void {
    const ids = { leaf: 0 }
    const visualLayouts = worktrees.map((tabs, i) => ({
      worktreeId: `w${i}`, worktreePath: `/e2e/wt-${i}`,
      root: { type: 'group', groupId: `g${i}`, activeTabId: `t${i}-0`, tabs: tabs.map((panes, j) => {
        const tabId = `t${i}-${j}`
        return { tabId, title: 'made up', activeLeafId: `l${ids.leaf + 1}`, panes: paneTree(panes, tabId, ids) }
      }) },
    }))
    const totalCount = worktrees.flat(2).length
    const file = join(this.dir, 'layout.json')
    // Renamed into place: a `terminal list` that runs meanwhile prints the old layout or the new, never half of one.
    writeFileSync(`${file}.new`, JSON.stringify({ id: 'e2e', ok: true, result: { terminals: [], visualLayouts, totalCount, truncated: false } }))
    renameSync(`${file}.new`, file)
  }

  /** A line on the watch's stdout: the terminal with focus, or none. A watch prints every line told so far, then each new one. */
  focus(handle: string | null): void { appendFileSync(join(this.dir, 'focus'), `${JSON.stringify({ handle })}\n`) }

  /** Whether a `watch-focus` of this fake still runs: a process whose command names its focus file. */
  watching(): boolean { return spawnSync('pgrep', ['-f', join(this.dir, 'focus')]).status === 0 }
}
