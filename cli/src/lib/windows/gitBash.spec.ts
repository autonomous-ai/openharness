import { describe, expect, it } from 'vitest'
import { findGitBash } from './gitBash.js'

/** A fake Windows disk: the files that exist, compared as Windows does, without regard to case. */
const disk = (...files: string[]) => {
  const present = new Set(files.map((file) => file.toLowerCase()))
  return (path: string) => present.has(path.toLowerCase())
}

describe('findGitBash', () => {
  it('finds bash.exe beside the git on PATH, in each layout Git for Windows puts git in', () => {
    const cmd = disk('D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd' }, isFile: cmd })).toBe('D:\\Tools\\Git\\bin\\bash.exe')
    const bin = disk('D:\\Git\\bin\\git.exe', 'D:\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: 'D:\\Git\\bin' }, isFile: bin })).toBe('D:\\Git\\bin\\bash.exe')
    const mingw = disk('D:\\Git\\mingw64\\bin\\git.exe', 'D:\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: 'D:\\Git\\mingw64\\bin' }, isFile: mingw })).toBe('D:\\Git\\bin\\bash.exe')
  })

  it('looks in the folders Git for Windows installs to when git is not on PATH, the per-user one included', () => {
    const machine = disk('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, isFile: machine })).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    const user = disk('C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, isFile: user })).toBe('C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
  })

  it('prefers the git on PATH over an older install in Program Files', () => {
    const both = disk('C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: 'D:\\Git\\cmd', ProgramFiles: 'C:\\Program Files' }, isFile: both })).toBe('D:\\Git\\bin\\bash.exe')
  })

  it('never takes the bash.exe on PATH that is WSL\'s, nor a git with no bash beside it', () => {
    // System32\bash.exe starts a Linux distribution, where C:\ paths and the Windows PATH mean nothing.
    const wsl = disk('C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\git.exe', 'D:\\MinGit\\cmd\\git.exe')
    expect(findGitBash({ env: { PATH: 'C:\\Windows\\System32;D:\\MinGit\\cmd' }, isFile: wsl })).toBeNull()
  })

  it('finds the git Scoop installed through the shim on PATH, whose own folder has no bash', () => {
    // Scoop puts <root>\shims on PATH; git itself, bash with it, is <root>\apps\git\current.
    const scoop = disk('C:\\Users\\ana\\scoop\\shims\\git.exe', 'C:\\Users\\ana\\scoop\\apps\\git\\current\\bin\\bash.exe')
    expect(findGitBash({ env: { PATH: 'C:\\Windows\\System32;C:\\Users\\ana\\scoop\\shims' }, isFile: scoop }))
      .toBe('C:\\Users\\ana\\scoop\\apps\\git\\current\\bin\\bash.exe')
  })

  it('looks where Scoop installs git when PATH has none yet: its own root, the home folder\'s, the global one', () => {
    const custom = disk('D:\\scoop\\apps\\git\\current\\bin\\bash.exe')
    expect(findGitBash({ env: { SCOOP: 'D:\\scoop' }, isFile: custom })).toBe('D:\\scoop\\apps\\git\\current\\bin\\bash.exe')
    const home = disk('C:\\Users\\ana\\scoop\\apps\\git\\current\\bin\\bash.exe')
    expect(findGitBash({ env: { USERPROFILE: 'C:\\Users\\ana' }, isFile: home })).toBe('C:\\Users\\ana\\scoop\\apps\\git\\current\\bin\\bash.exe')
    const global = disk('E:\\apps-global\\apps\\git\\current\\bin\\bash.exe')
    expect(findGitBash({ env: { SCOOP_GLOBAL: 'E:\\apps-global' }, isFile: global })).toBe('E:\\apps-global\\apps\\git\\current\\bin\\bash.exe')
    const programData = disk('C:\\ProgramData\\scoop\\apps\\git\\current\\bin\\bash.exe')
    expect(findGitBash({ env: { ProgramData: 'C:\\ProgramData' }, isFile: programData })).toBe('C:\\ProgramData\\scoop\\apps\\git\\current\\bin\\bash.exe')
  })

  it('is null on a computer with no Git for Windows at all', () => {
    expect(findGitBash({ env: { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' }, isFile: disk() })).toBeNull()
    expect(findGitBash({ env: {}, isFile: disk() })).toBeNull()
  })
})
