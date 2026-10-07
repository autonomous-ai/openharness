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
    expect(isInstalledCopy(join(dir, 'cli.js'), dir)).toBe(true)
    expect(isInstalledCopy(join(dir, 'link.js'), dir)).toBe(true)
    expect(isInstalledCopy(join(dir, 'hard.js'), dir)).toBe(true)
    expect(isInstalledCopy(join(dir, 'other.js'), dir)).toBe(false)
  })

  it('is matched by path when it cannot be read', () => {
    expect(isInstalledCopy(join(dir, 'cli.js'), dir)).toBe(true)
    expect(isInstalledCopy(join(dir, 'src', 'cli.ts'), dir)).toBe(false)
  })
})
