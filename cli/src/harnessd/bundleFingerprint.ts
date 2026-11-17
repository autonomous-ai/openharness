/** Streaming file fingerprints for supervisor transition and drift checks. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'

/** Selected CLI and cached code share one byte bound; the largest frozen CLI is 12.47 MB. */
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024
export type FingerprintFailure = 'bundle_fingerprint_unavailable' | 'bundle_fingerprint_file_refused'
  | 'bundle_fingerprint_size_refused' | 'bundle_fingerprint_changed' | 'bundle_fingerprint_close_unsettled'
const refused = (code: FingerprintFailure): Error & { code: FingerprintFailure } => Object.assign(new Error(code), { code })
let closeUnsettled = false

/** POSIX must not wait on a FIFO before descriptor inspection; Windows accepts regular disk files. */
export function bundleReadFlags(): number {
  const nonblock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK
  if (nonblock === undefined) throw refused('bundle_fingerprint_unavailable')
  return constants.O_RDONLY | nonblock
}

/** The piece of a file `sha256File` holds at a time: one, for every call (why is on `sha256File`). */
const HASH_PIECE = Buffer.allocUnsafe(64 * 1024)

/**
 * The sha256 of the file at [path], read a piece at a time. A master hashes cli.js, 6.5 MB, and every
 * file of its lean bundle before each process it starts (./leanServices.ts), eight of them as it boots:
 * read whole, each read was a buffer the size of the file, and at idle a master still held 35 to 45 MiB
 * of them, which a collection would have freed but none came (measured 2026-10-06).
 *
 * Every call reads through the same piece. With a piece of its own per call, a check of the lean folder
 * allocated 64 KiB per file, and the folder grew from 236 files to 393: about 25 MiB at each check. They
 * were freed, but the allocator kept the pages, so the master stayed as high as the collections' timing
 * had let it climb: 88 to 99 MiB resident on Linux and 101 to 111 on macOS, against the 100 MiB
 * e2e/lean.e2e.ts holds it under, which failed at 100.4 on 2026-11-14. Through one piece it is 75.3 MiB
 * on Linux (the median was 95.6) and 76.6 on macOS (108.6), the same in every run (Node 24.22.2, measured
 * 2026-11-14). The reads are synchronous, so no two calls ever hold the piece at once.
 */
export function sha256File(path: string): string {
  if (closeUnsettled) throw refused('bundle_fingerprint_close_unsettled')
  // Refuse devices, directories and symlink leaves before open. POSIX nonblocking open also prevents a
  // FIFO swapped into the pathname from hanging before fstat. Windows admits ordinary disk-file publication;
  // it has no POSIX FIFO/nonblocking flag, and the descriptor is checked again after its regular-leaf preflight.
  if (!lstatSync(path).isFile()) throw refused('bundle_fingerprint_file_refused')
  const hash = createHash('sha256')
  const fd = openSync(path, bundleReadFlags())
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw refused('bundle_fingerprint_file_refused')
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BUNDLE_BYTES) throw refused('bundle_fingerprint_size_refused')
    for (let left = stat.size; left > 0;) {
      const read = readSync(fd, HASH_PIECE, 0, Math.min(HASH_PIECE.length, left), null)
      if (read === 0) throw refused('bundle_fingerprint_changed')
      hash.update(HASH_PIECE.subarray(0, read))
      left -= read
    }
    if (readSync(fd, HASH_PIECE, 0, 1, null) !== 0) throw refused('bundle_fingerprint_changed')
  } finally {
    try { closeSync(fd) } catch {
      // close may already have freed/reused this fd. Never retry it or open another until process restart.
      closeUnsettled = true
      throw refused('bundle_fingerprint_close_unsettled')
    }
  }
  return hash.digest('hex')
}

/** A file's sha256: which bundle a master runs, or which is on disk; null when it cannot be read. */
export function fingerprint(path: string, onRefused?: (reason: FingerprintFailure) => void): string | null {
  try { return sha256File(path) } catch (error) {
    const code = (error as { code?: unknown })?.code
    const reason = typeof code === 'string' && /^bundle_fingerprint_(unavailable|file_refused|size_refused|changed|close_unsettled)$/.test(code)
      ? code as FingerprintFailure : 'bundle_fingerprint_unavailable'
    onRefused?.(reason)
    return null
  }
}
