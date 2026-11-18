import { chmodSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type Stats } from 'node:fs'
import { join, posix } from 'node:path'
import type { Done } from './journal.js'
import { draftOf, movedPath, type MovePlan } from './plan.js'

type Run = (command: string, args: string[]) => { status: number | null }

// How each file outside the tree spells a path. The writers are copied here because the move may load none of them:
// the installers' single quotes (cli/scripts/install.sh, lib/launchers.ts), install-cli.sh's double quotes (the path
// as it is), and the unit's program, argument, path and variable (harnessd/platform.ts execWord, pathValue,
// environmentWord). Each escapes character by character, so an entry's old path spelled the same way is the prefix
// to replace.
const singleQuoted = (path: string): string => path.replace(/'/g, `'\\''`)
const asIs = (path: string): string => path
const unitProgram = (path: string): string => path.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
const unitArgument = (path: string): string => unitProgram(path).replace(/\$/g, '$$$$')
const unitPath = (path: string): string => path.replace(/%/g, '%%')
const unitVariable = (name: string, value: string): string => `Environment="${unitProgram(`${name}=${value}`)}"`

/** The trailing exec line, the only line a shipped launcher varies (lib/launchers.ts). */
const EXEC_LINE = /^exec .*$/m
/** Carried into the unit so a daemon systemd starts finds the roots the move moved to (lib/platformDaemon.ts CARRIED_ENV). */
const XDG_NAMES = ['XDG_DATA_HOME', 'XDG_STATE_HOME'] as const

/**
 * [text] with each entry's old path, as [spell] writes it, replaced by its new one spelled the same. One pass, so a
 * new path is never replaced again.
 */
function respell(text: string, plan: MovePlan, spell: (path: string) => string): string {
  // An empty pattern would match between every two characters.
  if (plan.entries.length === 0) return text
  const to = new Map(plan.entries.map((entry) => [spell(`${entry.from}/`), spell(`${entry.to}/`)]))
  const from = new RegExp([...to.keys()].map((prefix) => prefix.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|'), 'g')
  return text.replace(from, (prefix) => to.get(prefix)!)
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Puts what [make] writes at a draft in [path]'s place with one rename, so nothing runs a file half written. */
function replace(path: string, make: (draft: string) => void): void {
  const draft = draftOf(path)
  rmSync(draft, { force: true })
  try {
    make(draft)
    renameSync(draft, path)
  } catch (error) {
    rmSync(draft, { force: true })
    throw error
  }
}

/** A launcher stays 755 and the unit as systemd had it: the mode the file has now, which the umask must not narrow. */
function writeKeepingMode(path: string, bytes: string | Buffer): void {
  const mode = statSync(path).mode & 0o7777
  replace(path, (draft) => {
    writeFileSync(draft, bytes, { mode })
    chmodSync(draft, mode)
  })
}

const linkTo = (path: string, target: string): void => replace(path, (draft) => symlinkSync(target, draft))

/** Writes [next] in [path]'s place once its previous [bytes] are in the journal. False when nothing changed. */
function rewriteFile(path: string, bytes: Buffer, next: string, journal: { add(done: Done): void }): boolean {
  if (next === bytes.toString('utf8')) return false
  journal.add({ did: 'file', path, before: bytes.toString('base64') })
  writeKeepingMode(path, next)
  return true
}

/**
 * A `harness` launcher, or an `hn` of releases #365 to #500 (`exec <node> <cli.js> tui "$@"`): its exec line, when it
 * runs this install's bundle as an installer quoted it. Anything else at that path is somebody's; today's `hn` names
 * only the launcher.
 */
function rewriteScript(path: string, plan: MovePlan, journal: { add(done: Done): void }): boolean {
  const bytes = readFileSync(path), text = bytes.toString('utf8')
  const exec = EXEC_LINE.exec(text)?.[0]
  const cli = posix.join(plan.legacy, 'cli', 'cli.js')
  if (!exec || !(exec.includes(`'${singleQuoted(cli)}'`) || exec.includes(`"${cli}"`))) return false
  const next = respell(respell(exec, plan, singleQuoted), plan, asIs)
  return rewriteFile(path, bytes, text.replace(EXEC_LINE, () => next), journal)
}

/** An `hn` that is a link into the old tree (to `bin/harness-tui`) is linked to the same file's new place. */
function relink(path: string, plan: MovePlan, journal: { add(done: Done): void }): boolean {
  const before = readlinkSync(path), next = movedPath(plan, before)
  if (next === before) return false
  journal.add({ did: 'link', path, before })
  linkTo(path, next)
  return true
}

function reload(run: Run): void {
  const { status } = run('systemctl', ['--user', 'daemon-reload'])
  if (status !== 0) throw new Error(`systemctl --user daemon-reload failed with status ${status}`)
}

/**
 * The systemd user unit, when it is this install's: it logs to [oldLogFile], as harnessd/platform.ts ownedBy reads it.
 * ExecStart's Node and cli.js and the log path name the new folders, and it carries the XDG variables as the move
 * read them (a line for one no longer set goes), where systemdUnit writes them: before its platform's variable, after
 * ExecStart in a unit without one.
 */
function rewriteUnit(plan: MovePlan, unitFile: string, oldLogFile: string, env: NodeJS.ProcessEnv, journal: { add(done: Done): void }, run: Run): boolean {
  if (!lstatOrNull(unitFile)?.isFile()) return false
  const bytes = readFileSync(unitFile), text = bytes.toString('utf8')
  if (!text.includes(`\nStandardOutput=append:${unitPath(oldLogFile)}\n`)) return false
  const lines = text.split('\n')
    .filter((line) => !XDG_NAMES.some((name) => line.startsWith(`Environment="${name}=`)))
    .map((line) => line.startsWith('ExecStart=') ? respell(respell(line, plan, unitProgram), plan, unitArgument)
      : /^Standard(?:Output|Error)=append:/.test(line) ? respell(line, plan, unitPath) : line)
  const platform = lines.findIndex((line) => line.startsWith('Environment="HARNESSD_PLATFORM='))
  const at = platform === -1 ? lines.findIndex((line) => line.startsWith('ExecStart=')) + 1 : platform
  lines.splice(at, 0, ...XDG_NAMES.filter((name) => env[name]).map((name) => unitVariable(name, env[name]!)))
  const next = lines.join('\n')
  if (next === text) return false
  // Before the file: a rollback, in reverse, puts the unit's bytes back first and then reloads.
  journal.add({ did: 'reload' })
  rewriteFile(unitFile, bytes, next, journal)
  reload(run)
  return true
}

/**
 * Step 7 of the move: what outside the tree names it. The `harness` launcher and `hn` in [where.binDir], and the
 * systemd user unit, then `systemctl --user daemon-reload` through [run]. Each file's previous bytes, and each link's
 * previous target, are journalled before it changes. Says which of the three changed.
 */
export function rewriteOutside(
  plan: MovePlan, where: { binDir: string; unitFile: string; oldLogFile: string; env: NodeJS.ProcessEnv },
  journal: { add(done: Done): void }, run: Run,
): { launcher: boolean; hn: boolean; unit: boolean } {
  const launcher = join(where.binDir, 'harness'), hn = join(where.binDir, 'hn')
  const hnStat = lstatOrNull(hn)
  return {
    launcher: !!lstatOrNull(launcher)?.isFile() && rewriteScript(launcher, plan, journal),
    hn: hnStat?.isSymbolicLink() ? relink(hn, plan, journal) : !!hnStat?.isFile() && rewriteScript(hn, plan, journal),
    unit: rewriteUnit(plan, where.unitFile, where.oldLogFile, where.env, journal, run),
  }
}

/** Undoes one step: a file's bytes back (or the file gone, if there was none), a link's target back, systemd reloaded again. */
export function restoreOutside(done: Done, run: Run): void {
  if (done.did === 'file') {
    if (done.before === null) rmSync(done.path, { force: true })
    else writeKeepingMode(done.path, Buffer.from(done.before, 'base64'))
  } else if (done.did === 'link') linkTo(done.path, done.before)
  else if (done.did === 'reload') reload(run)
}
