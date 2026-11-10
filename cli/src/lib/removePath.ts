import { lstatSync, rmdirSync, rmSync, unlinkSync, type Stats } from 'node:fs'

/** What is at [path], or null when nothing is: a path under a file (ENOTDIR) is nothing there too. */
function found(path: string): Stats | null {
  try { return lstatSync(path) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

/**
 * Removes the link or file at [path], whether a link's target is there or not, and never what it points to; nothing when
 * nothing is there. A real folder is refused (thrown), as `rmSync` without `recursive` refused it: where a link is kept (the
 * Team account's `~/.local/bin/gh`), a folder is someone else's. Node 25.3's `rmSync(path, { force: true })` leaves a link
 * whose target is gone in place, so the link made next failed with EEXIST (2026-11-09). On Windows `unlink` takes a symlink
 * and a junction; `rmdir` takes a folder link it would not (lib/uninstall/removal.ts).
 */
export function removeLink(path: string): void {
  const stats = found(path)
  if (!stats) return
  if (stats.isDirectory()) throw Object.assign(new Error(`${path} is a folder, not a link`), { code: 'EISDIR' })
  try { unlinkSync(path) } catch (error) {
    if (process.platform !== 'win32' || !stats.isSymbolicLink()) throw error
    rmdirSync(path)
  }
}

/** Removes what is at [path]: a link or a file (`removeLink`), or a folder with what is in it; nothing when nothing is there. */
export function removePath(path: string): void {
  const stats = found(path)
  if (stats?.isDirectory()) rmSync(path, { recursive: true, force: true })
  else if (stats) removeLink(path)
}
