/**
 * What keeps a throwaway VS Code on a Mac apart from the developer's own. macOS files an app's state by its bundle id,
 * not its folder: a downloaded copy keeps Microsoft's `com.microsoft.VSCode`, and on 2026-11-17 a gate run rewrote the
 * developer's `~/Library/Preferences/com.microsoft.VSCode.plist`, and LaunchServices kept the deleted copy under that id.
 * So before any launch the copy gets ids of its own and claims no links or files, after the run LaunchServices forgets
 * it, and the gate checks the developer's preferences were left as they were.
 *
 * And on every platform, what the throwaway runs, found and ended through the process table: `ps` on a Mac or Linux,
 * Win32_Process on Windows.
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, relative, win32 } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'

export const GATE_ID = 'ai.autonomous.harness.vscode-gate'
const MICROSOFT = 'com.microsoft.VSCode'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/** kLSApplicationNotFoundErr: `lsregister -u` fails with it for a bundle never registered, as a helper that never ran. */
const NOT_REGISTERED = '-10814'

/** The real home's, not $HOME's: the test setup points $HOME at a throwaway, and macOS and cfprefsd do not. */
const LIBRARY = join(userInfo().homedir, 'Library')
export const VSCODE_PREFERENCES = join(LIBRARY, 'Preferences', `${MICROSOFT}.plist`)

export type Run = (file: string, args: readonly string[]) => { status: number | null; stderr: string }
const run: Run = (file, args) => spawnSync(file, args, { encoding: 'utf8' })

/** Removes the throwaway's own preferences, which macOS keeps under GATE_ID after the run: through `defaults`, as
 *  cfprefsd holds a domain and would write a removed file back, and after the kill, as a quitting app writes its domain
 *  again. Then the file: cfprefsd keeps an empty one after the delete (2026-11-17). GATE_ID's domain and no other: it
 *  takes none. */
export function forgetPreferences(library = LIBRARY, defaults: Run = run): void {
  const deleted = defaults('/usr/bin/defaults', ['delete', GATE_ID])
  // Exit 1 with "Domain (…) not found": the domain is empty, or never was.
  if (deleted.status !== 0 && !/Domain \(.*\) not found/.test(deleted.stderr)) {
    throw new Error(`defaults delete ${GATE_ID} failed: ${deleted.stderr.trim()}`)
  }
  rmSync(join(library, 'Preferences', `${GATE_ID}.plist`), { force: true })
}

/** Removes the throwaway's caches and HTTP storage, which macOS files by GATE_ID: each folder named the id, or the id
 *  and a '.' (its updater's), and none other. */
export function removeOwnFolders(library = LIBRARY): void {
  for (const folder of ['Caches', 'HTTPStorages'].map((name) => join(library, name)).filter(existsSync)) {
    for (const name of readdirSync(folder)) {
      if (name === GATE_ID || name.startsWith(`${GATE_ID}.`)) rmSync(join(folder, name), { recursive: true, force: true })
    }
  }
}

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

/** What VS Code's apps claim, so macOS sends them `vscode:` links and the files they open: while the gate runs, a link
 *  the developer clicks could go to the throwaway. */
const CLAIMS = ['CFBundleURLTypes', 'CFBundleDocumentTypes', 'UTExportedTypeDeclarations', 'UTImportedTypeDeclarations']

function claims(bundle: string): string[] {
  const plist = join(bundle, 'Contents', 'Info.plist')
  return CLAIMS.filter((key) => spawnSync('plutil', ['-extract', key, 'xml1', '-o', '-', plist]).status === 0)
}

/** Gives the app and every bundle in it whose id is Microsoft's an id under GATE_ID, drops each app's claims on links
 *  and files, signs it again ad hoc (the rewrite broke Microsoft's signature, and the new one carries the new ids) and
 *  checks it. */
export function rebrand(app: string): void {
  for (const plist of infoPlists(app)) {
    const id = plistId(plist)
    if (id?.startsWith(MICROSOFT)) execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `${GATE_ID}${id.slice(MICROSOFT.length)}`, plist])
  }
  for (const bundle of appBundles(app)) {
    for (const key of claims(bundle)) execFileSync('plutil', ['-remove', key, join(bundle, 'Contents', 'Info.plist')])
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
  assertRebranded(app)
}

/** Throws, naming each, if any bundle in the app, or any app's signature, still carries Microsoft's id, or any app still
 *  claims links or files. */
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
    for (const key of claims(bundle)) left.push(`${name(bundle)} still claims ${key}`)
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

const WINDOWS = process.platform === 'win32'

/** On Windows @vscode/test-electron starts Code.exe through cmd.exe with its arguments unquoted (CVE-2024-27980): a
 *  space, &, % or quote in a path it passes splits it or runs as a command. Throws, naming each of `paths` that holds
 *  any character but these by what it is, never by its path, which holds the account's name. */
export function assertCmdSafe(paths: Readonly<Record<string, string>>): void {
  const unsafe = Object.entries(paths).filter(([, path]) => !/^[A-Za-z0-9\\:._-]+$/.test(path)).map(([what]) => what)
  if (unsafe.length) {
    throw new Error(`refusing to launch the throwaway VS Code: ${unsafe.join(' and ')}'s path holds a character cmd.exe would `
      + 'split or run; move it to a folder whose path holds only A-Z, a-z, 0-9, \\, :, ., _ and -')
  }
}

/** Where a gate run's root goes. On a Mac /tmp, short: the devices' socket goes in it, and a Unix socket's path has 96
 *  bytes. On Windows the account's temp folder, inside its profile, where the devices' pipe token may be kept; by its
 *  long name, which the throwaway's command lines carry, not an 8.3 short one TEMP may hold. */
export const GATE_TMP = WINDOWS ? realpathSync.native(tmpdir()) : '/tmp'

/** A gate run's root in GATE_TMP, before mkdtemp's suffix. It carries the run's pid, so a later run's sweep tells the
 *  root of a run that ended without its clean-up (Ctrl+C) from that of a run still going beside it. */
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

/** A row of Windows' process table. `started` is its creation time as a FILETIME, in decimal: with its pid, it tells it
 *  from a later process given the same pid. `command` is its program's path and its command line. */
export type WindowsProcess = { pid: number; ppid: number; name: string; command: string; started: string }

const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** Windows PowerShell's arguments for `script`, its output in UTF-8: encoded, so no quoting of a command line touches it. */
function powershellArgs(script: string): string[] {
  const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}
const POWERSHELL_OPTIONS = { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 } as const
const powershell = (script: string): string => execFileSync(POWERSHELL, powershellArgs(script), POWERSHELL_OPTIONS)

/** Win32_Process, read in one go: another account's processes come with no path or command line. */
function windowsProcesses(): WindowsProcess[] {
  return JSON.parse(powershell(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object {
    @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; command = "$($_.ExecutablePath) $($_.CommandLine)";
       started = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc().ToString() } else { '0' } } })`)) as WindowsProcess[]
}

/** Of a Windows process table, the throwaway's: each process whose program or command line names the root's folder (as
 *  a whole folder name, in any case), each shell the driver reported that is still the process it reported (by its
 *  start), and every descendant of either. Windows keeps an ended parent's pid in its children and gives that pid to a
 *  later process: a child is one only when it started after its parent. */
export function windowsThrowaway(table: readonly WindowsProcess[], root: string, shells: ReadonlyMap<number, string> = new Map()): WindowsProcess[] {
  const name = win32.basename(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = new RegExp(`[\\\\/]${name}(?=[\\\\/"\\s]|$)`, 'i')
  const doomed = new Set(table.filter(({ pid, command, started }) => names.test(command) || shells.get(pid) === started))
  for (const parent of doomed) {
    for (const row of table) if (row.ppid === parent.pid && row.pid !== parent.pid && BigInt(row.started) >= BigInt(parent.started)) doomed.add(row)
  }
  return [...doomed]
}

/** The throwaway's processes still running. */
export function throwawayProcesses(root: string): number[] {
  return WINDOWS ? windowsThrowaway(windowsProcesses(), root).map(({ pid }) => pid) : carrying(processes(), root)
}

/** Whether a VS Code other than the throwaway runs, by its process's name alone: the developer's own writes its
 *  preferences too, so a change seen while it runs may be its own. */
export function vscodeOutside(root: string): string {
  const own = new Set(throwawayProcesses(root))
  const found = spawnSync('/usr/bin/pgrep', ['-x', 'Code'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  return found.some((pid) => !own.has(Number(pid)))
    ? 'a VS Code (Code) outside the gate\'s root is running'
    : 'no VS Code (Code) outside the gate\'s root is running'
}

/** When the process started, as `ps` says, or on Windows its FILETIME: with its pid, it tells it from a later process
 *  given the same pid. Never synchronous: the gate's devices listener runs in its process, and a PowerShell takes over a
 *  second to start on the VM, past the extension's 2 s for a stream's head (4 streams for 1, 2026-11-20). */
export async function startedAt(pid: number): Promise<string | undefined> {
  if (WINDOWS) {
    const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToFileTimeUtc() }`
    return (await promisify(execFile)(POWERSHELL, powershellArgs(script), POWERSHELL_OPTIONS)).stdout.trim() || undefined
  }
  try {
    return (await promisify(execFile)('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })).stdout.trim()
  } catch {
    // No such process.
    return undefined
  }
}

/** SIGKILLs what the throwaway still runs, SIGKILL as a VS Code that will not quit may pass over SIGTERM: each process
 *  that carries the root's name, each shell the driver reported that is still the process it reported (by its start),
 *  and every descendant of either, which may carry no name. Returns the processes' names, never their arguments, which
 *  hold paths. */
export async function killThrowaway(root: string, shells: ReadonlyMap<number, string> = new Map()): Promise<string[]> {
  if (WINDOWS) {
    const doomed = windowsThrowaway(windowsProcesses(), root, shells)
    kill(doomed.map(({ pid }) => pid))
    return [...new Set(doomed.map(({ name }) => name))].sort()
  }
  const table = processes()
  const doomed = new Set(carrying(table, root))
  for (const [pid, started] of shells) if (await startedAt(pid) === started) doomed.add(pid)
  // Every descendant before any kill: a killed parent's children go to launchd, and out of reach.
  for (const parent of doomed) for (const { pid, ppid } of table) if (ppid === parent) doomed.add(pid)
  if (doomed.size === 0) return []
  const names = spawnSync('/bin/ps', ['-o', 'comm=', '-p', [...doomed].join(',')], { encoding: 'utf8' }).stdout
  kill(doomed)
  return [...new Set(names.split('\n').filter(Boolean).map((name) => basename(name.trim())))].sort()
}

/** On Windows, TerminateProcess. */
function kill(pids: Iterable<number>): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
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
export async function sweepLeftovers(tmp = GATE_TMP): Promise<string[]> {
  const cleared: string[] = []
  for (const entry of readdirSync(tmp, { withFileTypes: true })) {
    const pid = ROOT.exec(entry.name)?.[1]
    if (!entry.isDirectory() || pid === undefined || running(Number(pid))) continue
    const root = join(tmp, entry.name)
    // Windows' temp folder is the account's own, and gives no owner's uid.
    if (!WINDOWS && statSync(root).uid !== userInfo().uid) continue
    await killThrowaway(root)
    if (process.platform === 'darwin') unregister(root)
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

/** Throws if the file is not as `before` found it. It says how, never what the file holds, and names the file from ~:
 *  the home's path holds the account's name. */
export function assertUnchanged(path: string, before: Stamp): void {
  const after = stamp(path)
  if (isDeepStrictEqual(before, after)) return
  const how = before === null ? 'made' : after === null ? 'removed' : 'rewritten or touched'
  const home = userInfo().homedir
  const named = path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
  throw new Error(`the developer's VS Code's preferences changed while the throwaway VS Code ran: ${named} was ${how}`)
}
