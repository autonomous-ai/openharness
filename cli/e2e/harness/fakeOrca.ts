/**
 * The `orca` an end-to-end daemon finds first on its PATH, and on Linux its `orca-ide`, the same file, in place of the
 * stub that exits 1 (harness/daemon.ts): it notes every run, prints a layout and a focus watch a test tells it, echoes
 * on that watch each switch it takes, as Orca does, answers `terminal --help` as Orca 1.4.256 does, or as an Orca with
 * `watch-focus`, takes every `worktree activate`, and lists the accounts a test tells it. The real Orca never runs:
 * every session here runs inside it.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IsolatedDaemon } from './daemon.js'

export interface OrcaRun { args: string; at: number }
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

// A run's note: its exit, then the name it was run by and each argument, one a line (the devices pass Orca no control
// character, cable/hosts/orca.ts). Renamed into place, so it is read whole; its time is its mtime.
// `exec tail` makes the daemon's child the `tail` itself, so its SIGTERM ends it; `-n 1` prints the last line told before
// the watch started, as Orca prints the focus of that moment first. A switch Orca takes moves its focus: one that exits 0
// is told on every watch at once.
const script = (dir: string, watchFocus: boolean): string => `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/asked'
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
${watchFocus ? `  'terminal watch-focus') note 0 "\${0##*/}" "$@"; exec tail -n 1 -f '${dir}/focus' ;;\n` : ''}  'worktree activate') code=0 ;;
  'account list') cat '${dir}/accounts.json' 2>/dev/null && code=0 ;;
  'terminal switch'|'terminal send')
    printf '%s' "$*" > "$(mktemp '${dir}/runs/run.XXXXXX')"
    code=$(cat '${dir}/exit' 2>/dev/null); code=\${code:-0}
    if [ "$code $2" = '0 switch' ]; then
      handle= prev=
      for arg in "$@"; do [ "$prev" = --terminal ] && handle=$arg; prev=$arg; done
      printf '{"handle":"%s"}\\n' "$handle" >> '${dir}/focus'
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
  private constructor(private readonly dir: string, private readonly launcher: string) {}

  /** Writes `orca` into the daemon's `bin`, first on its PATH, before `d.start()`. `watchFocus` (default false): its
   *  `terminal --help` lists `watch-focus`, and `terminal watch-focus --json` runs. */
  static install(d: IsolatedDaemon, { watchFocus = false }: { watchFocus?: boolean } = {}): FakeOrca {
    // The daemon's own `bin` (beside its fake engines): a daemon `beside` another shares that one's root, not its bin.
    const bin = dirname(d.env.CLAUDE_PATH!)
    const dir = join(dirname(bin), 'orca')
    mkdirSync(join(dir, 'runs'), { recursive: true })
    mkdirSync(join(dir, 'log'))
    writeFileSync(join(dir, 'focus'), '')
    // Bin's link names the launcher in Orca's install the harness made, which is the Orca app's own too
    // (harness/daemon.ts): an `orca` anywhere else is not Orca's, and the daemon would run the app's, the stub.
    const fake = new FakeOrca(dir, realpathSync(join(bin, 'orca')))
    fake.watchFocus(watchFocus)
    return fake
  }

  /** `terminal --help` lists watch-focus, and `terminal watch-focus` runs, or not. The launcher is rewritten, as an Orca
   *  update rewrites it, so its mtime moves and the devices ask `terminal --help` again. */
  watchFocus(on: boolean): void {
    const before = statSync(this.launcher).mtimeMs
    // Renamed into place: a run that starts meanwhile reads the old script or the new, never half of one.
    writeFileSync(`${this.launcher}.new`, script(this.dir, on), { mode: 0o755 })
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

  /** A line on the watch's stdout: the terminal with focus, or none. A watch prints the last line told so far, then each new one. */
  focus(handle: string | null): void { appendFileSync(join(this.dir, 'focus'), `${JSON.stringify({ handle })}\n`) }

  /** Whether a `watch-focus` of this fake still runs: a process whose command names its focus file. */
  watching(): boolean { return spawnSync('pgrep', ['-f', join(this.dir, 'focus')]).status === 0 }

  /** Every `watch-focus` of this fake ends, as when Orca quits. */
  endWatch(): void { spawnSync('pkill', ['-f', join(this.dir, 'focus')]) }

  /** Renamed into place: a run that reads it meanwhile prints the old answer or the new, never half of one. */
  private put(name: string, json: object): void {
    const file = join(this.dir, name)
    writeFileSync(`${file}.new`, JSON.stringify(json))
    renameSync(`${file}.new`, file)
  }
}
