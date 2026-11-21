/**
 * The Git Bash that runs a harness's own scripts on Windows: its setup, its doctor, its workspace init and its viewer
 * (dsh/shell.ts). 65 of the Store's 67 harnesses have a setup or a doctor, and they are POSIX shell scripts; Windows has
 * no /bin/sh, and every Windows Store install failed at `spawn /bin/sh ENOENT` (0 of 25 in three days, 2026-10-28).
 * The same installs clone with git, so Git for Windows, which ships bash, is already the one thing they need.
 *
 * Found from the git install, never from a `bash.exe` on PATH: `C:\Windows\System32\bash.exe` is WSL's launcher, which
 * starts a Linux distribution where `C:\` paths and the Windows PATH mean nothing. MinGit, the git without a shell,
 * has no `bin\bash.exe`, so it is not taken for one.
 *
 * Where to look was first worked out, and checked on Windows 11, by an outside contribution (PR #1511).
 */
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

export interface GitBashSearch {
  env?: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
}

/** What a person is told to do when Git for Windows is missing. */
export const INSTALL_GIT_FOR_WINDOWS = 'Install Git for Windows from https://git-scm.com/download/win (or run: winget install --id Git.Git -e), then try again.'

/** Git's bash under a Scoop root: Scoop keeps each app's current version at apps\<app>\current. */
const SCOOP_GIT_BASH = win32.join('apps', 'git', 'current', 'bin', 'bash.exe')

export function findGitBash({ env = process.env, isFile = fileExists }: GitBashSearch = {}): string | null {
  const candidates: string[] = []
  // The git on PATH first, as the person's own terminal would run it. Git for Windows puts it in <root>\cmd (the
  // installer's default), <root>\bin or <root>\mingw64\bin; its bash is <root>\bin\bash.exe in each.
  // A relative entry names a folder of whatever folder the daemon runs in, which someone else's repository may fill.
  for (const dir of pathFolders(env.PATH).filter(fixedFolder)) {
    if (!isFile(win32.join(dir, 'git.exe'))) continue
    candidates.push(win32.resolve(dir, '..', 'bin', 'bash.exe'), win32.resolve(dir, '..', '..', 'bin', 'bash.exe'))
    // Scoop's git.exe on PATH is a shim in <root>\shims; the git it starts, and its bash, are in <root>\apps\git\current.
    candidates.push(win32.resolve(dir, '..', SCOOP_GIT_BASH))
  }
  // Then where its installer puts it, then where Scoop does for this user.
  for (const root of gitForWindowsRoots(env)) candidates.push(win32.join(root, 'bin', 'bash.exe'))
  for (const root of scoopRoots(env)) candidates.push(win32.join(root, SCOOP_GIT_BASH))
  return candidates.find((candidate) => isFile(candidate)) ?? null
}

/** The Program Files folders: this process's, the 64-bit one (another folder to a 32-bit process), and the 32-bit one. */
export function programFilesRoots(env: NodeJS.ProcessEnv): string[] {
  return [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((root): root is string => !!root)
}

/** Where Git for Windows' installer puts it: for everyone, or for this user alone (no administrator rights). */
export function gitForWindowsRoots(env: NodeJS.ProcessEnv): string[] {
  const user = env.LOCALAPPDATA ? [win32.join(env.LOCALAPPDATA, 'Programs', 'Git')] : []
  return [...programFilesRoots(env).map((root) => win32.join(root, 'Git')), ...user]
}

/** Scoop's root for this user: SCOOP, else ~\scoop. Never its root for everyone (SCOOP_GLOBAL, %ProgramData%\scoop):
 *  any user of the computer may make and fill it, a Harness guest included, and a real global install puts its shims
 *  on PATH. */
export function scoopRoots(env: NodeJS.ProcessEnv): string[] {
  return [env.SCOOP, env.USERPROFILE && win32.join(env.USERPROFILE, 'scoop')].filter((root): root is string => !!root)
}

/** PATH's folders as Node's spawn reads them on Windows (libuv's search_path): one in quotes, " or ', may hold a `;`,
 *  and the quotes are no part of it. */
export function pathFolders(path: string | undefined): string[] {
  return [...(path ?? '').matchAll(/(?:"[^"]*"?|'[^']*'?)?[^;]*/g)].map(([folder]) => folder.replace(/^["']|["']$/g, ''))
}

/** A folder that is the same whatever folder a program runs in: a drive's (C:\…) or a share's (\\server\…). Any other
 *  is looked up from the working folder, `\tools` included (from its drive). */
export function fixedFolder(folder: string): boolean {
  return /^(?:[A-Za-z]:\\|\\\\[^\\])/.test(win32.normalize(folder))
}

export function fileExists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
