/**
 * Removes a test's throwaway folder and everything in it: isolatedTmux's root (isolatedTmux.ts) and the home, data and
 * runtime folders vitest.setup.ts makes for every file. Plain Node only: vitest.setup.ts loads it before anything may
 * read the environment. The worker's reaper keeps a copy of its own (e2e/harness/reaperProcess.mjs), which plain Node
 * runs without a loader.
 */
import { chmodSync, type Dirent, lstatSync, readdirSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

// kill-server returns before its panes have exited, and a zsh among them writes its history as
// it goes (macOS's /etc/zshrc sets HISTFILE): the folder filled up under the removal, and a
// passing tmuxmoves.e2e.ts test failed in its teardown with ENOTEMPTY. Asked again, it is empty.
const tree = { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }

/**
 * [root] and everything in it. A recursive removal cannot unlink in a read-only folder, and the managed grid's install
 * makes its bin/ one (lib/runtimeInstall.ts `readOnly`): ten roots on one Mac kept their runtime/grid-*\/bin after their
 * close (2026-11-14). So a removal that fails makes the root's folders writable by their owner and is tried once more;
 * what that one cannot remove, its error names.
 */
export async function removeRoot(root: string): Promise<void> {
  try {
    await rm(root, tree)
  } catch {
    ownerWritable(root)
    await rm(root, tree)
  }
}

/** removeRoot, for a process that is ending (vitest.setup.ts's `exit` and `SIGTERM`), where nothing asynchronous runs. */
export function removeRootSync(root: string): void {
  try {
    rmSync(root, tree)
  } catch {
    ownerWritable(root)
    rmSync(root, tree)
  }
}

/** [folder] and every folder in it made writable by its owner. Read without following a link (lstat, and a link's own
 *  entry is never a folder), so nothing a link in the root leads to is changed. What it cannot change, the removal after
 *  it names. Synchronous, for removeRootSync; it runs only after a removal has failed. */
function ownerWritable(folder: string): void {
  let stats
  try { stats = lstatSync(folder) } catch { return }
  if (!stats.isDirectory()) return
  try { chmodSync(folder, (stats.mode & 0o7777) | 0o700) } catch { /* named by the removal after it */ }
  let entries: Dirent[] = []
  try { entries = readdirSync(folder, { withFileTypes: true }) } catch { /* named by the removal after it */ }
  for (const entry of entries) if (entry.isDirectory()) ownerWritable(join(folder, entry.name))
}
