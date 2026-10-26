import { cp, rename as renameEntry, rm } from 'node:fs/promises';

/**
 * Moves a directory to `to`. A rename cannot cross filesystems (EXDEV: a CI runner's /tmp may sit on
 * another disk than the checkout), so there it copies the tree and removes the source instead.
 */
export async function moveDirectory(from, to, { rename = renameEntry } = {}) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}
