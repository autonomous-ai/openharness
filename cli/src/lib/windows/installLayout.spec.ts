import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLI_POINTER, LAUNCH_EXE, STABLE_NOTIFY, currentCli, harnessLaunchPath, isSingleSegment, readPointer, writePointer, type PointerFs,
} from './installLayout.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-layout-'))
  roots.push(root)
  return root
}

/** A rename that fails with each code in [failures] in turn, then renames for real; and the waits between. */
function flaky(failures: string[]): PointerFs & { sleeps: number[]; calls: () => number } {
  const sleeps: number[] = []
  let calls = 0
  return {
    sleeps,
    calls: () => calls,
    sleep: (ms) => { sleeps.push(ms) },
    rename: (from, to) => {
      const code = failures[calls++]
      if (code) throw Object.assign(new Error(code), { code })
      renameSync(from, to)
    },
  }
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

  it('retries a rename an antivirus scan or the indexer holds, waiting longer each time', () => {
    const root = scratch()
    const fs = flaky(['EPERM', 'EBUSY', 'EACCES'])
    writePointer(root, 'current', '1.2.3', fs)
    expect(readPointer(root, 'current')).toBe('1.2.3')
    expect(fs.sleeps).toEqual([25, 50, 100])
  })

  it('gives up after five attempts, throws, and leaves no temporary file', () => {
    const root = scratch()
    writeFileSync(join(root, 'current'), '1.2.2\r\n')
    const fs = flaky(['EBUSY', 'EBUSY', 'EBUSY', 'EBUSY', 'EBUSY'])
    expect(() => writePointer(root, 'current', '1.2.3', fs)).toThrow('EBUSY')
    expect(fs.calls()).toBe(5)
    expect(readdirSync(root)).toEqual(['current'])
    expect(readPointer(root, 'current')).toBe('1.2.2')
  })

  it('does not retry a failure waiting cannot fix', () => {
    const root = scratch()
    const fs = flaky(['ENOENT'])
    expect(() => writePointer(root, 'current', '1.2.3', fs)).toThrow('ENOENT')
    expect(fs.calls()).toBe(1)
    expect(fs.sleeps).toEqual([])
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
