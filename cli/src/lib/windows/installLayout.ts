/**
 * The Windows install layout (spec section 1). Every version gets a folder, and pointer files name the one in use.
 * Windows cannot replace a running file, and creating a symlink needs Developer Mode or a privilege.
 *
 *   %USERPROFILE%\.harness\
 *     bin\harness.exe, bin\harness-launch.exe
 *     cli\<version>\cli.js, notify.mjs, package.json
 *     cli\current              the version in use: one line, one folder name
 *     cli\notify.mjs           the stable copy that hook command lines name (B4)
 *     runtime\current-node     node.exe's full path, as on a Mac (managedNodePath)
 *     runtime\pty\current-pty  the pty host's version folder (ptyHost/launch.ts currentPtyVersion)
 *
 * install.ps1 and the updater (B3) write these files. harness.exe (pty/src/command.rs), harness-launch.exe
 * (pty/src/launcher.rs) and the desktop app read them. The pointer readers in Node and in Rust (both programs share
 * launcher::resolve) apply the rules this file applies: one segment, resolved inside its root.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export const CLI_POINTER = 'current'
export const STABLE_NOTIFY = 'notify.mjs'
export const LAUNCH_EXE = 'harness-launch.exe'

/** `<root>\bin\harness-launch.exe`. install.ps1 copies it there from the pty payload. */
export function harnessLaunchPath(rootDir: string): string {
  return join(rootDir, 'bin', LAUNCH_EXE)
}

/**
 * A pointer names one folder beside it. That rules out `.`, any `..`, a separator, and a `:`. A `:` could be a
 * drive (`C:x`) or an NTFS stream (`notify.mjs:x`).
 */
export function isSingleSegment(value: string): boolean {
  return value !== '' && value !== '.' && !value.includes('..') && !/[\\/:\0]/.test(value)
}

/** `<root>\<name>`'s first line, trimmed. Null when it is missing, empty, or names more than one folder. */
export function readPointer(root: string, name: string): string | null {
  let text: string
  try {
    text = readFileSync(join(root, name), 'utf8')
  } catch {
    return null
  }
  const value = (text.split(/\r?\n/, 1)[0] ?? '').trim()
  return isSingleSegment(value) ? value : null
}

/** The two calls [writePointer] makes that tests replace. */
export interface PointerFs {
  rename: (from: string, to: string) => void
  sleep: (ms: number) => void
}

const defaultFs: PointerFs = {
  rename: renameSync,
  // Synchronous on purpose: a pointer write is a few milliseconds, and its callers are synchronous.
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}

/**
 * The codes Windows gives for a moment when an antivirus scan, the search indexer or a reader holds the file.
 * Waiting can fix those, and nothing else.
 */
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES'])
const ATTEMPTS = 5

/**
 * Point `<root>\<name>` at [value] by writing a temporary file and renaming it over the old one. A reader sees
 * either the old pointer or the new one, never half of one. The line ends in CRLF with no BOM: the Rust reader
 * (pty/src/launcher.rs) would keep a BOM as part of the value.
 */
export function writePointer(root: string, name: string, value: string, fs: PointerFs = defaultFs): void {
  if (!isSingleSegment(value)) throw new Error(`a pointer names one folder, not ${JSON.stringify(value)}`)
  const target = join(root, name)
  const temporary = join(root, `.${name}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(temporary, `${value}\r\n`)
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(temporary, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!RETRIED.has(code) || attempt >= ATTEMPTS) {
        rmSync(temporary, { force: true })
        throw error
      }
      fs.sleep(25 * 2 ** (attempt - 1))
    }
  }
}

export interface CurrentCli {
  version: string
  dir: string
  cliJs: string
  notifyMjs: string
}

/**
 * The CLI `cli\current` names: `<root>\cli\<version>\` with its cli.js and notify.mjs. Null when the pointer is
 * missing or bad, when a file is missing, or when a file resolves outside `cli\`. That last case is a junction or
 * symlink planted as a version folder.
 */
export function currentCli(rootDir: string): CurrentCli | null {
  const cliRoot = join(rootDir, 'cli')
  const version = readPointer(cliRoot, CLI_POINTER)
  if (!version) return null
  const dir = join(cliRoot, version)
  const cliJs = join(dir, 'cli.js')
  const notifyMjs = join(dir, STABLE_NOTIFY)
  if (!existsSync(cliJs) || !existsSync(notifyMjs)) return null
  try {
    const inside = realpathSync(cliRoot) + sep
    if (!realpathSync(cliJs).startsWith(inside) || !realpathSync(notifyMjs).startsWith(inside)) return null
  } catch {
    return null
  }
  return { version, dir, cliJs, notifyMjs }
}
