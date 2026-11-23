/**
 * The account's AppData folders on Windows, as Explorer's own keys name them, which the connections upload fence refuses
 * a file in (../connectors/call.ts). Not from `APPDATA` and `LOCALAPPDATA`: whoever runs the command sets those, and can
 * unset them, while a Group Policy or the person's own move puts AppData where only the registry says.
 *
 * One hidden `cmd.exe` run reads every key:
 * - `cmd.exe`, `chcp.com` and `reg.exe` by their full paths in Windows' own folder, which is asked of the file system
 *   (`systemProgram`, ./powershell.ts): a `reg` earlier on `PATH`, a `ComSpec` or a `SystemRoot` is the caller's.
 * - `chcp.com 65001` first: `reg.exe` prints to a pipe in the console's code page, which lacks most letters, so a folder
 *   named outside ASCII would come out misspelled (`userPathValue` in ../../scripts/installPs1.spec.ts met it).
 * - `/d`: the registry may give every `cmd.exe` AutoRun commands, which are not this run's.
 *
 * A read that fails refuses no upload (UX first, docs/plans/2026-11-18-connectors-fence-followup-design.md): the AppData
 * under each home stays fenced, and one line says what failed.
 */
import { isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { systemProgram, systemRoot } from './powershell.js'

/** As long as `readUserEnvironment` gives `reg query` (../serviceCommand.ts). */
export const KNOWN_FOLDERS_TIMEOUT_MS = 3_000
/** Where AppData is now, as a policy or the person set it, `%USERPROFILE%` unexpanded. */
export const USER_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
/** The same expanded, as Explorer last wrote it: it may still name where AppData was. */
export const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'

export interface AppDataFolders { roaming: string[], local: string[] }
/** Its message names what failed, with no path: 'cmd.exe did not start', 'cmd.exe timed out', 'cmd.exe exited <n>', 'reg.exe could not read a key'. */
export class RegFailure extends Error {}
export type RegRun = (file: string, args: string[], options: { env: NodeJS.ProcessEnv, timeout: number, windowsHide: true,
  windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }) => { status: number | null, stdout: Buffer, error?: Error }
/** Each key's values as reg.exe printed them, or why that key could not be read, in the order asked. */
export type RegQuery = (keys: string[]) => (Buffer | RegFailure)[]

/** Echoed after each key's query. No value line can be one: reg.exe indents every value. */
const KEY_READ = 'harness-key-read'
const KEY_FAILED = 'harness-key-failed'
const UNREAD_KEY = 'reg.exe could not read a key'
/** A text value named `AppData` or `Local AppData`, in any case, as reg.exe prints it: four spaces before its data. */
const FOLDER_VALUE = /^ +(AppData|Local AppData) +(?:REG_SZ|REG_EXPAND_SZ) {4}(.*)$/i

/** Every key in one hidden cmd.exe run whose console is UTF-8. Never throws. */
export function regQuery(keys: string[], run: RegRun = spawnSync): (Buffer | RegFailure)[] {
  // `&&` and `||` echo reg.exe's exit as the key's marker. The keys are this module's or a test's: none holds `"`, `%` or `!`.
  const line = [`"${systemProgram('chcp.com')}" 65001 >nul`,
    ...keys.map(key => `("${systemProgram('reg.exe')}" query "${key}" && echo ${KEY_READ} || echo ${KEY_FAILED})`)].join(' & ')
  // The line goes to cmd.exe as written, /s taking its outer quotes off, as ../../engines/kit/windowsInstall.ts passes one.
  // SystemRoot is the folder found here: a Windows program needs it, and Node would copy the caller's in for one missing.
  const result = run(systemProgram('cmd.exe'), ['/d', '/s', '/c', `"${line}"`], {
    env: { SystemRoot: systemRoot() }, timeout: KNOWN_FOLDERS_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'],
  })
  const failure = result.error ? ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'cmd.exe timed out' : 'cmd.exe did not start')
    : result.status !== 0 ? `cmd.exe exited ${result.status}` : undefined
  if (failure !== undefined) return keys.map(() => new RegFailure(failure))
  const answers: (Buffer | RegFailure)[] = []
  let start = 0
  for (let at = 0; at < result.stdout.length && answers.length < keys.length;) {
    const newline = result.stdout.indexOf(0x0a, at)
    const end = newline === -1 ? result.stdout.length : newline
    // cmd.exe's echo keeps the space before `||`, and the line ends in \r.
    const marker = result.stdout.subarray(at, end).toString('latin1').trimEnd()
    if (marker === KEY_READ) answers.push(result.stdout.subarray(start, at))
    if (marker === KEY_FAILED) answers.push(new RegFailure(UNREAD_KEY))
    if (marker === KEY_READ || marker === KEY_FAILED) start = end + 1
    at = end + 1
  }
  return [...answers, ...keys.slice(answers.length).map(() => new RegFailure(UNREAD_KEY))]
}

/** `AppData` and `Local AppData` in one key's output, as written; `unreadable` when reg.exe could not spell one of them. */
export function folderValues(stdout: Buffer): { roaming?: string, local?: string, unreadable: { roaming: boolean, local: boolean } } {
  const values: ReturnType<typeof folderValues> = { unreadable: { roaming: false, local: false } }
  // As latin1, one character a byte, so the data's own bytes can be taken back. reg.exe's messages, in the system's
  // language, match nothing.
  for (const line of stdout.toString('latin1').split(/\r?\n/)) {
    const match = FOLDER_VALUE.exec(line)
    if (!match) continue
    const kind = match[1]!.toLowerCase() === 'appdata' ? 'roaming' : 'local'
    const data = Buffer.from(match[2]!, 'latin1')
    // `?` is what reg.exe prints for a letter its code page lacks, and no folder's name holds one: a wrong spelling is
    // never taken for a folder.
    const text = isUtf8(data) ? data.toString('utf8') : '?'
    if (text.includes('?')) values.unreadable[kind] = true
    else values[kind] = text
  }
  return values
}

/** A value with `%USERPROFILE%` as `home`; undefined when it is empty, needs a home there is none of, or holds another variable. */
export function expandFolder(value: string, home: string | undefined): string | undefined {
  const parts = value.split(/%USERPROFILE%/i)
  // A lone `%` is a name's: only `%name%` is a variable.
  if (!value || (parts.length > 1 && home === undefined) || parts.some(part => /%[^%]+%/.test(part))) return undefined
  return parts.join(home)
}

/** Both keys' folders, `User Shell Folders` first, each once; `failure` names the first thing that could not be read. */
export function readAppDataFolders(home: string | undefined, query: RegQuery = regQuery): AppDataFolders & { failure?: string } {
  const answers = query([USER_SHELL_FOLDERS, SHELL_FOLDERS])
  const unread = answers.find(answer => answer instanceof RegFailure)?.message
  const values = answers.map(answer => answer instanceof RegFailure ? undefined : folderValues(answer))
  const folders: AppDataFolders = { roaming: [], local: [] }
  let unspelled = false
  for (const kind of ['roaming', 'local'] as const) {
    // Both keys' folders, each a place AppData is or was: a stale one only fences more.
    const named = values.map(value => { const data = value?.[kind]; return data === undefined ? undefined : expandFolder(data, home) })
    folders[kind] = [...new Set(named.filter(folder => folder !== undefined))]
    // User Shell Folders says where the folder is now: from Shell Folders alone it may be where it was.
    if (named[0] === undefined && values.some(value => value?.unreadable[kind])) unspelled = true
  }
  return { ...folders, failure: unread ?? (unspelled ? 'reg.exe printed a folder it could not spell' : undefined) }
}

let known: AppDataFolders | undefined

/** The same, read once in this process and only on Windows; `failed` hears a failure once, as that read is made. */
export function appDataFolders(home: string | undefined, failed: (failure: string) => void,
  read: (home: string | undefined) => AppDataFolders & { failure?: string } = readAppDataFolders, platform: NodeJS.Platform = process.platform): AppDataFolders {
  // Off Windows there is no registry, and nothing is run.
  if (platform !== 'win32') return { roaming: [], local: [] }
  // Once: a command that uploads several files starts one cmd.exe.
  if (!known) {
    const { failure, ...folders } = read(home)
    known = folders
    if (failure !== undefined) failed(failure)
  }
  return known
}
