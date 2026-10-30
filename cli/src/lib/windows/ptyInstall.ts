/**
 * Putting a prepared PTY payload (ptyPayload.ts) in use, and taking it back out (spec §3, "How a payload is
 * installed" and "Rollback"). The layout is installLayout.ts's:
 *
 *   <root>\bin\harness.exe, harness-launch.exe     copies out of the version folder in use
 *   <root>\runtime\pty\<version>\                  the six payload files, never replaced once complete
 *   <root>\runtime\pty\current-pty                 the version in use (ptyHost/launch.ts currentPtyVersion)
 *   <root>\runtime\pty\pty-pending.json            { version, previous } while the new version is on probation
 *   <root>\runtime\pty\pty-rejected.json           versions rolled back on this machine, never tried again
 *
 * Windows cannot overwrite or delete a running .exe, but it can rename one. So a bin file is never written in place:
 * the old one is kept aside as `<name>.old-<pid>-<ms>` and the new one is renamed in (putInPlace); the aside files
 * are swept once nothing runs them. Nothing here calls a Windows API, so it is tested on every OS.
 */
import { copyFileSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { VERSION_DIR } from '../ptyHost/launch.js'
import { isSingleSegment, readPointer, writePointer } from './installLayout.js'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, type PreparedPty } from './ptyPayload.js'

export const PTY_POINTER = 'current-pty'
export const PTY_PENDING = 'pty-pending.json'
export const PTY_REJECTED = 'pty-rejected.json'
/** The bin files that come out of the payload, in the order they are replaced. */
export const BIN_FILES = ['harness.exe', 'harness-launch.exe'] as const
/** What a sweep of bin\ removes: our aside files and install.ps1's (`.<name>.old-*`), our temporary copies, and the
 *  `<name>~RF<hex>.TMP` backups that File.Replace leaves when install.ps1 replaces a running program. */
const SWEPT = [/\.old-/, /^\..+\.new-\d+-\d+$/, /~RF.*\.TMP$/i]

/** The calls that change files, so the tests can make any one of them fail. */
export interface PtyInstallFs {
  rename: (from: string, to: string) => void
  link: (existing: string, newPath: string) => void
  copyFile: (from: string, to: string) => void
  writeFile: (path: string, data: string) => void
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => void
  sleep: (ms: number) => void
}

export const defaultPtyInstallFs: PtyInstallFs = {
  rename: renameSync,
  link: linkSync,
  copyFile: copyFileSync,
  writeFile: writeFileSync,
  rm: rmSync,
  // Synchronous on purpose, as in installLayout.ts: the caller holds the spawn lock and is synchronous.
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}

/**
 * The codes Windows gives while a file is held: by an antivirus scan or the indexer for a moment, or, for a rename
 * over a program, for as long as it runs. Waiting can fix those, and nothing else.
 */
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES'])
const ATTEMPTS = 5
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? ''
const backoff = (attempt: number) => 25 * 2 ** (attempt - 1)

function renameRetrying(fs: PtyInstallFs, from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(from, to)
      return
    } catch (error) {
      if (!RETRIED.has(codeOf(error)) || attempt >= ATTEMPTS) throw error
      fs.sleep(backoff(attempt))
    }
  }
}

function tryRm(fs: PtyInstallFs, path: string, options: { recursive?: boolean; force?: boolean } = { force: true }): void {
  try { fs.rm(path, options) } catch { /* a running file on Windows: swept later */ }
}

const ptyRootOf = (rootDir: string) => join(rootDir, 'runtime', 'pty')

/** `<dir>\<stem>-<pid>-<ms>`, not taken yet: two replacements of one file within a millisecond must not meet. */
function freshName(dir: string, stem: string): string {
  for (let ms = Date.now(); ; ms++) {
    const candidate = join(dir, `${stem}-${process.pid}-${ms}`)
    if (!existsSync(candidate)) return candidate
  }
}

/** What [putInPlace] did, so it can be undone: where the old file went (null when there was none). */
interface Replaced { target: string; aside: string | null }

/**
 * After a failed rename-in, the old file goes straight back. Any error is retried here (bounded): a target left
 * missing while its bytes sit under an `.old-` name is the one outcome that is not allowed.
 */
function putBack(fs: PtyInstallFs, aside: string, target: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(aside, target)
      return
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error
      fs.sleep(backoff(attempt))
    }
  }
}

/**
 * Rename the old [target] aside and [ready] in, as one unit: nothing runs between the two renames, so the path is
 * missing only for that moment. A failed rename-in puts the old file back at once; any wait happens with it in
 * place, and then the pair is tried again. The entry is in [done] across the gap, so if even the put-back fails,
 * the caller's undo still knows where the old file is.
 */
function swapPair(fs: PtyInstallFs, ready: string, target: string, aside: string, done: Replaced[]): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(target, aside)
    } catch (error) {
      if (!RETRIED.has(codeOf(error)) || attempt >= ATTEMPTS) throw error
      fs.sleep(backoff(attempt))
      continue
    }
    const entry: Replaced = { target, aside }
    done.push(entry)
    try {
      fs.rename(ready, target)
      return
    } catch (error) {
      try {
        putBack(fs, aside, target)
      } catch (putBackError) {
        // The put-back failure is what is thrown; the rename-in failure that led to it stays readable.
        throw Object.assign(putBackError as Error, { cause: error })
      }
      done.splice(done.indexOf(entry), 1)
      if (!RETRIED.has(codeOf(error)) || attempt >= ATTEMPTS) throw error
      fs.sleep(backoff(attempt))
    }
  }
}

/**
 * Put [ready] (a file already in bin\) at `<bin>\<name>`. When there is no old file, a plain rename. Otherwise one
 * rename over the old file first, which keeps the path answering throughout; with [keepOld] the old file first gets
 * a second name (a hard link, the aside file the undo needs). Windows refuses that rename while the old file runs,
 * and a link fails on FAT or for a running image: then [swapPair].
 */
function putInPlace(fs: PtyInstallFs, ready: string, bin: string, name: string, done: Replaced[], keepOld: boolean): void {
  const target = join(bin, name)
  if (!existsSync(target)) {
    renameRetrying(fs, ready, target)
    done.push({ target, aside: null })
    return
  }
  if (keepOld) {
    const link = freshName(bin, `${name}.old`)
    let linked = false
    try {
      fs.link(target, link)
      linked = true
    } catch { /* no second name here; the pair keeps the old file instead */ }
    if (linked) {
      try {
        fs.rename(ready, target)
        done.push({ target, aside: link })
        return
      } catch (error) {
        tryRm(fs, link)
        if (!RETRIED.has(codeOf(error))) throw error
      }
    }
  } else {
    try {
      fs.rename(ready, target)
      return
    } catch (error) {
      if (!RETRIED.has(codeOf(error))) throw error
    }
  }
  swapPair(fs, ready, target, freshName(bin, `${name}.old`), done)
}

/** Copy [source] to a temporary name in bin\ (before any rename touches the path), then [putInPlace]. */
function replaceBinFile(fs: PtyInstallFs, source: string, bin: string, name: string, done: Replaced[]): void {
  const temporary = freshName(bin, `.${name}.new`)
  try {
    fs.copyFile(source, temporary)
    putInPlace(fs, temporary, bin, name, done, true)
  } finally {
    tryRm(fs, temporary)
  }
}

/** Undo one [putInPlace]: the old file goes back the same way the new one came in, since the new one may run now. */
function undoReplaced(fs: PtyInstallFs, { target, aside }: Replaced): void {
  const bin = dirname(target)
  if (aside) return putInPlace(fs, aside, bin, basename(target), [], false)
  try {
    fs.rm(target, { force: true })
  } catch {
    // A new file someone already runs cannot be deleted on Windows; moved aside, it is swept later.
    fs.rename(target, freshName(bin, `${basename(target)}.old`))
  }
}

/** Write [path] whole or not at all: a reader never sees half a marker. */
function writeJson(fs: PtyInstallFs, path: string, value: unknown): void {
  const temporary = freshName(dirname(path), `.${basename(path)}.tmp`)
  try {
    fs.writeFile(temporary, JSON.stringify(value))
    renameRetrying(fs, temporary, path)
  } finally {
    tryRm(fs, temporary)
  }
}

function sameFiles(a: string, b: string): boolean {
  return PTY_PAYLOAD_FILES.every((name) => {
    try {
      return readFileSync(join(a, name)).equals(readFileSync(join(b, name)))
    } catch {
      return false
    }
  })
}

/** Run every undo step, even after one fails: each one left undone is a file out of place. */
function undoAll(steps: Array<() => void>): void {
  for (const step of [...steps].reverse()) {
    try { step() } catch { /* best effort; the original failure is what the caller hears */ }
  }
}

/**
 * Put [prepared] in use. The caller holds the daemon spawn lock. In order: the staging folder becomes
 * `<runtime>\pty\<version>\`; `bin\harness.exe` then `bin\harness-launch.exe` are replaced; `pty-pending.json`
 * records `{ version, previous }`; `current-pty` names the new version. A failure at any step undoes the steps
 * before it (the old bin files go back, the marker goes, the pointer is never moved) and is rethrown as it was.
 * Only content is refused ([PtyPayloadRefused]): a version launch.ts cannot read, or an existing version folder
 * with other files. Returns false, having done nothing, when `current-pty` already names the version (another
 * installer got there first). The staging folder is gone afterwards, whatever happened.
 */
export function installPreparedPty(prepared: PreparedPty, rootDir: string, fs: PtyInstallFs = defaultPtyInstallFs): boolean {
  const ptyRoot = ptyRootOf(rootDir)
  const bin = join(rootDir, 'bin')
  const { version, staging } = prepared
  const versionDir = join(ptyRoot, version)
  const undo: Array<() => void> = []
  try {
    if (!VERSION_DIR.test(version)) throw new PtyPayloadRefused(`version ${JSON.stringify(version)} is not a version folder name`)
    // A version still on probation must be confirmed or rolled back first: its marker names the one to go back to.
    if (existsSync(join(ptyRoot, PTY_PENDING))) throw new Error(`a pty version is still on probation (${PTY_PENDING})`)
    // Without a version to go back to, probation could not roll the new one back.
    const previous = readPointer(ptyRoot, PTY_POINTER)
    if (previous === null) throw new Error('no installed pty version to roll back to')
    if (previous === version) return false

    // 1. The version folder. A complete one is never replaced: a host may run from it.
    if (existsSync(versionDir)) {
      if (!sameFiles(versionDir, staging)) throw new PtyPayloadRefused(`${versionDir} exists with other files`)
    } else {
      renameRetrying(fs, staging, versionDir)
      // Back to the staging name first, so a folder that half fails to delete is never taken for a complete one.
      undo.push(() => { fs.rename(versionDir, staging) })
    }

    // 2. The bin files.
    const replaced: Replaced[] = []
    undo.push(() => { undoAll(replaced.map((entry) => () => undoReplaced(fs, entry))) })
    for (const name of BIN_FILES) replaceBinFile(fs, join(versionDir, name), bin, name, replaced)

    // 3. The probation marker.
    const marker = join(ptyRoot, PTY_PENDING)
    undo.push(() => { fs.rm(marker, { force: true }) })
    writeJson(fs, marker, { version, previous })

    // 4. The pointer, last: it is what makes the version the one in use.
    writePointer(ptyRoot, PTY_POINTER, version, { rename: fs.rename, sleep: fs.sleep })
    return true
  } catch (error) {
    undoAll(undo)
    throw error
  } finally {
    // A just-run canary can hold a file for a moment; a failed delete must not replace the real outcome.
    tryRm(fs, staging, { recursive: true, force: true })
  }
}

export interface PtyPending { version: string; previous: string }
type Pending = PtyPending

/** The version on probation and the one it replaced, or null when none is (or its marker cannot be read). */
export function readPtyPending(rootDir: string): PtyPending | null {
  return readPending(ptyRootOf(rootDir))
}

function readPending(ptyRoot: string): Pending | null {
  try {
    const value = JSON.parse(readFileSync(join(ptyRoot, PTY_PENDING), 'utf8')) as Partial<Pending>
    if (typeof value?.version !== 'string' || !isSingleSegment(value.version)) return null
    if (typeof value.previous !== 'string' || !isSingleSegment(value.previous)) return null
    return { version: value.version, previous: value.previous }
  } catch {
    return null
  }
}

export interface PtyRestore {
  /** There was a version on probation, and it is now rejected and its marker gone. */
  found: boolean
  /** `current-pty` names the previous version again. */
  pointer: boolean
  /** The bin files copied back from the previous version. */
  restored: string[]
  /** The bin files left as they were: missing from the previous version, or a copy back that failed and was undone. */
  kept: string[]
  /** The bin files whose copy back failed and whose undo failed too: the path is missing, and its last bytes sit in
   *  a `bin\<name>.old-*` file. The caller must put one back before a sweep. */
  missing: string[]
}

/**
 * Roll a version on probation back. The rejection is recorded first. `current-pty` names `previous` again when its
 * host is still there, and each bin file `previous` still has is copied back the rename-aside way; a missing one
 * keeps the current file. The version folder stays; a host may still run from it (spec §3 removes it later). Only a
 * failed pointer or record write throws, and a retry repeats nothing that took: a restore never sticks on a
 * version folder that is gone or incomplete.
 */
export function restorePty(rootDir: string, fs: PtyInstallFs = defaultPtyInstallFs): PtyRestore {
  const ptyRoot = ptyRootOf(rootDir)
  const result: PtyRestore = { found: false, pointer: false, restored: [], kept: [], missing: [] }
  const pending = readPending(ptyRoot)
  if (!pending) return result
  const previousDir = join(ptyRoot, pending.previous)
  const has = (name: string) => existsSync(join(previousDir, name))

  const rejected = rejectedPtyVersions(rootDir)
  if (!rejected.includes(pending.version)) writeJson(fs, join(ptyRoot, PTY_REJECTED), [...rejected, pending.version])

  if (has('harness-pty.exe')) {
    writePointer(ptyRoot, PTY_POINTER, pending.previous, { rename: fs.rename, sleep: fs.sleep })
    result.pointer = true
  }
  const bin = join(rootDir, 'bin')
  for (const name of BIN_FILES) {
    if (!has(name)) { result.kept.push(name); continue }
    const done: Replaced[] = []
    try {
      replaceBinFile(fs, join(previousDir, name), bin, name, done)
      result.restored.push(name)
    } catch {
      // Swallowed so a restore never sticks, but only once the current file is back where it was, if it can be.
      undoAll(done.map((entry) => () => undoReplaced(fs, entry)))
      ;(existsSync(join(bin, name)) ? result.kept : result.missing).push(name)
    }
  }
  fs.rm(join(ptyRoot, PTY_PENDING), { force: true })
  result.found = true
  return result
}

/** The version on probation came back healthy: it stays. */
export function confirmPty(rootDir: string, fs: PtyInstallFs = defaultPtyInstallFs): void {
  fs.rm(join(ptyRootOf(rootDir), PTY_PENDING), { force: true })
}

/** The versions rolled back on this machine. A missing or unreadable list is empty. */
export function rejectedPtyVersions(rootDir: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(ptyRootOf(rootDir), PTY_REJECTED), 'utf8'))
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/**
 * Delete the leftovers in bin\: `*.old-*` aside files (ours and install.ps1's `.<name>.old-*`), `.<name>.new-*`
 * temporary copies of an interrupted install, and install.ps1's `*~RF*.TMP`. One that is still running cannot be
 * deleted on Windows and is left for the next sweep. Returns how many are left. The caller holds the daemon spawn
 * lock: an install's `.new-*` copy and, mid-pair, its `.old-*` aside file are the only copies of their bytes, so a
 * sweep outside the lock can break a concurrent install or lose a path while it is renamed aside.
 */
export function sweepAsideFiles(rootDir: string, fs: PtyInstallFs = defaultPtyInstallFs): number {
  const bin = join(rootDir, 'bin')
  let names: string[]
  try {
    names = readdirSync(bin)
  } catch {
    return 0
  }
  let left = 0
  for (const name of names.filter((n) => SWEPT.some((pattern) => pattern.test(n)))) {
    try {
      fs.rm(join(bin, name))
    } catch (error) {
      // Gone already (another sweep) is as good as deleted.
      if (codeOf(error) !== 'ENOENT') left++
    }
  }
  return left
}
