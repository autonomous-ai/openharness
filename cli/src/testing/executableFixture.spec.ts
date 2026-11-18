import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeExecutable } from './executableFixture.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

describe('writeExecutable', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'executable-fixture-'))
    vi.mocked(spawnSync).mockClear()
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.skipIf(process.platform === 'win32')('leaves the real script, owner-only executable, and runs it once before', () => {
    const file = join(dir, 'tool')
    writeExecutable(file, '#!/bin/sh\necho marker "$@"\nexit 7\n')

    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho marker "$@"\nexit 7\n')
    expect(statSync(file).mode & 0o777).toBe(0o700)
    expect(vi.mocked(spawnSync).mock.calls.map(([command]) => command)).toEqual([file])
    let status = 0
    let stdout = ''
    try {
      execFileSync(file, ['now'], { encoding: 'utf8' })
    } catch (error) {
      ({ status, stdout } = error as { status: number; stdout: string })
    }
    expect({ status, stdout }).toEqual({ status: 7, stdout: 'marker now\n' })
  })

  // gitProject.spec.ts takes this Mac for Windows before it writes its taskkill, which this Mac then runs.
  it.skipIf(process.platform === 'win32')('runs the file once while a test takes this machine for Windows', () => {
    const file = join(dir, 'taskkill')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      writeExecutable(file, '#!/bin/sh\nexit 1\n')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }

    expect(vi.mocked(spawnSync).mock.calls.map(([command]) => command)).toEqual([file])
  })

  it('on Windows only writes the file: there is no /bin/sh to run it', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      writeExecutable(join(dir, 'tool.cmd'), '@echo off\r\n')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }

    expect(readFileSync(join(dir, 'tool.cmd'), 'utf8')).toBe('@echo off\r\n')
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
