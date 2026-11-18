import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { CallFailure, expandHome, fenced, forbiddenDirs, inside, tempDir, unc, uploadPath } from './call.js'

// The account's own home, which a test that needs one points at a folder of its own: no test writes in the real one.
const account = vi.hoisted(() => ({ home: undefined as string | undefined }))
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, userInfo: () => ({ ...os.userInfo(), homedir: account.home ?? os.userInfo().homedir }) }
})

describe('inside', () => {
  it('fences a Windows folder however its path is spelled', () => {
    expect(inside('C:\\Users\\a\\.ssh', 'C:\\Users\\a\\.ssh\\id.txt', win32)).toBe(true)
    expect(inside('C:\\Users\\a\\.ssh', 'c:\\users\\A\\.SSH\\x.txt', win32)).toBe(true)
    expect(inside('C:\\Users\\a\\.ssh', 'C:\\Users\\a\\.ssh', win32)).toBe(true)
    expect(inside('C:\\Users\\a\\.ssh', 'C:\\Users\\a\\.ssh\\..notes.txt', win32)).toBe(true)
    expect(inside('C:\\Users\\a\\.ssh', 'C:\\Users\\a\\.sshx\\f.txt', win32)).toBe(false)
    expect(inside('C:\\Users\\a\\.ssh', 'D:\\Users\\a\\.ssh\\f.txt', win32)).toBe(false)
    expect(inside('C:\\Users\\a\\.ssh', 'C:\\Users\\a\\f.txt', win32)).toBe(false)
  })

  it('fences a posix folder', () => {
    expect(inside('/home/a/.ssh', '/home/a/.ssh/id.txt', posix)).toBe(true)
    expect(inside('/home/a/.ssh', '/home/a/.ssh', posix)).toBe(true)
    expect(inside('/home/a/.ssh', '/home/a/.ssh/..notes.txt', posix)).toBe(true)
    expect(inside('/home/a/.ssh', '/home/a/.sshx/f.txt', posix)).toBe(false)
    expect(inside('/home/a/.ssh', '/home/a/f.txt', posix)).toBe(false)
  })
})

describe('expandHome', () => {
  it('expands ~\\ on Windows', () => {
    expect(expandHome('~\\.ssh\\id.txt', 'C:\\Users\\a', win32)).toBe('C:\\Users\\a\\.ssh\\id.txt')
    expect(expandHome('~/.ssh/id.txt', 'C:\\Users\\a', win32)).toBe('C:\\Users\\a/.ssh/id.txt')
  })

  it('leaves ~\\ alone on posix, where a backslash is part of a name', () => {
    expect(expandHome('~\\.ssh', '/home/a', posix)).toBe('~\\.ssh')
    expect(expandHome('~/.ssh', '/home/a', posix)).toBe('/home/a/.ssh')
    expect(expandHome('~', '/home/a', posix)).toBe('/home/a')
  })
})

describe('unc', () => {
  it('is a Windows path through a share, the local disk\'s admin share too', () => {
    expect(unc('\\\\localhost\\C$\\Users\\a\\x.txt', win32)).toBe(true)
    expect(unc('\\\\server\\share\\x.txt', win32)).toBe(true)
    expect(unc('C:\\Users\\a\\Pictures\\x.png', win32)).toBe(false)
  })

  it('is never a posix path', () => {
    expect(unc('//server/share/x.txt', posix)).toBe(false)
  })
})

describe('forbiddenDirs', () => {
  it('fences the folders under every home, once each', () => {
    const dirs = forbiddenDirs({ HOME: '/tmp/h' }, ['/home/a', '/tmp/h'], posix)
    expect(dirs).toEqual(expect.arrayContaining(['/tmp/h/.ssh', '/home/a/.ssh', '/home/a/.local/share', '/home/a/.claude']))
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('fences the folders under HOME, USERPROFILE and the account\'s own home on Windows', () => {
    expect(forbiddenDirs({ HOME: 'C:\\h', USERPROFILE: 'C:\\Users\\a' }, ['C:\\Users\\b'], win32)).toEqual(expect.arrayContaining(
      ['C:\\h\\.ssh', 'C:\\Users\\a\\.ssh', 'C:\\Users\\b\\.ssh', 'C:\\Users\\b\\.local\\share']))
  })

  it('fences AppData under every home on Windows, and the folders APPDATA and LOCALAPPDATA name', () => {
    expect(forbiddenDirs({ HOME: 'C:\\h', APPDATA: 'D:\\roaming', LOCALAPPDATA: 'D:\\local' }, ['C:\\Users\\a'], win32)).toEqual(expect.arrayContaining(
      ['C:\\h\\AppData', 'C:\\Users\\a\\AppData', 'D:\\roaming', 'D:\\local']))
  })

  it('fences no AppData on posix', () => {
    const env = { HOME: '/tmp/h', HARNESS_CONNECTIONS_DIR: '/tmp/c', APPDATA: '/tmp/roaming', LOCALAPPDATA: '/tmp/local' }
    expect(forbiddenDirs(env, [], posix)).toEqual(['/tmp/c', '/tmp/h/.ssh', '/tmp/h/.gnupg', '/tmp/h/.config', '/tmp/h/.local/share',
      '/tmp/h/.harness', '/tmp/h/.codex', '/tmp/h/.claude', '/etc', '/proc', '/sys'])
  })
})

describe('fenced', () => {
  const home = 'C:\\Users\\a'
  const refuses = (file: string, env: NodeJS.ProcessEnv = { USERPROFILE: home }): boolean =>
    fenced(file, forbiddenDirs(env, [home], win32), tempDir(home, win32), win32)

  it('refuses a file in AppData on Windows', () => {
    expect(refuses('C:\\Users\\a\\AppData\\Roaming\\x.txt')).toBe(true)
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Foo\\x.txt')).toBe(true)
    expect(refuses('C:\\Users\\a\\AppData\\LocalLow\\Foo\\x.txt')).toBe(true)
  })

  it('allows a file in the home\'s own AppData\\Local\\Temp', () => {
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Temp\\x.txt')).toBe(false)
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Temp\\docs\\x.txt')).toBe(false)
  })

  it('opens no folder TEMP or TMP names, which are the caller\'s to set', () => {
    const env = { USERPROFILE: home, TEMP: 'C:\\Users\\a\\AppData\\Roaming', TMP: 'C:\\Users\\a\\AppData\\Local\\Foo' }
    expect(refuses('C:\\Users\\a\\AppData\\Roaming\\x.txt', env)).toBe(true)
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Foo\\x.txt', env)).toBe(true)
  })

  it('refuses a file in AppData\\Local\\Temp that another forbidden folder holds', () => {
    const env = { HOME: 'C:\\Users\\a\\AppData\\Local\\Temp\\h' }
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Temp\\h\\.ssh\\id.txt', env)).toBe(true)
    expect(refuses('C:\\Users\\a\\AppData\\Local\\Temp\\h\\AppData\\Roaming\\x.txt', env)).toBe(true)
  })

  it('fences posix folders as before, with no temporary folder', () => {
    const forbidden = forbiddenDirs({ HOME: '/home/a' }, [], posix)
    expect(tempDir('/home/a', posix)).toBeUndefined()
    expect(fenced('/home/a/.ssh/id.txt', forbidden, undefined, posix)).toBe(true)
    expect(fenced('/home/a/docs/x.txt', forbidden, undefined, posix)).toBe(false)
  })
})

describe('uploadPath', () => {
  let home: string
  beforeEach(() => {
    // The file system's own spelling: on Windows CI the temporary folder is an 8.3 short name (C:\Users\RUNNER~1).
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'harness-upload-')))
    for (const dir of ['.ssh', '.harness', 'docs']) mkdirSync(join(home, dir))
    for (const dir of ['.ssh', '.harness', 'docs']) writeFileSync(join(home, dir, 'note.txt'), 'x')
  })
  afterEach(() => {
    account.home = undefined
    rmSync(home, { recursive: true, force: true })
  })

  const refused = (raw: string): unknown => { try { uploadPath(raw, { HOME: home }); return null } catch (error) { return error } }
  const expectFenced = (raw: string): void => {
    const error = refused(raw)
    expect(error, raw).toBeInstanceOf(CallFailure)
    expect((error as CallFailure).code, raw).toBe(2)
    expect((error as CallFailure).message, raw).toMatch(/not a media file/)
  }

  it('refuses a file inside a folder where credentials or configs live', () => {
    for (const dir of ['.ssh', '.harness']) expectFenced(join(home, dir, 'note.txt'))
  })

  it('refuses it under the account\'s own home, whatever home HOME names', () => {
    account.home = home
    expect(() => uploadPath(join(home, '.ssh', 'note.txt'), { HOME: join(home, 'docs') })).toThrow(/not a media file/)
  })

  it('refuses it however the path is spelled, where the file system reads the spelling as that folder', () => {
    const file = join(home, '.ssh', 'note.txt')
    // Another case (macOS, Windows), the temporary folder as given (a link on macOS, an 8.3 short name on Windows CI),
    // and Windows' \\?\ prefix. A spelling this file system does not read as the file is not one to fence.
    const spellings = [join(home, '.SSH', 'note.txt'), join(tmpdir(), basename(home), '.ssh', 'note.txt'), `\\\\?\\${file}`]
    for (const spelling of spellings.filter(spelling => existsSync(spelling))) expectFenced(spelling)
  })

  it('refuses a hard link, whose other names may be inside such a folder', () => {
    linkSync(join(home, '.ssh', 'note.txt'), join(home, 'docs', 'link.txt'))
    expectFenced(join(home, 'docs', 'link.txt'))
  })

  // A UNC path exists only on Windows, and only where this account reaches the local disk's admin share.
  it.skipIf(process.platform !== 'win32')('refuses a file through a share on Windows, even one allowed by its local path', ctx => {
    const share = `\\\\localhost\\${home[0]}$${home.slice(2)}\\docs\\note.txt`
    if (!existsSync(share)) ctx.skip()
    expectFenced(share)
  })

  // A junction needs no admin rights, but only Windows has one, and only there is AppData fenced. On Windows CI `home`
  // is in the account's own AppData\Local\Temp, so the junction is inside the one folder of AppData left open.
  it.skipIf(process.platform !== 'win32')('refuses a file reached through a junction to AppData\\Roaming, from the temporary folder too', () => {
    const app = join(home, 'AppData', 'Roaming', 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'note.txt'), 'x')
    symlinkSync(app, join(home, 'docs', 'app'), 'junction')
    expectFenced(join(home, 'docs', 'app', 'note.txt'))
  })

  // On Windows the temporary folder holding `home` is the account's AppData\Local\Temp, inside the fenced AppData.
  it('allows a document elsewhere, also written from ~/', () => {
    expect(uploadPath(join(home, 'docs', 'note.txt'), { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
    expect(uploadPath('~/docs/note.txt', { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
  })
})
