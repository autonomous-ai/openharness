/**
 * The newest artifact under a workspace, by extension — what the viewer shows when the verdict
 * names nothing (a STEP written by `gen` between two verifications, for instance).
 *
 * A bounded walk: generated and vendored trees are skipped by name, depth is capped, and the count
 * is capped, so a workspace that is also a large repo costs a few milliseconds, not a scan of
 * `node_modules`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const ARTIFACT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '__cadgen__', '.circuit', '.harness',
  '.claude', '.agents', '.codex', 'dist', 'build', '.cache', 'inputs', 'blocks',
])
const MAX_DEPTH = 6
const MAX_FILES = 20_000

export function isArtifactDirIgnored(name: string): boolean {
  return ARTIFACT_IGNORED_DIRS.has(name)
}

export interface ArtifactHit {
  /** Workspace-relative, forward slashes. */
  path: string
  mtimeMs: number
}

/** `maxFiles` bounds how many directory entries are looked at; a test seam, the default in production. */
export function newestArtifact(workspace: string, extensions: readonly string[], maxFiles = MAX_FILES): ArtifactHit | null {
  if (!extensions.length) return null
  const wanted = new Set(extensions.map((ext) => ext.toLowerCase()))
  let best: ArtifactHit | null = null
  let seen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen > maxFiles) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (seen++ > maxFiles) return
      const path = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!isArtifactDirIgnored(name) && !name.startsWith('.')) walk(path, depth + 1)
        continue
      }
      // A hidden file is never the artifact: the 3D viewer keeps its inline GLB as `.model.step.glb`
      // beside the STEP it was made from, and that is exactly the kind of file this must not pick.
      if (!st.isFile() || name.startsWith('.')) continue
      const dot = name.lastIndexOf('.')
      if (dot < 0 || !wanted.has(name.slice(dot).toLowerCase())) continue
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { path: relative(workspace, path).split('\\').join('/'), mtimeMs: st.mtimeMs }
      }
    }
  }
  walk(workspace, 0)
  return best
}

/** True when `path` (relative or absolute) ends with one of `extensions` and is not under an ignored directory. */
export function isCandidateArtifact(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase()
  if (!extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) return false
  const segments = path.split(/[\\/]/)
  if (segments[segments.length - 1].startsWith('.')) return false
  return !segments.slice(0, -1).some((segment) => isArtifactDirIgnored(segment))
}
