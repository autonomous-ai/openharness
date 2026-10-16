/**
 * The CLI's version folders on Windows (spec section 1, "Layout"; section 3, "Self-update and rollback"): each build
 * in `cli\<version>\`, the one in use named by the pointer file `cli\current` (./installLayout.ts), and beside them the
 * stable `cli\notify.mjs` the hooks' command lines name. On a Mac an update swaps files in place by rename and keeps
 * `.prev` hard links to roll back to. Windows cannot replace a file a running process holds, and has no symlinks
 * without Developer Mode, so a build is never touched once written: an update writes a new folder and moves the
 * pointer, a rollback moves it back.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLI_POINTER, STABLE_NOTIFY, writePointer } from './installLayout.js'

/** A build's folder name under cli\: its version, as the release names it (`0.5.0`, `0.5.1-dev.ab12`). Semver's
 *  identifiers, none empty: Windows drops a name's trailing dot, and the pointer refuses `..` (./installLayout.ts). */
export const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const CLI = 'cli.js'
const NOTIFY = 'notify.mjs'
const PACKAGE = 'package.json'
const RUNTIME_PACKAGE = `${JSON.stringify({ type: 'module' })}\n`
/** A hook reads notify.mjs for a moment; Defender scans a new file for longer. */
export const REPLACE_TRIES = 5
export const REPLACE_PAUSE_MS = 100

export function isVersionFolder(cliDir: string, version: string): boolean {
  return VERSION_FOLDER.test(version) && existsSync(join(cliDir, version, CLI)) && existsSync(join(cliDir, version, NOTIFY))
}

/** Every build on disk, in no order. */
export function versionsOnDisk(cliDir: string): string[] {
  try { return readdirSync(cliDir).filter((name) => isVersionFolder(cliDir, name)) } catch { return [] }
}

function sameBytes(file: string, bytes: Buffer): boolean {
  try { return readFileSync(file).equals(bytes) } catch { return false }
}

/**
 * Write [version]'s folder whole: into a folder beside it, renamed into place, so nothing ever runs half a build. One
 * already there with these bytes is kept (a build staged again after a rollback, or by `harness update`); one with
 * other bytes is moved aside, never written into, since a process may be running from it (the retirement removes it,
 * lib/selfUpdate.ts `retireCliVersions`).
 */
export function writeVersionFolder(cliDir: string, version: string, cliBuf: Buffer, notifyBuf: Buffer): string {
  if (!VERSION_FOLDER.test(version)) throw new Error(`not a version a folder can be named after: ${JSON.stringify(version)}`)
  const folder = join(cliDir, version)
  if (sameBytes(join(folder, CLI), cliBuf) && sameBytes(join(folder, NOTIFY), notifyBuf)) return folder
  const temporary = join(cliDir, `.${version}.${process.pid}.tmp`)
  try {
    mkdirSync(cliDir, { recursive: true })
    rmSync(temporary, { recursive: true, force: true })
    mkdirSync(temporary)
    writeFileSync(join(temporary, PACKAGE), RUNTIME_PACKAGE)
    writeFileSync(join(temporary, CLI), cliBuf)
    writeFileSync(join(temporary, NOTIFY), notifyBuf)
    if (existsSync(folder)) renameSync(folder, join(cliDir, `.${version}.${Date.now()}.old`))
    renameSync(temporary, folder)
  } catch (error) {
    try { rmSync(temporary, { recursive: true, force: true }) } catch { /* not this call's to clear */ }
    throw error
  }
  return folder
}

const pause = (ms: number): void => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Replace [file] whole, by a file beside it and a rename, tried again while Windows says it is busy (a hook has it
 *  open, or an antivirus scan). */
export function replaceFile(
  file: string, bytes: Buffer, rename: (from: string, to: string) => void = renameSync, tries = REPLACE_TRIES, pauseMs = REPLACE_PAUSE_MS,
): void {
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, bytes)
  for (let attempt = 1; ; attempt++) {
    try {
      rename(temporary, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= tries || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) {
        rmSync(temporary, { force: true })
        throw error
      }
      pause(pauseMs * attempt)
    }
  }
}

/**
 * Make [version] the build in use: `cli\current` first (what the next master and core start from), then the stable
 * notify.mjs. A notify.mjs a hook keeps busy past the retries is left as it was, and said: the hooks keep reporting
 * through the one before, as they do through any notify.mjs, until the next switch.
 */
export function switchTo(cliDir: string, version: string, log: (line: string) => void = (line) => console.error(line)): void {
  writePointer(cliDir, CLI_POINTER, version)
  try {
    replaceFile(join(cliDir, STABLE_NOTIFY), readFileSync(join(cliDir, version, NOTIFY)))
  } catch (error) {
    log(`[update] the hooks' notify.mjs could not be refreshed yet (${error instanceof Error ? error.message : String(error)}) — they keep the one before until the next update`)
  }
}
