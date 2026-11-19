import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { harnessPath } from '../config/harnessHome.js'
import type * as ClaudeHomesModule from './claudeHomes.js'
import type * as ClaudeProfilesModule from './claudeProfiles.js'

let dataDir = ''
let home = ''
const machineId = 'machine-1'
// A read of this path fails, as EMFILE (too many open files) does for a moment.
const failing = vi.hoisted(() => ({ read: '' }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (failing.read && args[0] === failing.read) throw Object.assign(new Error('EMFILE: fixture'), { code: 'EMFILE' })
      return actual.readFileSync(...args)
    }) as typeof actual.readFileSync,
  }
})

const host = vi.hoisted(() => ({ win32: false }))
vi.mock('../engines/kit/windowsFiles.js', async original => {
  const actual = await original<typeof import('../engines/kit/windowsFiles.js')>()
  return { ...actual, hostPlatform: () => host.win32 ? 'win32' : actual.hostPlatform() }
})

/** The listing (claudeHomes.ts) and the rest (claudeProfiles.ts), loaded fresh for this test's data folder. */
async function loadModule(): Promise<typeof ClaudeHomesModule & typeof ClaudeProfilesModule> {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return { ...await import('./claudeHomes.js'), ...await import('./claudeProfiles.js') }
}

function account(folder: string, oauthAccount: Record<string, string>): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, '.claude.json'), JSON.stringify({ oauthAccount }))
}

describe('claudeProfiles', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-profiles-data-'))
    // Real path: macOS's tmpdir sits behind a /var -> /private/var link. Always inside tmpdir, never the real home.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profiles-home-')))
  })

  afterEach(() => {
    failing.read = ''
    vi.restoreAllMocks()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('names the default account by its hex id, marked default, and pins the id vector', async () => {
    const { listClaudeProfiles, profileId } = await loadModule()
    expect(profileId('m', 'claude', 'default')).toBe('71dc90339553114c')
    account(home, { displayName: 'Me' })
    account(join(home, '.claude-work'), { displayName: 'Work' })
    const profiles = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(profiles.map((p) => p.id)).toEqual([profileId(machineId, 'claude', 'default'), expect.stringMatching(/^[0-9a-f]{16}$/)])
    expect(profiles[0]).toMatchObject({ path: home, label: basename(home), default: true })
    expect(profiles[1]).not.toHaveProperty('default')
    expect(profiles[1]).toMatchObject({ path: join(home, '.claude-work'), label: '.claude-work' })
  })

  it('lists the default account even with no .claude.json, and folders without Claude files are not listed', async () => {
    const { listClaudeProfiles, profileId } = await loadModule()
    mkdirSync(join(home, '.claude-empty'))
    const profiles = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(profiles).toEqual([{ id: profileId(machineId, 'claude', 'default'), default: true, path: home, label: expect.any(String) }])
  })

  it('finds the inherited CLAUDE_CONFIG_DIR and a folder holding only settings.json', async () => {
    const { listClaudeProfiles } = await loadModule()
    const inherited = join(home, 'elsewhere')
    mkdirSync(inherited)
    writeFileSync(join(inherited, 'settings.json'), '{}')
    const profiles = listClaudeProfiles([], { home, environment: { CLAUDE_CONFIG_DIR: inherited }, machineId })
    expect(profiles.map((p) => p.path)).toEqual([home, inherited])
  })

  it('finds Orca profiles', async () => {
    const { listClaudeProfiles } = await loadModule()
    const folder = join(home, 'Library/Application Support/orca/claude-profiles/ab12cd34-0000-4000-8000-000000000000/home')
    account(folder, { emailAddress: 'a@b.c' })
    const orca = listClaudeProfiles([], { home, environment: {}, machineId })[1]
    expect(orca).toMatchObject({ label: 'Orca ab12' })
  })

  it('names a profile by its folder, never by the account signed in to it', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-w'), { displayName: 'Work', emailAddress: 'w@x.y' })
    expect(listClaudeProfiles([], { home, environment: {}, machineId })[1]).toMatchObject({ label: '.claude-w' })
  })

  it('never names a person: the label is the folder, Orca by its id, Harness-made as Claude <n>', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-w'), { displayName: 'Jane Doe', emailAddress: 'jane@x.y' })
    account(join(home, '.harness/claude-profiles/acct1'), { displayName: 'Jane Doe' })
    const rows = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(rows.map((p) => p.label)).toEqual(expect.arrayContaining(['.claude-w', 'Claude acct1']))
    expect(JSON.stringify(rows.map((p) => p.label))).not.toContain('Jane')
  })

  it('ignores a malformed or oversized account file', async () => {
    const { listClaudeProfiles } = await loadModule()
    mkdirSync(join(home, '.claude-bad'))
    writeFileSync(join(home, '.claude-bad', '.claude.json'), 'not json')
    expect(listClaudeProfiles([], { home, environment: {}, machineId })[1]).toMatchObject({ label: '.claude-bad' })
  })

  it('links a folder and keeps it across reads', async () => {
    const { linkClaudeProfile, listClaudeProfiles } = await loadModule()
    const folder = join(home, 'custom')
    mkdirSync(folder)
    const linked = linkClaudeProfile(folder, machineId)
    expect(linked).toEqual({ profile: expect.objectContaining({ path: folder, label: 'custom' }) })
    const again = await loadModule()
    expect(again.listClaudeProfiles([], { home, environment: {}, machineId }).map((p) => p.path)).toEqual([home, folder])
    expect(listClaudeProfiles([folder, join(home, 'gone'), 'relative'], { home, environment: {}, machineId })).toHaveLength(2)
  })

  it('a torn profile list is set aside, not written over', async () => {
    const { linkClaudeProfile } = await loadModule()
    const file = join(dataDir, 'claude-profiles.json')
    // What a reader saw while another process was writing it.
    writeFileSync(file, '["/a', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folder = join(home, 'custom')
    mkdirSync(folder)

    expect(linkClaudeProfile(folder, machineId)).toEqual({ profile: expect.objectContaining({ path: folder }) })

    expect(readFileSync(`${file}.unreadable`, 'utf8')).toBe('["/a')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([folder])
    expect(warn).toHaveBeenCalledWith(
      '[state] claude-profiles.json could not be read (not valid JSON); kept as claude-profiles.json.unreadable, starting empty.')
  })

  it('a profile list that cannot be read for a moment is not written over', async () => {
    const { linkClaudeProfile } = await loadModule()
    const file = join(dataDir, 'claude-profiles.json')
    const kept = join(home, 'kept')
    const folder = join(home, 'custom')
    mkdirSync(kept)
    mkdirSync(folder)
    writeFileSync(file, JSON.stringify([kept]), { mode: 0o600 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    failing.read = file
    expect(() => linkClaudeProfile(folder, machineId)).toThrow('claude-profiles.json could not be read (EMFILE)')
    failing.read = ''
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([kept])
    expect(existsSync(`${file}.unreadable`)).toBe(false)
  })

  // Windows has no mode bits to refuse.
  it.skipIf(process.platform === 'win32')('a list another account could write is not set aside', async () => {
    const { linkClaudeProfile, readLinkedPaths } = await loadModule()
    const file = join(dataDir, 'claude-profiles.json')
    const folder = join(home, 'custom')
    mkdirSync(folder)
    writeFileSync(file, JSON.stringify([folder]))
    chmodSync(file, 0o664)
    expect(readLinkedPaths()).toEqual(new Set())

    writeFileSync(file, '["/a')
    expect(readLinkedPaths()).toEqual(new Set())
    expect(existsSync(`${file}.unreadable`)).toBe(false)
    expect(() => linkClaudeProfile(folder, machineId)).toThrow('state file is group/world writable')
    expect(readFileSync(file, 'utf8')).toBe('["/a')
  })

  it('refuses a relative path with INVALID_PATH, a missing folder or file with NOT_FOUND', async () => {
    const { linkClaudeProfile } = await loadModule()
    expect(linkClaudeProfile('relative/x', machineId)).toEqual({ error: 'INVALID_PATH' })
    expect(linkClaudeProfile('/tmp/a\nb', machineId)).toEqual({ error: 'INVALID_PATH' })
    expect(linkClaudeProfile(join(home, 'nope'), machineId)).toEqual({ error: 'NOT_FOUND' })
    writeFileSync(join(home, 'file'), '')
    expect(linkClaudeProfile(join(home, 'file'), machineId)).toEqual({ error: 'NOT_FOUND' })
  })

  // #4183: on Windows a profile folder is `C:\\…`, and the check that wanted a leading '/' refused every one.
  it('on Windows takes a drive-letter folder and refuses a POSIX one', async () => {
    host.win32 = true
    try {
      const { linkClaudeProfile } = await loadModule()
      expect(linkClaudeProfile('Z:\\no\\such\\.claude-work', machineId)).toEqual({ error: 'NOT_FOUND' })
      expect(linkClaudeProfile('/Users/u/.claude-work', machineId)).toEqual({ error: 'INVALID_PATH' })
    } finally {
      host.win32 = false
    }
  })

  it('profileId is stable, 16 hex and depends on machine, engine and path', async () => {
    const { profileId } = await loadModule()
    const id = profileId('m', 'claude', '/a')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(profileId('m', 'claude', '/a')).toBe(id)
    expect(new Set([id, profileId('n', 'claude', '/a'), profileId('m', 'codex', '/a'), profileId('m', 'claude', '/b')]).size).toBe(4)
  })
})

describe('Desktop-added accounts', () => {
  it('finds <home>/.harness/claude-profiles/* folders once they hold Claude files', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-profiles-data-'))
    home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profiles-home-')))
    const { listClaudeProfiles } = await loadModule()
    const base = join(home, '.harness', 'claude-profiles')
    account(join(base, 'acct1'), { displayName: 'Desk' })
    mkdirSync(join(base, 'empty'), { recursive: true })
    const labels = listClaudeProfiles([], { home, environment: {}, machineId }).map((p) => p.label)
    expect(labels).toContain('Claude acct1')
    expect(labels).not.toContain('Desk')
    expect(labels).not.toContain('empty')
    rmSync(dataDir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })
})

describe('profileHome', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-profiles-data-'))
    home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-profiles-home-')))
  })
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    delete process.env.ADAPTER_DATA_DIR
  })

  it('maps a reported id back to its folder, the default account to default, and an unknown id to null', async () => {
    const { listClaudeProfiles, profileHome, profileId } = await loadModule()
    account(join(home, '.claude-work'), { displayName: 'Work' })
    const options = { home, environment: {} }
    const work = listClaudeProfiles([], { ...options, machineId })[1]
    expect(profileHome('claude', work.id, machineId, options)).toBe(work.path)
    expect(profileHome('claude', 'default', machineId, options)).toBe('default')
    expect(profileHome('claude', profileId(machineId, 'claude', 'default'), machineId, options)).toBe('default')
    expect(profileHome('codex', profileId(machineId, 'codex', 'default'), machineId, options)).toBe('default')
    expect(profileHome('claude', 'f'.repeat(16), machineId, options)).toBeNull()
    expect(profileHome('codex', 'f'.repeat(16), machineId, options)).toBeNull()
    expect(profileHome('gemini', 'default', machineId, options)).toBeNull()
  })

  it('finds a Codex folder by its id', async () => {
    const { profileHome, profileId } = await loadModule()
    const codex = join(home, '.codex-two')
    mkdirSync(codex)
    writeFileSync(join(codex, 'config.toml'), '')
    const found = profileHome('codex', profileId(machineId, 'codex', codex), machineId, { home, environment: {} })
    expect(found).toBe(codex)
  })

  it('keeps a symlinked folder as it was given (Claude Code hashes that path), with the id of its real path', async () => {
    const { linkClaudeProfile, listClaudeProfiles, profileHome, profileId } = await loadModule()
    const real = join(home, 'real-claude')
    mkdirSync(real)
    const given = join(home, '.claude-link')
    symlinkSync(real, given)
    const linked = linkClaudeProfile(given, machineId)
    expect(linked).toMatchObject({ profile: { path: given, id: profileId(machineId, 'claude', real) } })
    const listed = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(listed.filter((p) => p.path === given)).toHaveLength(1)
    expect(profileHome('claude', profileId(machineId, 'claude', real), machineId, { home, environment: {} })).toBe(given)
  })

  it('the default Codex home answers as the default account, by the id of its path too', async () => {
    const { profileHome, profileId } = await loadModule()
    const codex = join(home, '.codex')
    mkdirSync(codex)
    writeFileSync(join(codex, 'config.toml'), '')
    expect(profileHome('codex', profileId(machineId, 'codex', codex), machineId, { home, environment: {} })).toBe('default')
  })

  // Harness's claude-profiles folder is ~/.harness's on macOS and the XDG data root's on a fresh Linux home like this one.
  it('takes a claudeHome that is a listed profile or a folder under Harness\'s claude-profiles, never the default or any other path', async () => {
    const { claudeHomeListed } = await loadModule()
    const work = join(home, '.claude-work')
    account(work, { displayName: 'Work' })
    const options = { home, environment: {} }
    const own = harnessPath('claude-profiles', home)
    expect(claudeHomeListed(work, machineId, options)).toBe(true)
    expect(claudeHomeListed(join(own, 'new-one'), machineId, options)).toBe(true)
    expect(claudeHomeListed(join(`${own}x`, 'new-one'), machineId, options)).toBe(false)
    expect(claudeHomeListed(join(own, '..', '..', 'elsewhere'), machineId, options)).toBe(false)
    expect(claudeHomeListed(home, machineId, options)).toBe(false)
    expect(claudeHomeListed(join(home, 'not-listed'), machineId, options)).toBe(false)
  })
})

// The id hashes the folder's real path, so a profile moved with Harness's folder takes its new folder's id; nothing stores
// one (the move rewrites the folders), and Desktop's swarmProfileId computes the same from the folder the daemon reports.
describe('profile ids after Harness\'s folder moves', () => {
  const moved = { env: {}, exists: (path: string) => path === '/h/.local/share/harness', isFile: (path: string) => path === '/h/.local/share/harness/.harness-root' }

  it('a profile in the moved folder takes the id of its new folder', async () => {
    const { profileFor, profileId } = await loadModule()
    const folder = join(harnessPath('claude-profiles', '/h', 'linux', moved), '2')
    expect(folder).toBe('/h/.local/share/harness/claude-profiles/2')
    expect(profileFor('m', folder, folder, '/h').id).toBe(profileId('m', 'claude', folder))
    // swarmProfileId('m', 'claude', '/h/.local/share/harness/claude-profiles/2') in Desktop.
    expect(profileId('m', 'claude', folder)).toBe('872709902d494c68')
  })

  it('the default profile\'s id does not change', async () => {
    const { profileFor } = await loadModule()
    expect(profileFor('m', '/h', '/h', '/h', true).id).toBe('71dc90339553114c')
  })

  it('macOS hashes the real path as before', async () => {
    const { profileFor } = await loadModule()
    const folder = join(harnessPath('claude-profiles', '/Users/h', 'darwin', moved), '2')
    expect(folder).toBe('/Users/h/.harness/claude-profiles/2')
    expect(profileFor('m', folder, folder, '/Users/h').id).toBe('9a02c3def3094fc3')
  })
})
