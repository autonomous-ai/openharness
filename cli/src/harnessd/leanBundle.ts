/**
 * The lean bundle a release's cli.js carries, written out for the master, the core and the services to
 * run from.
 *
 * Node parses the whole file a process is started on. Started on the 4.4 MB cli.js, harnessd's master
 * and each service paid about 45 MiB for that alone, at idle, before running a line of their own code
 * (measured 2026-10-05), and the core parsed the CLI's commands with it. The build therefore bundles the
 * master and the services a second time on their own, and the core apart from them, split into files so
 * that each process parses only the ones its own code is in, and appends those files to cli.js as a
 * comment, which Node only skims (scripts/lib/leanBlock.mjs). This reads them back and writes them where
 * the master can start processes from them: `lean/<sha>/` in the data folder.
 *
 * Nothing here is needed for the daemon to run. A cli.js without the block (one built from the
 * sources, or a test's), a block that does not match its checksum, or a folder that cannot be written
 * leaves every process running from cli.js, as before; and a service or the core is started from cli.js
 * whenever its master's lean files are gone or changed, or cli.js is no longer the bundle they came from
 * (./leanServices.ts).
 *
 * Several masters can share one data folder (a second `harness start`, two builds on one computer), and
 * a master restarts its services from its folder for as long as it lives. So each master claims the
 * folder it runs from (`.claim-<pid>`) before it is in place or checked, gives the claim up as it exits
 * cleanly, and a folder is removed only once no live master claims it and it has not changed for a
 * minute. A claim older than the computer's last start is a dead master's, whatever has its pid now.
 */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { sha256File } from './reexec.js'

/** As scripts/lib/leanBlock.mjs writes it. Built in two pieces, so this file's own text never matches. */
const MARKER = Buffer.from('/*@harness-' + 'lean:')
const END = Buffer.from('*/')
/** The file the master and the services start on (src/leanEntry.ts); the others are what it imports. */
export const LEAN_ENTRY = 'harnessd.mjs'
/** The file the core starts on (src/leanCoreEntry.ts). It and the files it imports, named `core-*`, are
 *  built apart from the master's and the services', so that neither loads code only the other uses. */
export const LEAN_CORE_ENTRY = 'harnessd-core.mjs'
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.mjs$/
const FOLDER = /^[0-9a-f]{16}$/
const CLAIM = /^\.claim-(\d+)$/
const SCRATCH = /^[0-9a-f]{16}\.(\d+)\.(tmp|old)$/

export interface LeanBundle {
  /** Its files, by name: the entry and the chunks it imports. */
  files: ReadonlyMap<string, Buffer>
  /** The sha256 of its files, as the build recorded it. */
  sha256: string
  /** The sha256 of the whole cli.js it was read from: the bundle the master runs, for re-execution. */
  bundleSha256: string
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The lean bundle [bundle] carries; null when it carries none, or one that does not match its checksum. */
export function readLeanBundle(bundle: Buffer): LeanBundle | null {
  const start = bundle.lastIndexOf(MARKER)
  if (start < 0) return null
  const end = bundle.indexOf(END, start + MARKER.length)
  // The block is the last thing in the file: anything else that looks like its start is not it.
  if (end < 0 || bundle.subarray(end + END.length).toString('latin1').trim() !== '') return null
  const body = bundle.subarray(start + MARKER.length, end).toString('latin1')
  const colon = body.indexOf(':')
  const expected = body.slice(0, colon)
  if (colon < 0 || !/^[0-9a-f]{64}$/.test(expected)) return null
  let payload: Buffer
  try { payload = brotliDecompressSync(Buffer.from(body.slice(colon + 1), 'base64')) } catch { return null }
  if (sha256(payload) !== expected) return null
  let named: unknown
  try { named = JSON.parse(payload.toString('utf8')) } catch { return null }
  if (!named || typeof named !== 'object' || Array.isArray(named)) return null
  const files = new Map<string, Buffer>()
  for (const [name, code] of Object.entries(named)) {
    // Names become paths: nothing that could leave the folder, or be taken for a claim or scratch.
    if (!FILE_NAME.test(name) || typeof code !== 'string') return null
    files.set(name, Buffer.from(code, 'utf8'))
  }
  if (!files.has(LEAN_ENTRY)) return null
  return { files, sha256: expected, bundleSha256: sha256(bundle) }
}

/** Whether a process is alive; one of another user's is (EPERM). */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * A fingerprint of the lean bundle's code, file by file in name order, which a folder written from it
 * reproduces (`folderFingerprint`): how a master knows, before each service it starts, that the files it
 * would start it from are still the ones it was started with.
 */
export function leanFingerprint(lean: LeanBundle): string {
  const hash = createHash('sha256')
  for (const name of [...lean.files.keys()].sort()) hash.update(`${name}\0${sha256(lean.files.get(name)!)}\n`)
  return hash.digest('hex')
}

/** The fingerprint of the lean bundle written in [folder] (claims aside); null when it holds none. */
export function folderFingerprint(folder: string): string | null {
  const names = safeList(folder).filter((name) => FILE_NAME.test(name)).sort()
  if (!names.includes(LEAN_ENTRY)) return null
  const hash = createHash('sha256')
  try {
    // A piece at a time, as cli.js is: before every process a master starts (./reexec.ts `sha256File`).
    for (const name of names) hash.update(`${name}\0${sha256File(join(folder, name))}\n`)
  } catch {
    return null
  }
  return hash.digest('hex')
}

/** The claim [pid] holds on the lean bundle whose entry is [entry], given up as its master exits. */
export function releaseLeanClaim(entry: string, pid: number = process.pid): void {
  removeQuietly(join(dirname(entry), `.claim-${pid}`))
}

/** What a cleaner leaves alone: a folder or file changed this recently may be one a master is writing,
 *  or has just claimed, in another process at this moment. */
export const LEAN_RECENT_MS = 60_000

export interface LeanWrite {
  /** This master: what its claim is under. */
  pid?: number
  alive?: (pid: number) => boolean
  /** The wall clock, ms. */
  now?: () => number
  /** When this computer started, ms: a claim older than that was made by a process that is gone,
   *  whatever runs under its pid now. */
  bootedAt?: number
}

/** Whether [folder] holds every file of [lean], byte for byte. */
function holds(folder: string, lean: LeanBundle): boolean {
  for (const [name, code] of lean.files) {
    try { if (!readFileSync(join(folder, name)).equals(code)) return false } catch { return false }
  }
  return true
}

const removeQuietly = (path: string): void => { try { rmSync(path, { recursive: true, force: true }) } catch { /* the next master tries again */ } }
const changedAt = (path: string): number => { try { return lstatSync(path).mtimeMs } catch { return 0 } }

/** The pids that claim [folder], with when each claimed it. */
function claimsIn(folder: string): Array<{ pid: number; at: number }> {
  return safeList(folder).flatMap((file) => {
    const claim = CLAIM.exec(file)
    return claim ? [{ pid: Number(claim[1]), at: changedAt(join(folder, file)) }] : []
  })
}

/** Claim [folder] for [claim], then check it holds [lean]: from the moment its bytes are found good, a
 *  cleaner in another process sees the claim. False when there is no folder, or it does not hold them. */
function claimed(folder: string, claim: string, lean: LeanBundle): boolean {
  try { writeFileSync(join(folder, claim), '', { mode: 0o600 }) } catch { return false }
  return holds(folder, lean)
}

/**
 * Write [lean] into `[dir]/<sha>/`, claim it for this master and return the path of its entry. A folder
 * already there is used only if it holds the bundle's bytes; one that does not is replaced whole, with
 * the claims of the live masters that run from it. Every other lean folder no live master claims, and
 * every write a crash cut short, is removed, unless it changed in the last minute: a process running
 * from one has read it already, and the next master writes its own. Throws when the folder cannot be
 * written, and leaves nothing half-written.
 */
export function writeLeanBundle(dir: string, lean: LeanBundle, options: LeanWrite = {}): string {
  const pid = options.pid ?? process.pid
  const alive = options.alive ?? processAlive
  const now = options.now ?? Date.now
  const bootedAt = options.bootedAt ?? Date.now() - uptime() * 1000
  // A claim made before this computer started is a dead master's, whatever runs under its pid now.
  const live = (claim: { pid: number; at: number }): boolean => claim.at >= bootedAt && alive(claim.pid)
  const claim = `.claim-${pid}`
  const name = lean.sha256.slice(0, 16)
  const folder = join(dir, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!claimed(folder, claim, lean)) {
    // Written whole, claimed, then renamed into place: a folder there is always complete and never
    // unclaimed, so two masters of one build starting at once (a second `harness start`) never see each
    // other's half, and no cleaner takes it between the rename and the claim.
    const scratch = join(dir, `${name}.${pid}.tmp`)
    removeQuietly(scratch)
    try {
      mkdirSync(scratch, { mode: 0o700 })
      for (const [file, code] of lean.files) writeFileSync(join(scratch, file), code, { mode: 0o600 })
      writeFileSync(join(scratch, claim), '', { mode: 0o600 })
    } catch (error) {
      // A full disk, part-way: nothing half-written is left for the next master to trip on.
      removeQuietly(scratch)
      throw error
    }
    try {
      renameSync(scratch, folder)
    } catch (error) {
      // Not over a folder with files in it. Another master of this build, written first: the same bytes.
      if (claimed(folder, claim, lean)) {
        removeQuietly(scratch)
      } else {
        // One that changed on disk is replaced, and keeps the claims of the masters still running from
        // it. One starting a service from it in that instant finds no file and starts it from cli.js.
        for (const other of claimsIn(folder)) {
          if (other.pid !== pid && live(other)) writeFileSync(join(scratch, `.claim-${other.pid}`), '', { mode: 0o600 })
        }
        const aside = join(dir, `${name}.${pid}.old`)
        try {
          renameSync(folder, aside)
          renameSync(scratch, folder)
        } catch {
          removeQuietly(scratch)
          throw error
        } finally {
          removeQuietly(aside)
        }
      }
    }
  }
  const settled = (path: string): boolean => now() - changedAt(path) >= LEAN_RECENT_MS
  for (const entry of safeList(dir)) {
    const path = join(dir, entry)
    const scratch = SCRATCH.exec(entry)
    if (scratch) {
      if (Number(scratch[1]) === pid || (!alive(Number(scratch[1])) && settled(path))) removeQuietly(path)
      continue
    }
    if (!FOLDER.test(entry)) continue
    const claims = claimsIn(path)
    if (entry === name) {
      for (const other of claims) if (other.pid !== pid && !live(other)) removeQuietly(join(folder, `.claim-${other.pid}`))
    } else if (!claims.some((other) => other.pid !== pid && live(other)) && settled(path)) {
      // A claim of this master's own on another folder is one it held before it re-executed on this one.
      removeQuietly(path)
    }
  }
  return join(folder, LEAN_ENTRY)
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
