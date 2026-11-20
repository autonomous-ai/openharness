/**
 * Harness's VS Code extension (plugins/harness-device-vscode): whether it is on, and turning it on or off through the
 * editor's own CLI (`code` or `cursor`, `--install-extension`, `--uninstall-extension`), for its default profile, in VS
 * Code or in Cursor, which runs VS Code's extensions. Harness never writes the editor's files itself: it reads the
 * editor's record of its extensions, and hands the editor a `.vsix` packed here from the extension cli.js carries. It
 * runs in the `harness` command's own process (`harness device vscode|cursor …`) and in the devices' process, which sets
 * the extension up once a computer (cable/vscodeExtensionSetup.ts); never in the core's.
 */
import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path'
import { ownProcessGroup } from '../lib/windows/noWindow.js'
import { windowsProgram, type Program } from '../lib/windows/program.js'
import { writeZip } from '../lib/zipWriter.js'

declare const __VSCODE_EXTENSION__: string | undefined

export const VSCODE_EXTENSION_ID = 'autonomous-ai.harness-device'
export const VSCODE_RUN_MS = 60_000
/** VS Code's record of a person with hundreds of extensions is a few hundred KiB. */
export const VSCODE_RECORD_MAX_BYTES = 8 * 1024 * 1024
export type VscodeEditor = 'vscode' | 'cursor'
export type VscodeStatus = { state: 'absent' } | { state: 'off' } | { state: 'on'; version: string }
export type VscodeFailure = 'no-code' | 'timeout' | 'failed'
export type VscodeChange = VscodeStatus | (VscodeStatus & { error: VscodeFailure })
/** The extension as cli.js carries it: its package.json's text and its one bundled file. */
export interface VscodeExtensionFiles { manifest: string; main: string }
export interface VscodeExtensionDeps {
  /** Which editor: its app, its CLI and its record. */
  editor: VscodeEditor
  /** A path through its links; the path itself when it cannot be resolved. */
  real(path: string): string
  platform: NodeJS.Platform
  home: string
  /** PATH, where Linux has `code` or `cursor`, and Windows their `.cmd` launchers. */
  pathVar: string
  /** Windows' `%LOCALAPPDATA%` and `%ProgramFiles%`, where the editors' installers put them. */
  folders?: { localAppData?: string; programFiles?: string }
  exists(path: string): boolean
  /** A regular file this account may run. */
  executable(path: string): boolean
  /** A file's text; null when it is missing, larger than `maxBytes` or cannot be read. */
  read(path: string, maxBytes: number): string | null
  /** The editor's own CLI, with no shell. `code` is null when it was killed or could not start; on Windows, also when
   *  its launcher is not one Harness starts (lib/windows/program.ts). */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }>
  /** Null in a run from the sources, which carries no built extension. */
  files(): VscodeExtensionFiles | null
  /** A new folder only this account can read. */
  tempDir(): string
  /** Written for this account alone (0600). */
  write(path: string, data: Buffer): void
  /** A folder and all in it; never throws. */
  remove(path: string): void
  /** The end-to-end tests' editor, the raw `HARNESS_VSCODE_BIN` or `HARNESS_CURSOR_BIN` (read in services/devices.ts):
   *  an absolute path is the only CLI looked for, so a daemon under test finds none of this computer's own; empty or
   *  relative, the editor is looked for where it is installed. */
  bin?: string
}

/** Each editor's app on a Mac, its CLI (inside the app there, on PATH on Linux) and the folder in the home that holds its
 *  record. Cursor's `shim`, under the home, is cursor-agent's own `cursor` command, which is no editor. On Windows, the
 *  folder of its launcher in `%LOCALAPPDATA%\Programs` (`user`), and in `%ProgramFiles%` (`machine`) for VS Code alone:
 *  no machine-wide Cursor has been seen, so none is guessed (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 1). */
const EDITORS: Record<VscodeEditor, { app: string; cli: string; folder: string; shim?: string; user: string; machine?: string }> = {
  vscode: { app: 'Visual Studio Code.app', cli: 'code', folder: '.vscode', user: 'Microsoft VS Code\\bin', machine: 'Microsoft VS Code\\bin' },
  cursor: { app: 'Cursor.app', cli: 'cursor', folder: '.cursor', shim: join('.local', 'bin', 'cursor'), user: 'cursor\\resources\\app\\bin' },
}
const VSIX = 'harness-device.vsix'
/** What a version in the editor's record may be before it is printed or compared: no path, no markup, no line. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/
const FAILED = { state: 'off', error: 'failed' } as const

/** Where the editor is: its app on a Mac, its CLI on Linux, its `.cmd` launcher on Windows; null when it is not there
 *  and on any other platform. A relative PATH folder is wherever Harness happens to run, so only absolute ones are looked
 *  in. */
function installed(deps: VscodeExtensionDeps): string | null {
  // /Applications is the computer's whatever the home, so a daemon under test is given a CLI of its own instead.
  if (deps.bin && (deps.platform === 'win32' ? win32.isAbsolute : isAbsolute)(deps.bin)) return deps.executable(deps.bin) ? deps.bin : null
  const { app, cli, shim, user, machine } = EDITORS[deps.editor]
  if (deps.platform === 'win32') {
    // The launcher, never the `.exe` or the script it names: the script moves with each update, and each run reads the
    // launcher anew.
    const { localAppData, programFiles } = deps.folders ?? {}
    const folders = [
      ...deps.pathVar.split(win32.delimiter),
      localAppData && win32.join(localAppData, 'Programs', user),
      machine && programFiles && win32.join(programFiles, machine),
    ]
    return folders.filter((dir): dir is string => !!dir && win32.isAbsolute(dir)).map((dir) => win32.join(dir, `${cli}.cmd`))
      .find((path) => deps.executable(path)) ?? null
  }
  if (deps.platform === 'darwin') return [join('/Applications', app), join(deps.home, 'Applications', app)].find((path) => deps.exists(path)) ?? null
  if (deps.platform === 'linux') {
    // Told by its real path: a link on PATH that ends at the shim is the shim too.
    const shimAt = shim === undefined ? undefined : deps.real(join(deps.home, shim))
    return deps.pathVar.split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, cli))
      .find((path) => deps.executable(path) && (shimAt === undefined || deps.real(path) !== shimAt)) ?? null
  }
  return null
}

/** The editor's own CLI: the one inside the app on a Mac, which a person may never have put on PATH; its `.cmd` launcher
 *  on Windows. */
export function editorCli(deps: VscodeExtensionDeps): string | null {
  const found = installed(deps)
  if (found === null || found === deps.bin || deps.platform !== 'darwin') return found
  const cli = join(found, 'Contents', 'Resources', 'app', 'bin', EDITORS[deps.editor].cli)
  return deps.exists(cli) ? cli : null
}

/** The `.desktop` file Cursor's Linux package installs (testing/recordedLinuxApps.ts). */
const CURSOR_DESKTOP = 'cursor.desktop'
/** An app's `.desktop` file is a few KiB. */
const DESKTOP_MAX_BYTES = 64 * 1024
/** Linux's PATH_MAX. */
const EXEC_MAX = 4096

/** The Cursor CLI a tap opens an agent's folder with on Linux (docs/plans/2026-11-19-dial-linux-design.md § 1.6), from
 *  Cursor's deps: the tests' own; else the `bin/cursor` beside the binary Cursor's `.desktop` file starts, where its
 *  package puts its CLI, which no PATH need hold; else the `cursor` on PATH that is not cursor-agent's shim. Null off
 *  Linux, where macOS opens the folder by Cursor's bundle. */
export function cursorFolderCli(deps: VscodeExtensionDeps): string | null {
  if (deps.platform !== 'linux') return null
  if (deps.bin && isAbsolute(deps.bin)) return installed(deps)
  // The person's own entries before the computer's, as the desktop's menu reads them.
  for (const share of [join(deps.home, '.local', 'share'), '/usr/local/share', '/usr/share']) {
    const text = deps.read(join(share, 'applications', CURSOR_DESKTOP), DESKTOP_MAX_BYTES)
    const binary = text?.split('\n').find((line) => line.startsWith('Exec='))?.slice('Exec='.length).trim().split(/\s+/)[0]
    // What the file names decides the file run: only an absolute path, no longer than a path can be, with no control
    // character.
    if (!binary || binary.length > EXEC_MAX || !isAbsolute(binary) || /[\u0000-\u001f\u007f-\u009f]/.test(binary)) continue
    const cli = join(dirname(binary), 'bin', EDITORS.cursor.cli)
    if (deps.executable(cli)) return cli
  }
  return installed(deps)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function recordVersion(text: string): string | undefined {
  let record: unknown
  try { record = JSON.parse(text) } catch { return undefined }
  if (!Array.isArray(record)) return undefined
  for (const entry of record) {
    if (!isRecord(entry) || !isRecord(entry.identifier)) continue
    const { id } = entry.identifier
    const { version } = entry
    // VS Code compares extension ids without case.
    if (typeof id === 'string' && id.toLowerCase() === VSCODE_EXTENSION_ID && typeof version === 'string' && VERSION.test(version)) return version
  }
  return undefined
}

/** The editor rewrites its record whenever an extension changes: a read cut short, too large or not an array is `off`. */
export function vscodeStatus(deps: VscodeExtensionDeps): VscodeStatus {
  if (installed(deps) === null) return { state: 'absent' }
  const at = deps.platform === 'win32' ? win32.join : join
  const text = deps.read(at(deps.home, EDITORS[deps.editor].folder, 'extensions', 'extensions.json'), VSCODE_RECORD_MAX_BYTES)
  const version = text === null ? undefined : recordVersion(text)
  return version === undefined ? { state: 'off' } : { state: 'on', version }
}

/** A failure answers `off` whatever was installed before: what the caller needs is that this build's is not on. */
export async function vscodeEnable(deps: VscodeExtensionDeps): Promise<VscodeChange> {
  // On at this build's version already: an enable that arrives twice installs once.
  const before = vscodeStatus(deps)
  if (before.state === 'on' && before.version === buildVersion(deps)) return before
  const cli = editorCli(deps)
  if (cli === null) return { state: 'off', error: 'no-code' }
  const files = deps.files()
  if (files === null) return FAILED
  let folder: string | undefined
  try {
    folder = deps.tempDir()
    const vsix = join(folder, VSIX)
    deps.write(vsix, packVsix(files))
    // --force: the same version again, or an older one, is installed as asked rather than refused.
    const ran = await deps.run(cli, ['--install-extension', vsix, '--force'], VSCODE_RUN_MS)
    if (ran.timedOut) return { state: 'off', error: 'timeout' }
    if (ran.code !== 0) return FAILED
  } catch {
    return FAILED
  } finally {
    if (folder !== undefined) deps.remove(folder)
  }
  const status = vscodeStatus(deps)
  return status.state === 'on' ? status : FAILED
}

export async function vscodeDisable(deps: VscodeExtensionDeps): Promise<VscodeChange> {
  const before = vscodeStatus(deps)
  if (before.state !== 'on') return before
  const cli = editorCli(deps)
  let failure: VscodeFailure = 'no-code'
  if (cli !== null) {
    const ran = await deps.run(cli, ['--uninstall-extension', VSCODE_EXTENSION_ID], VSCODE_RUN_MS)
    failure = ran.timedOut ? 'timeout' : 'failed'
  }
  const after = vscodeStatus(deps)
  return after.state === 'on' ? { ...after, error: failure } : after
}

/** The manifest's fields the `.vsix`'s own manifest repeats. */
interface Manifest { name: string; version: string; publisher: string; displayName: string; description: string; engines: { vscode: string } }

export function buildVersion(deps: Pick<VscodeExtensionDeps, 'files'>): string | null {
  const files = deps.files()
  return files === null ? null : (JSON.parse(files.manifest) as Manifest).version
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&apos;' })[c]!)
}

/** The `.vsix` `vsce package` would make of the extension: VS Code installs from its `extension/` folder and reads the
 *  two XML files' identity and engine. */
export function packVsix(files: VscodeExtensionFiles): Buffer {
  const m = JSON.parse(files.manifest) as Manifest
  const vsixManifest = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">',
    '  <Metadata>',
    `    <Identity Language="en-US" Id="${xml(m.name)}" Version="${xml(m.version)}" Publisher="${xml(m.publisher)}"/>`,
    `    <DisplayName>${xml(m.displayName)}</DisplayName>`,
    `    <Description xml:space="preserve">${xml(m.description)}</Description>`,
    `    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(m.engines.vscode)}"/></Properties>`,
    '  </Metadata>',
    '  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>',
    '  <Dependencies/>',
    '  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>',
    '</PackageManifest>',
    '',
  ].join('\n')
  const contentTypes = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
    '',
  ].join('\n')
  return writeZip([
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest, 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: 'extension/package.json', data: Buffer.from(files.manifest, 'utf8') },
    { name: 'extension/extension.js', data: Buffer.from(files.main, 'utf8') },
  ])
}

/** At most [maxBytes] of a regular file. The size is the open file's, and no more than it is read: VS Code may be
 *  rewriting the record, and a read cut short is not JSON. */
function readBounded(path: string, maxBytes: number): string | null {
  let fd: number
  try {
    // O_NONBLOCK: a FIFO put where the record was would otherwise hold the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size)
    return buffer.subarray(0, readSync(fd, buffer, 0, stat.size, 0)).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** [file] run with no shell, reading and writing nothing: no output of its is used. Its time ends it with SIGKILL: a
 *  `code` that does not end on TERM would hold the command or the devices' setup. On Windows the launcher is read at
 *  every run for the editor's `.exe` and CLI script, as an update renames the script's folder. */
function runFile(file: string, args: readonly string[], timeoutMs: number, platform: NodeJS.Platform): Promise<{ code: number | null; timedOut: boolean }> {
  let program: Program
  try { program = windowsProgram(file, args, { platform }) } catch { return Promise.resolve({ code: null, timedOut: false }) }
  return new Promise((resolve) => {
    // A process group of its own, and the time kills the group: VS Code's `code` on macOS and Linux is a script that
    // starts Electron as a child and waits for it, so a kill of the script alone would leave the install running.
    const child = spawn(program.file, program.args, { ...ownProcessGroup(platform), stdio: 'ignore', env: program.env })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Windows has no process groups, and none is needed: there the editor's `.exe` runs the CLI script itself.
      try {
        if (platform === 'win32') child.kill('SIGKILL')
        else process.kill(-child.pid!, 'SIGKILL')
      } catch { /* the group ended as its time did */ }
    }, timeoutMs)
    // A file that could not start emits `error` and no `exit`.
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, timedOut: false })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut })
    })
  })
}

/** The real ones. `files` reads what the build inlined. */
export function vscodeExtensionDeps(editor: VscodeEditor, bin?: string): VscodeExtensionDeps {
  const platform = process.platform
  return {
    editor,
    bin,
    real: (path) => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    },
    platform,
    home: homedir(),
    pathVar: process.env.PATH ?? '',
    folders: { localAppData: process.env.LOCALAPPDATA, programFiles: process.env.ProgramFiles },
    exists: existsSync,
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    read: readBounded,
    run: (file, args, timeoutMs) => runFile(file, args, timeoutMs, platform),
    files: () => typeof __VSCODE_EXTENSION__ === 'string' ? JSON.parse(__VSCODE_EXTENSION__) as VscodeExtensionFiles : null,
    // mkdtemp makes the folder 0700.
    tempDir: () => mkdtempSync(join(tmpdir(), 'harness-vscode-')),
    write: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
    remove: (path) => {
      try { rmSync(path, { recursive: true, force: true }) } catch { /* left for the system's cleaning of its temporary folder */ }
    },
  }
}
