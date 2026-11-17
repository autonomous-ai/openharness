/** One immutable, claimed image for a probe and every child admitted by that probe. */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { MAX_BUNDLE_BYTES, bundleReadFlags } from './bundleFingerprint.js'
import {
  LEAN_CORE_ENTRY, LEAN_ENTRY, readLeanBundle, releaseLeanClaim, writeLeanBundle,
  type LeanBundle, type LeanWrite,
} from './leanBundle.js'

// The largest measured release is 12.47 MB; retain over ten times that headroom without unbounded reads.
const FULL_ENTRY = 'cohort-cli.mjs'
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export interface ExecutionArtifact {
  readonly selected: string
  readonly originalScript: string
  readonly probeScript: string
  readonly fullScript: string
  readonly fullFingerprint: string
  readonly leanScript?: string
  readonly leanCoreScript?: string
  readonly leanFingerprint?: string
  readonly leanEntryFingerprint?: string
  readonly leanCoreFingerprint?: string
  /** Call only after the probe and every child using this image have actually closed. May throw. */
  release(): void
}

interface ArtifactOptions extends LeanWrite { directory: string }
type ImagePaths = Omit<ExecutionArtifact, 'release'>

class SourceCloseUnsettled extends Error {
  constructor() { super('worker_artifact_source_close_unsettled') }
}

/** The descriptor pins an atomic publication; size and reads refer to that same file. */
function readSource(path: string): Buffer {
  try {
    if (!lstatSync(path).isFile()) throw new Error()
    const fd = openSync(path, bundleReadFlags())
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BUNDLE_BYTES) throw new Error()
      const bytes = Buffer.allocUnsafe(stat.size)
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), null)
        if (count === 0) throw new Error()
        offset += count
      }
      // Never accept a truncated prefix if an in-place writer grows the opened file.
      if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, null) !== 0) throw new Error()
      return bytes
    } finally {
      try { closeSync(fd) } catch { throw new SourceCloseUnsettled() }
    }
  } catch (error) {
    if (error instanceof SourceCloseUnsettled) throw error
    throw new Error('worker_artifact_source_unavailable')
  }
}

function release(entry: string, options: ArtifactOptions): void {
  if (options.keepMasterEntry && resolve(dirname(options.keepMasterEntry)) === resolve(dirname(entry))) return
  const pid = options.pid ?? process.pid
  releaseLeanClaim(entry, pid)
  try { lstatSync(join(dirname(entry), `.claim-${pid}`)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
  }
  // releaseLeanClaim leaves failed removals for the next cleaner; this owner cannot relinquish yet.
  throw new Error('worker_artifact_release_failed')
}

function remains(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Bounded live ownership, independent of the shared store's existing recent-file cleanup grace. */
export function createExecutionArtifacts(options: ArtifactOptions): { prepare(originalScript: string, expected: string): ExecutionArtifact } {
  let active: ExecutionArtifact | null = null
  let unsettled = false
  // Kept out of the release closure: no source bytes, inflated payload or file map survives preparation.
  function prepareImage(originalScript: string, expected: string): ImagePaths {
    let bytes: Buffer
    try { bytes = readSource(originalScript) } catch (error) {
      // A failed close may already have released/reused its fd. Never retry that number or open another.
      if (error instanceof SourceCloseUnsettled) unsettled = true
      throw error
    }
    const selected = digest(bytes)
    if (selected !== expected) throw new Error('worker_artifact_source_changed')
    const lean = readLeanBundle(bytes)
    if (lean && [...lean.files.keys()].some((name) => name.toLowerCase() === FULL_ENTRY)) throw new Error('worker_artifact_reserved_name')
    const fullName = lean ? FULL_ENTRY : LEAN_ENTRY
    const files = new Map(lean?.files)
    files.set(fullName, bytes)
    const hash = createHash('sha256')
    for (const name of [...files.keys()].sort()) hash.update(`${name}\0${name === fullName ? selected : digest(files.get(name)!)}\n`)
    const fingerprint = hash.digest('hex')
    const composite: LeanBundle = { files, sha256: fingerprint, bundleSha256: selected }
    const folder = join(options.directory, fingerprint.slice(0, 16))
    const entry = join(folder, LEAN_ENTRY)
    const scratch = `${folder}.${options.pid ?? process.pid}`
    try {
      writeLeanBundle(options.directory, composite, options)
      if (remains(`${scratch}.tmp`) || remains(`${scratch}.old`)) throw new Error()
    } catch (error) {
      if (['LEAN_RESTORE_FAILED', 'bundle_fingerprint_close_unsettled'].includes((error as NodeJS.ErrnoException).code ?? '')) unsettled = true
      else {
        try {
          if (remains(`${scratch}.tmp`) || remains(`${scratch}.old`)) unsettled = true
          else release(entry, options)
        } catch { unsettled = true }
      }
      throw new Error(unsettled ? 'worker_artifact_cleanup_unsettled' : 'worker_artifact_publish_failed')
    }
    const fullScript = join(folder, fullName)
    const core = lean?.files.get(LEAN_CORE_ENTRY)
    return {
      selected, originalScript, probeScript: fullScript, fullScript, fullFingerprint: selected,
      ...(lean ? {
        leanScript: entry, leanFingerprint: fingerprint, leanEntryFingerprint: digest(lean.files.get(LEAN_ENTRY)!),
        ...(core ? { leanCoreScript: join(folder, LEAN_CORE_ENTRY), leanCoreFingerprint: digest(core) } : {}),
      } : {}),
    }
  }
  return {
    prepare(originalScript, expected) {
      if (unsettled) throw new Error('worker_artifact_cleanup_unsettled')
      if (active) throw new Error('worker_artifact_in_use')
      const paths = prepareImage(originalScript, expected)
      let released = false
      const image: ExecutionArtifact = {
        ...paths,
        release() {
          if (released) return
          release(paths.fullScript, options)
          released = true
          active = null
        },
      }
      active = image
      return image
    },
  }
}
