import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pass-through until a test fills the disk: a write then stops part way, as ENOSPC leaves it.
const disk = vi.hoisted(() => ({ full: false }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
    },
  }
})

// The module reads env.ADAPTER_DATA_DIR at import, so each test gets a fresh module over a scratch dir.
let dataDir: string
async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return await import('./hostTheme.js')
}
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'host-theme-')) })
afterEach(() => {
  disk.full = false
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
})

describe('hostTheme', () => {
  it('accepts only a full pair of #rrggbb colours, lowercased', async () => {
    const { parseHostTheme } = await load()
    expect(parseHostTheme({ background: '#171B29', foreground: '#F5F5F5' })).toEqual({ background: '#171b29', foreground: '#f5f5f5' })
    expect(parseHostTheme({ background: '#171b29' })).toBeNull()
    expect(parseHostTheme({ background: 'black', foreground: '#ffffff' })).toBeNull()
    expect(parseHostTheme({ background: '#fff', foreground: '#ffffff' })).toBeNull()
    expect(parseHostTheme(null)).toBeNull()
  })

  it('spells the tmux window-style value', async () => {
    const { windowStyleOf, DEFAULT_HOST_THEME } = await load()
    expect(windowStyleOf(DEFAULT_HOST_THEME)).toBe('bg=#181818,fg=#f5f5f5')
  })

  it('round-trips through the data dir and ignores a corrupt file', async () => {
    const { loadHostTheme, saveHostTheme } = await load()
    expect(loadHostTheme()).toBeNull()
    saveHostTheme({ background: '#300a24', foreground: '#ffffff' })
    expect(JSON.parse(readFileSync(join(dataDir, 'host-theme.json'), 'utf8'))).toEqual({ background: '#300a24', foreground: '#ffffff' })
    expect(loadHostTheme()).toEqual({ background: '#300a24', foreground: '#ffffff' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(dataDir, 'host-theme.json'), '{not json')
    expect(loadHostTheme()).toBeNull()
  })

  it('a torn file is set aside, not written over', async () => {
    const { loadHostTheme, saveHostTheme } = await load()
    const file = join(dataDir, 'host-theme.json')
    writeFileSync(file, '{"background":"#30')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(loadHostTheme()).toBeNull()

    saveHostTheme({ background: '#300a24', foreground: '#ffffff' })
    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('{"background":"#30')
    expect(loadHostTheme()).toEqual({ background: '#300a24', foreground: '#ffffff' })
  })

  it('a save that fails part way leaves the old file', async () => {
    const { loadHostTheme, saveHostTheme } = await load()
    saveHostTheme({ background: '#300a24', foreground: '#ffffff' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    disk.full = true
    saveHostTheme({ background: '#ffffff', foreground: '#000000' })
    disk.full = false
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not persist host theme'))
    expect(loadHostTheme()).toEqual({ background: '#300a24', foreground: '#ffffff' })
  })
})
