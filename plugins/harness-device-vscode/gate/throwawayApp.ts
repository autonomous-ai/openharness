/**
 * What keeps a throwaway VS Code on a Mac apart from the developer's own. macOS files an app's state by its bundle id,
 * not its folder: a downloaded copy keeps Microsoft's `com.microsoft.VSCode`, and on 2026-11-17 a gate run rewrote the
 * developer's `~/Library/Preferences/com.microsoft.VSCode.plist`, and LaunchServices kept the deleted copy under that id.
 * So before any launch the copy gets ids of its own, after the run LaunchServices forgets it, and the gate checks the
 * developer's preferences were left as they were.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const GATE_ID = 'ai.autonomous.harness.vscode-gate'
const MICROSOFT = 'com.microsoft.VSCode'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** kLSApplicationNotFoundErr: `lsregister -u` fails with it for a bundle never registered, as a helper that never ran. */
const NOT_REGISTERED = '-10814'

/** The real home's, not $HOME's: the test setup points $HOME at a throwaway, and macOS does not. */
export const VSCODE_PREFERENCES = join(userInfo().homedir, 'Library', 'Preferences', `${MICROSOFT}.plist`)

/** Every bundle's Info.plist in the app: its own, its helpers' and its frameworks'. */
function infoPlists(app: string): string[] {
  return readdirSync(app, { recursive: true, encoding: 'utf8' }).filter((path) => basename(path) === 'Info.plist').map((path) => join(app, path))
}

function plistId(plist: string): string | undefined {
  const read = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' })
  return read.status === 0 ? read.stdout.trim() : undefined
}

/** The id the bundle's signature carries, which is the one macOS knows its processes by. */
function signedId(bundle: string): string | undefined {
  return /^Identifier=(.+)$/m.exec(spawnSync('codesign', ['-dv', bundle], { encoding: 'utf8' }).stderr)?.[1]
}

/** Gives the app and every bundle in it whose id is Microsoft's an id under GATE_ID, signs it again ad hoc (the rewrite
 *  broke Microsoft's signature, and the new one carries the new ids) and checks it. */
export function rebrand(app: string): void {
  for (const plist of infoPlists(app)) {
    const id = plistId(plist)
    if (id?.startsWith(MICROSOFT)) execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `${GATE_ID}${id.slice(MICROSOFT.length)}`, plist])
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
  assertRebranded(app)
}

/** Throws, naming each, if any bundle in the app, or any app's signature, still carries Microsoft's id. */
export function assertRebranded(app: string): void {
  const left: string[] = []
  const name = (path: string): string => relative(dirname(realpathSync(app)), path)
  for (const plist of infoPlists(realpathSync(app))) {
    const id = plistId(plist)
    if (id?.startsWith(MICROSOFT)) left.push(`${name(plist)} still carries ${id}`)
  }
  for (const bundle of appBundles(app)) {
    const signed = signedId(bundle)
    if (signed === undefined || signed.startsWith(MICROSOFT)) left.push(`${name(bundle)} is signed as ${signed ?? 'nothing'}`)
  }
  if (left.length) throw new Error(`refusing to launch the throwaway VS Code: ${left.join('; ')}`)
}

/** The app and each app inside it (its helpers), by the real path LaunchServices records them under (/private/tmp for
 *  /tmp): it registers each helper that runs apart from the app. */
export function appBundles(app: string): string[] {
  const real = realpathSync(app)
  return infoPlists(real).filter((plist) => basename(dirname(plist)) === 'Contents').map((plist) => dirname(dirname(plist)))
}

/** LaunchServices keeps an app it saw launch after its folder is gone: this forgets this one, its helpers too, and
 *  nothing else. */
export function unregister(app: string): void {
  for (const bundle of appBundles(app)) {
    const run = spawnSync(LSREGISTER, ['-u', bundle], { encoding: 'utf8' })
    if (run.status !== 0 && !run.stderr.includes(NOT_REGISTERED)) throw new Error(`lsregister -u ${bundle} failed: ${run.stderr.trim()}`)
  }
}

/** A gate run's root in /tmp, before mkdtemp's suffix. It carries the run's pid, so a later run's sweep tells the root of
 *  a run that ended without its clean-up (Ctrl+C) from that of a run still going beside it. */
export const rootName = (pid: number): string => `harness-vscode-gate-${pid}-`
const ROOT = /^harness-vscode-gate-(\d+)-/

type Process = { pid: number; ppid: number; args: string }

/** This account's processes, read in one go: their arguments, never their environment. */
function processes(): Process[] {
  const table = execFileSync('/bin/ps', ['-ww', '-U', String(userInfo().uid), '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
  return table.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line)
    return row ? [{ pid: Number(row[1]), ppid: Number(row[2]), args: row[3]! }] : []
  })
}

/** Each of this account's processes whose arguments carry the root's folder name: every process of the throwaway runs
 *  from under the root, or names its folders, by /tmp or /private/tmp. */
function carrying(table: readonly Process[], root: string): number[] {
  const name = basename(root)
  return table.filter(({ args }) => args.includes(name)).map(({ pid }) => pid)
}

/** The throwaway's processes still running. */
export function throwawayProcesses(root: string): number[] {
  return carrying(processes(), root)
}

/** When the process started, as `ps` says: with its pid, it tells it from a later process given the same pid. */
export function startedAt(pid: number): string | undefined {
  const read = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  return read.status === 0 ? read.stdout.trim() : undefined
}

/** SIGKILLs what the throwaway still runs, SIGKILL as a VS Code that will not quit may pass over SIGTERM: each process
 *  that carries the root's name, each shell the driver reported that is still the process it reported (by its start),
 *  and every descendant of either, which may carry no name. Returns the processes' names, never their arguments, which
 *  hold paths. */
export function killThrowaway(root: string, shells: ReadonlyMap<number, string> = new Map()): string[] {
  const table = processes()
  const doomed = new Set(carrying(table, root))
  for (const [pid, started] of shells) if (startedAt(pid) === started) doomed.add(pid)
  // Every descendant before any kill: a killed parent's children go to launchd, and out of reach.
  for (const parent of doomed) for (const { pid, ppid } of table) if (ppid === parent) doomed.add(pid)
  if (doomed.size === 0) return []
  const names = spawnSync('/bin/ps', ['-o', 'comm=', '-p', [...doomed].join(',')], { encoding: 'utf8' }).stdout
  for (const pid of doomed) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  return [...new Set(names.split('\n').filter(Boolean).map((name) => basename(name.trim())))].sort()
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Clears, of this account's roots in `tmp`, each whose run has ended: kills what still runs from it, has LaunchServices
 *  forget its apps and removes it. Returns the roots it cleared. */
export function sweepLeftovers(tmp = '/tmp'): string[] {
  const cleared: string[] = []
  for (const entry of readdirSync(tmp, { withFileTypes: true })) {
    const pid = ROOT.exec(entry.name)?.[1]
    if (!entry.isDirectory() || pid === undefined || running(Number(pid))) continue
    const root = join(tmp, entry.name)
    if (statSync(root).uid !== userInfo().uid) continue
    killThrowaway(root)
    unregister(root)
    // What was killed may still be letting go of its files.
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    cleared.push(entry.name)
  }
  return cleared
}

export type Stamp = { mtimeMs: number; sha256: string } | null

/** The file's mtime and hash, or null when there is none (a VS Code never run leaves none). */
export function stamp(path: string): Stamp {
  let mtimeMs: number
  try {
    ;({ mtimeMs } = statSync(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return { mtimeMs, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }
}

/** Throws if the file is not as `before` found it. It says how, never what the file holds. */
export function assertUnchanged(path: string, before: Stamp): void {
  const after = stamp(path)
  if (isDeepStrictEqual(before, after)) return
  const how = before === null ? 'made' : after === null ? 'removed' : 'rewritten or touched'
  throw new Error(`the developer's VS Code's preferences changed while the throwaway VS Code ran: ${path} was ${how}`)
}
