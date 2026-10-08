import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineAccount } from './engineAccount.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function home() {
  const root = mkdtempSync(join(tmpdir(), 'harness-engine-account-'))
  roots.push(root)
  return root
}
const linux = { env: {}, platform: 'linux' as const }

describe('engineAccount', () => {
  it('reads Claude Code as signed out with nothing there, and never asks the Keychain off macOS', async () => {
    const asked: string[] = []
    expect(await engineAccount('claude', { home: home(), ...linux, keychainHas: async service => { asked.push(service); return true } }))
      .toEqual({ signedIn: false, lastUsedAt: null })
    expect(asked).toEqual([])
  })

  it('finds Claude Code signed in by its credential file, its macOS Keychain item, or an API key', async () => {
    const withFile = home()
    mkdirSync(join(withFile, '.claude', 'projects'), { recursive: true })
    writeFileSync(join(withFile, '.claude', '.credentials.json'), '{}')
    utimesSync(join(withFile, '.claude', 'projects'), 1_700_000_000, 1_700_000_000)
    expect(await engineAccount('claude', { home: withFile, ...linux }))
      .toEqual({ signedIn: true, lastUsedAt: 1_700_000_000_000 })

    const asked: string[] = []
    expect((await engineAccount('claude', { home: home(), env: {}, platform: 'darwin',
      keychainHas: async service => { asked.push(service); return true } })).signedIn).toBe(true)
    expect(asked).toEqual(['Claude Code-credentials'])

    expect((await engineAccount('claude', { home: home(), env: { ANTHROPIC_API_KEY: 'k' }, platform: 'linux' })).signedIn).toBe(true)
  })

  it('finds Codex signed in only with a token or key in auth.json, or an API key', async () => {
    const root = home()
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    mkdirSync(join(root, '.codex', 'sessions'), { recursive: true })
    writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ tokens: null, OPENAI_API_KEY: null }))
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }))
    utimesSync(join(root, '.codex', 'sessions'), 1_800_000_000, 1_800_000_000)
    expect(await engineAccount('codex', { home: root, ...linux })).toEqual({ signedIn: true, lastUsedAt: 1_800_000_000_000 })
    writeFileSync(join(root, '.codex', 'auth.json'), 'not json')
    expect((await engineAccount('codex', { home: root, ...linux })).signedIn).toBe(false)
    expect((await engineAccount('codex', { home: root, env: { OPENAI_API_KEY: 'k' }, platform: 'linux' })).signedIn).toBe(true)
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
})
