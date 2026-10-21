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
 * the old one is kept aside as `<name>.old-<pid>-<ms>` and the new one is renamed in (replaceBinFile); the aside
 * files are swept once nothing runs them. Nothing here calls a Windows API, so it is tested on every OS.
 */
import { copyFileSync, existsSync, linkSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isSingleSegment, readPointer, writePointer } from './installLayout.js'
import { PTY_PAYLOAD_FILES, PtyPayloadRefused, type PreparedPty } from './ptyPayload.js'

export const PTY_POINTER = 'current-pty'
export const PTY_PENDING = 'pty-pending.json'
export const PTY_REJECTED = 'pty-rejected.json'
/** The bin files that come out of the payload, in the order they are replaced. */
const BIN_FILES = ['harness.exe', 'harness-launch.exe'] as const
const ASIDE = /\.old-/

/** The calls that change files, so the tests can make any one of them fail. */
export interface PtyInstallFs {
  rename: (from: string, to: string) => void
  link: (existing: string, newPath: string) => void
  copyFile: (from: string, to: string) => void
  writeFile: (path: string, data: string) => void
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => void
  sleep: (ms: number) => void
}

const defaultFs: PtyInstallFs = {
  rename: renameSync,
  link: linkSync,
  copyFile: copyFileSync,
  writeFile: writeFileSync,
  rm: rmSync,
  // Synchronous on purpose, as in installLayout.ts: the caller holds the spawn lock and is synchronous.
  sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) },
}

/** A file just copied in is often held for a moment by an antivirus scan or the indexer; only waiting fixes that. */
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES'])
const ATTEMPTS = 5
function renameRetrying(fs: PtyInstallFs, from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rename(from, to)
      return
    } catch (error) {
      if (!RETRIED.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= ATTEMPTS) throw error
      fs.sleep(25 * 2 ** (attempt - 1))
    }
  }
}

const ptyRootOf = (rootDir: string) => join(rootDir, 'runtime', 'pty')

/** `<dir>\<stem>-<pid>-<ms>`, not taken yet: two replacements of one file within a millisecond must not meet. */
function freshName(dir: string, stem: string): string {
  for (let ms = Date.now(); ; ms++) {
    const candidate = join(dir, `${stem}-${process.pid}-${ms}`)
    if (!existsSync(candidate)) return candidate
  }
}

/** What [replaceBinFile] did, so it can be undone: where the old file went (null when there was none). */
interface Replaced { target: string; aside: string | null }

/**
 * Replace `<bin>\<name>` with [source] so that the path always answers. The new bytes go to a temporary name in the
 * same folder first. The old file gets a second name, `<name>.old-<pid>-<ms>` (a hard link: the bytes stay for an
 * undo), and one rename puts the new file over the path. When the old file is running, Windows may refuse that
 * rename: then the old file is renamed aside instead and the new one renamed in, and the path is empty only between
 * those two renames. A removal Windows refuses (the extra link to a running file) is left for [sweepAsideFiles].
 */
function replaceBinFile(fs: PtyInstallFs, source: string, bin: string, name: string, done: Replaced[]): void {
  const target = join(bin, name)
  const temporary = freshName(bin, `.${name}.new`)
  const tryRm = (path: string) => { try { fs.rm(path, { force: true }) } catch { /* swept later */ } }
  try {
    fs.copyFile(source, temporary)
    if (!existsSync(target)) {
      renameRetrying(fs, temporary, target)
      done.push({ target, aside: null })
      return
    }
    const link = freshName(bin, `${name}.old`)
    fs.link(target, link)
    try {
      fs.rename(temporary, target)
      done.push({ target, aside: link })
      return
    } catch (error) {
      if (!RETRIED.has((error as NodeJS.ErrnoException).code ?? '')) {
        tryRm(link)
        throw error
      }
    }
    const aside = freshName(bin, `${name}.old`)
    try {
      fs.rename(target, aside)
      try {
        renameRetrying(fs, temporary, target)
      } catch (error) {
        fs.rename(aside, target)
        throw error
      }
    } finally {
      // The link was only the undo copy for the rename over the path; [aside] is that copy now.
      tryRm(link)
    }
    done.push({ target, aside })
  } finally {
    tryRm(temporary)
  }
}

/** Write [path] whole or not at all: a reader never sees half a marker. */
function writeJson(fs: PtyInstallFs, path: string, value: unknown): void {
  const temporary = freshName(dirname(path), `.${basename(path)}.tmp`)
  try {
    fs.writeFile(temporary, JSON.stringify(value))
    renameRetrying(fs, temporary, path)
  } finally {
    fs.rm(temporary, { force: true })
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
  for (const step of steps.reverse()) {
    try { step() } catch { /* best effort; the original failure is what the caller hears */ }
  }
}

/**
 * Put [prepared] in use. The caller holds the daemon spawn lock. In order: the staging folder becomes
 * `<runtime>\pty\<version>\`; `bin\harness.exe` then `bin\harness-launch.exe` are replaced; `pty-pending.json`
 * records `{ version, previous }`; `current-pty` names the new version. A failure at any step undoes the steps
 * before it (the old bin files go back, the marker goes, the pointer is never moved) and throws
 * [PtyPayloadRefused]. The staging folder is gone afterwards, whatever happened.
 */
export function installPreparedPty(prepared: PreparedPty, rootDir: string, fs: PtyInstallFs = defaultFs): void {
  const ptyRoot = ptyRootOf(rootDir)
  const bin = join(rootDir, 'bin')
  const { version, staging } = prepared
  const versionDir = join(ptyRoot, version)
  const undo: Array<() => void> = []
  try {
    if (!isSingleSegment(version)) throw new PtyPayloadRefused(`version ${JSON.stringify(version)} is not a folder name`)
    // Without a version to go back to, probation could not roll the new one back.
    const previous = readPointer(ptyRoot, PTY_POINTER)
    if (previous === null) throw new PtyPayloadRefused('no installed pty version to roll back to')
    if (previous === version) throw new PtyPayloadRefused(`version ${version} is already in use`)

    // 1. The version folder. A complete one is never replaced: a host may run from it.
    if (existsSync(versionDir)) {
      if (!sameFiles(versionDir, staging)) throw new PtyPayloadRefused(`${versionDir} exists with other files`)
      fs.rm(staging, { recursive: true, force: true })
    } else {
      renameRetrying(fs, staging, versionDir)
      // Back to the staging name first, so a folder that half fails to delete is never taken for a complete one.
      undo.push(() => { fs.rename(versionDir, staging) })
    }

    // 2. The bin files.
    const replaced: Replaced[] = []
    undo.push(() => {
      undoAll(replaced.map(({ target, aside }) => () => {
        if (aside) renameRetrying(fs, aside, target)
        else fs.rm(target, { force: true })
      }))
    })
    for (const name of BIN_FILES) replaceBinFile(fs, join(versionDir, name), bin, name, replaced)

    // 3. The probation marker.
    const marker = join(ptyRoot, PTY_PENDING)
    undo.push(() => { fs.rm(marker, { force: true }) })
    writeJson(fs, marker, { version, previous })

    // 4. The pointer, last: it is what makes the version the one in use.
    writePointer(ptyRoot, PTY_POINTER, version, { rename: fs.rename, sleep: fs.sleep })
  } catch (error) {
    undoAll(undo)
    if (error instanceof PtyPayloadRefused) throw error
    throw new PtyPayloadRefused(error instanceof Error ? error.message : String(error))
  } finally {
    fs.rm(staging, { recursive: true, force: true })
  }
}

interface Pending { version: string; previous: string }

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

/**
 * Roll a version on probation back: `current-pty` names `previous` again, its two bin files are copied back the
 * rename-aside way, and the version joins the rejected list. The version folder stays; a host may still run from it
 * (spec §3 removes it later). Returns whether there was anything to restore. The marker goes last, so a restore
 * that fails part way is tried again whole.
 */
export function restorePty(rootDir: string, fs: PtyInstallFs = defaultFs): boolean {
  const ptyRoot = ptyRootOf(rootDir)
  const pending = readPending(ptyRoot)
  if (!pending) return false
  writePointer(ptyRoot, PTY_POINTER, pending.previous, { rename: fs.rename, sleep: fs.sleep })
  const bin = join(rootDir, 'bin')
  for (const name of BIN_FILES) replaceBinFile(fs, join(ptyRoot, pending.previous, name), bin, name, [])
  const rejected = rejectedPtyVersions(rootDir)
  if (!rejected.includes(pending.version)) writeJson(fs, join(ptyRoot, PTY_REJECTED), [...rejected, pending.version])
  fs.rm(join(ptyRoot, PTY_PENDING), { force: true })
  return true
}

/** The version on probation came back healthy: it stays. */
export function confirmPty(rootDir: string, fs: PtyInstallFs = defaultFs): void {
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
 * Delete the `bin\*.old-*` files: the ones renamed aside here, and install.ps1's `.<name>.old-*`. One that is still
 * running cannot be deleted on Windows and is left for the next sweep. Returns how many are left.
 */
export function sweepAsideFiles(rootDir: string, fs: PtyInstallFs = defaultFs): number {
  const bin = join(rootDir, 'bin')
  let names: string[]
  try {
    names = readdirSync(bin)
  } catch {
    return 0
  }
  let left = 0
  for (const name of names.filter((n) => ASIDE.test(n))) {
    try {
      fs.rm(join(bin, name))
    } catch (error) {
      // Gone already (another sweep) is as good as deleted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') left++
    }
  }
  return left
}
