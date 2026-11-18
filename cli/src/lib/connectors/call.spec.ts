import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { CallFailure, expandHome, inside, uploadPath } from './call.js'

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

describe('uploadPath', () => {
  let home: string
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'harness-upload-')))
    for (const dir of ['.ssh', '.harness', 'docs']) mkdirSync(join(home, dir))
    for (const dir of ['.ssh', '.harness', 'docs']) writeFileSync(join(home, dir, 'note.txt'), 'x')
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const refused = (raw: string): unknown => { try { uploadPath(raw, { HOME: home }); return null } catch (error) { return error } }

  it('refuses a file inside a folder where credentials or configs live', () => {
    for (const dir of ['.ssh', '.harness']) {
      const error = refused(join(home, dir, 'note.txt'))
      expect(error).toBeInstanceOf(CallFailure)
      expect((error as CallFailure).code).toBe(2)
    }
  })

  it('allows a document elsewhere, also written from ~/', () => {
    expect(uploadPath(join(home, 'docs', 'note.txt'), { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
    expect(uploadPath('~/docs/note.txt', { HOME: home })).toBe(join(home, 'docs', 'note.txt'))
  })
})
