import { lstatSync, readdirSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/**
 * Every path under `dirs`: a file as `${size} ${mtimeMs}`, a folder as `dir`, since a folder's mtime moves with each
 * entry added or renamed in it, which those entries already show. A symlinked folder is walked one level: a profile's
 * `shell-snapshots`, `todos` and the like link into ~/.claude, and a link inside those is not followed.
 */
export function snapshot(dirs: string[]): Map<string, string> {
  const paths = new Map<string, string>()
  for (const dir of dirs) walk(dir, false, paths)
  return paths
}

/** Paths made, removed or changed between two snapshots, sorted. */
export function changed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort()
}

function walk(dir: string, linked: boolean, paths: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const link = entry.isSymbolicLink()
    const info = link ? target(path) : lstatSync(path)
    if (!info.isDirectory()) {
      paths.set(path, `${info.size} ${info.mtimeMs}`)
      continue
    }
    paths.set(path, 'dir')
    if (!(link && linked)) walk(path, linked || link, paths)
  }
}

/** What a link points at, or the link itself when it dangles: one made in the profile is a change too. */
function target(path: string): Stats {
  try {
    return statSync(path)
  } catch {
    return lstatSync(path)
  }
}
