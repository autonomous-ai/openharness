/**
 * The Git Bash Claude Code runs its status line in on Windows, found as Claude Code 2.1.316 finds it (task #4164): its status
 * line goes through its hook runner, which runs a command in this bash, or in PowerShell when there is none. Harness's status
 * line is written for that shell (kit/statusLine.ts), so this follows Claude Code's own order, not gitBash.ts's.
 */
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

export interface ClaudeGitBashSearch {
  env?: NodeJS.ProcessEnv
  isFile?: (path: string) => boolean
}

const SHELLS = new Set(['bash.exe', 'sh.exe', 'bash', 'sh'])
const INSTALLED = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']

/** The bash's path, or null where Claude Code runs its status line in PowerShell. */
export function claudeCodeGitBash({ env = process.env, isFile = fileExists }: ClaudeGitBashSearch = {}): string | null {
  const named = env.CLAUDE_CODE_GIT_BASH_PATH
  if (named && SHELLS.has(win32.basename(named).toLowerCase()) && isFile(named)) return named
  const installed = INSTALLED.find((path) => isFile(path))
  if (installed) return installed
  // `where git`: the first git on PATH, by PATHEXT; its bash is two folders up, in bin (<root>\cmd\git.exe: <root>\bin\bash.exe).
  const extensions = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    const git = extensions.map((extension) => win32.join(dir, `git${extension.toLowerCase()}`)).find((path) => isFile(path))
    if (!git) continue
    const bash = win32.join(git, '..', '..', 'bin', 'bash.exe')
    return isFile(bash) ? bash : null
  }
  return null
}

function fileExists(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}
