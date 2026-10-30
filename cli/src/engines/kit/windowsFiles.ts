/**
 * What the hook file writers (nativeHookFiles.ts, homeAdoption.ts) do differently on Windows, as measured on the Windows
 * VM (Node 24, NTFS, 2026-10-16): fsync on a read-only handle is EPERM (FlushFileBuffers needs a writable one), and a
 * rename onto a file another process has open is EPERM until that process lets go (an engine reading its settings).
 */
import { constants, renameSync } from 'node:fs'
import nodePath, { sep, type posix } from 'node:path'
import { HookPreparationHeld } from './hookHeld.js'

/**
 * Windows is decided by the path module, not process.platform: specs that fake win32 on a POSIX host keep the POSIX
 * behaviour (and its owner and mode checks). The one rule NativePaths, the journal and the file writers share.
 */
export const hostPlatform = (): NodeJS.Platform => sep === '\\' ? 'win32' : 'linux'

/** [path] is a filesystem root: `/`, a drive's `C:\`, a share's `\\server\share\`. A root is its own parent. */
export function isRoot(path: string, pathModule: Pick<typeof posix, 'dirname'> = nodePath): boolean {
  return pathModule.dirname(path) === path
}

const HELD = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface RenameDeps {
  platform?: NodeJS.Platform
  rename?: (from: string, to: string) => void
  wait?: (ms: number) => Promise<void>
  /** Tries in all, the first included. */
  attempts?: number
  /** The writer's owner still authorizes another try (HookPreparationAttempt.check). */
  check?: () => void
}

/** [from] renamed over [to]. On Windows a held target is tried again, 25 ms more each time (0.7 s for 8 tries), then held. */
export async function renameReplacing(from: string, to: string, deps: RenameDeps = {}): Promise<void> {
  const { platform = hostPlatform(), rename = renameSync, attempts = 8, check } = deps
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  for (let tried = 1; ; tried++) {
    try { rename(from, to); return } catch (error) {
      if (platform !== 'win32' || !HELD.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      // Still held after every try: a reason a person can read, not the raw errno (B4.10 review).
      if (tried >= attempts) throw new HookPreparationHeld('the settings file is open in another program')
      await wait(25 * tried)
      check?.()
    }
  }
}

const POSIX_READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * POSIX reopens an unchanged settings file read-only for its flush. On Windows, a read-write open changes ctime even
 * without a write (measured on NTFS with Node 22.23.2), invalidating the file proof. The staged writer already
 * flushed before rename, and Windows directory handles cannot be flushed, so do not reopen the unchanged file.
 */
export function unchangedFlushFlags(_mode: number, platform: NodeJS.Platform = hostPlatform()): number | null {
  return platform === 'win32' ? null : POSIX_READ
}

/** Reopen a journal record only on POSIX. A Windows O_RDWR open would change its reviewed ctime. */
export function journalFlushFlags(platform: NodeJS.Platform = hostPlatform()): number | null {
  return platform === 'win32' ? null : POSIX_READ
}
