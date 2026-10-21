import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VERSION_FOLDER, isVersionFolder, processRetireDeps, replaceFile, retireUnused, switchTo, versionsOnDisk, writeVersionFolder } from './cliVersions.js'

// A disk that fills up partway through a write: the file is left with half its bytes, and the write throws.
const fault = vi.hoisted(() => ({ at: null as ((file: string) => boolean) | null }))
vi.mock('node:fs', async (real) => {
  const actual = await real<typeof import('node:fs')>()
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    const [file, data] = args
    if (!fault.at?.(String(file))) return actual.writeFileSync(...args)
    actual.writeFileSync(file, String(data).slice(0, 1))
    throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
  }
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync }
})

// A's process table, as this computer's retirement reads it.
const table = vi.hoisted(() => ({ rows: vi.fn() }))
vi.mock('./processTable.js', () => ({ windowsProcessRows: table.rows }))

const dirs: string[] = []
const cliDir = () => { const root = mkdtempSync(join(tmpdir(), 'cli-versions-')); dirs.push(root); const cli = join(root, 'cli'); mkdirSync(cli); return cli }
afterEach(() => { fault.at = null; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

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

  it('leave nothing behind when the write fails, and the folder there before as it was', () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.5.0', Buffer.from('cli'), Buffer.from('notify'))
    // The folder beside it is made, and holds package.json, when its cli.js cannot be written whole.
    fault.at = (file) => file === join(cli, `.0.5.0.${process.pid}.tmp`, 'cli.js')
    expect(() => writeVersionFolder(cli, '0.5.0', Buffer.from('other'), Buffer.from('notify'))).toThrow('ENOSPC')
    expect(readdirSync(cli)).toEqual(['0.5.0'])
    expect(readFileSync(join(cli, '0.5.0', 'cli.js'), 'utf8')).toBe('cli')
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

  it('leaves no part-written file beside it when the write fails', () => {
    const cli = cliDir()
    const file = join(cli, 'notify.mjs')
    writeFileSync(file, 'old')
    fault.at = (path) => path.startsWith(`${file}.`)
    expect(() => replaceFile(file, Buffer.from('new'), renameSync, 1, 0)).toThrow('ENOSPC')
    expect(readdirSync(cli)).toEqual(['notify.mjs'])
    expect(readFileSync(file, 'utf8')).toBe('old')
  })
})

describe('retiring older builds', () => {
  const rows = (...args: string[]) => async () => args.map((line, i) => ({ pid: 100 + i, parentPid: 1, executable: 'node.exe', startMarker: 'w:1', args: line }))

  it('removes builds and leftovers outside the ones to keep, unless a process runs from one', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.5.1', '0.5.2', '0.4.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    mkdirSync(join(cli, '.0.3.0.1.old'))
    mkdirSync(join(cli, '.0.5.3.999.tmp'))
    const stale = join(cli, '.0.5.4.998.tmp')
    mkdirSync(stale)
    utimesSync(stale, new Date(Date.now() - 2 * 3_600_000), new Date(Date.now() - 2 * 3_600_000))
    mkdirSync(join(cli, 'data'))
    const removed = await retireUnused(cli, new Set(['0.5.2', '0.5.1']), {
      rows: rows(`node ${join(cli, '0.4.0', 'cli.js')} __run`), remove: (path) => rmSync(path, { recursive: true, force: true }), log: () => {},
    })
    expect(removed.sort()).toEqual(['.0.3.0.1.old', '.0.5.4.998.tmp', '0.5.0'])
    expect(readdirSync(cli).sort()).toEqual(['.0.5.3.999.tmp', '0.4.0', '0.5.1', '0.5.2', 'data'])
  })

  it('removes nothing it cannot see is unused, and tries again later what it cannot remove yet', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.4.0', '0.3.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    const log = vi.fn()
    expect(await retireUnused(cli, new Set(['0.5.0']), { rows: async () => null, remove: () => { throw new Error('no') }, log })).toEqual([])
    expect(log).toHaveBeenCalledWith('[update] the process table could not be read — the older CLI builds stay for now')
    const removed = await retireUnused(cli, new Set(['0.5.0']), {
      rows: rows(), log,
      remove: (path) => { if (path.endsWith('0.4.0')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); rmSync(path, { recursive: true }) },
    })
    expect(removed).toEqual(['0.3.0'])
    expect(log).toHaveBeenLastCalledWith('[update] 0.4.0 could not be removed yet (EBUSY) — trying again later')
    expect(await retireUnused(join(cli, 'none'), new Set(), { rows: rows(), remove: () => {}, log })).toEqual([])
  })

  it('asks which builds to keep again once the process table is read, and removes nothing when none can be said', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.4.0', '0.3.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    const remove = (path: string) => rmSync(path, { recursive: true, force: true })
    let keep: Set<string> | null = new Set(['0.5.0'])
    const rows = async () => { keep = new Set(['0.5.0', '0.3.0']); return [] }
    expect(await retireUnused(cli, () => keep, { rows, remove, log: () => {} })).toEqual(['0.4.0'])
    const lost = async () => { keep = null; return [] }
    keep = new Set(['0.5.0'])
    expect(await retireUnused(cli, () => keep, { rows: lost, remove, log: () => {} })).toEqual([])
    const unread = vi.fn(async () => [])
    expect(await retireUnused(cli, () => null, { rows: unread, remove, log: () => {} })).toEqual([])
    expect(unread).not.toHaveBeenCalled()
    expect(readdirSync(cli).sort()).toEqual(['0.3.0', '0.5.0'])
  })

  it('leaves a build a process\'s executable sits in, whatever the case or slashes', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.4.0', '0.3.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    const remove = (path: string) => rmSync(path, { recursive: true, force: true })
    const running = async () => [
      { pid: 7, parentPid: 1, executable: join(cli, '0.4.0', 'helper.exe').toUpperCase(), startMarker: 'w:1', args: 'helper' },
      { pid: 8, parentPid: 1, executable: 'node.exe', startMarker: 'w:2', args: 'node', imagePath: `${join(cli, '0.3.0').replace(/\\/g, '/')}/x.exe` },
    ]
    expect(await retireUnused(cli, new Set(['0.5.0']), { rows: running, remove, log: () => {} })).toEqual([])
    // A name that only starts with a build's (0.4.0 in 0.4.01's path) is not that build.
    const elsewhere = async () => [{ pid: 9, parentPid: 1, executable: 'node.exe', startMarker: 'w:3', args: `node ${join(cli, '0.4.01', 'cli.js')}` }]
    expect((await retireUnused(cli, new Set(['0.5.0']), { rows: elsewhere, remove, log: () => {} })).sort()).toEqual(['0.3.0', '0.4.0'])
  })

  it('tries again at the next pass a build it removed only in part', async () => {
    const cli = cliDir()
    for (const version of ['0.5.0', '0.4.0']) writeVersionFolder(cli, version, Buffer.from(version), Buffer.from('n'))
    const log = vi.fn()
    // Windows removes the files it can and refuses the one still open: cli.js went, notify.mjs stayed.
    const partly = (path: string) => { rmSync(join(path, 'cli.js')); throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) }
    expect(await retireUnused(cli, new Set(['0.5.0']), { rows: async () => [], remove: partly, log })).toEqual([])
    expect(isVersionFolder(cli, '0.4.0')).toBe(false)
    const remove = (path: string) => rmSync(path, { recursive: true, force: true })
    expect(await retireUnused(cli, new Set(['0.5.0']), { rows: async () => [], remove, log })).toEqual(['0.4.0'])
    expect(readdirSync(cli)).toEqual(['0.5.0'])
  })

  it('on this computer, reads A\'s process table, removes a whole folder and says so in the daemon log', async () => {
    const cli = cliDir()
    writeVersionFolder(cli, '0.4.0', Buffer.from('cli'), Buffer.from('n'))
    const deps = processRetireDeps()
    deps.remove(join(cli, '0.4.0'))
    deps.remove(join(cli, 'gone already'))
    expect(readdirSync(cli)).toEqual([])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    deps.log('a line')
    expect(log).toHaveBeenCalledWith('a line')
    log.mockRestore()
    const row = { pid: 7, parentPid: 1, executable: 'node.exe', startMarker: 'w:1', args: 'node' }
    table.rows.mockResolvedValueOnce([row])
    // From the host binary, with no host connection of its own.
    await expect(deps.rows()).resolves.toEqual([row])
    expect(table.rows).toHaveBeenCalledExactlyOnceWith(null)
  })
})
