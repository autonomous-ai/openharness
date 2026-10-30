import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isInstalledCopy } from './installedCopy.js'

describe('the installed copy', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'installed-copy-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is cli.js in the CLI folder, by inode, under any name that reaches it', () => {
    writeFileSync(join(dir, 'cli.js'), 'cli')
    symlinkSync(join(dir, 'cli.js'), join(dir, 'link.js'))
    linkSync(join(dir, 'cli.js'), join(dir, 'hard.js'))
    writeFileSync(join(dir, 'other.js'), 'other')
    expect(isInstalledCopy(join(dir, 'cli.js'), dir, 'linux')).toBe(true)
    expect(isInstalledCopy(join(dir, 'link.js'), dir, 'linux')).toBe(true)
    expect(isInstalledCopy(join(dir, 'hard.js'), dir, 'linux')).toBe(true)
    expect(isInstalledCopy(join(dir, 'other.js'), dir, 'linux')).toBe(false)
  })

  it('is matched by path when it cannot be read', () => {
    expect(isInstalledCopy(join(dir, 'cli.js'), dir, 'linux')).toBe(true)
    expect(isInstalledCopy(join(dir, 'src', 'cli.ts'), dir, 'linux')).toBe(false)
  })

  it('is a version folder\'s cli.js under cli\\ on Windows, compared as Windows compares paths', () => {
    const cli = 'C:\\Users\\d\\.harness\\cli'
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\0.5.0\\cli.js', cli, 'win32')).toBe(true)
    expect(isInstalledCopy('c:\\users\\D\\.HARNESS\\cli\\0.5.1-dev.ab12\\cli.js', cli, 'win32')).toBe(true)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\data\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\Users\\d\\.harness\\cli\\0.5.0\\other.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('C:\\work\\oh\\cli\\dist\\cli.js', cli, 'win32')).toBe(false)
    expect(isInstalledCopy('D:\\cli\\0.5.0\\cli.js', cli, 'win32')).toBe(false)
  })

  it('is the Harness Team account\'s too: its task runs the version folder `cli\\current` names (team/windowsScript.ts)', () => {
    const cli = 'C:\\Users\\harnessteam\\.harness\\cli'
    expect(isInstalledCopy('C:\\Users\\harnessteam\\.harness\\cli\\0.4.97\\cli.js', cli, 'win32')).toBe(true)
    // The flat copy an earlier setup laid down was never the installed one, so its updater never ran.
    expect(isInstalledCopy('C:\\Users\\harnessteam\\.harness\\cli\\cli.js', cli, 'win32')).toBe(false)
  })
})
