import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { agentSettingsPath } from './agentSettings.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import { loadEngine } from '../engines/inProcess.js'
import { buildLaunchOverrides, prepareLaunchOverrides, validateLaunchOverrides, type LaunchOverridesDeps } from './launchOverrides.js'
import { DSH_SESSION_ENV } from '../dsh/launch.js'
import { GRID_CONFLICTING_ENV_VARS, type GridLaunchOverride } from './gridLaunch.js'
import { gridLaunchInProcess } from '../testing/gridLaunchInProcess.js'
import { AGENT_ATTRIBUTION_LINE, HARNESS_INSTRUCTIONS } from './agentAttribution.js'
import { prepareSwarmSkill } from './swarmSkills.js'
import { swarmEngineArgs } from './swarmEngineArgs.js'
import { swarmGitHubLaunch } from './swarmGitHub.js'
import { writeMachineMcp } from './machineMcp.js'

const GRID: GridLaunchOverride = {
  networkId: 'grid-abc',
  networkName: 'Team grid',
  baseUrl: 'https://grid.example/grid-abc/relay/v1',
  apiKey: 'gridkey-abc123',
  model: 'gpt-5',
}

// OpenCode's version probe is its own code, loaded for an OpenCode launch alone; a test may say it could not be.
vi.mock('../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

function deps(overrides: Partial<LaunchOverridesDeps> = {}) {
  const calls: string[] = []
  const d: LaunchOverridesDeps = {
    machine: () => ({ hermesSystemManaged: false }), gridLaunch: gridLaunchInProcess(),
    writeGridConfigDir: async (key) => { calls.push(`writeConfig:${key}`); return `/state/grid-engine-config/${key}` },
    capabilities: async () => ({ sessionEnv: true }),
    installCodexHooks: (home) => { calls.push(`hooks:${home}`); return true },
    // No Codex configuration unless a test says so — otherwise every relaunch built here would
    // consult the config.toml of whoever is running the suite.
    readCodexConfig: () => null,
    // The Swarm on, as by default (`HARNESS_SWARM`); a test of it off leaves it out.
    swarm: { prepare: prepareSwarmSkill, github: (key) => swarmGitHubLaunch(key), args: swarmEngineArgs },
    ...overrides,
  }
  return { d, calls }
}

// A Claude Code or Codex launch is told how to use Harness (lib/agentAttribution.ts) once the account lets agents start
// agents, and a harness another agent started adds its pull request line once the account has that on: both off by
// default, so each relaunch below shows only what it is about. Each has its own describe, which turns it on.
afterEach(() => { rmSync(agentSettingsPath(env.ADAPTER_DATA_DIR), { force: true }); signedOutForTest() })

describe('buildLaunchOverrides — a relaunch comes back where the agent was', () => {
  it('awaits profile hook durability, holds an unavailable profile and checks ownership after completion', async () => {
    let finish!: (installed: boolean) => void, allowed = true, replied = false
    const install = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { d } = deps({ installCodexHooks: install })
    const first = buildLaunchOverrides(d, 'codex', { codexHome: '/profiles/work' }, 'agent-1', () => allowed)
      .finally(() => { replied = true })
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(replied).toBe(false)
    finish(false)
    expect(await first).toMatchObject({ ok: false, unavailable: 'native' })
    const second = buildLaunchOverrides(d, 'codex', { codexHome: '/profiles/work' }, 'agent-1', () => allowed)
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(2))
    allowed = false; finish(true)
    expect(await second).toMatchObject({ ok: false, error: 'AGENT_CHANGED' })
  })
  it.each(['before', 'models', 'Store', 'commit', 'write'] as const)('revocation at %s cannot apply a stale preparation', async stage => {
    let allowed = stage !== 'before'
    const { d, calls } = deps({
      gridLaunch: async request => {
        if (stage === 'models') allowed = false
        return gridLaunchInProcess()(request)
      },
      dshLaunch: async () => {
        if (stage === 'Store') allowed = false
        return { ok: true, launch: { env: {}, args: [] } }
      },
      writeGridConfigDir: async () => { calls.push('write'); if (stage === 'write') allowed = false; return '/fixture/config' },
    })
    const prepared = await prepareLaunchOverrides(d, 'pi', { gridLaunch: GRID, dsh: 'fixture/tools', cwd: '/workspace' }, 'agent-1', () => allowed)
    if (stage === 'commit') allowed = false
    const result = prepared.ok ? await prepared.commit() : prepared
    expect(result).toMatchObject({ error: 'AGENT_CHANGED' })
    expect(calls).toEqual(stage === 'write' ? ['write'] : [])
  })

  it.each(['pi', 'codex'] as const)('does not alter %s configuration when the Store cannot prepare its harness', async engine => {
    const refusal = { ok: false as const, error: 'DSH_UNAVAILABLE', detail: 'Preparation is unconfirmed.', unavailable: 'store' as const, holdScope: 'workspace' as const }
    const { d, calls } = deps({ dshLaunch: async () => refusal })
    const source = { dsh: 'fixture/tools', cwd: '/workspace', ...(engine === 'pi' ? { gridLaunch: GRID } : { codexHome: '/profiles/work' }) }
    expect(await buildLaunchOverrides(d, engine, source, 'agent-1')).toEqual(refusal)
    expect(calls).toEqual([])
  })

  it('does not ask the Store or write configuration when models is unavailable', async () => {
    const dshLaunch = vi.fn()
    const refusal = { ok: false as const, error: 'GRID_UNAVAILABLE', detail: 'Waiting for models.', unavailable: 'models' }
    const { d, calls } = deps({ gridLaunch: async () => refusal, dshLaunch })
    expect(await buildLaunchOverrides(d, 'pi', { gridLaunch: GRID, dsh: 'fixture/tools', cwd: '/workspace' }, 'agent-1')).toEqual(refusal)
    expect(dshLaunch).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('keeps one request and machine snapshot while services answer, and writes only on commit', async () => {
    const machine = vi.fn(() => ({ hermesSystemManaged: false, opencodeMajor: 1 }))
    const source = { gridLaunch: { ...GRID }, dsh: 'fixture/tools', cwd: '/workspace', agent: 'reviewer' }
    const { d, calls } = deps({ machine, dshLaunch: async () => {
      source.agent = 'changed'
      source.gridLaunch.apiKey = 'changed'
      machine.mockReturnValue({ hermesSystemManaged: false, opencodeMajor: 2 })
      return { ok: true, launch: { env: { HARNESS_DSH: 'fixture/tools' }, args: ['--context', 'fixture'] } }
    } })
    const prepared = await prepareLaunchOverrides(d, 'opencode', source, 'agent-1')
    expect(prepared.ok).toBe(true)
    expect(calls).toEqual([])
    if (!prepared.ok) throw new Error('Fixture preparation failed')
    const result = await prepared.commit()
    expect(result).toMatchObject({ ok: true, overrides: {
      env: { HARNESS_DSH: 'fixture/tools' },
      extraArgs: expect.arrayContaining(['-m', '--agent', 'reviewer', '--context', 'fixture']),
      gridLaunchRecord: { override: { apiKey: GRID.apiKey } },
    } })
    expect(calls).toEqual(['writeConfig:agent-1'])
    expect(machine).toHaveBeenCalledExactlyOnceWith('opencode', undefined)
    expect(await prepared.commit()).toMatchObject({ error: 'LAUNCH_PREPARATION_USED' })
    expect(calls).toHaveLength(1)
  })

  it('rebuilds a grid launch from the persisted override: env with the key, argv, and the vendor variables to clear', async () => {
    const { d, calls } = deps()
    const result = await buildLaunchOverrides(d, 'claude', { gridLaunch: GRID }, 'agent-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.overrides.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'gridkey-abc123', ANTHROPIC_MODEL: 'gpt-5' })
    expect(result.overrides.env.ANTHROPIC_BASE_URL).toMatch(/^https:\/\/grid\.example\/grid-abc\/relay/)
    expect(result.overrides.extraArgs).toEqual(expect.arrayContaining(['--disallowedTools=WebSearch,WebFetch']))
    // Everything the launch does not set itself, so an inherited key cannot outrank the grid.
    for (const name of GRID_CONFLICTING_ENV_VARS) {
      expect(result.overrides.clearEnv.includes(name)).toBe(!(name in result.overrides.env))
    }
    expect(calls).toEqual([])
  })

  it('writes a file-configured engine its config directory keyed on the agent, and points the env at it', async () => {
    const { d, calls } = deps()
    const result = await buildLaunchOverrides(d, 'opencode', { gridLaunch: GRID }, 'agent-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toEqual(['writeConfig:agent-1'])
    expect(result.overrides.env.OPENCODE_CONFIG).toBe('/state/grid-engine-config/agent-1/opencode.json')
    expect(result.overrides.clearEnv).not.toContain('OPENCODE_CONFIG')
  })

  it("hands Pi its provider extension as a flag, and leaves Pi's own home alone", async () => {
    // A relaunch is a model switch too: moving Pi's home here reopened it without the conversation it resumes.
    const { d, calls } = deps()
    const result = await buildLaunchOverrides(d, 'pi', { gridLaunch: GRID }, 'agent-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toEqual(['writeConfig:agent-1'])
    expect(result.overrides.extraArgs.slice(-2)).toEqual(['-e', '/state/grid-engine-config/agent-1/grid-provider.ts'])
    expect(result.overrides.env).not.toHaveProperty('PI_CODING_AGENT_DIR')
  })

  it('names the service that could not be asked, so a restore holds the agent rather than failing it', async () => {
    const down = async () => ({ ok: false as const, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
    expect(await buildLaunchOverrides(deps({ gridLaunch: down }).d, 'claude', { gridLaunch: GRID }, 'a'))
      .toEqual({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
    expect(await validateLaunchOverrides(deps({ gridLaunch: down }).d, 'claude', { gridLaunch: GRID }))
      .toEqual({ ok: false, error: 'GRID_UNAVAILABLE', detail: 'models is down', unavailable: 'models' })
  })

  it('refuses rather than falling back when the grid cannot be honoured', async () => {
    expect(await buildLaunchOverrides(deps().d, 'cursor', { gridLaunch: GRID }, 'a')).toMatchObject({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED' })
    expect(await buildLaunchOverrides(deps({ capabilities: async () => ({ sessionEnv: false }) }).d, 'claude', { gridLaunch: GRID }, 'a'))
      .toMatchObject({ ok: false, error: 'TMUX_TOO_OLD_FOR_GRID', detail: expect.stringContaining('Team grid') })
    expect(await buildLaunchOverrides(deps({ writeGridConfigDir: async () => { throw new Error('disk full') } }).d, 'pi', { gridLaunch: GRID }, 'a'))
      .toMatchObject({ ok: false, error: 'GRID_CONFIG_FAILED', detail: expect.stringContaining('disk full') })
  })

  it('validation refuses the same launches without writing anything', async () => {
    const { d, calls } = deps({ capabilities: async () => ({ sessionEnv: false }) })
    expect(await validateLaunchOverrides(d, 'claude', { gridLaunch: GRID })).toMatchObject({ ok: false, error: 'TMUX_TOO_OLD_FOR_GRID' })
    expect(await validateLaunchOverrides(d, 'cursor', { gridLaunch: GRID })).toMatchObject({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED' })
    expect(await validateLaunchOverrides(d, 'pi', { gridLaunch: null, codexHome: '/x' })).toEqual({ ok: true })
    expect(await validateLaunchOverrides(deps().d, 'pi', { gridLaunch: GRID })).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('a Codex profile gets its CODEX_HOME, its hooks and its own provider, and clears inherited harness context', async () => {
    const { d, calls } = deps()
    const result = await buildLaunchOverrides(d, 'codex', { gridLaunch: null, codexHome: '/home/u/.codex-work' }, 'agent-2')
    // `model_provider` rides every own-login Codex launch, not only one that follows a grid: the
    // row does not record where the thread has been, and naming the provider Codex would have
    // picked anyway is what makes a poisoned thread resumable again.
    expect(result).toEqual({
      ok: true,
      overrides: {
        env: { CODEX_HOME: '/home/u/.codex-work' },
        extraArgs: ['-c', 'model_provider="openai"'],
        clearEnv: [...DSH_SESSION_ENV],
      },
    })
    expect(calls).toEqual(['hooks:/home/u/.codex-work'])
  })

  it('an agent on its own login keeps provider variables and clears inherited harness context', async () => {
    const { d, calls } = deps()
    expect(await buildLaunchOverrides(d, 'claude', {}, 'a')).toEqual({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [...DSH_SESSION_ENV] } })
    expect(await buildLaunchOverrides(d, 'claude', { gridLaunch: null, codexHome: null }, 'a')).toMatchObject({ ok: true })
    expect(calls).toEqual([])
  })

  it('in the Harness Team account, spends the owner\'s subscription through the relay on every relaunch', async () => {
    const relay = { env: { HARNESS_RELAY_TOKEN: 't' }, args: ['-c', 'model_provider="harness_owner"'] }
    const ownerRelay = vi.fn(async (engine: string) => engine === 'codex' ? relay
      : engine === 'claude' ? { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/claude', ANTHROPIC_AUTH_TOKEN: 't' }, args: [] } : null)
    // Codex is told the relay's provider in place of its own login's: two `-c model_provider` would leave it to pick.
    expect(await buildLaunchOverrides(deps({ ownerRelay }).d, 'codex', { subscriptionModel: 'gpt-5-codex' }, 'a'))
      .toMatchObject({ ok: true, overrides: { env: { HARNESS_RELAY_TOKEN: 't' }, extraArgs: ['-c', 'model_provider="harness_owner"', '-m', 'gpt-5-codex'] } })
    expect(await buildLaunchOverrides(deps({ ownerRelay }).d, 'claude', {}, 'a'))
      .toMatchObject({ ok: true, overrides: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/claude', ANTHROPIC_AUTH_TOKEN: 't' }, extraArgs: [] } })
    expect(await buildLaunchOverrides(deps({ ownerRelay }).d, 'codex', { gridLaunch: null, codexHome: '/home/u/.codex-work' }, 'a'))
      .toMatchObject({ ok: true, overrides: { env: { CODEX_HOME: '/home/u/.codex-work', HARNESS_RELAY_TOKEN: 't' }, extraArgs: relay.args } })
    // The relay readies, and asks about, that home: a Swarm Product Manager's own, whose sign-in and models are its own.
    expect(ownerRelay).toHaveBeenLastCalledWith('codex', '/home/u/.codex-work')
    // A relaunch (restart, resume, restore) the relay cannot sign in is held with why, as a launch that waits is: after a
    // reboot the Team daemon may restore before the owner's relay is there.
    expect(await buildLaunchOverrides(deps({ ownerRelay: vi.fn(async () => ({ refused: 'No relay here.' })) }).d, 'codex', { gridLaunch: null, codexHome: '/home/u/.codex-work' }, 'a'))
      .toEqual({ ok: false, error: 'OWNER_RELAY_UNAVAILABLE', unavailable: 'native', detail: 'No relay here.' })
    // A grid is its own provider: the relay is not asked.
    ownerRelay.mockClear()
    await buildLaunchOverrides(deps({ ownerRelay }).d, 'codex', { gridLaunch: GRID }, 'a')
    expect(ownerRelay).not.toHaveBeenCalled()
  })

  it('builds OpenCode overrides without optional code and uses the requested engine facts', async () => {
    vi.mocked(loadEngine).mockImplementation(() => new Promise(() => {}))
    expect(await buildLaunchOverrides(deps().d, 'opencode', {}, 'agent-1')).toMatchObject({ ok: true })
    const machine = vi.fn((_engine: string) => ({ hermesSystemManaged: false }))
    await buildLaunchOverrides(deps({ machine }).d, 'claude', { gridLaunch: GRID, subscriptionModel: 'opus' }, 'agent-1')
    expect(machine.mock.calls.every(([engine]) => engine === 'claude')).toBe(true)
    await buildLaunchOverrides(deps({ machine }).d, 'opencode', { agent: 'reviewer' }, 'agent-1')
    expect(machine).toHaveBeenLastCalledWith('opencode', undefined)
    expect(loadEngine).not.toHaveBeenCalled()
  })

  it('never lets the key into argv', async () => {
    for (const engine of ['claude', 'codex', 'opencode', 'hermes', 'grok', 'pi', 'copilot'] as const) {
      const result = await buildLaunchOverrides(deps().d, engine, { gridLaunch: { ...GRID, model: 'm' } }, 'a')
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.overrides.extraArgs.join(' ')).not.toContain('gridkey-abc123')
    }
  })
})

describe('buildLaunchOverrides — coming back off a grid', () => {
  it('re-selects the model the agent was on before it left', async () => {
    // Without this the engine restores the model its OWN session file remembers — the grid's — fails
    // to resolve it, and falls back to a house default. Measured on Claude Code: "Session model
    // Qwen3.6-35B-A3B-UD-Q5_K_XL could not be restored … using opus instead."
    const result = await buildLaunchOverrides(deps().d, 'claude', { subscriptionModel: 'opus' }, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { env: { ANTHROPIC_MODEL: 'opus' } } })
  })

  it('uses argv for an engine whose interactive CLI resolves the model there', async () => {
    const result = await buildLaunchOverrides(deps().d, 'codex', { subscriptionModel: 'gpt-5-codex' }, 'a')
    // The provider comes FIRST: `-c` configures and `-m` selects, and Codex resolves the model
    // against the provider it was given.
    expect(result).toMatchObject({ ok: true, overrides: { extraArgs: ['-c', 'model_provider="openai"', '-m', 'gpt-5-codex'] } })
  })

  it('adds nothing when there is no model to come back to', async () => {
    const result = await buildLaunchOverrides(deps().d, 'claude', {}, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { env: {}, extraArgs: [] } })
  })

  // ── the provider, which Codex remembers on its own ────────────────────────────────────────────
  //
  // Codex records the provider per THREAD (`threads.model_provider` in its own state database),
  // written from the `-c model_provider=` the grid launch passed. Dropping that argv on the way back
  // leaves the NAME stored with nothing defining it, and `codex resume` dies before the TUI is up:
  //   thread/resume failed: failed to load configuration: Model provider `grid` not found
  // The daemon's only answer was to abandon the conversation ("retrying fresh"). Reproduced against
  // codex-cli 0.155.1; see `ownProvider` in `engines/codex/launch.ts`.

  it('names a provider for Codex even when no model is remembered', async () => {
    // The case a model-shaped fix misses entirely: nothing to re-select, and the stale provider is
    // still what stops the resume.
    const result = await buildLaunchOverrides(deps().d, 'codex', {}, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { extraArgs: ['-c', 'model_provider="openai"'] } })
  })

  it('keeps the user’s own model_provider instead of forcing them onto openai', async () => {
    const { d } = deps({ readCodexConfig: () => 'model = "gpt-6"\nmodel_provider = "azure"\n' })
    const result = await buildLaunchOverrides(d, 'codex', { subscriptionModel: 'gpt-6' }, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { extraArgs: ['-c', 'model_provider="azure"', '-m', 'gpt-6'] } })
  })

  it('reads the AGENT’s Codex profile, not this machine’s default', async () => {
    const seen: string[] = []
    const { d } = deps({ readCodexConfig: (path) => { seen.push(path); return null } })
    await buildLaunchOverrides(d, 'codex', { codexHome: '/profiles/work' }, 'a')
    expect(seen).toEqual(['/profiles/work/config.toml'])
  })

  it('keeps the Codex profile AND its hooks while naming the provider', async () => {
    // Both used to be lost: a row with a remembered model returned before the profile branch, so it
    // came back on the default profile and fired no hook.
    const { d, calls } = deps()
    const result = await buildLaunchOverrides(d, 'codex', { codexHome: '/profiles/work', subscriptionModel: 'gpt-6' }, 'a')
    expect(result).toMatchObject({
      ok: true,
      overrides: { env: { CODEX_HOME: '/profiles/work' }, extraArgs: ['-c', 'model_provider="openai"', '-m', 'gpt-6'] },
    })
    expect(calls).toContain('hooks:/profiles/work')
  })

  it('leaves every other engine’s provider alone', async () => {
    // Only Codex persists one. Claude Code and Hermes read theirs fresh each launch, and OpenCode's
    // lives in a file this daemon writes and can simply stop writing.
    for (const engine of ['claude', 'hermes', 'opencode'] as const) {
      const result = await buildLaunchOverrides(deps().d, engine, { subscriptionModel: 'a/b' }, 'a')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.overrides.extraArgs.join(' ')).not.toContain('model_provider')
    }
  })

  it('never names a provider on a GRID launch — that launch names its own', async () => {
    // `-c model_provider="grid"` is the grid contract's, and a second one after it would decide the
    // launch. Nothing about coming back may reach the way out.
    let reads = 0
    const { d } = deps({ readCodexConfig: () => { reads++; return null } })
    const result = await buildLaunchOverrides(d, 'codex', { gridLaunch: GRID, subscriptionModel: 'gpt-6' }, 'a')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const providers = result.overrides.extraArgs.filter((arg) => arg.startsWith('model_provider='))
    expect(providers).toEqual(['model_provider="grid"'])
    // And it is not merely outvoted downstream: a launch going TO a grid has no reason to open the
    // user's Codex configuration at all, so the question is never asked.
    expect(reads).toBe(0)
  })

  it('never lets a remembered model reach a GRID launch — that launch names its own', async () => {
    const result = await buildLaunchOverrides(
      deps().d, 'claude', { gridLaunch: GRID, subscriptionModel: 'opus' }, 'a',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The grid's model, not the remembered one.
    expect(result.overrides.env.ANTHROPIC_MODEL).toBe('gpt-5')
  })
})

describe('buildLaunchOverrides — a pane opened as a named agent comes back as it', () => {
  it('appends opencode\'s --agent after everything else, on its own login and on a grid', async () => {
    const own = await buildLaunchOverrides(deps().d, 'opencode', { agent: 'harness-compute' }, 'a')
    expect(own).toEqual({ ok: true, overrides: { env: {}, extraArgs: ['--agent', 'harness-compute'], clearEnv: [...DSH_SESSION_ENV] } })
    const home = await buildLaunchOverrides(deps().d, 'opencode', { agent: 'harness-compute', subscriptionModel: 'anthropic/claude' }, 'a')
    expect(home).toMatchObject({ ok: true, overrides: { extraArgs: ['-m', 'anthropic/claude', '--agent', 'harness-compute'], sessionModel: 'anthropic/claude' } })
    const grid = await buildLaunchOverrides(deps().d, 'opencode', { gridLaunch: GRID, agent: 'harness-compute' }, 'a')
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    expect(grid.overrides.extraArgs.slice(-2)).toEqual(['--agent', 'harness-compute'])
    expect(grid.overrides.gridLaunchRecord).toBeDefined()
  })

  it('adds nothing for a general session, or for an engine with no contract on a hand-edited row', async () => {
    expect(await buildLaunchOverrides(deps().d, 'opencode', { agent: null }, 'a')).toMatchObject({ ok: true, overrides: { extraArgs: [] } })
    expect(await buildLaunchOverrides(deps().d, 'claude', { agent: 'harness-compute' }, 'a')).toMatchObject({ ok: true, overrides: { extraArgs: [] } })
  })
})

describe('buildLaunchOverrides — retired PR branding', () => {
  it('leaves native attribution alone even when an old account enabled Harness branding', async () => {
    setAgentSettingsForTest(env.ADAPTER_DATA_DIR, { pullRequestLine: true })
    const read = vi.fn(() => '{"attribution":{"pr":"Mine"}}')
    for (const engine of ['claude', 'codex', 'opencode'] as const) {
      const own = await buildLaunchOverrides(deps({ readAttribution: read }).d, engine, { startedBy: 'agent', cwd: '/workspace' }, 'a')
      const personal = await buildLaunchOverrides(deps({ readAttribution: read }).d, engine, { startedBy: null, cwd: '/workspace' }, 'a')
      expect(own).toEqual(personal)
      expect(JSON.stringify(own)).not.toContain(AGENT_ATTRIBUTION_LINE)
      const grid = await buildLaunchOverrides(deps({ readAttribution: read }).d, engine, { startedBy: 'agent', gridLaunch: GRID, cwd: null }, 'a')
      expect(JSON.stringify(grid)).not.toContain(AGENT_ATTRIBUTION_LINE)
    }
    expect(read).not.toHaveBeenCalled()
  })
})

describe('buildLaunchOverrides — every harness is told how to use Harness', () => {
  it('on every relaunch, beside its grid\'s own prompt for Claude Code and in the one instructions value for Codex', async () => {
    setAgentSettingsForTest(env.ADAPTER_DATA_DIR, { agentsStartAgents: true, pullRequestLine: true })
    const own = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'claude', { startedBy: null, cwd: '/w' }, 'a')
    expect(own).toMatchObject({ ok: true, overrides: { extraArgs: ['--append-system-prompt', HARNESS_INSTRUCTIONS] } })
    const grid = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'claude', { startedBy: 'agent', gridLaunch: GRID, cwd: null }, 'a')
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    const args = grid.overrides.extraArgs
    expect(args.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1)
    expect(args[args.indexOf('--append-system-prompt') + 1]).toMatch(new RegExp(`\\n\\n${HARNESS_INSTRUCTIONS.slice(0, 30)}`))
    const codex = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'codex', { startedBy: 'agent', cwd: null }, 'a')
    expect(codex.ok).toBe(true)
    if (!codex.ok) return
    expect(codex.overrides.extraArgs.filter((arg) => arg.startsWith('developer_instructions='))).toHaveLength(1)
    expect(codex.overrides.extraArgs.at(-1)).toContain('You are running in Harness')
    expect(codex.overrides.extraArgs.at(-1)).not.toContain('Started by another agent in [Harness]')
  })
})

describe('buildLaunchOverrides — machine MCP servers (#1872)', () => {
  afterEach(() => rmSync(join(env.ADAPTER_DATA_DIR, 'mcp-servers.json'), { force: true }))

  it('carries the person\'s servers on every relaunch, beside a grid\'s own, before what Harness tells the agent', async () => {
    writeMachineMcp({ lamp: { command: 'lamp-mcp', args: ['--lamp', 'lamp-75c9'], engines: [], projects: [] } })
    setAgentSettingsForTest(env.ADAPTER_DATA_DIR, { agentsStartAgents: true })
    const own = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'claude', { startedBy: null, cwd: '/w' }, 'a')
    expect(own).toMatchObject({ ok: true, overrides: { extraArgs: [
      `--mcp-config=${JSON.stringify({ mcpServers: { lamp: { type: 'stdio', command: 'lamp-mcp', args: ['--lamp', 'lamp-75c9'] } } })}`,
      '--append-system-prompt', HARNESS_INSTRUCTIONS] } })
    const grid = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'claude', { startedBy: null, gridLaunch: GRID, cwd: null }, 'a')
    expect(grid.ok).toBe(true)
    if (!grid.ok) return
    // On a grid too, as its own `--mcp-config=`: a grid's web tools, when it has them, keep theirs.
    expect(grid.overrides.extraArgs.some((arg) => arg.startsWith('--mcp-config={"mcpServers":{"lamp"'))).toBe(true)
    const codex = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'codex', { startedBy: null, cwd: null }, 'a')
    expect(codex.ok && codex.overrides.extraArgs).toEqual(expect.arrayContaining(['mcp_servers.lamp.command="lamp-mcp"', 'mcp_servers.lamp.args=["--lamp","lamp-75c9"]']))
    expect(JSON.stringify(codex)).not.toContain('approval_mode')
    const hermes = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'hermes', { startedBy: null, cwd: null }, 'a')
    expect(JSON.stringify(hermes)).not.toContain('lamp-mcp')
  })

  it('relaunches a Buddy with none of them: it starts no MCP server at all (review 3 of #2092)', async () => {
    writeMachineMcp({ lamp: { command: 'lamp-mcp', args: [], engines: [], projects: [] } })
    const buddy = await buildLaunchOverrides(deps({ readAttribution: () => null }).d, 'claude',
      { startedBy: null, cwd: mkdtempSync(join(tmpdir(), 'overrides-buddy-')), swarmSkill: { role: 'buddy', key: 'harness-claude-buddy' } }, 'a', () => true)
    expect(buddy.ok).toBe(true)
    expect(JSON.stringify(buddy)).not.toContain('lamp-mcp')
  })
})

describe('buildLaunchOverrides — opencode v2', () => {
  const v2 = () => deps({ machine: () => ({ hermesSystemManaged: false, opencodeMajor: 2 }) }).d

  it('hands the v2 TUI neither -m nor --agent, on its own login or on a grid', async () => {
    // Both are `opencode run` flags in v2; the TUI exits 1 on them and the pane becomes a shell.
    for (const source of [
      { agent: 'harness-compute', subscriptionModel: 'anthropic/claude' },
      { gridLaunch: GRID, agent: 'harness-compute' },
    ]) {
      const built = await buildLaunchOverrides(v2(), 'opencode', source, 'a')
      expect(built.ok).toBe(true)
      if (!built.ok) return
      expect(built.overrides.extraArgs).not.toContain('-m')
      expect(built.overrides.extraArgs).not.toContain('--agent')
    }
  })

  it('carries the model the resumed session has to be switched to', async () => {
    const home = await buildLaunchOverrides(v2(), 'opencode', { subscriptionModel: 'anthropic/claude' }, 'a')
    expect(home).toMatchObject({ ok: true, overrides: { extraArgs: [], sessionModel: 'anthropic/claude' } })
    const grid = await buildLaunchOverrides(v2(), 'opencode', { gridLaunch: GRID }, 'a')
    expect(grid).toMatchObject({ ok: true, overrides: { extraArgs: ['--standalone'], sessionModel: 'team-grid/gpt-5' } })
  })
})

describe('buildLaunchOverrides — what the app is told about web search', () => {
  const WITH_MCP: GridLaunchOverride = { ...GRID, mcpUrl: 'https://api-grid.example/v1/grid/web-mcp/' }

  it('reports on when the launch wired the server', async () => {
    const result = await buildLaunchOverrides(deps().d, 'claude', { gridLaunch: WITH_MCP }, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { gridLaunchRecord: { override: WITH_MCP, webSearch: 'on' } } })
  })

  it('reports unavailable when the persisted launch carries no url', async () => {
    const result = await buildLaunchOverrides(deps().d, 'claude', { gridLaunch: GRID }, 'a')
    expect(result).toMatchObject({ ok: true, overrides: { gridLaunchRecord: { override: GRID, webSearch: 'unavailable' } } })
  })

  it('reports unsupported for Hermes on a pinned machine, and writes nothing there', async () => {
    // The machine fact is read through the dependency and handed to the builder; the builder drops
    // the overlay, so there is no config directory to write — the write is what used to be pruned
    // beside the builder, and is now simply never asked for.
    const { d, calls } = deps({ machine: () => ({ hermesSystemManaged: true }) })
    const result = await buildLaunchOverrides(d, 'hermes', { gridLaunch: WITH_MCP }, 'agent-h')
    expect(result).toMatchObject({ ok: true, overrides: { gridLaunchRecord: { override: WITH_MCP, webSearch: 'unsupported' } } })
    if (!result.ok) return
    expect(calls).toEqual([])
    expect(result.overrides.env).not.toHaveProperty('HERMES_MANAGED_DIR')
    expect(result.overrides.clearEnv).toContain('HERMES_MANAGED_DIR')
  })

  it('says nothing about web search for a launch that is not onto a grid', async () => {
    const own = await buildLaunchOverrides(deps().d, 'claude', { gridLaunch: null }, 'a')
    expect(own.ok && own.overrides).not.toHaveProperty('gridLaunchRecord')
    const profile = await buildLaunchOverrides(deps().d, 'codex', { codexHome: '/Users/x/.codex-work' }, 'a')
    expect(profile.ok && profile.overrides).not.toHaveProperty('gridLaunchRecord')
  })
})

describe('buildLaunchOverrides — a Swarm session on the Harness GitHub App', () => {
  const skill = { role: 'dev' as const, key: 'harness-claude-github-fixture', github: true as const }
  const workspace = () => mkdtempSync(join(tmpdir(), 'overrides-github-'))

  it('relaunches with the app\'s git and gh, and clears inherited GitHub token variables', async () => {
    const { d } = deps()
    const result = await buildLaunchOverrides(d, 'claude', { cwd: workspace(), swarmSkill: skill }, 'agent-1', () => true)
    if (!result.ok) throw new Error(result.error)
    const session = join(env.ADAPTER_DATA_DIR, 'swarm-github', 'sessions', skill.key)
    expect(result.overrides.env).toMatchObject({ GH_CONFIG_DIR: join(session, 'gh'), HARNESS_SWARM_GITHUB_DIR: session, GIT_TERMINAL_PROMPT: '0' })
    expect(result.overrides.env.GIT_CONFIG_PARAMETERS).toContain(`'core.hookspath'='${join(env.ADAPTER_DATA_DIR, 'swarm-github', 'hooks')}'`)
    expect(result.overrides.clearEnv).toEqual(expect.arrayContaining(['GH_TOKEN', 'GITHUB_TOKEN']))
  })

  it('relaunches a session without the flag exactly as before', async () => {
    const { d } = deps()
    const result = await buildLaunchOverrides(d, 'claude', { cwd: workspace(), swarmSkill: { role: 'dev', key: 'harness-claude-plain' } }, 'agent-1', () => true)
    if (!result.ok) throw new Error(result.error)
    expect(result.overrides.env).not.toHaveProperty('GIT_CONFIG_PARAMETERS')
    expect(result.overrides.clearEnv).not.toContain('GH_TOKEN')
  })

  it('relaunches a Swarm Codex without its startup update check, and a Codex the Swarm never started with it', async () => {
    const { d } = deps()
    const swarm = await buildLaunchOverrides(d, 'codex', { cwd: workspace(), swarmSkill: { role: 'dev', key: 'harness-codex-plain' } }, 'agent-1', () => true)
    const own = await buildLaunchOverrides(d, 'codex', { cwd: workspace() }, 'agent-1', () => true)
    if (!swarm.ok || !own.ok) throw new Error('relaunch refused')
    expect(swarm.overrides.extraArgs.join(' ')).toContain('-c check_for_update_on_startup=false')
    expect(own.overrides.extraArgs.join(' ')).not.toContain('check_for_update_on_startup')
  })

  // HARNESS_SWARM=off: the core hands in no Swarm, and a session the Swarm started is not relaunched without its role.
  it('refuses a Swarm session with the Swarm off, before it asks or writes anything', async () => {
    const native = vi.fn(), dshLaunch = vi.fn()
    const { d, calls } = deps({ swarm: undefined, native, dshLaunch })
    for (const swarmSkill of [skill, { role: 'lead' as const, key: 'harness-claude-plain' }]) {
      expect(await buildLaunchOverrides(d, 'claude', { cwd: workspace(), dsh: 'fixture/blender', swarmSkill }, 'agent-1', () => true))
        .toEqual({ ok: false, error: 'SWARM_SKILL_FAILED', detail: 'The Swarm is off on this computer (HARNESS_SWARM).' })
    }
    expect(native).not.toHaveBeenCalled()
    expect(dshLaunch).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    // A session the Swarm never started relaunches as it always did.
    expect(await buildLaunchOverrides(d, 'claude', { cwd: workspace() }, 'agent-1', () => true)).toMatchObject({ ok: true })
  })

  it('refuses the relaunch when the app\'s files cannot be written', async () => {
    const root = join(env.ADAPTER_DATA_DIR, 'swarm-github')
    rmSync(root, { recursive: true, force: true })
    writeFileSync(root, 'not a folder')
    try {
      const { d } = deps()
      expect(await buildLaunchOverrides(d, 'claude', { cwd: workspace(), swarmSkill: skill }, 'agent-1', () => true))
        .toMatchObject({ ok: false, error: 'SWARM_SKILL_FAILED' })
    } finally { rmSync(root, { force: true }) }
  })
})
