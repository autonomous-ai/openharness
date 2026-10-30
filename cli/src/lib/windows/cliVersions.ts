/**
 * The CLI's version folders on Windows (spec section 1, "Layout"; section 3, "Self-update and rollback"): each build
 * in `cli\<version>\`, the one in use named by the pointer file `cli\current` (./installLayout.ts), and beside them the
 * stable `cli\notify.mjs` the hooks' command lines name. On a Mac an update swaps files in place by rename and keeps
 * `.prev` hard links to roll back to. Windows cannot replace a file a running process holds, and has no symlinks
 * without Developer Mode, so a build is never touched once written: an update writes a new folder and moves the
 * pointer, a rollback moves it back.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessRow } from '../processTable.js'
import { CLI_POINTER, STABLE_NOTIFY, writePointer } from './installLayout.js'
import { windowsProcessRows } from './processTable.js'

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
  try {
    writeFileSync(temporary, bytes)
    for (let attempt = 1; ; attempt++) {
      try {
        rename(temporary, file)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= tries || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) throw error
        pause(pauseMs * attempt)
      }
    }
  } catch (error) {
    // Also a file the write left half-written (a full disk).
    rmSync(temporary, { force: true })
    throw error
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

export interface RetireDeps {
  rows(): Promise<readonly ProcessRow[] | null>
  remove(path: string): void
  log(line: string): void
}

/** This computer's: A's process table, a removal of the whole folder, the daemon log. */
export const processRetireDeps = (): RetireDeps => ({
  rows: () => windowsProcessRows(null),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  log: (line) => console.log(line),
})

/** A folder a stage is still writing is left alone for this long. */
const STAGING_GRACE_MS = 60 * 60_000
/** A build moved aside by `writeVersionFolder`, and a folder a stage writes before its rename. */
const SET_ASIDE = /^\..+\.old$/
const STAGING = /^\..+\.tmp$/

function isFolder(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/**
 * Remove every build but [keep] (or the builds it names when asked, null for none), and the folders a stage set aside (`.old`) or left (`.tmp`, once it is an hour old),
 * once no process runs from one: a core or a service of the build before may still be running from its folder, and a
 * pane's `harness` command line names one too. Without a process table nothing is removed. A folder Windows will not
 * remove yet (a file in it still open) is said and tried again at the next pass; so is what is left of one it removed
 * only in part, which is why a build here is any folder named as one, with or without its cli.js.
 */
export async function retireUnused(
  cliDir: string, keep: ReadonlySet<string> | (() => ReadonlySet<string> | null), deps: RetireDeps,
): Promise<string[]> {
  const kept = typeof keep === 'function' ? keep : () => keep
  // A first look: with nothing to retire, no process table to read.
  if (!retirable(cliDir, kept()).length) return []
  const rows = await deps.rows()
  if (!rows) { deps.log('[update] the process table could not be read — the older CLI builds stay for now'); return [] }
  // And again after the read, the only wait: a stage meanwhile (this process's own, which the spawn lock lets
  // through) may have pointed cli\current at a build the first look would have removed. From here on nothing waits.
  const candidates = retirable(cliDir, kept())
  // What a process runs from: its image, and every path its command line names (node's own, cli.js, a hook's).
  const lines = rows.flatMap((row) => [row.executable, row.imagePath ?? '', row.args, ...(row.nativeArgv ?? [])])
    .map((line) => line.toLowerCase().replace(/\//g, '\\'))
  const removed: string[] = []
  for (const name of candidates) {
    // By text: a path spelled as the launcher spelled it matches; one through an 8.3 short name, a junction or subst does not.
    const folder = `${join(cliDir, name).toLowerCase().replace(/\//g, '\\')}\\`
    if (lines.some((line) => line.includes(folder))) continue
    try {
      deps.remove(join(cliDir, name))
      removed.push(name)
    } catch (error) {
      deps.log(`[update] ${name} could not be removed yet (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}) — trying again later`)
    }
  }
  return removed
}

/** The folders in [cliDir] `retireUnused` would remove, given [keep]; none without it. */
function retirable(cliDir: string, keep: ReadonlySet<string> | null): string[] {
  if (!keep) return []
  let names: string[]
  try { names = readdirSync(cliDir) } catch { return [] }
  const now = Date.now()
  return names.filter((name) => {
    if (keep.has(name)) return false
    if (VERSION_FOLDER.test(name) || SET_ASIDE.test(name)) return isFolder(join(cliDir, name))
    if (!STAGING.test(name)) return false
    try { return now - statSync(join(cliDir, name)).mtimeMs > STAGING_GRACE_MS } catch { return false }
  })
}
