/**
 * Codex's own provider, declared (`ownProvider` in codex/launch.ts), read by the kit (kit/launchArgs.ts)
 * through the composition core calls (`ownLoginProviderArgs`). The cases below are the former
 * engines/codex/ownLoginProvider.spec.ts's, unchanged, run against the composed pieces.
 *
 * The parsing is deliberately small — one key, top level only — so what is worth pinning is where
 * it must NOT find that key, and what it hands back when it finds nothing.
 */
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchHome } from '../lib/engineHomes.js'
import { launch as codex } from './codex/launch.js'
import { topLevelString } from './kit/launchArgs.js'
import { harnessAdapters, launchContract, launchField, ownLoginProviderArgs } from './launches.js'

const own = codex.ownProvider!
const CODEX_DEFAULT_PROVIDER = own.fallback
const parseCodexModelProvider = (toml: string): string | null => topLevelString(toml, own.key)
const codexConfigPath = (home: string | null | undefined, environment?: NodeJS.ProcessEnv): string =>
  join(launchHome(own.home, home, environment), own.file)

// The login shell's environment, as the daemon captured it at start-up: none, unless a test says so.
const shell = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }))
vi.mock('../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => shell.env }))
afterEach(() => { shell.env = {} })

describe('parseCodexModelProvider', () => {
  it('reads a top-level key, with either kind of quote and any spacing', () => {
    expect(parseCodexModelProvider('model_provider = "azure"')).toBe('azure')
    expect(parseCodexModelProvider("model_provider='azure'")).toBe('azure')
    expect(parseCodexModelProvider('  model_provider   =   "azure"  \n')).toBe('azure')
  })

  it('finds it among the other top-level keys a real config carries', () => {
    expect(parseCodexModelProvider([
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "max"',
      'model_provider = "azure"',
      'service_tier = "default"',
    ].join('\n'))).toBe('azure')
  })

  it('STOPS at the first table header', () => {
    // In TOML every key after a header belongs to that table. `model_provider` under
    // `[profiles.work]` is that profile's choice, and handing it back as the file's would move the
    // agent onto a provider the user selected for something else entirely.
    expect(parseCodexModelProvider([
      'model = "gpt-6"',
      '',
      '[profiles.work]',
      'model_provider = "azure"',
    ].join('\n'))).toBeNull()
    expect(parseCodexModelProvider('[projects."/x"]\nmodel_provider = "azure"')).toBeNull()
  })

  it('ignores a commented-out key, and keeps a comment that follows a real one', () => {
    expect(parseCodexModelProvider('# model_provider = "azure"')).toBeNull()
    expect(parseCodexModelProvider('model_provider = "azure" # the work tenant')).toBe('azure')
  })

  it('does not mistake a `#` inside the value for a comment', () => {
    expect(parseCodexModelProvider('model_provider = "az#ure"')).toBe('az#ure')
  })

  it('is not fooled by a key that merely ends in model_provider', () => {
    expect(parseCodexModelProvider('default_model_provider = "azure"')).toBeNull()
  })

  it('answers null for an empty value, a missing key, and an empty file', () => {
    expect(parseCodexModelProvider('model_provider = ""')).toBeNull()
    expect(parseCodexModelProvider('model = "gpt-6"')).toBeNull()
    expect(parseCodexModelProvider('')).toBeNull()
  })
})

describe('codexConfigPath', () => {
  it('prefers the agent’s own profile over the environment', () => {
    expect(codexConfigPath('/profiles/work', { CODEX_HOME: '/elsewhere' })).toBe('/profiles/work/config.toml')
  })

  it('falls back to CODEX_HOME when the agent names no profile', () => {
    expect(codexConfigPath(null, { CODEX_HOME: '/elsewhere' })).toBe('/elsewhere/config.toml')
  })

  // The CODEX_HOME a person moves is set in their shell profile, which every pane's Codex reads and the
  // daemon never does: the desktop app or launchd starts it. Read from the daemon's own environment, the
  // provider a move back off a grid named came from ~/.codex/config.toml, and argv outranks the config, so
  // the person's own `model_provider` in the moved config.toml was overridden with Codex's default.
  it('reads the CODEX_HOME the login shell moves, as every pane\'s Codex does', () => {
    shell.env = { CODEX_HOME: '/codex-work' }
    expect(codexConfigPath(null)).toBe('/codex-work/config.toml')
    expect(codexConfigPath('/profiles/work')).toBe('/profiles/work/config.toml')
    const read = (path: string) => path === '/codex-work/config.toml' ? 'model_provider = "azure"' : null
    expect(ownLoginProviderArgs('codex', null, { read })).toEqual(['-c', 'model_provider="azure"'])
  })
})

describe('ownLoginProviderArgs', () => {
  const read = (toml: string | null) => () => toml

  it('names the configured provider when there is one', () => {
    expect(ownLoginProviderArgs('codex', null, { read: read('model_provider = "azure"'), env: {} }))
      .toEqual(['-c', 'model_provider="azure"'])
  })

  it('falls back to Codex’s own default, which is what Codex would have picked', () => {
    expect(ownLoginProviderArgs('codex', null, { read: read(null), env: {} }))
      .toEqual(['-c', `model_provider="${CODEX_DEFAULT_PROVIDER}"`])
  })

  it('says nothing for every engine that does not persist a provider', () => {
    // Claude Code and Hermes resolve theirs fresh each launch; OpenCode's lives in a file this
    // daemon writes and can stop writing. Only Codex keeps one in state of its own.
    for (const engine of ['claude', 'hermes', 'opencode', 'cursor', 'grok'] as const) {
      expect(ownLoginProviderArgs(engine, '/profiles/work', { read: read('model_provider = "azure"'), env: {} })).toEqual([])
    }
  })

  it('treats an unreadable config as "nothing configured" rather than as a failure', () => {
    // A relaunch must not be blocked by a config.toml that is absent, or that this daemon cannot
    // read. The default is a correct answer in both cases.
    const throws = () => { throw new Error('EACCES') }
    expect(ownLoginProviderArgs('codex', null, { read: () => { try { return throws() } catch { return null } }, env: {} }))
      .toEqual(['-c', `model_provider="${CODEX_DEFAULT_PROVIDER}"`])
  })
})

describe('the launch contracts, composed', () => {
  it('finds a contract only for an engine that declares one', () => {
    expect(launchContract('codex')).toBe(codex)
    expect(launchContract('claude')?.resumeArgs).toEqual(['--resume'])
    expect(launchContract('opencode')).toBeUndefined()
    expect(launchContract('terminal')).toBeUndefined()
    expect(launchField('resumeArgs')).toEqual({ claude: ['--resume'], codex: ['resume'] })
  })

  it('hands a harness each engine\'s declared flags as argv', () => {
    expect(harnessAdapters.claude.contextArgs?.('/w/"a"/CONTEXT.md'))
      .toEqual(['--append-system-prompt', 'Read the harness context at "/w/\\"a\\"/CONTEXT.md" before working.'])
    expect(harnessAdapters.claude.envArgs).toBeUndefined()
    expect(harnessAdapters.codex.contextArgs).toBeUndefined()
    expect(harnessAdapters.codex.envArgs?.({ OK: 'a "b"', 'NOT-OK': 'x', 'a.b': 'y' }))
      .toEqual(['-c', 'shell_environment_policy.set.OK="a \\"b\\""'])
    expect(harnessAdapters.codex.instructionFiles).toEqual(['AGENTS.override.md', 'AGENTS.md'])
  })
})
