/**
 * The files `harness uninstall` removes, and how. `~/.harness` holds both the program (bin, runtime, pty, the CLI's
 * bundles) and the person's data (sign-in, this computer's identity, history, settings, hn's state): without
 * --keep-data both go, with it the program only. The desktop app keeps its own state in the same root
 * (`desktop-app-v2`); that is the app's, which its own uninstall removes, and never this command's.
 *
 * mac and Linux delete a running program's files at once. Windows cannot delete the node.exe the CLI runs from, nor a
 * folder a process has open, so there the files go in a cmd.exe that waits for the CLI's process to exit, started
 * through WMI so that it is outside the CLI's job: an SSH session (OpenSSH ends every process of its job at the end of
 * the session, docs/testing/windows-pty-e2e.md F16) or a terminal closing would end it half way. WMI is the only way
 * it starts. A cmd.exe the CLI spawns itself is in libuv's job and ends the moment the CLI exits, before it has removed
 * anything (B5.4 review, on the VM); so when WMI fails the CLI says so and how to finish by hand.
 *
 * This code deletes a person's files, and a wrong path deletes their home. So every plan, however it was made, is
 * checked before anything is removed: its root is a full path to a folder named `.harness` that is not a drive's root,
 * not the home folder nor above it, with no `..`; and every path it names is strictly inside that root. A link (a
 * symlink, or on Windows a junction) is removed as a link and never followed: on the Windows VM `del` given a
 * junction emptied the folder it pointed to (B5.4), so the last step never hands del anything that is a folder.
 */
import { chmodSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runPowershell, type PowershellRun } from '../windows/powershell.js'

export interface RootEntry { name: string; dir: boolean; link?: true }
export interface RemovalTarget { path: string; dir: boolean; link?: true }
export interface RemovalPlan { root: string; remove: RemovalTarget[]; kept: string[]; removeRoot: boolean }

/** The desktop app's own state in the product root. */
export const DESKTOP_STATE = /^desktop-app/
/** The program, as --keep-data reads the root: the rest of it is the person's data. */
export const PROGRAM = new Set(['bin', 'runtime', 'pty'])
/** The only folder name a removal root may have. */
export const ROOT_NAME = '.harness'
/**
 * `harness uninstall` at work, in the root: while it is there (and fresh) the desktop app does not start the daemon
 * again (desktop/lib/core/uninstall_marker.dart), which would hold the files being removed and undo the uninstall. It
 * is in no plan: it goes after every other path (removeNow, finalRemovalScript), and before the root, whatever
 * --keep-data keeps. Its text is the time it was written, in seconds: one that outlived an uninstall killed half way
 * stops counting on its own.
 */
export const UNINSTALL_MARKER = 'uninstalling'

export interface PlanInput {
  platform: NodeJS.Platform
  root: string
  entries: readonly RootEntry[]
  cliDir: string
  cliEntries: readonly RootEntry[]
  dataDir: string
  keepData: boolean
  /** The person's home, which the root must not be nor hold. This computer's when the platform is this one. */
  home?: string
}

/** A plan that would remove what it must not: nothing has been removed. */
export class RemovalRefused extends Error {
  override name = 'RemovalRefused'
}

function refuse(path: string, why: string): never {
  throw new RemovalRefused(`Harness will not remove "${path}": ${why}.`)
}

const pathsFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)
/** Windows paths are the same path in any case. */
const same = (platform: NodeJS.Platform, a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
const defaultHome = (platform: NodeJS.Platform) => (platform === process.platform ? homedir() : undefined)
const segments = (platform: NodeJS.Platform, path: string) => path.split(platform === 'win32' ? /[\\/]+/ : /\/+/)
/** `..`, and on Windows `...` and the like, which Windows reads as a way up as well. */
const goesUp = (platform: NodeJS.Platform, segment: string) => segment === '..' || (platform === 'win32' && /^\.{2,}$/.test(segment))

/** [child] strictly inside [parent], lexically. */
function inside(platform: NodeJS.Platform, parent: string, child: string): boolean {
  const p = pathsFor(platform)
  const rel = p.relative(parent, child)
  return rel !== '' && !p.isAbsolute(rel) && !goesUp(platform, segments(platform, rel)[0])
}

/** A full path, and one that a cmd.exe script can carry between double quotes. */
function checkPathText(platform: NodeJS.Platform, path: string): void {
  if (typeof path !== 'string' || path.trim() === '') refuse(String(path ?? ''), 'the path is empty')
  if (/[\u0000-\u001f\u007f]/.test(path)) refuse(path, 'the path holds a control character')
  if (platform === 'win32') {
    if (/[*?"<>|]/.test(path) || path.indexOf(':', 2) !== -1) refuse(path, 'the path holds a character a Windows path cannot have')
    // A drive and a separator, or \\server\share. Not \Users (the current drive's), C:Users (relative) or \\?\ and \\.\.
    if (!/^[A-Za-z]:[\\/]/.test(path) && !/^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(path)) refuse(path, 'it is not a full path')
  } else if (!path.startsWith('/')) {
    refuse(path, 'it is not a full path')
  }
  if (segments(platform, path).some((s) => goesUp(platform, s))) refuse(path, 'the path goes up a folder with ..')
}

/** [path] normalized, without a trailing separator unless it is its own root. */
function normalized(platform: NodeJS.Platform, path: string): string {
  const p = pathsFor(platform)
  let n = p.normalize(path)
  const top = p.parse(n).root
  while (n.length > top.length && /[\\/]$/.test(n) && (platform === 'win32' || n.endsWith('/'))) n = n.slice(0, -1)
  return n
}

/** The root, checked and normalized: a folder named .harness that is not a drive's root, nor home or above it. */
export function checkRoot(platform: NodeJS.Platform, root: string, home?: string): string {
  checkPathText(platform, root)
  const p = pathsFor(platform)
  const n = normalized(platform, root)
  if (same(platform, n, p.parse(n).root) || p.basename(n) === '') refuse(root, 'it is the root of a drive')
  if (!same(platform, p.basename(n), ROOT_NAME)) refuse(root, `it is not a folder named ${ROOT_NAME}`)
  if (home !== undefined && home !== '') {
    const h = normalized(platform, home)
    if (same(platform, h, n)) refuse(root, 'it is your home folder')
    if (inside(platform, n, h)) refuse(root, 'your home folder is inside it')
  }
  return n
}

/** A name read from a folder, which joined to that folder stays inside it. */
function checkName(platform: NodeJS.Platform, dir: string, name: string): void {
  const bad = !name || name === '.' || name === '..' || /[/\u0000]/.test(name)
    || (platform === 'win32' && (/[\\:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)))
  if (bad) refuse(`${dir}${platform === 'win32' ? '\\' : '/'}${name}`, 'its name could reach outside the folder')
}

/** Every path of [plan] strictly inside its root, and the root a .harness of its own. Returns the normalized root. */
export function checkPlan(platform: NodeJS.Platform, plan: RemovalPlan, home?: string): string {
  const root = checkRoot(platform, plan.root, home)
  const p = pathsFor(platform)
  for (const target of plan.remove) {
    checkPathText(platform, target.path)
    if (!inside(platform, root, normalized(platform, target.path))) refuse(target.path, `it is not inside ${root}`)
    for (const segment of segments(platform, p.relative(root, target.path))) checkName(platform, root, segment)
  }
  return root
}

export function removalPlan(o: PlanInput): RemovalPlan {
  const p = pathsFor(o.platform)
  const home = o.home ?? defaultHome(o.platform)
  checkRoot(o.platform, o.root, home)
  for (const entry of o.entries) checkName(o.platform, o.root, entry.name)
  o = { ...o, entries: o.entries.filter((e) => e.name !== UNINSTALL_MARKER) }
  const at = (dir: string) => (entry: RootEntry): RemovalTarget => ({ path: p.join(dir, entry.name), dir: entry.dir, ...(entry.link ? { link: true as const } : {}) })
  const done = (plan: RemovalPlan): RemovalPlan => { checkPlan(o.platform, plan, home); return plan }
  if (!o.keepData) {
    const kept = o.entries.filter((e) => DESKTOP_STATE.test(e.name)).map((e) => e.name)
    return done({ root: o.root, remove: o.entries.filter((e) => !DESKTOP_STATE.test(e.name)).map(at(o.root)), kept, removeRoot: kept.length === 0 })
  }
  // The CLI's folder is the program's only when it is the root's own `cli` (ADAPTER_CLI_DIR can name another), and
  // only when that `cli` is a folder: a link's far side is not this root's to empty.
  const cliLink = o.entries.some((e) => e.name === 'cli' && e.link)
  const cliHere = !cliLink && same(o.platform, p.resolve(o.cliDir), p.resolve(o.root, 'cli'))
  if (cliHere) for (const entry of o.cliEntries) checkName(o.platform, o.cliDir, entry.name)
  // Data is kept whatever holds it: the data folder itself, a folder it is inside, anything inside it.
  const data = p.resolve(o.dataDir)
  const touchesData = (path: string) => same(o.platform, path, data) || inside(o.platform, path, data) || inside(o.platform, data, path)
  const rootGoes = (e: RootEntry) => PROGRAM.has(e.name) && !touchesData(p.resolve(o.root, e.name))
  const cliGoes = (e: RootEntry) => cliHere && !touchesData(p.resolve(o.cliDir, e.name))
  return done({
    root: o.root,
    remove: [...o.entries.filter(rootGoes).map(at(o.root)), ...o.cliEntries.filter(cliGoes).map(at(o.cliDir))],
    kept: [
      ...o.entries.filter((e) => !rootGoes(e) && !(cliHere && e.name === 'cli')).map((e) => e.name),
      ...(cliHere ? o.cliEntries.filter((e) => !cliGoes(e)).map((e) => p.join('cli', e.name)) : []),
    ],
    removeRoot: false,
  })
}

/** Every entry of [dir]; none when it is missing. A link is not a folder: removing it removes the link. */
export function listEntries(dir: string): RootEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, dir: entry.isDirectory(), ...(entry.isSymbolicLink() ? { link: true as const } : {}) }))
  } catch { return [] }
}

/** [path] is a symlink, or on Windows a junction (Node reports both as links: checked on the VM, B5.4). */
export function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

const present = (path: string): boolean => { try { lstatSync(path); return true } catch { return false } }

/** The folders between [root] and [path], outermost first. */
function between(platform: NodeJS.Platform, root: string, path: string): string[] {
  const p = pathsFor(platform)
  const parts = segments(platform, p.relative(root, path)).slice(0, -1)
  return parts.map((_, i) => p.join(root, ...parts.slice(0, i + 1)))
}

/** The link itself: unlink takes a symlink, and on Windows a junction too; rmdir is for a folder link it would not. */
function removeLink(path: string): void {
  try { unlinkSync(path) } catch { rmdirSync(path) }
}

/**
 * Every check a plan must pass before anything is removed, as removeNow and scheduleFinalRemoval make them: its paths
 * (checkPlan), its root not a link, and, given the temp folder the last step runs from, that folder not in the root.
 * `harness uninstall` runs it before it asks or stops anything, so a root it would refuse at the end is refused while
 * nothing has been done yet (B5.9 review, I1). Returns the normalized root.
 */
export function checkRemovable(plan: RemovalPlan, o: { platform?: NodeJS.Platform; home?: string; tempDir?: string } = {}): string {
  const platform = o.platform ?? process.platform
  const root = checkPlan(platform, plan, o.home ?? defaultHome(platform))
  if (o.tempDir !== undefined) {
    // The script and its log must outlive the removal, and the script must not remove the folder it runs from.
    const temp = normalized(platform, o.tempDir)
    if (same(platform, temp, root) || inside(platform, root, temp)) refuse(plan.root, `the temp folder ${o.tempDir} is inside it`)
  }
  if (isLink(root)) refuse(plan.root, 'it is a link to another folder')
  return root
}

/**
 * Every folder in [dir], itself first, opened up for its owner (read, write, search) before it is listed: a 0o000 or
 * 0o300 folder could not be listed otherwise. A link is never followed: its far side keeps its mode. One folder that
 * still fails is left as it is (removeNow reports what stayed), and the others go on.
 */
function writable(dir: string): void {
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) return
    if ((stat.mode & 0o700) !== 0o700) chmodSync(dir, (stat.mode & 0o7777) | 0o700)
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(posix.join(dir, entry.name))
  } catch { /* this folder stays; removeNow says so */ }
}

/** mac and Linux: the plan, carried out now. Returns what is still there. Throws, removing nothing, on a bad plan. */
export function removeNow(plan: RemovalPlan, o: { platform?: NodeJS.Platform; home?: string } = {}): string[] {
  const platform = o.platform ?? process.platform
  const root = checkRemovable(plan, o)
  for (const target of plan.remove) {
    // A folder on the way that has become a link would take the removal outside the root: leave the target.
    if (between(platform, root, target.path).some(isLink)) continue
    try {
      if (isLink(target.path)) removeLink(target.path)
      else rmSync(target.path, { recursive: true, force: true })
    } catch {
      // A read-only folder keeps its entries: the managed grid installs runtime/grid-<v>-<platform>/bin as 0555, and
      // the uninstall left ~/.harness/runtime on macOS (task B5.14). Its folders are made writable, then it goes.
      try { if (!isLink(target.path)) { writable(target.path); rmSync(target.path, { recursive: true, force: true }) } } catch { /* reported below */ }
    }
  }
  // Last of all but the root, so the desktop app starts no daemon while anything else is still going. A folder of that
  // name is not the marker: rmSync without recursive leaves it, and the root with it.
  try { rmSync(pathsFor(platform).join(root, UNINSTALL_MARKER), { force: true }) } catch { /* the marker is only believed while fresh */ }
  // The root only once empty, never with something the plan did not name (an entry that arrived since).
  if (plan.removeRoot) { try { rmdirSync(plan.root) } catch { /* reported below */ } }
  return [...plan.remove.map((t) => t.path), ...(plan.removeRoot ? [plan.root] : [])].filter(present)
}

/** How long the script waits for the CLI to exit (one try a second), and how often it tries a path that is busy. */
export const WAIT_TRIES = 120
export const REMOVE_PASSES = 10

/** A path inside double quotes in a batch file: cmd expands % even there. checkPathText has kept quotes out. */
const quoted = (path: string): string => `"${path.replace(/%/g, '%%')}"`
/** A path as `echo` prints it: % doubled and cmd's operators escaped. */
const echoed = (path: string): string => path.replace(/%/g, '%%').replace(/[\^&|<>()]/g, (c) => `^${c}`)

/**
 * The cmd.exe script of the last step: wait for [pid] (the CLI) to exit, then remove each path, retrying a busy one
 * (an antivirus scan, a process still letting go) a few times, list what stayed in [log], and delete itself.
 * Every tool by its full path; `(goto) 2>nul & del` deletes the script without cmd reading it again afterwards.
 *
 * Paths are data here: each checked (a full path, no quote, no control character, inside the root) and written
 * between double quotes with % doubled, under DisableDelayedExpansion so that a `!` is only a `!`. Before removing it
 * looks again: a root, or a folder in it, that has become a link since the plan sends it to its log, removing nothing.
 */
export function finalRemovalScript(o: { pid: number; plan: RemovalPlan; log: string; systemRoot: string; home?: string }): string {
  if (!Number.isSafeInteger(o.pid) || o.pid <= 0) refuse(o.plan.root, `the process to wait for (${o.pid}) is not a process id`)
  const root = checkPlan('win32', o.plan, o.home ?? defaultHome('win32'))
  checkPathText('win32', o.log)
  checkPathText('win32', o.systemRoot)
  const tool = (name: string) => quoted(win32.join(o.systemRoot, 'System32', name))
  const rootTarget = o.plan.removeRoot ? [{ path: o.plan.root, dir: true, root: true }] : []
  const targets = [...o.plan.remove, ...rootTarget]
  const marker = win32.join(root, UNINSTALL_MARKER)
  const guarded = [root, ...new Set(o.plan.remove.flatMap((t) => between('win32', root, t.path)))]
  const remove = (t: { path: string; dir: boolean; root?: boolean }): string[] => {
    if (t.root) return [`rmdir ${quoted(t.path)} 2>nul`]
    if (t.dir) return [`rmdir /s /q ${quoted(t.path)} 2>nul`]
    // A file, or a link: rmdir takes a folder link (never what is in it), and del only what is not a folder, since
    // del given a junction deletes the files of the folder it points to.
    return [`rmdir ${quoted(t.path)} 2>nul`, `if not exist ${quoted(`${t.path}\\*`)} del /f /q ${quoted(t.path)} 2>nul`]
  }
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `${tool('chcp.com')} 65001 >nul`,
    'set tries=0',
    ':wait',
    `${tool('tasklist.exe')} /FI "PID eq ${o.pid}" /NH 2>nul | ${tool('find.exe')} " ${o.pid} " >nul`,
    'if errorlevel 1 goto remove',
    'set /a tries+=1',
    `if %tries% GEQ ${WAIT_TRIES} goto remove`,
    `${tool('PING.EXE')} -n 2 127.0.0.1 >nul`,
    'goto wait',
    ':remove',
    // %~a of a reparse point (a junction, a symlink) has an l; attr starts as - so it is set when the path is gone.
    ...guarded.flatMap((dir) => ['set "attr=-"', `for %%A in (${quoted(dir)}) do set "attr=-%%~aA"`, 'if not "%attr%"=="%attr:l=%" goto refused']),
    'set pass=0',
    ':again',
    ...o.plan.remove.flatMap(remove),
    // `if exist` follows a link: a link whose far side is gone reads as removed even when it is still there, and is
    // neither retried nor listed in the log. Accepted (B5.4 review): what stays is a dangling link inside the root,
    // which points nowhere and which a later uninstall or a person deleting the folder takes.
    'set left=0',
    ...o.plan.remove.map((t) => `if exist ${quoted(t.path)} set left=1`),
    'if %left%==0 goto last',
    'set /a pass+=1',
    `if %pass% GEQ ${REMOVE_PASSES} goto last`,
    `${tool('PING.EXE')} -n 3 127.0.0.1 >nul`,
    'goto again',
    // The uninstall marker once every other path is gone or has had its last try: until then the desktop app starts
    // no daemon, which would hold what is still being removed. Then the root, which the marker kept from being empty.
    ':last',
    // `del` only when it is not a folder (a junction of that name is not the marker), as for any file.
    `if not exist ${quoted(`${marker}\\*`)} del /f /q ${quoted(marker)} 2>nul`,
    ...rootTarget.flatMap(remove),
    'set left=0',
    ...targets.map((t) => `if exist ${quoted(t.path)} set left=1`),
    'if %left%==0 goto done',
    `>${quoted(o.log)} echo Harness could not remove these after harness uninstall (a program still had them open):`,
    ...targets.map((t) => `if exist ${quoted(t.path)} >>${quoted(o.log)} echo ${echoed(t.path)}`),
    'goto done',
    // Nothing is removed, the marker neither: it would be removed through the link. It stops counting on its own.
    ':refused',
    `>${quoted(o.log)} echo Harness did not remove ${echoed(root)} because it, or a folder in it, has become a link to another folder.`,
    ':done',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n')
}

export interface FinalRemovalDeps {
  pid: number
  tempDir: string
  systemRoot: string
  now(): number
  write(path: string, text: string): void
  remove(path: string): void
  powershell: PowershellRun
}

/**
 * The last step started; or not, and then [reason] says why and [manual] what the person does instead, both sentences
 * to print as they are (B5.5). [detail] is for a bug report.
 */
export type FinalRemoval =
  | { ok: true; script: string; log: string }
  | { ok: false; reason: string; manual: string; detail: string }

/**
 * What the person deletes by hand: the root when the plan takes all of it, else the plan's paths, which never hold data
 * that is kept. Once the command has finished, not once the window is closed: the files are free as soon as this
 * command's node.exe has exited, and the terminal holds none of them (uninstall refuses to run from inside the root).
 */
export function manualRemoval(plan: RemovalPlan): string {
  if (plan.removeRoot) return `When this command has finished, delete ${plan.root} yourself.`
  return `When this command has finished, delete these yourself:${plan.remove.map((t) => `\n  ${t.path}`).join('')}`
}

/**
 * Starts the last step through WMI (Win32_Process.Create), hidden, outside this process's job, with
 * `cmd.exe /d /v:off /c .\<script>` run from the temp folder. cmd.exe gets the script's name only: cmd /c expands a
 * %VAR% in its command line, so a full path such as C:\Users\a%OS%b\AppData\Local\Temp\… would be run as another. The
 * name is digits and dashes. /v:off keeps a `!` a `!` even where the registry turns delayed expansion on for every cmd;
 * /d skips the AutoRun commands the registry may give every cmd.
 */
const START_OUTSIDE_JOB = String.raw`$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$command = '"' + $env:HARNESS_CMD + '" /d /v:off /c .\' + $env:HARNESS_UNINSTALL_SCRIPT
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $env:HARNESS_UNINSTALL_CWD; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { [Console]::Error.Write("Win32_Process.Create returned $($result.ReturnValue)"); exit 3 }`

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Writes and starts the last step. Throws, writing and starting nothing, on a plan finalRemovalScript refuses. When it
 * cannot start, it removes the script it wrote: the temp folder is left as it was.
 */
export function scheduleFinalRemoval(plan: RemovalPlan, deps: FinalRemovalDeps): FinalRemoval {
  const stamp = `${deps.pid}-${deps.now()}`
  const name = `harness-uninstall-${stamp}.cmd`
  const script = win32.join(deps.tempDir, name)
  const log = win32.join(deps.tempDir, `harness-uninstall-${stamp}.log`)
  checkPathText('win32', script)
  const text = finalRemovalScript({ pid: deps.pid, plan, log, systemRoot: deps.systemRoot })
  checkRemovable(plan, { platform: 'win32', tempDir: deps.tempDir })
  const manual = manualRemoval(plan)
  try { deps.write(script, text) } catch (error) {
    return { ok: false, reason: 'Harness could not save the step that removes its files once this command has ended.', manual, detail: `could not write ${script}: ${message(error)}` }
  }
  const cmd = win32.join(deps.systemRoot, 'System32', 'cmd.exe')
  const started = deps.powershell(START_OUTSIDE_JOB, { HARNESS_CMD: cmd, HARNESS_UNINSTALL_SCRIPT: name, HARNESS_UNINSTALL_CWD: deps.tempDir })
  if (!started.error && started.status === 0) return { ok: true, script, log }
  try { deps.remove(script) } catch { /* a script left in the temp folder does nothing on its own */ }
  const detail = started.error ? message(started.error) : (started.stderr.trim() || `PowerShell exited with ${started.status}`)
  return { ok: false, reason: 'Windows did not start the step that removes Harness\'s files once this command has ended.', manual: wmiRefused(detail) ? overSsh(plan) : manual, detail }
}

/**
 * WMI's refusal (Access denied, 0x80041003): what it answers a standard user whose logon is a network logon, as an SSH
 * session is. Seen on the VM for a fresh standard user over SSH (task-B3.21 finding F1, B5.12); at the desktop the same
 * user starts the step.
 */
const wmiRefused = (detail: string): boolean => /access (is )?denied|0x80041003/i.test(detail)

/** The manual line when WMI refused: why, the way that works, and what to delete otherwise. */
function overSsh(plan: RemovalPlan): string {
  const why = 'Windows refused to start it, as it does for a standard user signed in over SSH; run harness uninstall at the desktop, or'
  return plan.removeRoot ? `${why} delete ${plan.root} yourself.` : `${why} delete these yourself:${plan.remove.map((t) => `\n  ${t.path}`).join('')}`
}

/** This computer's. */
export function finalRemovalDeps(): FinalRemovalDeps {
  return {
    pid: process.pid,
    tempDir: tmpdir(),
    systemRoot: process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
    now: () => Date.now(),
    write: (path, text) => writeFileSync(path, text, 'utf8'),
    remove: (path) => rmSync(path, { force: true }),
    powershell: runPowershell,
  }
}
