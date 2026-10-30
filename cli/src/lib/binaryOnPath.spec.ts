import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { binaryOnPath, windowsLaunchCommand } from './binaryOnPath.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function dirWith(name: string | null, mode = 0o755): string {
  const dir = mkdtempSync(join(tmpdir(), 'bin-on-path-'))
  dirs.push(dir)
  if (name) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name), mode)
  }
  return dir
}

describe('binaryOnPath', () => {
  it('finds an executable by name on PATH', () => {
    expect(binaryOnPath('codex', { PATH: dirWith('codex') })).toBe(true)
  })

  // The case behind the report: the machine has claude but not codex, so "New agent → Codex" can only
  // fail. Saying WHICH is the whole point — tmux reports success for a command that does not exist.
  it('reports a name that is on no PATH entry', () => {
    expect(binaryOnPath('codex', { PATH: `${dirWith('claude')}${delimiter}${dirWith(null)}` })).toBe(false)
  })

  it('requires the executable bit, not just the file', () => {
    expect(binaryOnPath('codex', { PATH: dirWith('codex', 0o644) })).toBe(false)
  })

  it('checks an explicit path directly instead of searching PATH', () => {
    const dir = dirWith('codex')
    expect(binaryOnPath(join(dir, 'codex'), { PATH: '' })).toBe(true)
    expect(binaryOnPath(join(dir, 'nope'), { PATH: dir })).toBe(false)
  })

  it('handles an empty or absent PATH and an empty name', () => {
    expect(binaryOnPath('codex', {})).toBe(false)
    expect(binaryOnPath('', { PATH: dirWith('codex') })).toBe(false)
  })
})

describe('windowsLaunchCommand', () => {
  /** A folder as npm leaves a global CLI on Windows: the sh script, the .cmd and the .ps1 shims. */
  function npmFolder(...names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'win-launch-'))
    dirs.push(dir)
    for (const name of names) writeFileSync(join(dir, name), '')
    return dir
  }

  it('names the .cmd shim of an npm global CLI, never its .ps1 or sh script', () => {
    const npm = npmFolder('codex', 'codex.cmd', 'codex.ps1')
    expect(windowsLaunchCommand('codex', { PATH: `${npmFolder()};${npm}` }, 'win32')).toBe(join(npm, 'codex.cmd'))
  })

  it('prefers the native exe, and keeps PATH order', () => {
    const native = npmFolder('claude.exe'), npm = npmFolder('claude', 'claude.cmd', 'claude.ps1')
    expect(windowsLaunchCommand('claude', { PATH: `${native};${npm}` }, 'win32')).toBe(join(native, 'claude.exe'))
    expect(windowsLaunchCommand('claude', { PATH: `${npm};${native}` }, 'win32')).toBe(join(npm, 'claude.cmd'))
    expect(windowsLaunchCommand('claude', { Path: native }, 'win32')).toBe(join(native, 'claude.exe'))
  })

  it('swaps a configured .ps1 for its program, and completes a path without an extension', () => {
    const npm = npmFolder('opencode', 'opencode.cmd', 'opencode.ps1')
    expect(windowsLaunchCommand(join(npm, 'opencode.ps1'), { PATH: '' }, 'win32')).toBe(join(npm, 'opencode.cmd'))
    expect(windowsLaunchCommand(join(npm, 'opencode'), { PATH: '' }, 'win32')).toBe(join(npm, 'opencode.cmd'))
  })

  it('leaves a program, a name it cannot find, and every other platform alone', () => {
    const npm = npmFolder('codex', 'codex.cmd', 'codex.ps1')
    expect(windowsLaunchCommand('C:\\tools\\codex.EXE', { PATH: npm }, 'win32')).toBe('C:\\tools\\codex.EXE')
    expect(windowsLaunchCommand('codex.cmd', { PATH: npm }, 'win32')).toBe('codex.cmd')
    expect(windowsLaunchCommand('codex', { PATH: npmFolder('codex.ps1') }, 'win32')).toBe('codex')
    expect(windowsLaunchCommand('codex', {}, 'win32')).toBe('codex')
    expect(windowsLaunchCommand('', { PATH: npm }, 'win32')).toBe('')
    expect(windowsLaunchCommand('codex', { PATH: npm }, 'darwin')).toBe('codex')
    expect(windowsLaunchCommand('codex', { PATH: npm }, 'linux')).toBe('codex')
  })
})
