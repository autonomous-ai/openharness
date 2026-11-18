import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { CallFailure, expandHome, forbiddenDirs, inside, unc, uploadPath } from './call.js'

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
})

describe('uploadPath', () => {
  let home: string
  beforeEach(() => {
    // The file system's own spelling: on Windows CI the temporary folder is an 8.3 short name (C:\Users\RUNNER~1).
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'harness-upload-')))
    for (const dir of ['.ssh', '.harness', 'docs']) mkdirSync(join(home, dir))
    for (const dir of ['.ssh', '.harness', 'docs']) writeFileSync(join(home, dir, 'note.txt'), 'x')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

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

  it('allows a document elsewhere, also written from ~/', () => {
    expect(uploadPath(join(home, 'docs', 'note.txt'), { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
    expect(uploadPath('~/docs/note.txt', { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
  })
})
