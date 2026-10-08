import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineAccount } from './engineAccount.js'
import { resetLoginShellEnvironmentCache } from './loginShellEnv.js'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function home() {
  const root = mkdtempSync(join(tmpdir(), 'harness-engine-account-'))
  roots.push(root)
  return root
}
const linux = { env: {}, platform: 'linux' as const }
const touch = (path: string, seconds: number) => utimesSync(path, seconds, seconds)

describe('engineAccount', () => {
  it('reads Claude Code as signed out with nothing there, and never asks the Keychain off macOS', async () => {
    const asked: string[] = []
    expect(await engineAccount('claude', { home: home(), ...linux, keychainHas: async service => { asked.push(service); return true } }))
      .toEqual({ signedIn: false, lastUsedAt: null })
    expect(asked).toEqual([])
  })

  it('finds Claude Code signed in by its credential file, an apiKeyHelper, its Keychain item, or the environment', async () => {
    const withFile = home()
    mkdirSync(join(withFile, '.claude'), { recursive: true })
    writeFileSync(join(withFile, '.claude', '.credentials.json'), '{}')
    expect((await engineAccount('claude', { home: withFile, ...linux })).signedIn).toBe(true)

    const helper = home()
    mkdirSync(join(helper, '.claude'))
    writeFileSync(join(helper, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '~/bin/key' }))
    expect((await engineAccount('claude', { home: helper, ...linux })).signedIn).toBe(true)

    const asked: string[] = []
    expect((await engineAccount('claude', { home: home(), env: {}, platform: 'darwin',
      keychainHas: async service => { asked.push(service); return true } })).signedIn).toBe(true)
    expect(asked).toEqual(['Claude Code-credentials'])

    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      expect((await engineAccount('claude', { home: home(), env: { [name]: '1' }, platform: 'linux' })).signedIn, name).toBe(true)
    }
  })

  it('looks up the Keychain service Claude Code names for a custom config folder', async () => {
    const root = home()
    const custom = join(root, 'claude-dir')
    const asked: string[] = []
    await engineAccount('claude', { home: root, env: { CLAUDE_CONFIG_DIR: custom }, platform: 'darwin',
      keychainHas: async service => { asked.push(service); return false } })
    expect(asked).toEqual([`Claude Code-credentials-${createHash('sha256').update(custom).digest('hex').slice(0, 8)}`])
  })

  // ~/.claude.json is rewritten on every launch (and by Harness's folder trust), and Codex's
  // `sessions` folder changes once a year: neither says which engine the person works in.
  it('reads last use from the newest Claude Code project folder and the newest Codex day folder', async () => {
    const root = home()
    mkdirSync(join(root, '.claude', 'projects', 'old'), { recursive: true })
    mkdirSync(join(root, '.claude', 'projects', 'new'), { recursive: true })
    touch(join(root, '.claude', 'projects', 'old'), 1_600_000_000)
    touch(join(root, '.claude', 'projects', 'new'), 1_700_000_000)
    writeFileSync(join(root, '.claude.json'), '{}')
    touch(join(root, '.claude.json'), 1_900_000_000)
    expect((await engineAccount('claude', { home: root, ...linux })).lastUsedAt).toBe(1_700_000_000_000)

    for (const day of ['2026/09/30', '2026/10/08', '2025/12/31']) mkdirSync(join(root, '.codex', 'sessions', day), { recursive: true })
    touch(join(root, '.codex', 'sessions', '2026', '10', '08'), 1_800_000_000)
    touch(join(root, '.codex', 'sessions', '2026', '09', '30'), 1_850_000_000)
    expect((await engineAccount('codex', { home: root, ...linux })).lastUsedAt).toBe(1_800_000_000_000)
    expect((await engineAccount('codex', { home: home(), ...linux })).lastUsedAt).toBeNull()
  })

  it('finds Codex signed in only with a token or key in auth.json, or an API key', async () => {
    const root = home()
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    mkdirSync(join(root, '.codex'), { recursive: true })
    writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ tokens: null, OPENAI_API_KEY: null }))
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }))
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(true)
    writeFileSync(join(root, '.codex', 'auth.json'), 'not json')
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    expect((await engineAccount('codex', { home: root, env: { OPENAI_API_KEY: 'k' }, platform: 'linux' })).signedIn).toBe(true)
  })

  it('answers unknown for a Codex that keeps its credentials in the OS keyring', async () => {
    const root = home()
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.codex', 'config.toml'), 'model = "gpt"\ncli_auth_credentials_store = "keyring"\n')
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBeNull()
  })

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR, and answers unknown for other engines', async () => {
    const root = home()
    mkdirSync(join(root, 'codex-home'))
    writeFileSync(join(root, 'codex-home', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'k' }))
    expect((await engineAccount('codex', { home: root, env: { CODEX_HOME: join(root, 'codex-home') }, platform: 'linux' })).signedIn).toBe(true)
    mkdirSync(join(root, 'claude-dir'))
    writeFileSync(join(root, 'claude-dir', '.credentials.json'), '{}')
    expect((await engineAccount('claude', { home: root, env: { CLAUDE_CONFIG_DIR: join(root, 'claude-dir') }, platform: 'linux' })).signedIn).toBe(true)
    expect(await engineAccount('opencode', { home: root, ...linux })).toEqual({ signedIn: null, lastUsedAt: null })
  })

  // A daemon the app started never sees what the person exports in ~/.zshrc.
  it('finds a credential the login shell exports, which the daemon itself never read', async () => {
    const root = home()
    const rc = 'export ANTHROPIC_API_KEY=sk-secret-value\n'
    // zsh where there is one (macOS), bash otherwise (the Linux CI runner has no zsh).
    for (const file of ['.zshrc', '.bashrc', '.bash_profile']) writeFileSync(join(root, file), rc)
    vi.stubEnv('HOME', root)
    vi.stubEnv('ZDOTDIR', root)
    vi.stubEnv('SHELL', existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    delete process.env.ANTHROPIC_API_KEY
    resetLoginShellEnvironmentCache()
    try {
      expect((await engineAccount('claude', { home: root, platform: 'linux' })).signedIn).toBe(true)
    } finally {
      resetLoginShellEnvironmentCache()
    }
  })
})
