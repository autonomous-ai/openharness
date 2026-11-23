/**
 * Claude Code found where its native installer puts it on Windows: `claude.exe` in the profile's `.local\bin`, a folder
 * the installer leaves off PATH (docs/plans/2026-11-19-dial-windows-vm-notes.md `## Task 1` §3). The `.exe` and its
 * paths are Windows' own, so this runs on Windows alone; a Mac run would prove nothing. The stand-in `claude.exe` is a
 * copy of this run's node.exe, in a throwaway profile.
 */
import * as childProcess from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeFound, claudeRun } from './claudePlugin.js'

// A copy of the module, so the test can see every process the lookup and the runs start.
vi.mock('node:child_process', async (original) => ({ ...await original<object>() }))

const profiles: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of profiles.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('Claude Code on Windows', () => {
  it('finds claude.exe in the profile\'s .local\\bin, off PATH', async () => {
    const profile = realpathSync(mkdtempSync(join(tmpdir(), 'harness-profile-')))
    profiles.push(profile)
    const exe = join(profile, '.local', 'bin', 'claude.exe')
    mkdirSync(dirname(exe), { recursive: true })
    copyFileSync(process.execPath, exe)
    vi.stubEnv('USERPROFILE', profile)
    vi.stubEnv('HOME', profile)
    vi.stubEnv('LOCALAPPDATA', join(profile, 'AppData', 'Local'))
    // System32 alone: Windows' own programs, and no claude.
    vi.stubEnv('PATH', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'))
    const started = vi.spyOn(childProcess, 'execFile')

    const runs = [await claudeFound(join(profile, '.claude'), false), await claudeFound(join(profile, '.claude'), true), claudeRun()]

    for (const run of runs) {
      expect(run).not.toBeNull()
      const { code, stdout } = await run!(['-e', 'process.stdout.write(process.execPath)'], 15_000)
      expect(code).toBe(0)
      expect(realpathSync(stdout)).toBe(realpathSync(exe))
    }
    // Every process started was that claude.exe: no shell, for the lookup or a run.
    expect(started.mock.calls.map(([file]) => realpathSync(String(file)))).toEqual(runs.map(() => realpathSync(exe)))
  })
})
