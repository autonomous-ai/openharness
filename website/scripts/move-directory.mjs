import { cp as copyTree, mkdtemp, rename as renameEntry, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Moves a directory to `to`. A rename cannot cross filesystems (EXDEV: a CI runner's /tmp may sit on
 * another disk than the checkout), so there it copies the tree into a folder beside `to`, renames that
 * into place and removes the source: a copy that fails partway never leaves a half-written `to`.
 */
export async function moveDirectory(from, to, { rename = renameEntry, cp = copyTree } = {}) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
  }
  const staging = await mkdtemp(path.join(path.dirname(to), `.${path.basename(to)}-`));
  try {
    await cp(from, staging, { recursive: true });
    await rename(staging, to);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(from, { recursive: true, force: true });
}
