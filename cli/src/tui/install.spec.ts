import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
let installedTuiPath: typeof import('./install.js').installedTuiPath
let installTui: typeof import('./install.js').installTui
let platformKey: typeof import('./install.js').platformKey
let updateTui: typeof import('./install.js').updateTui

// Only disposable executables are run, with --version. Downloads never reach the network.
const binary = (version: string): Buffer => Buffer.from(`#!/bin/sh\nprintf 'hn ${version} (tmux 3.5a)\\n'\n`)
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
let home: string
let target: string
let downloads: string[]

function installed(version = '0.1.1'): Buffer {
  const bytes = binary(version)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes, { mode: 0o755 })
  return bytes
}

function published(version = '0.1.2', bytes = binary(version), overrides: Record<string, unknown> = {}): void {
  const meta = { version, builds: { [platformKey()!]: { url: 'https://example.test/hn', sha256: digest(bytes), size: bytes.length, ...overrides } } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    downloads.push(url)
    return url === 'https://example.test/hn'
      ? new Response(new Uint8Array(bytes))
      : Response.json(meta)
  }))
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hn-update-test-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('HARNESS_TUI_BIN', undefined)
  vi.stubEnv('HARNESS_BIN_DIR', join(home, '.local', 'bin'))
  vi.stubEnv('ADAPTER_CLI_DIR', join(home, '.harness', 'cli'))
  vi.resetModules()
  ;({ installedTuiPath, installTui, platformKey, updateTui } = await import('./install.js'))
  target = installedTuiPath()
  downloads = []
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected network request')))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('managed hn updates', () => {
  it('atomically upgrades an old installation while an open descriptor keeps the old bytes', async () => {
    const old = installed()
    const fd = openSync(target, 'r')
    const oldInode = fstatSync(fd).ino
    published()
    const log = vi.fn()
    try {
      expect(await updateTui(log)).toBe(true)
      expect(readFileSync(target)).toEqual(binary('0.1.2'))
      expect(readFileSync(fd)).toEqual(old)
      expect(lstatSync(target).ino).not.toBe(oldInode)
      expect(lstatSync(target).mode & 0o777).toBe(0o755)
      expect(readdirSync(dirname(target))).toEqual(['harness-tui'])
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('reopen hn'))
    } finally { closeSync(fd) }
  })

  it.each(['0.1.2', '0.1.3', '0.10.0'])('does not download or downgrade a current/newer hn %s', async (version) => {
    const old = installed(version)
    published()
    expect(await updateTui()).toBe(false)
    expect(downloads).toHaveLength(1)
    expect(readFileSync(target)).toEqual(old)
  })

  it('does not install an unused hn or replace an explicit override', async () => {
    expect(await updateTui()).toBe(false)
    installed()
    vi.stubEnv('HARNESS_TUI_BIN', join(home, 'custom-hn'))
    expect(await updateTui()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('repairs a missing managed binary when the managed command is already installed', async () => {
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'hn'), `#!/bin/sh\nexec '${join(bin, 'harness')}' tui "$@"\n`, { mode: 0o755 })
    published()
    expect(await updateTui()).toBe(true)
    expect(readFileSync(target)).toEqual(binary('0.1.2'))
    expect(await updateTui()).toBe(false)
    expect(downloads.filter(url => url === 'https://example.test/hn')).toHaveLength(1)
  })

  it('leaves symlinked binaries and development versions alone', async () => {
    mkdirSync(dirname(target), { recursive: true })
    const custom = join(home, 'custom')
    writeFileSync(custom, binary('0.1.1'), { mode: 0o755 })
    symlinkSync(custom, target)
    expect(await updateTui()).toBe(false)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    rmSync(target)
    installed('0.1.1-dev.local')
    expect(await updateTui()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['checksum', { sha256: 'a'.repeat(64) }],
    ['size', { size: 9999 }],
    ['invalid checksum', { sha256: 'broken' }],
    ['invalid URL', { url: 'file:///tmp/hn' }],
    ['plaintext URL', { url: 'http://example.test/hn' }],
  ])('keeps the old binary on a %s failure', async (_, overrides) => {
    const old = installed()
    published('0.1.2', binary('0.1.2'), overrides)
    await expect(updateTui()).rejects.toThrow()
    expect(readFileSync(target)).toEqual(old)
    expect(readdirSync(dirname(target))).toEqual(['harness-tui'])
  })

  it.each([
    binary('0.1.9'),
    Buffer.from('#!/bin/sh\nexit 1\n'),
    Buffer.from('#!/bin/sh\nprintf "not hn\\n"\n'),
  ])('rejects a checksum-valid executable that fails its version check', async (bytes) => {
    const old = installed()
    published('0.1.2', bytes)
    await expect(updateTui()).rejects.toThrow()
    expect(readFileSync(target)).toEqual(old)
    expect(readdirSync(dirname(target))).toEqual(['harness-tui'])
  })

  it('recovers on the next check after an offline manifest or failed download', async () => {
    const old = installed()
    await expect(updateTui()).rejects.toThrow('unexpected network')
    expect(readFileSync(target)).toEqual(old)
    published()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 503 }))
    await expect(updateTui()).rejects.toThrow('503')
    expect(await updateTui()).toBe(true)
  })

  it('does not replace a newer installation that arrives during the download', async () => {
    installed()
    published()
    const served = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[0] === 'https://example.test/hn') installed('0.1.3')
      return served(...args)
    })
    expect(await updateTui()).toBe(false)
    expect(readFileSync(target)).toEqual(binary('0.1.3'))
    expect(readdirSync(dirname(target))).toEqual(['harness-tui'])
  })

  it('honors an override added while downloading', async () => {
    const old = installed()
    published()
    const served = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[0] === 'https://example.test/hn') vi.stubEnv('HARNESS_TUI_BIN', '/custom/hn')
      return served(...args)
    })
    expect(await updateTui()).toBe(false)
    expect(readFileSync(target)).toEqual(old)
  })

  it('serializes overlapping checks without downloading the same build twice', async () => {
    installed()
    published()
    expect(await Promise.all([updateTui(), updateTui(), updateTui()])).toEqual([true, false, false])
    expect(downloads.filter(url => url === 'https://example.test/hn')).toHaveLength(1)
  })

  it('cancels an update before it can replace the binary', async () => {
    const old = installed()
    published()
    const controller = new AbortController()
    const served = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (args[0] === 'https://example.test/hn') controller.abort()
      return served(...args)
    })
    await expect(updateTui(undefined, controller.signal)).rejects.toThrow()
    expect(readFileSync(target)).toEqual(old)
  })

  it('still installs on first use and explicitly repairs a broken binary', async () => {
    published()
    expect(await installTui(() => {})).toBe(target)
    writeFileSync(target, 'broken')
    expect(await installTui(() => {})).toBe(target)
    expect(readFileSync(target)).toEqual(binary('0.1.2'))
    expect(existsSync(target)).toBe(true)
  })
})
