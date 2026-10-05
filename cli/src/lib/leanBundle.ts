/**
 * The lean bundle a release's cli.js carries, written out for the master and the services to run from.
 *
 * Node parses the whole file a process is started on. Started on the 4.4 MB cli.js, harnessd's master
 * and each service paid about 45 MiB for that alone, at idle, before running a line of their own code
 * (measured 2026-10-05). The build therefore bundles the master and the services a second time on
 * their own, under 1 MB, and appends that bundle to cli.js as a comment, which Node only skims
 * (scripts/lib/leanBlock.mjs). This reads it back and writes it where the master can start processes
 * from it.
 *
 * Nothing here is needed for the daemon to run. A cli.js without the block (one built from the
 * sources, or a test's), a block that does not match its checksum, or a folder that cannot be written
 * leaves every process running from cli.js, as before.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

/** As scripts/lib/leanBlock.mjs writes it. Built in two pieces, so this file's own text never matches. */
const MARKER = Buffer.from('/*@harness-' + 'lean:')
const END = Buffer.from('*/')

export interface LeanBundle {
  /** The lean bundle's own code. */
  code: Buffer
  /** Its sha256, as the build recorded it. */
  sha256: string
  /** The sha256 of the whole cli.js it was read from: the bundle the master runs, for re-execution. */
  bundleSha256: string
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The lean bundle [bundle] carries; null when it carries none or one that does not match its checksum. */
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
  let code: Buffer
  try { code = brotliDecompressSync(Buffer.from(body.slice(colon + 1), 'base64')) } catch { return null }
  if (sha256(code) !== expected) return null
  return { code, sha256: expected, bundleSha256: sha256(bundle) }
}

export interface LeanFs {
  readFile: (path: string) => Buffer
  writeFile: (path: string, data: Buffer) => void
  rename: (from: string, to: string) => void
  mkdir: (path: string) => void
  list: (dir: string) => string[]
  remove: (path: string) => void
}

export const nodeLeanFs: LeanFs = {
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data, { mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  list: (dir) => readdirSync(dir),
  remove: (path) => rmSync(path, { force: true }),
}

/**
 * Write [lean] into [dir] as `harnessd-<sha>.mjs` and return its path. A file already there is used
 * only if its bytes are the bundle's, and every other lean bundle in the folder is removed: a process
 * running from one has read it already, and the next master writes its own.
 */
export function writeLeanBundle(dir: string, lean: LeanBundle, fs: LeanFs = nodeLeanFs): string {
  const name = `harnessd-${lean.sha256.slice(0, 16)}.mjs`
  const path = join(dir, name)
  fs.mkdir(dir)
  let present: Buffer | null = null
  try { present = fs.readFile(path) } catch { /* not written yet */ }
  if (!present || sha256(present) !== lean.sha256) {
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFile(tmp, lean.code)
    fs.rename(tmp, path)
  }
  for (const other of fs.list(dir)) {
    if (other !== name && /^harnessd-[0-9a-f]+\.mjs(\.\d+\.tmp)?$/.test(other)) fs.remove(join(dir, other))
  }
  return path
}
