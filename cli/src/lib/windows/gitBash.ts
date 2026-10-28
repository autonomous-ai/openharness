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

export function findGitBash({ env = process.env, isFile = fileExists }: GitBashSearch = {}): string | null {
  const candidates: string[] = []
  // The git on PATH first, as the person's own terminal would run it. Git for Windows puts it in <root>\cmd (the
  // installer's default), <root>\bin or <root>\mingw64\bin; its bash is <root>\bin\bash.exe in each.
  for (const dir of (env.PATH ?? '').split(';').filter(Boolean)) {
    if (!isFile(win32.join(dir, 'git.exe'))) continue
    candidates.push(win32.resolve(dir, '..', 'bin', 'bash.exe'), win32.resolve(dir, '..', '..', 'bin', 'bash.exe'))
  }
  // Then where its installer puts it: for everyone, or for this user alone (no administrator rights).
  for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
    if (root) candidates.push(win32.join(root, 'Git', 'bin', 'bash.exe'))
  }
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  return candidates.find((candidate) => isFile(candidate)) ?? null
}

function fileExists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
