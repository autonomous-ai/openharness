/**
 * engineNearby: an engine where the daemon finds it with no shell started, on Windows with Windows' extensions. The
 * folders are real temp ones; on Windows the PATH is joined with `;` whatever this computer is.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { env } from '../config/env.js'
import type { ProcessEngine } from '../engines/types.js'
import { engineNearby } from './engineBin.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-nearby-'))
  roots.push(root)
  return root
}

function file(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, '')
  return path
}

const windows = (PATH: string, home = folder()) => ({ platform: 'win32' as const, environment: { PATH, LOCALAPPDATA: join(home, 'AppData', 'Local') }, home })

describe('engineNearby on Windows', () => {
  it('finds claude.exe on PATH', () => {
    const empty = folder(), dir = folder()
    const exe = file(dir, 'claude.exe')
    expect(engineNearby('claude', windows(`${empty};${dir}`))).toBe(exe)
  })

  it('finds an npm shim, claude.cmd, on PATH', () => {
    const dir = folder()
    const shim = file(dir, 'claude.cmd')
    expect(engineNearby('claude', windows(dir))).toBe(shim)
  })

  it.each([
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['cursor', 'cursor-agent'],
    ['opencode', 'opencode'],
    ['pi', 'pi'],
    ['commandcode', 'command-code'],
    ['kilo', 'kilo'],
    ['grok', 'grok'],
  ] as [ProcessEngine, string][])('finds %s as %s.exe on PATH', (engine, name) => {
    const dir = folder()
    const exe = file(dir, `${name}.exe`)
    expect(engineNearby(engine, windows(dir))).toBe(exe)
  })

  it('never takes cmd.exe for Command Code', () => {
    const dir = folder()
    file(dir, 'cmd.exe')
    expect(engineNearby('commandcode', windows(dir))).toBeNull()
  })

  it('finds Claude Code where its installer puts it, off PATH', () => {
    const home = folder()
    const exe = file(join(home, '.local', 'bin'), 'claude.exe')
    expect(engineNearby('claude', windows('', home))).toBe(exe)
  })

  it('takes a path override that names the program itself', () => {
    const exe = file(folder(), 'claude.exe')
    const before = env.CLAUDE_PATH
    env.CLAUDE_PATH = exe
    try {
      expect(engineNearby('claude', windows(folder()))).toBe(exe)
    } finally {
      env.CLAUDE_PATH = before
    }
  })
})

describe.skipIf(process.platform === 'win32')('engineNearby off Windows', () => {
  it('off Windows looks as claudeNearby did', () => {
    const dir = folder()
    const bin = file(dir, 'claude')
    chmodSync(bin, 0o755)
    expect(engineNearby('claude', { platform: process.platform, environment: { PATH: dir }, home: folder() })).toBe(bin)
  })
})
