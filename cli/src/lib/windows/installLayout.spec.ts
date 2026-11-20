import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLI_POINTER, LAUNCH_EXE, currentCli, harnessLaunchPath, isSingleSegment, readPointer, writePointer,
} from './installLayout.js'
import { STABLE_NOTIFY } from './installNames.js'
import { directorySyncSupported } from '../secureState.js'

// Pass-through, noting each path written or opened by name and each rename's target; `order`: each flush (of a file or
// a folder) and each rename, as they happened.
const io = vi.hoisted(() => ({ written: [] as string[], renamedOnto: [] as string[], order: [] as string[] }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>) => {
    if (typeof args[0] !== 'number') io.written.push(String(args[0]))
    return actual.writeFileSync(...args)
  }
  const openSync = (...args: Parameters<typeof actual.openSync>) => { io.written.push(String(args[0])); return actual.openSync(...args) }
  const renameSync = (...args: Parameters<typeof actual.renameSync>) => {
    io.renamedOnto.push(String(args[1]))
    io.order.push(`rename ${String(args[1])}`)
    return actual.renameSync(...args)
  }
  const fsyncSync = (fd: number) => { io.order.push(actual.fstatSync(fd).isDirectory() ? 'flush folder' : 'flush file'); return actual.fsyncSync(fd) }
  const wrapped = { writeFileSync, openSync, renameSync, fsyncSync }
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } }
})

const roots: string[] = []
afterEach(() => {
  io.written.length = 0
  io.renamedOnto.length = 0
  io.order.length = 0
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-layout-'))
  roots.push(root)
  return root
}

describe('pointer files', () => {
  it('reads the first line, trimmed, whichever line ending wrote it', () => {
    const root = scratch()
    writeFileSync(join(root, 'crlf'), '1.2.3\r\n')
    writeFileSync(join(root, 'lf'), '  0.3.120-dev.abc123  \nignored\n')
    expect(readPointer(root, 'crlf')).toBe('1.2.3')
    expect(readPointer(root, 'lf')).toBe('0.3.120-dev.abc123')
  })

  it('has no answer for a missing or empty pointer', () => {
    const root = scratch()
    writeFileSync(join(root, 'empty'), '\r\n')
    expect(readPointer(root, 'missing')).toBeNull()
    expect(readPointer(root, 'empty')).toBeNull()
  })

  it('refuses a pointer that could name anything but one folder beside it', () => {
    const root = scratch()
    for (const value of ['..', '.', '../1.2.3', '1.2.3\\..\\x', 'a/b', 'a\\b', 'C:x', 'x..y', 'notify.mjs:stream']) {
      writeFileSync(join(root, 'p'), `${value}\r\n`)
      expect(readPointer(root, 'p'), value).toBeNull()
      expect(isSingleSegment(value), value).toBe(false)
    }
  })

  it('writes the value and CRLF, with no BOM, through a temporary file that does not stay', () => {
    const root = scratch()
    writePointer(root, 'current', '1.2.3')
    expect(readFileSync(join(root, 'current'))).toEqual(Buffer.from('1.2.3\r\n'))
    writePointer(root, 'current', '1.2.4')
    expect(readPointer(root, 'current')).toBe('1.2.4')
    expect(readdirSync(root)).toEqual(['current'])
  })

  it('the save goes through a temporary file renamed onto the target', () => {
    const root = scratch()
    const target = join(root, 'current')
    writePointer(root, 'current', '1.2.2')
    writePointer(root, 'current', '1.2.3')
    expect(io.renamedOnto).toEqual([target, target])
    expect(io.written).not.toContain(target)
  })

  // An emptied pointer (cli\current, current-pty) stops Harness from starting until a reinstall; it moves once an update.
  it('flushes the pointer before it is renamed into place, and its folder after', () => {
    const root = scratch()
    writePointer(root, 'current', '1.2.3')
    expect(io.order).toEqual(['flush file', `rename ${join(root, 'current')}`, ...(directorySyncSupported() ? ['flush folder'] : [])])
  })

  it('a file at the old temporary name is left alone', () => {
    const root = scratch()
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const planted = join(root, `.current.tmp-${process.pid}-1000`)
    writeFileSync(planted, 'not ours')
    writePointer(root, 'current', '1.2.3')
    expect(readFileSync(planted, 'utf8')).toBe('not ours')
    expect(readPointer(root, 'current')).toBe('1.2.3')
  })

  it('refuses to write a pointer its readers would refuse', () => {
    const root = scratch()
    expect(() => writePointer(root, 'current', '..\\escape')).toThrow('one folder')
    expect(readdirSync(root)).toEqual([])
  })
})

describe('currentCli', () => {
  function installed(root: string, version: string): string {
    const dir = join(root, 'cli', version)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cli.js'), '')
    writeFileSync(join(dir, 'notify.mjs'), '')
    writeFileSync(join(root, 'cli', CLI_POINTER), `${version}\r\n`)
    return dir
  }

  it('names the version folder cli\\current points at, and its two files', () => {
    const root = scratch()
    const dir = installed(root, '1.2.3')
    expect(currentCli(root)).toEqual({ version: '1.2.3', dir, cliJs: join(dir, 'cli.js'), notifyMjs: join(dir, STABLE_NOTIFY) })
  })

  it('has no answer without a pointer, or for a folder missing either file', () => {
    const root = scratch()
    expect(currentCli(root)).toBeNull()
    const dir = installed(root, '1.2.3')
    rmSync(join(dir, 'notify.mjs'))
    expect(currentCli(root)).toBeNull()
    writeFileSync(join(root, 'cli', CLI_POINTER), 'data\r\n')
    mkdirSync(join(root, 'cli', 'data'), { recursive: true })
    expect(currentCli(root)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a version folder that resolves outside cli\\', () => {
    const root = scratch()
    const outside = installed(scratch(), '9.9.9')
    mkdirSync(join(root, 'cli'), { recursive: true })
    symlinkSync(outside, join(root, 'cli', '9.9.9'))
    writeFileSync(join(root, 'cli', CLI_POINTER), '9.9.9\r\n')
    expect(currentCli(root)).toBeNull()
  })

  it('puts the windowless starter in bin\\', () => {
    expect(harnessLaunchPath(join('R', '.harness'))).toBe(join('R', '.harness', 'bin', LAUNCH_EXE))
    expect(LAUNCH_EXE).toBe('harness-launch.exe')
  })
})
