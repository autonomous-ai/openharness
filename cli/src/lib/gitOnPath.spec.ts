import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProgramPath, findGh, findGit } from './gitOnPath.js'

/** The folder a simulated Windows git runs in: a repository someone else's commits filled. */
const WORKING_FOLDER = 'C:\\repo'

/** A fake Windows disk, compared without regard to case. A relative path names a file of the working folder, as it
 *  does to a program Node starts there; every path asked is kept, so a test can see none was relative. */
function windowsDisk(...files: string[]) {
  const present = new Set(files.map((file) => win32.resolve(WORKING_FOLDER, file).toLowerCase()))
  const asked: string[] = []
  const isFile = (path: string) => {
    asked.push(path)
    return present.has(win32.resolve(WORKING_FOLDER, path).toLowerCase())
  }
  return { isFile, asked }
}

const WINDOWS_ROOTS = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local', USERPROFILE: 'C:\\Users\\ana' }
const noLoginShell = async () => null

const folders: string[] = []
const startFolder = process.cwd()
afterEach(() => {
  process.chdir(startFolder)
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A real folder holding an executable for each name. */
function folderWith(...names: string[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'git-on-path-'))
  folders.push(folder)
  for (const name of names) {
    writeFileSync(join(folder, name), '#!/bin/sh\n')
    chmodSync(join(folder, name), 0o755)
  }
  return folder
}

describe('findGit on Windows', () => {
  it('never runs a git.exe of the working folder or of a relative PATH entry', async () => {
    // `\repo` is a folder of the working folder's drive, and `C:bin` one under the working folder when that is on C:.
    const disk = windowsDisk('.\\git.exe', 'tools\\git.exe', 'bin\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe')
    const found = await findGit({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: '.;;tools;\\repo;C:bin;C:\\Tools' }, isFile: disk.isFile })
    expect(found).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
    expect(win32.isAbsolute(found!)).toBe(true)
    expect(disk.asked.length).toBeGreaterThan(0)
    expect(disk.asked.filter((path) => !win32.isAbsolute(path))).toEqual([])
  })

  it('takes git.exe alone from PATH, never a git.cmd, which only cmd.exe runs', async () => {
    const disk = windowsDisk('C:\\X\\git.cmd')
    expect(await findGit({ platform: 'win32', env: { PATH: 'C:\\X' }, isFile: disk.isFile })).toBeNull()
  })

  it("prefers PATH's git.exe over the folders Git for Windows installs to", async () => {
    const disk = windowsDisk('C:\\X\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Users\\ana\\scoop\\shims\\git.exe')
    const env = { ...WINDOWS_ROOTS, PATH: 'C:\\Windows\\System32;C:\\X' }
    expect(await findGit({ platform: 'win32', env, isFile: disk.isFile })).toBe('C:\\X\\git.exe')
    // A share's folder is the same wherever git runs.
    const share = windowsDisk('\\\\server\\tools\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe')
    expect(await findGit({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: '\\\\server\\tools' }, isFile: share.isFile })).toBe('\\\\server\\tools\\git.exe')
  })

  it("with none on PATH: Program Files' cmd folder, then the per-user install's, then Scoop's shims", async () => {
    const machine = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const user = 'C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'
    const scoop = 'C:\\Users\\ana\\scoop\\shims\\git.exe'
    const find = (...files: string[]) => findGit({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: '' }, isFile: windowsDisk(...files).isFile })
    expect(await find(machine, user, scoop)).toBe(machine)
    expect(await find(user, scoop)).toBe(user)
    expect(await find(scoop)).toBe(scoop)
    expect(await find()).toBeNull()
  })
})

describe('findGh on Windows', () => {
  it('never runs a gh.exe of the working folder or of a relative PATH entry', async () => {
    const disk = windowsDisk('.\\gh.exe', 'tools\\gh.exe')
    expect(await findGh({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: '.;;tools' }, isFile: disk.isFile })).toBeNull()
    expect(disk.asked.length).toBeGreaterThan(0)
    expect(disk.asked.filter((path) => !win32.isAbsolute(path))).toEqual([])
  })

  it('takes gh.exe alone from PATH, never a gh.cmd', async () => {
    const disk = windowsDisk('C:\\X\\gh.cmd')
    expect(await findGh({ platform: 'win32', env: { PATH: 'C:\\X' }, isFile: disk.isFile })).toBeNull()
  })

  it("prefers PATH's gh.exe over the folders GitHub CLI installs to", async () => {
    const disk = windowsDisk('C:\\X\\gh.exe', 'C:\\Program Files\\GitHub CLI\\gh.exe')
    expect(await findGh({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: 'C:\\X' }, isFile: disk.isFile })).toBe('C:\\X\\gh.exe')
  })

  it("with none on PATH: GitHub CLI's folder in Program Files, then Scoop's shims", async () => {
    const machine = 'C:\\Program Files\\GitHub CLI\\gh.exe'
    const scoop = 'C:\\Users\\ana\\scoop\\shims\\gh.exe'
    const find = (...files: string[]) => findGh({ platform: 'win32', env: { ...WINDOWS_ROOTS, PATH: '' }, isFile: windowsDisk(...files).isFile })
    expect(await find(machine, scoop)).toBe(machine)
    expect(await find(scoop)).toBe(scoop)
  })
})

describe("Scoop's root for everyone", () => {
  it('is never looked in for git or gh: any user of the computer can fill it', async () => {
    // Users may make C:\ProgramData\scoop, a Harness guest included; a real global install puts its shims on PATH.
    const disk = windowsDisk('C:\\ProgramData\\scoop\\shims\\git.exe', 'C:\\ProgramData\\scoop\\shims\\gh.exe',
      'D:\\GlobalScoop\\shims\\git.exe', 'D:\\GlobalScoop\\shims\\gh.exe')
    for (const env of [{ ProgramData: 'C:\\ProgramData', PATH: '' }, { SCOOP_GLOBAL: 'D:\\GlobalScoop', PATH: '' }]) {
      expect(await findGit({ platform: 'win32', env, isFile: disk.isFile })).toBeNull()
      expect(await findGh({ platform: 'win32', env, isFile: disk.isFile })).toBeNull()
    }
  })
})

describe.each(['darwin', 'linux'] as const)('findGit and findGh on %s', (platform) => {
  it("takes the first absolute PATH folder's program before asking the login shell", async () => {
    const tools = folderWith('git', 'gh')
    const env = { PATH: [folderWith(), tools].join(delimiter) }
    const loginShell = async () => '/opt/elsewhere/bin/git'
    expect(await findGit({ platform, env, loginShell })).toBe(join(tools, 'git'))
    expect(await findGh({ platform, env, loginShell })).toBe(join(tools, 'gh'))
  })

  it("asks the login shell when PATH has no git, as launchd's minimal PATH has none", async () => {
    const found = await findGit({ platform, env: { PATH: folderWith() }, loginShell: async () => '/opt/homebrew/bin/git' })
    expect(found).toBe('/opt/homebrew/bin/git')
    expect(isAbsolute(found!)).toBe(true)
  })
})

describe('relative PATH entries', () => {
  it('are skipped on every platform', async () => {
    // The folder git runs in holds a git and a gh of its own, and PATH names it as `.`.
    process.chdir(folderWith('git', 'gh'))
    for (const platform of ['darwin', 'linux'] as const) {
      expect(await findGit({ platform, env: { PATH: '.' }, loginShell: noLoginShell })).toBeNull()
      expect(await findGh({ platform, env: { PATH: '.' }, loginShell: noLoginShell })).toBeNull()
    }
    const disk = windowsDisk('.\\git.exe', '.\\gh.exe')
    expect(await findGit({ platform: 'win32', env: { PATH: '.' }, isFile: disk.isFile })).toBeNull()
    expect(await findGh({ platform: 'win32', env: { PATH: '.' }, isFile: disk.isFile })).toBeNull()
  })
})

describe('createProgramPath', () => {
  it("rejects with the error spawn gives for a missing program, so each caller's ENOENT handling reads it", async () => {
    await expect(createProgramPath('git', async () => null)()).rejects.toMatchObject({ code: 'ENOENT', path: 'git', message: 'spawn git ENOENT' })
    await expect(createProgramPath('gh', async () => null)()).rejects.toMatchObject({ code: 'ENOENT', path: 'gh', message: 'spawn gh ENOENT' })
  })

  it('asks again after a miss, and keeps a find for the process', async () => {
    const answers = [null, '/usr/bin/git']
    let asked = 0
    const missThenFound = createProgramPath('git', async () => answers[asked++] ?? null)
    await expect(missThenFound()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await missThenFound()).toBe('/usr/bin/git')
    expect(await missThenFound()).toBe('/usr/bin/git')
    expect(asked).toBe(2)

    let searches = 0
    const found = createProgramPath('git', async () => { searches += 1; return '/usr/bin/git' })
    expect([await found(), await found()]).toEqual(['/usr/bin/git', '/usr/bin/git'])
    expect(searches).toBe(1)
  })

  it('shares one search among the callers that ask while it runs', async () => {
    let searches = 0
    let answer!: (path: string) => void
    const programPath = createProgramPath('git', () => { searches += 1; return new Promise((resolve) => { answer = resolve }) })
    const both = Promise.all([programPath(), programPath()])
    answer('/usr/bin/git')
    expect(await both).toEqual(['/usr/bin/git', '/usr/bin/git'])
    expect(searches).toBe(1)
  })
})
