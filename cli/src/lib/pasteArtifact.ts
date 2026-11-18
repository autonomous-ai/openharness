/**
 * Final input authority: prove a bounded worker artifact without reading its payload or accepting
 * an arbitrary path. Upload storage, expiry and clipboard work belong to the paste component.
 */
import { join } from 'node:path'
import { closeSync, constants, fstatSync, openSync, type BigIntStats } from 'node:fs'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { NativePaths } from '../engines/kit/nativePaths.js'
import { insideWindowsRoots, windowsStateRoots } from './secureState.js'
import type { PasteResult } from '../core/api.js'
import { env } from '../config/env.js'

/** Windows changes ctime when the final writer closes; its last-write time is the publication version. */
export const pasteFileVersion = (info: BigIntStats): string =>
  `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}${process.platform === 'win32' ? '' : `:${info.ctimeNs}`}`

/** A failed close cannot be retried: the numeric descriptor may already belong to another file. */
export class PasteArtifactCleanupUnconfirmed extends Error {
  constructor() { super('PASTE_FILE_CLOSE_FAILED'); this.name = 'PasteArtifactCleanupUnconfirmed' }
}

/** Independently bind a worker result to the selected generation's private file, without reading its bytes. */
export function openPreparedPaste(generation: string, artifact: NonNullable<Extract<PasteResult, { bytesWritten: number }>['artifact']>,
  dataDir = env.ADAPTER_DATA_DIR, maximumBytes = 20 * 1024 * 1024): { path: string; descriptor: number; current(): boolean; close(): void } {
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(generation)
    || !artifact.name.startsWith(`${generation}-`) || Buffer.byteLength(artifact.name) > 157
    || /[\x00-\x1f\x7f/\\:]/.test(artifact.name) || /[. ]$/.test(artifact.name)) throw new Error('PASTE_INVALID_ARTIFACT')
  const directory = join(dataDir, 'paste-drops', 'file-uploads')
  const path = join(directory, artifact.name)
  const paths = new NativePaths(new NativeEvidenceBudget())
  const dataRoot = paths.resolveSync(dataDir)!.path
  const parent = paths.resolveSync(directory)!
  for (const ancestor of [dataDir, join(dataDir, 'paste-drops')]) {
    const info = paths.resolveSync(ancestor)!.info
    if (!info.isDirectory() || process.platform !== 'win32' && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n) !== 0n)) {
      throw new Error('PASTE_INVALID_ARTIFACT')
    }
  }
  const leaf = paths.resolveSync(path)!
  const facts = paths.snapshot()
  if (leaf.path !== join(parent.path, artifact.name) || !parent.info.isDirectory()
    || facts.some((fact) => fact.alias && fact.path.startsWith(join(dataRoot, 'paste-drops')))
    || !paths.within(leaf.path, [parent.info])) throw new Error('PASTE_INVALID_ARTIFACT')
  if (process.platform === 'win32') {
    if (!insideWindowsRoots(path, windowsStateRoots())) throw new Error('PASTE_INVALID_ARTIFACT')
  } else if (parent.info.uid !== BigInt(process.getuid!()) || (parent.info.mode & 0o077n) !== 0n) throw new Error('PASTE_INVALID_ARTIFACT')
  const verifyRoute = paths.retain()
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let closed = false, closeFailed = false
  const close = (): void => {
    if (closeFailed) throw new PasteArtifactCleanupUnconfirmed()
    if (closed) return
    closed = true
    try { closeSync(fd) } catch { closeFailed = true; throw new PasteArtifactCleanupUnconfirmed() }
  }
  const current = (): boolean => {
    if (closed) return false
    try {
      verifyRoute()
      const info = fstatSync(fd, { bigint: true })
      const fresh = new NativePaths(new NativeEvidenceBudget()).resolveSync(path)!.info
      return info.isFile() && info.nlink === 1n && info.size > 0n && info.size <= BigInt(maximumBytes)
        && (process.platform === 'win32' || info.uid === BigInt(process.getuid!()) && (info.mode & 0o077n) === 0n)
        && pasteFileVersion(info) === artifact.version && pasteFileVersion(fresh) === artifact.version
    } catch { return false }
  }
  if (!current()) { close(); throw new Error('PASTE_INVALID_ARTIFACT') }
  return { path, descriptor: fd, current, close }
}
