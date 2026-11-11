import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import {
  agentAliasOwner,
  agentCommandOwnershipSnapshot,
  cursorRuntimeBin,
  ENGINE_CLI_COMMANDS,
  engineBin,
  engineFileOwners,
  PROCESS_ENGINES,
  executableFileIdentity,
  hermesBootFileKey,
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

  it('keeps the user-facing 16-engine command contract exact and ordered', () => {
    expect(PROCESS_ENGINES.map((engine) => [engine, ENGINE_CLI_COMMANDS[engine]])).toEqual([
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['cursor', 'cursor-agent'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
      ['omp', 'omp'],
      ['hermes', 'hermes'],
      ['commandcode', 'cmd'],
      ['devin', 'devin'],
      ['muse', 'muse'],
      ['amp', 'amp'],
      ['kilo', 'kilo'],
      ['grok', 'grok'],
      ['agy', 'agy'],
      ['copilot', 'copilot'],
      ['openclaw', 'openclaw'],
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

  it('finds openclaw on PATH and honours OPENCLAW_PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-openclaw-'))
    tempDirs.push(root)
    const onPath = join(root, 'bin', 'openclaw'), chosen = join(root, 'chosen', 'openclaw')
    for (const file of [onPath, chosen]) {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
    }
    process.env.PATH = join(root, 'bin')
    expect(engineBin('openclaw')).toBe('openclaw')
    expect(installedEngineBin('openclaw')).toBe(onPath)
    const original = env.OPENCLAW_PATH
    env.OPENCLAW_PATH = chosen
    try {
      expect(engineBin('openclaw')).toBe(chosen)
      expect(installedEngineBin('openclaw')).toBe(chosen)
    } finally { env.OPENCLAW_PATH = original }
  })

  const linuxIt = process.platform === 'linux' ? it : it.skip
  linuxIt('keeps the running native image identity after an updater replaces its pathname', async () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-deleted-image-'))
    tempDirs.push(root)
    const executable = join(root, 'native-agent')
    // Node itself, not /bin/sleep: Ubuntu 26.04's sleep is a multi-call coreutils binary that picks its tool by its own
    // name, so a copy named native-agent exits at once and its /proc image is gone before it is read.
    copyFileSync(process.execPath, executable)
    const child = spawn(executable, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' })
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

function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try { return run() } finally { Object.defineProperty(process, 'platform', original) }
}

// Harness runs Hermes' installer launcher on Windows as `<python> -I <root>\bin\hermes-boot.py` (Smart App Control refuses
// the launcher, lib/windows/hermesLaunch.ts). That module is the pane's Hermes: without it no Hermes pane there was
// ever confirmed (DESKTOP-0TFH0OJ, 2026-11-09).
describe('Hermes\' boot module on Windows', () => {
  const install = () => {
    const root = mkdtempSync(join(tmpdir(), 'engine-bin-hermes-'))
    tempDirs.push(root)
    const hermes = join(root, 'hermes')
    mkdirSync(join(hermes, 'bin'), { recursive: true })
    mkdirSync(join(hermes, 'hermes-agent', 'hermes_cli'), { recursive: true })
    writeFileSync(join(hermes, 'hermes-agent', 'hermes_cli', 'main.py'), '')
    writeFileSync(join(hermes, 'bin', 'hermes.exe'), 'MZ', { mode: 0o755 })
    const boot = join(hermes, 'bin', 'hermes-boot.py')
    return { bin: join(hermes, 'bin'), launcher: join(hermes, 'bin', 'hermes.exe'), boot }
  }

  it('is owned once Harness has written it beside the installer\'s launcher', () => {
    const { launcher, boot } = install()
    expect(hermesBootFileKey(launcher)).toBeNull()
    writeFileSync(boot, 'import sys\n')
    expect(hermesBootFileKey(launcher)).toBe(executableFileIdentity(boot)!.fileKey)
  })

  it('is nothing for another Hermes', () => {
    expect(hermesBootFileKey('/usr/local/bin/hermes')).toBeNull()
    expect(hermesBootFileKey('hermes')).toBeNull()
  })

  it('counts as Hermes in the ownership snapshot, the launcher found on PATH as the launch finds it', () => {
    const { bin, boot } = install()
    writeFileSync(boot, 'import sys\n')
    process.env.PATH = bin
    const snapshot = onPlatform('win32', () => agentCommandOwnershipSnapshot())
    expect(engineFileOwners([executableFileIdentity(boot)!.fileKey], snapshot)).toEqual(['hermes'])
  })
})

it('starts Command Code by its own name on Windows, where cmd is the command processor (F7)', () => {
  expect(onPlatform('win32', () => engineBin('commandcode'))).toBe('command-code')
  expect(onPlatform('darwin', () => engineBin('commandcode'))).toBe('cmd')
})
