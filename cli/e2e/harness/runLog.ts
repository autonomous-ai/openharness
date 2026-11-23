/**
 * The run log of a program a daemon under test runs (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 14): the
 * fake Orca's (fakeOrca.ts), and the recording `tmux` and `herdr` wrappers' on the dial eval's daemons. A file a run,
 * `log/run.XXXXXX` under its folder: its exit, then the name it was run by, then one argument a line (the devices pass
 * none a newline: cable/hosts/orca.ts, tmux.ts, herdr.ts). Written aside and renamed into place, so it is read whole;
 * its time is its mtime.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** One run noted: the name it was run by, then its arguments; whether it exited 0; and its time, ms since the epoch. */
export interface LoggedRun { argv: string[]; ok: boolean; at: number }

/** The shell function `note`, which notes its arguments (the exit, the name run by, each argument) under [dir]. Its
 *  folder is made at its first note, so a program that never ran leaves none. */
export function noteFunction(dir: string): string {
  return `note() {
  [ -d '${dir}/log' ] || mkdir -p '${dir}/log'
  file=$(mktemp '${dir}/log/.XXXXXX')
  printf '%s\\n' "$@" > "$file"
  mv "$file" '${dir}/log/'"run\${file##*/}"
}`
}

/**
 * A wrapper script: runs [real] as its child and notes the run under [dir] (noteFunction) when its first argument is one
 * of [recorded], exiting with its status; any other run execs [real] as it was.
 */
export function recordingWrapper(real: string, dir: string, recorded: readonly string[]): string {
  if ([real, dir, ...recorded].some((word) => word.includes("'"))) throw new Error("a recording wrapper's program, folder or command holds a quote")
  return `#!/bin/sh
${noteFunction(dir)}
case "$1" in
  ${recorded.map((name) => `'${name}'`).join('|')})
    '${real}' "$@"
    code=$?
    note "$code" "\${0##*/}" "$@"
    exit "$code" ;;
esac
exec '${real}' "$@"
`
}

/** Every run noted under [dir], oldest first; none before the first. */
export function runLog(dir: string): LoggedRun[] {
  const log = join(dir, 'log')
  if (!existsSync(log)) return []
  return readdirSync(log).filter((name) => name.startsWith('run')).map((name) => {
    const path = join(log, name)
    const [exit, ...argv] = readFileSync(path, 'utf8').split('\n').slice(0, -1)
    return { argv, ok: exit === '0', at: statSync(path).mtimeMs }
  }).sort((a, b) => a.at - b.at)
}
