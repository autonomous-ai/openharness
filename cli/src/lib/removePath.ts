import { lstatSync, rmSync, unlinkSync, type Stats } from 'node:fs'

/**
 * Removes what is at [path]: a file, a folder with what is in it, or a link (never what it points to), whether its target is
 * there or not; nothing when nothing is there. Node 25.3's `rmSync(path, { force: true })` leaves a link whose target is gone in
 * place, so the link made next failed with EEXIST (a re-linked package, the Team account's tmux and gh, 2026-11-09).
 */
export function removePath(path: string): void {
  let found: Stats
  try { found = lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (found.isDirectory()) rmSync(path, { recursive: true, force: true })
  else unlinkSync(path)
}
