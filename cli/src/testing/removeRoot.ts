/**
 * Removes a test's throwaway folder and everything in it: isolatedTmux's root (isolatedTmux.ts) and the home, data and
 * runtime folders vitest.setup.ts makes for every file. Plain Node only: vitest.setup.ts loads it before anything may
 * read the environment. The worker's reaper keeps a copy of its own (e2e/harness/reaperProcess.mjs), which plain Node
 * runs without a loader.
 */
import { chmod, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

// kill-server returns before its panes have exited, and a zsh among them writes its history as
// it goes (macOS's /etc/zshrc sets HISTFILE): the folder filled up under the removal, and a
// passing tmuxmoves.e2e.ts test failed in its teardown with ENOTEMPTY. Asked again, it is empty.
const removeTree = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

/**
 * [root] and everything in it. A recursive removal cannot unlink in a read-only folder, and the managed grid's install
 * makes its bin/ one (lib/runtimeInstall.ts `readOnly`): ten roots on one Mac kept their runtime/grid-*\/bin after their
 * close (2026-11-14). So a removal that fails makes the root's folders writable by their owner and is tried once more;
 * what that one cannot remove, its error names.
 */
export async function removeRoot(root: string): Promise<void> {
  try {
    await removeTree(root)
  } catch {
    await ownerWritable(root)
    await removeTree(root)
  }
}

/** [folder] and every folder in it made writable by its owner. Read without following a link (lstat, and a link's own
 *  entry is never a folder), so nothing a link in the root leads to is changed. What it cannot change, the removal after
 *  it names. */
async function ownerWritable(folder: string): Promise<void> {
  const stats = await lstat(folder).catch(() => null)
  if (!stats?.isDirectory()) return
  await chmod(folder, (stats.mode & 0o7777) | 0o700).catch(() => {})
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await ownerWritable(join(folder, entry.name))
  }
}
