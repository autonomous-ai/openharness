import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type * as CodexProfilesModule from './codexProfiles.js'

// Pass-through, recording what the shared writer does on disk: the renames and the opens.
const disk = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      disk.events.push(`rename ${String(args[1])}`)
      return actual.renameSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      disk.events.push(`open ${String(args[0])}`)
      return actual.openSync(...args)
    },
  }
})

const host = vi.hoisted(() => ({ win32: false }))
vi.mock('../engines/kit/windowsFiles.js', async original => {
  const actual = await original<typeof import('../engines/kit/windowsFiles.js')>()
  return { ...actual, hostPlatform: () => host.win32 ? 'win32' : actual.hostPlatform() }
})

let dataDir = ''
let home = ''

async function loadModule(): Promise<typeof CodexProfilesModule> {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./codexProfiles.js')
}

const emptyDiscovery = { home: '/nonexistent-empty-home', environment: {} }

describe('codexProfiles', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-profiles-data-'))
    // By its real path: resolveCodexProfilePath realpath-resolves everything it returns, and macOS's
    // tmpdir sits behind a /var → /private/var symlink that would otherwise make the resolved path
    // disagree with the literal folder these tests just created. In the temporary folder: made in the home
    // folder, this once made and removed folders in the developer's profile (Windows reads USERPROFILE, not HOME).
    home = realpathSync(mkdtempSync(join(tmpdir(), '.codex-profiles-test-')))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('resolveCodexProfilePath rejects a relative path', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('relative/codex')).toEqual({ error: 'INVALID_PATH' })
  })

  // #4183: on Windows a CODEX_HOME is `C:\\…`, and the check that wanted a leading '/' refused every one.
  it('resolveCodexProfilePath on Windows takes a drive-letter folder and refuses a POSIX one', async () => {
    host.win32 = true
    try {
      const { resolveCodexProfilePath } = await loadModule()
      expect(resolveCodexProfilePath('Z:\\no\\such\\.codex-work')).toEqual({ error: 'NOT_FOUND' })
      expect(resolveCodexProfilePath('/Users/u/.codex-work')).toEqual({ error: 'INVALID_PATH' })
    } finally {
      host.win32 = false
    }
  })

  it('resolveCodexProfilePath rejects a path with control characters', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath('/tmp/codex\nhome')).toEqual({ error: 'INVALID_PATH' })
  })

  it('resolveCodexProfilePath rejects a folder that does not exist', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    expect(resolveCodexProfilePath(join(home, 'nope'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath rejects a path that is a file, not a directory', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const file = join(home, 'not-a-dir')
    writeFileSync(file, '')
    expect(resolveCodexProfilePath(file)).toEqual({ error: 'NOT_FOUND' })
  })

  it('resolveCodexProfilePath accepts and resolves an existing absolute folder', async () => {
    const { resolveCodexProfilePath } = await loadModule()
    const folder = join(home, '.codex-work')
    mkdirSync(folder)
    expect(resolveCodexProfilePath(folder)).toEqual({ path: folder, label: '.codex-work' })
  })

  it('linkCodexProfile persists the resolved path on this machine', async () => {
    const { linkCodexProfile } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    expect(linkCodexProfile(folder)).toEqual({ path: folder, label: '.codex-linked' })
    const persisted = JSON.parse(readFileSync(join(dataDir, 'codex-profiles.json'), 'utf8'))
    expect(persisted).toEqual([folder])
  })

  // Windows cannot flush a folder (syncStateDirectory skips it) and has no mode bits to refuse.
  it.skipIf(process.platform === 'win32')('the list is written by the shared helper', async () => {
    const { linkCodexProfile } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    disk.events = []
    linkCodexProfile(folder)
    const renamed = disk.events.indexOf(`rename ${file}`)
    expect(renamed).toBeGreaterThanOrEqual(0)
    expect(disk.events.indexOf(`open ${dataDir}`, renamed)).toBeGreaterThan(renamed)

    chmodSync(file, 0o660)
    expect(() => linkCodexProfile(join(home, '.codex-linked'))).toThrow('state file is group/world writable')
    expect(statSync(file).mode & 0o777).toBe(0o660)
  })

  it('a torn profile list is set aside, not written over', async () => {
    const { linkCodexProfile } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    // What a reader saw while another process was writing it.
    writeFileSync(file, '["/a', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)

    expect(linkCodexProfile(folder)).toEqual({ path: folder, label: '.codex-linked' })

    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('["/a')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([folder])
    expect(warn).toHaveBeenCalledWith(
      '[state] codex-profiles.json could not be read (not valid JSON); kept as codex-profiles.json.unreadable, starting empty.')
  })

  // Windows has no mode bits to refuse.
  it.skipIf(process.platform === 'win32')('a list another account could write is not set aside', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const file = join(dataDir, 'codex-profiles.json')
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    writeFileSync(file, JSON.stringify([folder]))
    chmodSync(file, 0o664)
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])

    writeFileSync(file, '["/a')
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
    expect(existsSync(`${file}.unreadable`)).toBe(false)
    expect(() => linkCodexProfile(folder)).toThrow('state file is group/world writable')
    expect(readFileSync(file, 'utf8')).toBe('["/a')
  })

  it('linkCodexProfile refuses a folder that does not exist', async () => {
    const { linkCodexProfile } = await loadModule()
    expect(linkCodexProfile(join(home, 'ghost'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('listCodexProfiles returns a previously linked folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    // A link is a folder this machine knows (New Harness makes them).
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-linked' }])
  })

  it('listCodexProfiles drops a linked folder that has since vanished', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-linked')
    mkdirSync(folder)
    linkCodexProfile(folder)
    rmSync(folder, { recursive: true, force: true })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })

  it('listCodexProfiles includes observedPaths without requiring them to be linked', async () => {
    const { listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex-observed')
    mkdirSync(folder)
    expect(listCodexProfiles([folder], emptyDiscovery)).toEqual([{ path: folder, label: '.codex-observed' }])
  })

  it('listCodexProfiles includes freshly discovered folders', async () => {
    const { listCodexProfiles } = await loadModule()
    mkdirSync(join(home, '.codex'))
    writeFileSync(join(home, '.codex', 'config.toml'), '')
    expect(listCodexProfiles([], { home, environment: {} })).toEqual([
      { path: join(home, '.codex'), label: '.codex' },
    ])
  })

  it('listCodexProfiles dedupes linked, observed and discovered copies of the same folder', async () => {
    const { linkCodexProfile, listCodexProfiles } = await loadModule()
    const folder = join(home, '.codex')
    mkdirSync(folder)
    writeFileSync(join(folder, 'config.toml'), '')
    linkCodexProfile(folder)
    expect(listCodexProfiles([folder], { home, environment: {} })).toEqual([{ path: folder, label: '.codex' }])
  })

  it('listCodexProfiles sorts by label (case-insensitive), then by path', async () => {
    const { listCodexProfiles } = await loadModule()
    const b = join(home, '.codex-Beta')
    const a = join(home, '.codex-alpha')
    mkdirSync(a)
    mkdirSync(b)
    expect(listCodexProfiles([a, b], emptyDiscovery)).toEqual([
      { path: a, label: '.codex-alpha' },
      { path: b, label: '.codex-Beta' },
    ])
  })

  it('listCodexProfiles never throws when the state file is malformed', async () => {
    const { listCodexProfiles } = await loadModule()
    writeFileSync(join(dataDir, 'codex-profiles.json'), 'not json', { mode: 0o600 })
    expect(listCodexProfiles([], emptyDiscovery)).toEqual([])
  })
})
