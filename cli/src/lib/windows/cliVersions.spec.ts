import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VERSION_FOLDER, isVersionFolder, replaceFile, switchTo, versionsOnDisk, writeVersionFolder } from './cliVersions.js'

const dirs: string[] = []
const cliDir = () => { const root = mkdtempSync(join(tmpdir(), 'cli-versions-')); dirs.push(root); const cli = join(root, 'cli'); mkdirSync(cli); return cli }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the CLI\'s version folders', () => {
  it('are named after a release\'s version and hold its cli.js and notify.mjs', () => {
    expect(['0.5.0', '0.5.1-dev.ab12', '1.2.3+build'].every((name) => VERSION_FOLDER.test(name))).toBe(true)
    expect(['data', 'current', '..', '0.5', '0.5.0\\x', '.0.5.0.1.tmp'].some((name) => VERSION_FOLDER.test(name))).toBe(false)
    // Semver's identifiers only: Windows drops a trailing dot (`1.2.3-a.` would be `1.2.3-a`'s folder), and the
    // pointer refuses an empty identifier (`1.2.3-a..b` would be a folder nothing could point at).
    expect(['1.2.3-a.', '1.2.3-a..b', '1.2.3-', '1.2.3+', '1.2.3+b.', '1.2.3-a+b..c'].filter((name) => VERSION_FOLDER.test(name))).toEqual([])
    expect(['1.2.3-a.b-c.1', '1.2.3-a+b.c', '1.2.3+b.c-d'].every((name) => VERSION_FOLDER.test(name))).toBe(true)
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    mkdirSync(join(cli, '0.4.0'))
    mkdirSync(join(cli, 'data'))
    expect(isVersionFolder(cli, '0.5.0')).toBe(true)
    expect(isVersionFolder(cli, '0.4.0')).toBe(false)
    expect(versionsOnDisk(cli)).toEqual(['0.5.0'])
    expect(versionsOnDisk(join(cli, 'none'))).toEqual([])
  })

  it('are written whole, through a folder beside them, with the module package metadata', () => {
    const cli = cliDir()
    expect(writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))).toBe(join(cli, '0.5.0'))
    expect(readdirSync(join(cli, '0.5.0')).sort()).toEqual(['cli.js', 'notify.mjs', 'package.json'])
    expect(readFileSync(join(cli, '0.5.0', 'package.json'), 'utf8')).toBe('{"type":"module"}\n')
    expect(readdirSync(cli)).toEqual(['0.5.0'])
    expect(() => writeVersionFolder(cli, '..\\evil', Buffer.from(''), Buffer.from(''))).toThrow(/not a version a folder can be named after/)
  })

  it('keep a folder that already holds these bytes, and move one with other bytes aside', () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    expect(readdirSync(cli)).toEqual(['0.5.0'])
    writeVersionFolder(cli, '0.5.0', Buffer.from('other'), Buffer.from('notify'))
    expect(readFileSync(join(cli, '0.5.0', 'cli.js'), 'utf8')).toBe('other')
    expect(readdirSync(cli).filter((name) => name.endsWith('.old'))).toHaveLength(1)
  })

  it('leave nothing behind when the write fails', () => {
    const cli = cliDir()
    writeFileSync(join(cli, 'blocker'), '')
    expect(() => writeVersionFolder(join(cli, 'blocker'), '0.5.0', Buffer.from(''), Buffer.from(''))).toThrow()
    expect(readdirSync(cli)).toEqual(['blocker'])
  })

  it('switch by moving cli\\current and refreshing the stable notify.mjs the hooks name', () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify 0.5.0'))
    switchTo(cli, '0.5.0')
    expect(readFileSync(join(cli, 'current'), 'utf8').trim()).toBe('0.5.0')
    expect(readFileSync(join(cli, 'notify.mjs'), 'utf8')).toBe('notify 0.5.0')
    // A notify.mjs a running hook holds is left for later: the pointer, which is what runs, has moved.
    const log = vi.fn()
    writeVersionFolder(cli, '0.5.1', Buffer.from('cli'), Buffer.from('notify 0.5.1'))
    rmSync(join(cli, 'notify.mjs'))
    mkdirSync(join(cli, 'notify.mjs'))
    switchTo(cli, '0.5.1', log)
    expect(readFileSync(join(cli, 'current'), 'utf8').trim()).toBe('0.5.1')
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[update\] the hooks' notify\.mjs could not be refreshed yet/))
  })
})

describe('replacing a file a hook may hold', () => {
  it('tries again while Windows says the file is busy, and gives up on anything else', () => {
    const cli = cliDir()
    const file = join(cli, 'notify.mjs')
    let busy = 2
    const rename = vi.fn((from: string, to: string) => {
      if (busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      writeFileSync(to, readFileSync(from)); rmSync(from)
    })
    replaceFile(file, Buffer.from('new'), rename, 3, 0)
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(rename).toHaveBeenCalledTimes(3)
    const denied = vi.fn(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    expect(() => replaceFile(file, Buffer.from('x'), denied, 2, 0)).toThrow('EACCES')
    expect(denied).toHaveBeenCalledTimes(2)
    const missing = vi.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    expect(() => replaceFile(file, Buffer.from('x'), missing, 5, 0)).toThrow('ENOENT')
    expect(missing).toHaveBeenCalledTimes(1)
    expect(readdirSync(cli)).toEqual(['notify.mjs'])
  })
})
