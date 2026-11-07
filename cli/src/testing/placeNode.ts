import { chmodSync, copyFileSync, linkSync } from 'node:fs'

/** This test's Node at [path]: a hard link of the running one, or a copy where the temp folder is on
 *  another filesystem than the Node install (EXDEV: the Linux CI runner's toolcache, 2026-10-22). */
export function placeNode(path: string, _runFrom: string[] = []): void {
  try { linkSync(process.execPath, path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(process.execPath, path)
    chmodSync(path, 0o755)
  }
}
