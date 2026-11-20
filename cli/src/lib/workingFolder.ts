/**
 * The folder the master and the core work in: the person's home, whatever folder `harness start`, launchd, systemd,
 * Task Scheduler or an update ran them in. A firmware flash ran `harness start` inside a git worktree, then removed the
 * worktree: the daemon kept the deleted folder as its own, every core started there after failed to read it, and
 * discovery never confirmed an engine again. The home exists as long as the person is signed in; the data folder moves
 * or goes, and on Windows a process's folder cannot be deleted while it runs. Services, tmux and the PTY host inherit it.
 */
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { errorKind } from './log.js'

/** Enter the home, else the root of its filesystem. The line to log when the home could not be entered, else null:
 *  error kinds only, never the home's path. Never throws. */
export function enterHome(deps: { home?: () => string; chdir?: (folder: string) => void; platform?: NodeJS.Platform } = {}): string | null {
  const { home = homedir, chdir = (folder: string) => process.chdir(folder), platform = process.platform } = deps
  let root = platform === 'win32' ? `${process.env.SystemDrive ?? 'C:'}\\` : '/'
  let failure: unknown
  try {
    const folder = home()
    root = (platform === 'win32' ? win32 : posix).parse(folder).root || root
    chdir(folder)
    return null
  } catch (error) { failure = error }
  try {
    chdir(root)
    return `[start] could not enter the home (${errorKind(failure)}); working in the root of its filesystem`
  } catch (error) {
    return `[start] could not enter the home (${errorKind(failure)}) or the root of its filesystem (${errorKind(error)}); staying in the start folder`
  }
}
