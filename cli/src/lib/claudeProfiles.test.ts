import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type * as ClaudeProfilesModule from './claudeProfiles.js'

let dataDir = ''
let home = ''
const machineId = 'machine-1'

async function loadModule(): Promise<typeof ClaudeProfilesModule> {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./claudeProfiles.js')
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
    expect(profiles[0]).toMatchObject({ path: home, label: 'Me', reportLabel: expect.not.stringContaining('Me'), offered: true, default: true })
    expect(profiles[1]).not.toHaveProperty('default')
    expect(profiles[1]).toMatchObject({ path: join(home, '.claude-work'), label: 'Work' })
  })

  it('lists the default account even with no .claude.json, and folders without Claude files are not offered', async () => {
    const { listClaudeProfiles, profileId } = await loadModule()
    mkdirSync(join(home, '.claude-empty'))
    const profiles = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(profiles).toEqual([{ id: profileId(machineId, 'claude', 'default'), default: true, path: home, label: expect.any(String), reportLabel: expect.any(String), offered: true }])
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
    expect(orca).toMatchObject({ label: 'a@b.c', reportLabel: 'Orca ab12' })
  })

  it('uses displayName for the label when present', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-w'), { displayName: 'Work', emailAddress: 'w@x.y' })
    expect(listClaudeProfiles([], { home, environment: {}, machineId })[1]).toMatchObject({ label: 'Work', reportLabel: '.claude-w' })
  })

  it('never reports a person: the label is the folder, Orca by its id, Harness-made as Claude <n>', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-w'), { displayName: 'Jane Doe', emailAddress: 'jane@x.y' })
    account(join(home, '.harness/claude-profiles/acct1'), { displayName: 'Jane Doe' })
    const rows = listClaudeProfiles([], { home, environment: {}, machineId })
    expect(rows.map((p) => p.reportLabel)).toEqual(expect.arrayContaining(['.claude-w', 'Claude acct1']))
    expect(JSON.stringify(rows.map((p) => p.reportLabel))).not.toContain('Jane')
  })

  it('offers only the default account and what the owner offered: linking or Add Claude account never does, and a withdraw takes it back', async () => {
    const { listClaudeProfiles, linkClaudeProfile, offerAccount } = await loadModule()
    const orca = join(home, 'Library/Application Support/orca/claude-profiles/ab12cd34-0000-4000-8000-000000000000/home')
    account(orca, { displayName: 'Ken' })
    account(join(home, '.claude-w'), {})
    account(join(home, '.harness/claude-profiles/acct1'), {})
    const offered = () => Object.fromEntries(listClaudeProfiles([], { home, environment: {}, machineId }).map((p) => [p.path === home ? 'default' : p.reportLabel, p.offered]))
    expect(offered()).toEqual({ default: true, 'Orca ab12': false, '.claude-w': false, 'Claude acct1': false })
    linkClaudeProfile(orca, machineId)
    expect(offered()['Orca ab12']).toBe(false)
    expect(offerAccount('claude', orca, true, { home, environment: {} })).toEqual({ offered: true })
    expect(offered()['Orca ab12']).toBe(true)
    expect(offerAccount('claude', orca, false, { home, environment: {} })).toEqual({ offered: false })
    expect(offered()['Orca ab12']).toBe(false)
  })

  it('offers by the real folder, refuses the default account and a missing folder, and withdraws a folder that is gone', async () => {
    const { offerAccount, listClaudeProfiles } = await loadModule()
    const real = join(home, '.claude-w'), link = join(home, 'link-to-w')
    account(real, {})
    symlinkSync(real, link)
    const where = { home, environment: {} }
    expect(offerAccount('claude', link, true, where)).toEqual({ offered: true })
    expect(listClaudeProfiles([], { ...where, machineId }).find((p) => p.path === real)?.offered).toBe(true)
    expect(offerAccount('claude', home, true, where)).toEqual({ error: 'DEFAULT_ACCOUNT' })
    expect(offerAccount('claude', join(home, 'ghost'), true, where)).toEqual({ error: 'NOT_FOUND' })
    expect(offerAccount('claude', 'relative', true, where)).toEqual({ error: 'INVALID_PATH' })
    expect(offerAccount('grok', real, true, where)).toEqual({ error: 'INVALID_ENGINE' })
    rmSync(real, { recursive: true })
    expect(offerAccount('claude', real, false, where)).toEqual({ offered: false })
  })

  it('a damaged offers file offers nothing', async () => {
    const { offerAccount, listClaudeProfiles } = await loadModule()
    const folder = join(home, '.claude-w')
    account(folder, {})
    offerAccount('claude', folder, true, { home, environment: {} })
    writeFileSync(join(dataDir, 'swarm-account-offers.json'), '{not json', { mode: 0o600 })
    expect(listClaudeProfiles([], { home, environment: {}, machineId }).find((p) => p.path === folder)?.offered).toBe(false)
  })

  it('drops a report label containing @', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-w'), { displayName: 'me@x.y' })
    const profile = listClaudeProfiles([], { home, environment: {}, machineId })[1]
    expect(profile).toMatchObject({ label: 'me@x.y', reportLabel: '.claude-w' })
  })

  it('falls back to a plain word when even the folder name has an @', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-me@x.y'), {})
    expect(listClaudeProfiles([], { home, environment: {}, machineId })[1].reportLabel).toBe('Claude')
  })

  it('cuts it at 40 characters', async () => {
    const { listClaudeProfiles } = await loadModule()
    account(join(home, '.claude-' + 'x'.repeat(60)), {})
    expect(listClaudeProfiles([], { home, environment: {}, machineId })[1].reportLabel).toBe(('.claude-' + 'x'.repeat(60)).slice(0, 40))
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

  it('refuses a relative path with INVALID_PATH, a missing folder or file with NOT_FOUND', async () => {
    const { linkClaudeProfile } = await loadModule()
    expect(linkClaudeProfile('relative/x', machineId)).toEqual({ error: 'INVALID_PATH' })
    expect(linkClaudeProfile('/tmp/a\nb', machineId)).toEqual({ error: 'INVALID_PATH' })
    expect(linkClaudeProfile(join(home, 'nope'), machineId)).toEqual({ error: 'NOT_FOUND' })
    writeFileSync(join(home, 'file'), '')
    expect(linkClaudeProfile(join(home, 'file'), machineId)).toEqual({ error: 'NOT_FOUND' })
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
    expect(labels).toContain('Desk')
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

  it('with offeredOnly, an account the owner never offered is as good as gone, and only an offer brings it back', async () => {
    const { listClaudeProfiles, profileHome, linkClaudeProfile, offerAccount, profileId } = await loadModule()
    const folder = join(home, '.claude-work')
    account(folder, {})
    const codex = join(home, '.codex-two')
    mkdirSync(codex)
    writeFileSync(join(codex, 'auth.json'), '{}')
    const options = { home, environment: {}, offeredOnly: true }
    const work = listClaudeProfiles([], { home, environment: {}, machineId })[1]
    expect(profileHome('claude', work.id, machineId, options)).toBeNull()
    expect(profileHome('claude', work.id, machineId, { home, environment: {} })).toBe(folder)
    expect(profileHome('codex', profileId(machineId, 'codex', codex), machineId, options)).toBeNull()
    expect(profileHome('claude', 'default', machineId, options)).toBe('default')
    linkClaudeProfile(folder, machineId)
    expect(profileHome('claude', work.id, machineId, options)).toBeNull()
    offerAccount('claude', folder, true, options)
    expect(profileHome('claude', work.id, machineId, options)).toBe(folder)
    offerAccount('codex', codex, true, options)
    expect(profileHome('codex', profileId(machineId, 'codex', codex), machineId, options)).toBe(codex)
    // Withdrawn while a switch is on its way: its host finds the account gone before it closes the PM.
    offerAccount('claude', folder, false, options)
    expect(profileHome('claude', work.id, machineId, options)).toBeNull()
  })

  it('finds a Codex folder by its id', async () => {
    const { profileHome, profileId, codexReportLabel } = await loadModule()
    const codex = join(home, '.codex-two')
    mkdirSync(codex)
    writeFileSync(join(codex, 'auth.json'), '{}')
    const found = profileHome('codex', profileId(machineId, 'codex', codex), machineId, { home, environment: {} })
    expect(found).toBe(codex)
    expect(codexReportLabel('/x/.codex-two')).toBe('.codex-two')
    expect(codexReportLabel('/x/jane@corp')).toBe('Codex')
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
    writeFileSync(join(codex, 'auth.json'), '{}')
    expect(profileHome('codex', profileId(machineId, 'codex', codex), machineId, { home, environment: {} })).toBe('default')
  })

  it('offers a claudeHome that is a listed profile or a folder under ~/.harness/claude-profiles, never the default or any other path', async () => {
    const { claudeHomeOffered } = await loadModule()
    const work = join(home, '.claude-work')
    account(work, { displayName: 'Work' })
    const options = { home, environment: {} }
    expect(claudeHomeOffered(work, machineId, options)).toBe(true)
    expect(claudeHomeOffered(join(home, '.harness', 'claude-profiles', 'new-one'), machineId, options)).toBe(true)
    expect(claudeHomeOffered(join(home, '.harness', 'claude-profiles', '..', '..', 'elsewhere'), machineId, options)).toBe(false)
    expect(claudeHomeOffered(home, machineId, options)).toBe(false)
    expect(claudeHomeOffered(join(home, 'not-listed'), machineId, options)).toBe(false)
  })
})
