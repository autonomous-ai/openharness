import { stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { projectsRoot } from '../lib/projectFolder.js'

export interface CapacityDisk { freeBytes: number; totalBytes?: number; volume: string; path: string }

/** A managed worktree may live on a different volume from its source repo.
 * Sample its existing parent without creating a folder during admission. */
export async function readCapacityDisk(cwd: string, worktree = false, root = projectsRoot()): Promise<CapacityDisk> {
  let path = worktree ? join(root, 'worktrees') : cwd
  for (;;) {
    try {
      const info = await stat(path)
      if (!info.isDirectory()) throw new Error('The destination is not a directory.')
      const disk = await statfs(path)
      const freeBytes = disk.bavail * disk.bsize
      if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) throw new Error('The destination disk capacity is unknown.')
      return { freeBytes, totalBytes: disk.blocks * disk.bsize, volume: String(info.dev), path }
    } catch (error) {
      if (!worktree || (error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
      path = dirname(path)
    }
  }
}
