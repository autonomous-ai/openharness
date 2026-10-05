import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { type Artifact, requireThat } from './model.js'

function inside(root: string, file: string): boolean {
  const path = relative(root, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * The places `.harness/loop/` names in the workspace `root` (already canonical): the folder as written and where it
 * really is, so a linked `.harness` or `.harness/loop` still counts as the loop logs.
 */
export async function loopFolders(root: string): Promise<string[]> {
  const direct = join(root, '.harness', 'loop')
  return [direct, await realpath(direct).catch(() => direct)]
}
/** `path` (named by the worker) resolves to `source`; neither may be the loop logs or lie inside them. */
function refuseLoopLog(reserved: string[], root: string, path: string, source: string): void {
  const hit = reserved.some(folder => [join(root, path), source].some(file => file === folder || inside(folder, file)))
  requireThat(!hit, 'INVALID_ARTIFACT', `${path} is a loop check log, not an artifact.`)
}

/** `.harness/loop/` holds loop check logs; they are never artifacts. Checked on canonical paths, so aliases count. */
export async function assertNotLoopLog(root: string, paths: string[]): Promise<void> {
  const real = await realpath(root), reserved = await loopFolders(real)
  for (const path of paths) refuseLoopLog(reserved, real, path, await realpath(join(real, path)).catch(() => join(real, path)))
}

/**
 * Snapshot only named regular files contained in the worker's own workspace. `check` runs before creating the
 * destination and before each file's folder and copy, so a caller that lost the right to save (the task was stopped
 * meanwhile) creates and copies nothing more. The read-only `chmod` of a file just copied into the destination is not
 * re-checked: it only touches that private staging copy.
 */
export async function snapshotArtifacts(cwd: string, destination: string, paths: string[], check: () => void): Promise<Artifact[]> {
  requireThat(paths.length <= 64, 'ARTIFACT_LIMIT', 'At most 64 artifacts per task.')
  const root = await realpath(cwd), reserved = await loopFolders(root)
  const prepared: Array<{ source: string; path: string; size: number }> = []
  let bytes = 0
  for (const path of new Set(paths)) {
    requireThat(path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'), 'INVALID_ARTIFACT', 'Artifact paths must stay inside the task workspace.')
    // Resolved once: the path that passes these checks is the one copied.
    const source = await realpath(join(root, path))
    refuseLoopLog(reserved, root, path, source)
    requireThat(inside(root, source), 'INVALID_ARTIFACT', `Artifact ${path} escapes the task workspace.`)
    const info = await stat(source)
    requireThat(info.isFile() && info.size <= 256 * 1024 * 1024, 'INVALID_ARTIFACT', `${path} must be a regular file of at most 256 MiB.`)
    bytes += info.size
    requireThat(bytes <= 1024 * 1024 * 1024, 'ARTIFACT_LIMIT', 'Artifacts exceed 1 GiB.')
    prepared.push({ source, path, size: info.size })
  }
  // Destination is a new attempt-owned directory, never a caller-supplied path.
  check()
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const result: Artifact[] = []
  for (const file of prepared) {
    const target = join(destination, file.path)
    check()
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    check()
    await copyFile(file.source, target)
    const info = await stat(target)
    const sha256 = await hashFile(target)
    requireThat(info.size === file.size && sha256 === await hashFile(file.source), 'ARTIFACT_CHANGED', `${file.path} changed during handoff. Finish writing it and try again.`)
    await chmod(target, 0o400)
    result.push({ path: file.path, size: info.size, sha256 })
  }
  return result
}

export async function materializeInputs(source: string, destination: string, artifacts: Artifact[]): Promise<void> {
  for (const artifact of artifacts) {
    const path = join(source, artifact.path)
    requireThat(await hashFile(path) === artifact.sha256, 'ARTIFACT_CHANGED', `The saved artifact ${artifact.path} no longer matches its completed result.`)
    const target = join(destination, artifact.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await copyFile(path, target)
    requireThat(await hashFile(target) === artifact.sha256, 'ARTIFACT_CHANGED', `The input copy of ${artifact.path} changed.`)
    await chmod(target, 0o400)
  }
}
