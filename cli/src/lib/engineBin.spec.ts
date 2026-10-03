import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  cursorRuntimeBin,
  ENGINE_CLI_COMMANDS,
  PROCESS_ENGINES,
  executableFileIdentity,
  installedEngineBin,
} from './engineBin.js'

const originalPath = process.env.PATH
const tempDirs: string[] = []
const overlayInodes = vi.hoisted(() => new Map<string, bigint>())

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, statSync: (path: Parameters<typeof fs.statSync>[0], options?: { bigint?: boolean }) => {
    const value = fs.statSync(path, options)
    const inode = overlayInodes.get(String(path))
    if (value && inode !== undefined) Object.assign(value, { ino: options?.bigint ? inode : Number(BigInt.asUintN(64, inode)) })
    return value
  } }
})

afterEach(() => {
  process.env.PATH = originalPath
  overlayInodes.clear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('canonical engine CLI commands', () => {
  it('keeps distinct live-USB executables distinct above the JS integer limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-live-inodes-'))
    tempDirs.push(root)
    const opencode = join(root, 'opencode'), shell = join(root, 'bash')
    writeFileSync(opencode, 'agent', { mode: 0o755 })
    writeFileSync(shell, 'shell', { mode: 0o755 })
    // Recorded from the same preview 4 USB in BIOS and UEFI. Node's BigInt
    // stat uses signed values; its Number stat rounds both to the same value.
    overlayInodes.set(opencode, -9223372036854773743n)
    overlayInodes.set(shell, -9223372036854774580n)
    process.env.PATH = root
    const snapshot = agentCommandOwnershipSnapshot()
    const agent = executableFileIdentity(opencode)!
    const bash = executableFileIdentity(shell)!
    expect(agent.fileKey).not.toBe(bash.fileKey)
    expect(agent.fileKey).toMatch(/:9223372036854777873$/)
    expect(bash.fileKey).toMatch(/:9223372036854777036$/)
    expect(snapshot.engineFileKeys?.get('opencode')?.has(agent.fileKey)).toBe(true)
    expect(snapshot.engineFileKeys?.get('opencode')?.has(bash.fileKey)).toBe(false)
  })

  it('keeps the user-facing 14-engine command contract exact and ordered', () => {
    expect(PROCESS_ENGINES.map((engine) => [engine, ENGINE_CLI_COMMANDS[engine]])).toEqual([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['cursor', 'cursor-agent'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['hermes', 'hermes'],
      ['commandcode', 'cmd'],
      ['devin', 'devin'],
      ['muse', 'muse'],
      ['amp', 'amp'],
      ['kilo', 'kilo'],
      ['grok', 'grok'],
      ['agy', 'agy'],
      ['copilot', 'copilot'],
    ])
  })

  it('adapts agent ownership and Cursor recap command to PATH order without install-path assumptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-ownership-'))
    tempDirs.push(root)
    const cursorBin = join(root, 'custom-cursor-prefix', 'bin')
    const grokBin = join(root, 'custom-grok-prefix', 'bin')
    const cursorTarget = join(root, 'share', 'cursor-agent', 'versions', '2099.01.01', 'cursor-agent')
    const grokTarget = join(root, 'downloads', 'renamed-grok-image')
    mkdirSync(cursorBin, { recursive: true })
    mkdirSync(grokBin, { recursive: true })
    mkdirSync(join(cursorTarget, '..'), { recursive: true })
    mkdirSync(join(grokTarget, '..'), { recursive: true })
    writeFileSync(cursorTarget, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(grokTarget, 'grok', { mode: 0o755 })
    symlinkSync(cursorTarget, join(cursorBin, 'agent'))
    symlinkSync(cursorTarget, join(cursorBin, 'cursor-agent'))
    symlinkSync(grokTarget, join(grokBin, 'agent'))
    symlinkSync(grokTarget, join(grokBin, 'grok'))

    process.env.PATH = [grokBin, cursorBin].join(delimiter)
    let snapshot = agentCommandOwnershipSnapshot()
    expect(agentAliasOwner([snapshot.agentCandidates[0]?.fileKey], snapshot)).toBe('grok')
    expect(agentAliasOwner([snapshot.agentCandidates[1]?.fileKey], snapshot)).toBe('cursor')
    expect(cursorRuntimeBin(snapshot)).toBe('cursor-agent')
    expect(installedEngineBin('cursor', snapshot)).toBe(join(cursorBin, 'cursor-agent'))

    process.env.PATH = [cursorBin, grokBin].join(delimiter)
    snapshot = agentCommandOwnershipSnapshot()
    expect(agentAliasOwner([snapshot.agentCandidates[0]?.fileKey], snapshot)).toBe('cursor')
    expect(cursorRuntimeBin(snapshot)).toBe('agent')
    expect(installedEngineBin('cursor', snapshot)).toBe(join(cursorBin, 'agent'))
  })

  const linuxIt = process.platform === 'linux' ? it : it.skip
  linuxIt('keeps the running native image identity after an updater replaces its pathname', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-deleted-image-'))
    tempDirs.push(root)
    const executable = join(root, 'native-agent')
    copyFileSync('/bin/sleep', executable)
    const child = spawn(executable, ['30'], { stdio: 'ignore' })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    try {
      rmSync(executable)
      const identity = executableFileIdentity(`/proc/${child.pid}/exe`)
      expect(identity?.fileKey).toMatch(/^\d+:\d+$/)
      expect(identity?.realPath).toContain('native-agent')
    } finally {
      child.kill('SIGKILL')
    }
  })
})
