/** Checked immutable native helper bytes; no daemon configuration or startup effects. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface ProcessImageArtifact {
  schema: 1
  sha256: string
  size: number
  base64: string
}

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

function artifactBytes(artifact: ProcessImageArtifact): Buffer {
  if (artifact.schema !== 1 || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    || !Number.isInteger(artifact.size) || artifact.size < 32 || artifact.size > MAX_ARTIFACT_BYTES
    || typeof artifact.base64 !== 'string' || artifact.base64.length > Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4) {
    throw new Error('Invalid native process-image artifact')
  }
  const bytes = Buffer.from(artifact.base64, 'base64')
  if (bytes.length !== artifact.size || bytes.toString('base64') !== artifact.base64
    || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('Native process-image artifact checksum mismatch')
  }
  return bytes
}

async function privateDirectory(path: string, recursive = false): Promise<void> {
  try { await mkdir(path, { recursive, mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()
    || (info.mode & 0o022) !== 0) throw new Error('Unsafe native helper directory')
}

async function verifyFile(path: string, artifact: ProcessImageArtifact): Promise<boolean> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0
      || (info.mode & 0o100) === 0 || info.size !== artifact.size) return false
    const bytes = await file.readFile()
    return createHash('sha256').update(bytes).digest('hex') === artifact.sha256
  } catch { return false }
  finally { await file?.close() }
}

/** Extract only bytes pinned by the CLI bundle, never a network download or a
 * path supplied by terminal output. Creation is atomic across multiple daemons.
 * This is an optional optimization: callers preserve their ordinary reader on
 * every failure. No account state, sessions or existing files are replaced. */
export async function prepareProcessImageHelper(
  artifact: ProcessImageArtifact, runtimeDirectory: string,
): Promise<string | null> {
  let temporary: string | undefined
  try {
    const bytes = artifactBytes(artifact)
    await privateDirectory(runtimeDirectory, true)
    const directory = join(runtimeDirectory, 'process-images')
    await privateDirectory(directory)
    const target = join(directory, artifact.sha256)
    if (await verifyFile(target, artifact)) return target
    try { await lstat(target); return null }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // A bad existing target stays untouched and cannot be executed. link()
    // below is create-only, so concurrent writers cannot replace one another.
    temporary = join(directory, `.${artifact.sha256}-${randomUUID()}`)
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o500)
    try { await file.writeFile(bytes) }
    finally { await file.close() }
    try { await link(temporary, target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return await verifyFile(target, artifact) ? target : null
  } catch { return null }
  finally { if (temporary) await unlink(temporary).catch(() => {}) }
}

