/**
 * The lean bundle a release's cli.js carries, written out for the master and the services to run from.
 *
 * Node parses the whole file a process is started on. Started on the 4.4 MB cli.js, harnessd's master
 * and each service paid about 45 MiB for that alone, at idle, before running a line of their own code
 * (measured 2026-10-05). The build therefore bundles the master and the services a second time on their
 * own, split into files so that each process parses only the ones its own code is in, and appends those
 * files to cli.js as a comment, which Node only skims (scripts/lib/leanBlock.mjs). This reads them back
 * and writes them where the master can start processes from them: `lean/<sha>/` in the data folder.
 *
 * Nothing here is needed for the daemon to run. A cli.js without the block (one built from the
 * sources, or a test's), a block that does not match its checksum, or a folder that cannot be written
 * leaves every process running from cli.js, as before.
 *
 * Several masters can share one data folder (a second `harness start`, two builds on one computer), and
 * a master restarts its services from its folder for as long as it lives. So each master claims the
 * folder it runs from (`.claim-<pid>`), and a folder is removed only once no live master claims it.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

/** As scripts/lib/leanBlock.mjs writes it. Built in two pieces, so this file's own text never matches. */
const MARKER = Buffer.from('/*@harness-' + 'lean:')
const END = Buffer.from('*/')
/** The file the master and the services start on (src/leanEntry.ts); the others are what it imports. */
export const LEAN_ENTRY = 'harnessd.mjs'
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

export interface LeanWrite {
  /** This master: what its claim is under. */
  pid?: number
  alive?: (pid: number) => boolean
}

/** Whether [folder] holds every file of [lean], byte for byte. */
function holds(folder: string, lean: LeanBundle): boolean {
  for (const [name, code] of lean.files) {
    try { if (!readFileSync(join(folder, name)).equals(code)) return false } catch { return false }
  }
  return true
}

const removeQuietly = (path: string): void => { try { rmSync(path, { recursive: true, force: true }) } catch { /* the next master tries again */ } }

/**
 * Write [lean] into `[dir]/<sha>/`, claim it for this master and return the path of its entry. A folder
 * already there is used only if it holds the bundle's bytes; one that does not is replaced whole. Every
 * other lean folder no live master claims, and every write a crash cut short, is removed: a process
 * running from one has read it already, and the next master writes its own. Throws when the folder
 * cannot be written.
 */
export function writeLeanBundle(dir: string, lean: LeanBundle, options: LeanWrite = {}): string {
  const pid = options.pid ?? process.pid
  const alive = options.alive ?? processAlive
  const name = lean.sha256.slice(0, 16)
  const folder = join(dir, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!holds(folder, lean)) {
    // Written whole, then renamed into place: a folder there is always complete, so two masters of one
    // build starting at once (a second `harness start`) never see each other's half.
    const scratch = join(dir, `${name}.${pid}.tmp`)
    removeQuietly(scratch)
    mkdirSync(scratch, { mode: 0o700 })
    for (const [file, code] of lean.files) writeFileSync(join(scratch, file), code, { mode: 0o600 })
    try {
      renameSync(scratch, folder)
    } catch (error) {
      // Not over a folder with files in it. The other master's, written first, is the same bytes.
      if (holds(folder, lean)) {
        removeQuietly(scratch)
      } else {
        // One that changed on disk is moved aside and replaced. A master starting a service from it in
        // that instant finds no file and fails that start, which it retries.
        const aside = join(dir, `${name}.${pid}.old`)
        try { renameSync(folder, aside) } catch { throw error }
        renameSync(scratch, folder)
        removeQuietly(aside)
      }
    }
  }
  writeFileSync(join(folder, `.claim-${pid}`), '', { mode: 0o600 })
  for (const entry of safeList(dir)) {
    const scratch = SCRATCH.exec(entry)
    if (scratch) {
      if (Number(scratch[1]) === pid || !alive(Number(scratch[1]))) removeQuietly(join(dir, entry))
      continue
    }
    if (!FOLDER.test(entry)) continue
    // A claim of this master's own on another folder is one it held before it re-executed on this one.
    const claimants = safeList(join(dir, entry)).flatMap((file) => {
      const claim = CLAIM.exec(file)
      return claim ? [Number(claim[1])] : []
    })
    if (entry === name) {
      for (const claimant of claimants) if (claimant !== pid && !alive(claimant)) removeQuietly(join(folder, `.claim-${claimant}`))
    } else if (!claimants.some((claimant) => claimant !== pid && alive(claimant))) {
      removeQuietly(join(dir, entry))
    }
  }
  return join(folder, LEAN_ENTRY)
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
