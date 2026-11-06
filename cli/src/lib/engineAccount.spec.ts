import { afterEach, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineAccount, type EngineStatusRun } from './engineAccount.js'
import { resetLoginShellEnvironmentCache } from './loginShellEnv.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(childProcess.execFile).mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function home() {
  const root = mkdtempSync(join(tmpdir(), 'harness-engine-account-'))
  roots.push(root)
  return root
}
const touch = (path: string, seconds: number) => utimesSync(path, seconds, seconds)

/** A fake `claude auth status --json` / `codex login status`, recording what it was asked. */
function cli(answer: { claude?: boolean | string | null; codex?: number | null } = {}) {
  const calls: Array<{ engine: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
  const run: EngineStatusRun = async (engine, args, env) => {
    calls.push({ engine, args, env })
    if (engine === 'claude') {
      const value = answer.claude === undefined ? false : answer.claude
      if (value === null) return null
      const stdout = typeof value === 'string' ? value : JSON.stringify({ loggedIn: value, authMethod: value ? 'claude.ai' : 'none', apiProvider: 'firstParty' })
      return { code: value === true ? 0 : 1, stdout }
    }
    const code = answer.codex === undefined ? 1 : answer.codex
    return code === null ? null : { code, stdout: '' }
  }
  return { run, calls }
}

/** Decoy sign-in files the CLIs once kept: their presence must never count. */
function decoys(root: string) {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }))
  mkdirSync(join(root, '.codex'), { recursive: true })
  writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'k', tokens: { access_token: 'a', refresh_token: 'r' } }))
}

describe('engineAccount', () => {
  it('asks Claude Code itself, `claude auth status --json`, and reads its loggedIn', async () => {
    const yes = cli({ claude: true })
    expect(await engineAccount('claude', { home: home(), env: { PATH: '/bin' }, run: yes.run })).toEqual({ signedIn: true, lastUsedAt: null })
    expect(yes.calls).toEqual([{ engine: 'claude', args: ['auth', 'status', '--json'], env: { PATH: '/bin' } }])
    const custom = cli({ claude: true })
    await engineAccount('claude', { home: home(), env: { CLAUDE_CONFIG_DIR: '/profiles/w' }, run: custom.run })
    expect(custom.calls[0]!.env.CLAUDE_CONFIG_DIR).toBe('/profiles/w')
  })

  it('reads no credentials file and asks no Keychain: a signed-out Claude Code is signed out whatever files lie there', async () => {
    const root = home()
    decoys(root)
    const no = cli({ claude: false })
    expect(await engineAccount('claude', { home: root, env: {}, run: no.run })).toEqual({ signedIn: false, lastUsedAt: null })
    expect(await engineAccount('claude', { home: root, env: { CLAUDE_CONFIG_DIR: join(root, '.claude') }, run: no.run })).toEqual({ signedIn: false, lastUsedAt: null })
    expect(vi.mocked(childProcess.execFile).mock.calls.map(call => call[0])).not.toContain('security')
  })

  it('answers unknown when Claude Code cannot say: not there, timed out, or no answer it can read', async () => {
    expect((await engineAccount('claude', { home: home(), env: {}, run: cli({ claude: null }).run })).signedIn).toBeNull()
    expect((await engineAccount('claude', { home: home(), env: {}, run: cli({ claude: 'not json' }).run })).signedIn).toBeNull()
    expect((await engineAccount('claude', { home: home(), env: {}, run: cli({ claude: '{"authMethod":"none"}' }).run })).signedIn).toBeNull()
  })

  it('asks Codex itself, `codex login status`, by its exit code, and reads no auth.json', async () => {
    const root = home()
    decoys(root)
    const no = cli({ codex: 1 })
    expect((await engineAccount('codex', { home: root, env: {}, run: no.run })).signedIn).toBe(false)
    expect(no.calls).toEqual([{ engine: 'codex', args: ['login', 'status'], env: {} }])
    expect((await engineAccount('codex', { home: root, env: {}, run: cli({ codex: 0 }).run })).signedIn).toBe(true)
    expect((await engineAccount('codex', { home: root, env: {}, run: cli({ codex: null }).run })).signedIn).toBeNull()
    const custom = cli({ codex: 0 })
    await engineAccount('codex', { home: root, env: { CODEX_HOME: join(root, 'codex-home') }, run: custom.run })
    expect(custom.calls[0]!.env.CODEX_HOME).toBe(join(root, 'codex-home'))
  })

  it('takes a key in the environment, an apiKeyHelper or a saved model API without asking the CLI', async () => {
    const asked = cli({ claude: false })
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
      expect((await engineAccount('claude', { home: home(), env: { [name]: '1' }, run: asked.run })).signedIn, name).toBe(true)
    }
    expect((await engineAccount('codex', { home: home(), env: { OPENAI_API_KEY: 'k' }, run: asked.run })).signedIn).toBe(true)
    const helper = home()
    mkdirSync(join(helper, '.claude'))
    writeFileSync(join(helper, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: '~/bin/key' }))
    expect((await engineAccount('claude', { home: helper, env: {}, run: asked.run })).signedIn).toBe(true)
    expect(asked.calls).toEqual([])
  })

  it('counts a saved model API as a sign-in, so a machine with no subscription can take Swarm work', async () => {
    // Headless run, 2026-11-03: a working OpenRouter key was saved for the team account, and the machine still read
    // "not signed in", so no Swarm start was admitted.
    const root = home()
    const data = join(root, '.harness', 'cli', 'data', 'api-connections')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'connections.json'), JSON.stringify({ version: 1, recognizedBases: ['https://openrouter.ai/api/v1'],
      connections: [{ id: 'openrouter', provider: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
        keyEnv: 'OPENROUTER_API_KEY', authHeader: 'Authorization', authPrefix: 'Bearer', apiKey: 'sk-x' }] }))
    const signedOut = cli()
    expect((await engineAccount('claude', { home: root, env: {}, run: signedOut.run })).signedIn).toBe(true)
    // Codex's own launch needs its config, so a saved API alone does not sign it in.
    expect((await engineAccount('codex', { home: root, env: {}, run: signedOut.run })).signedIn).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('runs the CLI found on the given PATH, with the given environment', async () => {
    const root = home()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n[ "$1 $2 $3" = "auth status --json" ] || exit 2\n'
      + 'if [ "$CLAUDE_CONFIG_DIR" = /signed/in ]; then echo \'{"loggedIn": true}\'; else echo \'{"loggedIn": false}\'; exit 1; fi\n')
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\n[ "$1 $2" = "login status" ] || exit 2\n[ "$CODEX_HOME" = /signed/in ]\n')
    for (const name of ['claude', 'codex']) chmodSync(join(bin, name), 0o755)
    const account = (engine: 'claude' | 'codex', env: NodeJS.ProcessEnv) => engineAccount(engine, { home: root, env: { PATH: bin, ...env }, lastUsed: false })
    expect((await account('claude', { CLAUDE_CONFIG_DIR: '/signed/in' })).signedIn).toBe(true)
    expect((await account('claude', {})).signedIn).toBe(false)
    expect((await account('codex', { CODEX_HOME: '/signed/in' })).signedIn).toBe(true)
    expect((await account('codex', {})).signedIn).toBe(false)
    // No CLI on the PATH: this machine cannot say.
    expect((await engineAccount('codex', { home: root, env: { PATH: join(root, 'none') }, lastUsed: false })).signedIn).toBeNull()
  })

  // ~/.claude.json is rewritten on every launch (and by Harness's folder trust), and Codex's
  // `sessions` folder changes once a year: neither says which engine the person works in.
  it('reads last use from the newest Claude Code project folder and the newest Codex day folder', async () => {
    const root = home()
    const { run } = cli()
    mkdirSync(join(root, '.claude', 'projects', 'old'), { recursive: true })
    mkdirSync(join(root, '.claude', 'projects', 'new'), { recursive: true })
    touch(join(root, '.claude', 'projects', 'old'), 1_600_000_000)
    touch(join(root, '.claude', 'projects', 'new'), 1_700_000_000)
    writeFileSync(join(root, '.claude.json'), '{}')
    touch(join(root, '.claude.json'), 1_900_000_000)
    expect((await engineAccount('claude', { home: root, env: {}, run })).lastUsedAt).toBe(1_700_000_000_000)

    for (const day of ['2026/09/30', '2026/10/08', '2025/12/31']) mkdirSync(join(root, '.codex', 'sessions', day), { recursive: true })
    touch(join(root, '.codex', 'sessions', '2026', '10', '08'), 1_800_000_000)
    touch(join(root, '.codex', 'sessions', '2026', '09', '30'), 1_850_000_000)
    expect((await engineAccount('codex', { home: root, env: {}, run })).lastUsedAt).toBe(1_800_000_000_000)
    expect((await engineAccount('codex', { home: home(), env: {}, run })).lastUsedAt).toBeNull()
    // Asked for the sign-in alone (the gateway's first-launch count): no folder is scanned.
    expect(await engineAccount('claude', { home: root, env: {}, run, lastUsed: false })).toEqual({ signedIn: false, lastUsedAt: null })
    expect(await engineAccount('codex', { home: root, env: {}, run, lastUsed: false })).toEqual({ signedIn: false, lastUsedAt: null })
  })

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR for last use, and answers unknown for other engines', async () => {
    const root = home()
    const { run, calls } = cli()
    mkdirSync(join(root, 'claude-dir', 'projects', 'p'), { recursive: true })
    touch(join(root, 'claude-dir', 'projects', 'p'), 1_700_000_000)
    expect((await engineAccount('claude', { home: root, env: { CLAUDE_CONFIG_DIR: join(root, 'claude-dir') }, run })).lastUsedAt).toBe(1_700_000_000_000)
    mkdirSync(join(root, 'codex-home', 'sessions', '2026', '10', '08'), { recursive: true })
    touch(join(root, 'codex-home', 'sessions', '2026', '10', '08'), 1_800_000_000)
    expect((await engineAccount('codex', { home: root, env: { CODEX_HOME: join(root, 'codex-home') }, run })).lastUsedAt).toBe(1_800_000_000_000)
    calls.length = 0
    expect(await engineAccount('opencode', { home: root, env: {}, run })).toEqual({ signedIn: null, lastUsedAt: null })
    expect(calls).toEqual([])
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
      expect((await engineAccount('claude', { home: root, run: cli().run })).signedIn).toBe(true)
    } finally {
      resetLoginShellEnvironmentCache()
    }
  })
})
