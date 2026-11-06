/**
 * On Windows, Claude Code 2.1.316 runs its status line in Git Bash when it finds one, and in PowerShell otherwise (task #4164).
 * Harness's status line is written for the shell Claude Code will run it in, so the Git Bash is found as Claude Code finds it.
 */
import { describe, expect, it } from 'vitest'
import { claudeCodeGitBash } from './claudeCodeGitBash.js'

const there = (...paths: string[]) => (path: string) => paths.includes(path)
const PROGRAM_FILES = 'C:\\Program Files\\Git\\bin\\bash.exe'
const PROGRAM_FILES_X86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'

describe('the Git Bash Claude Code runs its status line in on Windows', () => {
  it('is CLAUDE_CODE_GIT_BASH_PATH when it names a bash or sh that is there', () => {
    for (const path of ['D:\\Git\\bin\\bash.exe', 'D:\\Git\\bin\\sh.exe', 'D:\\msys\\usr\\bin\\bash']) {
      expect(claudeCodeGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: path }, isFile: there(path, PROGRAM_FILES) })).toBe(path)
    }
  })

  it('looks further when CLAUDE_CODE_GIT_BASH_PATH names something else, or nothing there', () => {
    expect(claudeCodeGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Tools\\zsh.exe' }, isFile: there('D:\\Tools\\zsh.exe', PROGRAM_FILES) })).toBe(PROGRAM_FILES)
    expect(claudeCodeGitBash({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Gone\\bash.exe' }, isFile: there(PROGRAM_FILES) })).toBe(PROGRAM_FILES)
  })

  it('is then Git for Windows in Program Files, then in Program Files (x86), before the git on PATH', () => {
    const env = { PATH: 'C:\\Tools\\Git\\cmd' }
    const onPath = 'C:\\Tools\\Git\\bin\\bash.exe'
    expect(claudeCodeGitBash({ env, isFile: there(PROGRAM_FILES, PROGRAM_FILES_X86, 'C:\\Tools\\Git\\cmd\\git.exe', onPath) })).toBe(PROGRAM_FILES)
    expect(claudeCodeGitBash({ env, isFile: there(PROGRAM_FILES_X86, 'C:\\Tools\\Git\\cmd\\git.exe', onPath) })).toBe(PROGRAM_FILES_X86)
  })

  it('is then the bash two folders up from the git on PATH', () => {
    const env = { PATH: 'C:\\Windows\\System32;C:\\Tools\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(claudeCodeGitBash({ env, isFile: there('C:\\Tools\\Git\\cmd\\git.exe', 'C:\\Tools\\Git\\bin\\bash.exe') })).toBe('C:\\Tools\\Git\\bin\\bash.exe')
    // WSL's bash in System32 is no Git Bash: only the git is looked for on PATH.
    expect(claudeCodeGitBash({ env, isFile: there('C:\\Windows\\System32\\bash.exe') })).toBeNull()
  })

  it('is none without Git for Windows, where Claude Code runs it in PowerShell', () => {
    expect(claudeCodeGitBash({ env: { PATH: 'C:\\Windows\\System32' }, isFile: there() })).toBeNull()
    // MinGit has a git but no bash.
    expect(claudeCodeGitBash({ env: { PATH: 'C:\\MinGit\\cmd' }, isFile: there('C:\\MinGit\\cmd\\git.exe') })).toBeNull()
  })
})
