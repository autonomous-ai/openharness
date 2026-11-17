/**
 * Harness's VS Code extension (plugins/harness-device-vscode): whether it is on, and turning it on or off through VS
 * Code's own CLI (`code --install-extension`, `--uninstall-extension`), for VS Code's default profile. Harness never
 * writes VS Code's files itself: it reads VS Code's record of its extensions, and hands VS Code a `.vsix` packed here from
 * the extension cli.js carries. It runs in the `harness` command's own process (`harness device vscode …`) and in the
 * devices' process, which brings an installed extension current; never in the core's.
 */
import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { writeZip } from '../lib/zipWriter.js'

declare const __VSCODE_EXTENSION__: string | undefined

export const VSCODE_EXTENSION_ID = 'autonomous-ai.harness-device'
export const VSCODE_RUN_MS = 60_000
/** VS Code's record of a person with hundreds of extensions is a few hundred KiB. */
export const VSCODE_RECORD_MAX_BYTES = 8 * 1024 * 1024
export type VscodeStatus = { vscode: 'absent' } | { vscode: 'off' } | { vscode: 'on'; version: string }
export type VscodeFailure = 'no-code' | 'timeout' | 'failed'
export type VscodeChange = VscodeStatus | (VscodeStatus & { error: VscodeFailure })
/** The extension as cli.js carries it: its package.json's text and its one bundled file. */
export interface VscodeExtensionFiles { manifest: string; main: string }
export interface VscodeExtensionDeps {
  platform: NodeJS.Platform
  home: string
  /** PATH, where Linux has `code`. */
  pathVar: string
  exists(path: string): boolean
  /** A regular file this account may run. */
  executable(path: string): boolean
  /** A file's text; null when it is missing, larger than `maxBytes` or cannot be read. */
  read(path: string, maxBytes: number): string | null
  /** VS Code's own CLI, with no shell. `code` is null when it was killed or could not start. */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }>
  /** Null in a run from the sources, which carries no built extension. */
  files(): VscodeExtensionFiles | null
  /** A new folder only this account can read. */
  tempDir(): string
  /** Written for this account alone (0600). */
  write(path: string, data: Buffer): void
  /** A folder and all in it; never throws. */
  remove(path: string): void
}

const APP = 'Visual Studio Code.app'
const VSIX = 'harness-device.vsix'
/** What a version in VS Code's record may be before it is printed or compared: no path, no markup, no line. */
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/
const FAILED = { vscode: 'off', error: 'failed' } as const

/** Where VS Code is: its app on a Mac, its `code` on Linux; null when it is not there and on any other platform. A
 *  relative PATH folder is wherever Harness happens to run, so only absolute ones are looked in. */
function installed(deps: VscodeExtensionDeps): string | null {
  if (deps.platform === 'darwin') return [join('/Applications', APP), join(deps.home, 'Applications', APP)].find((path) => deps.exists(path)) ?? null
  if (deps.platform === 'linux') {
    return deps.pathVar.split(delimiter).filter((dir) => isAbsolute(dir)).map((dir) => join(dir, 'code')).find((path) => deps.executable(path)) ?? null
  }
  return null
}

/** VS Code's own CLI: the one inside the app on a Mac, which a person may never have put on PATH. */
function vscodeCli(deps: VscodeExtensionDeps): string | null {
  const found = installed(deps)
  if (found === null || deps.platform !== 'darwin') return found
  const cli = join(found, 'Contents', 'Resources', 'app', 'bin', 'code')
  return deps.exists(cli) ? cli : null
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

/** VS Code rewrites its record whenever an extension changes: a read cut short, too large or not an array is `off`. */
export function vscodeStatus(deps: VscodeExtensionDeps): VscodeStatus {
  if (installed(deps) === null) return { vscode: 'absent' }
  const text = deps.read(join(deps.home, '.vscode', 'extensions', 'extensions.json'), VSCODE_RECORD_MAX_BYTES)
  const version = text === null ? undefined : recordVersion(text)
  return version === undefined ? { vscode: 'off' } : { vscode: 'on', version }
}

/** A failure answers `off` whatever was installed before: what the caller needs is that this build's is not on. */
export async function vscodeEnable(deps: VscodeExtensionDeps): Promise<VscodeChange> {
  const cli = vscodeCli(deps)
  if (cli === null) return { vscode: 'off', error: 'no-code' }
  const files = deps.files()
  if (files === null) return FAILED
  let folder: string | undefined
  try {
    folder = deps.tempDir()
    const vsix = join(folder, VSIX)
    deps.write(vsix, packVsix(files))
    // --force: the same version again, or an older one, is installed as asked rather than refused.
    const ran = await deps.run(cli, ['--install-extension', vsix, '--force'], VSCODE_RUN_MS)
    if (ran.timedOut) return { vscode: 'off', error: 'timeout' }
    if (ran.code !== 0) return FAILED
  } catch {
    return FAILED
  } finally {
    if (folder !== undefined) deps.remove(folder)
  }
  const status = vscodeStatus(deps)
  return status.vscode === 'on' ? status : FAILED
}

export async function vscodeDisable(deps: VscodeExtensionDeps): Promise<VscodeChange> {
  const before = vscodeStatus(deps)
  if (before.vscode !== 'on') return before
  const cli = vscodeCli(deps)
  let failure: VscodeFailure = 'no-code'
  if (cli !== null) {
    const ran = await deps.run(cli, ['--uninstall-extension', VSCODE_EXTENSION_ID], VSCODE_RUN_MS)
    failure = ran.timedOut ? 'timeout' : 'failed'
  }
  const after = vscodeStatus(deps)
  return after.vscode === 'on' ? { ...after, error: failure } : after
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
 *  `code` that does not end on TERM would hold the menu's click or the devices' update. */
function runFile(file: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    // A process group of its own, and the time kills the group: VS Code's `code` on macOS and Linux is a script that
    // starts Electron as a child and waits for it, so a kill of the script alone would leave the install running.
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* the group ended as its time did */ }
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
export function vscodeExtensionDeps(): VscodeExtensionDeps {
  return {
    platform: process.platform,
    home: homedir(),
    pathVar: process.env.PATH ?? '',
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
    run: runFile,
    files: () => typeof __VSCODE_EXTENSION__ === 'string' ? JSON.parse(__VSCODE_EXTENSION__) as VscodeExtensionFiles : null,
    // mkdtemp makes the folder 0700.
    tempDir: () => mkdtempSync(join(tmpdir(), 'harness-vscode-')),
    write: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
    remove: (path) => {
      try { rmSync(path, { recursive: true, force: true }) } catch { /* left for the system's cleaning of its temporary folder */ }
    },
  }
}
