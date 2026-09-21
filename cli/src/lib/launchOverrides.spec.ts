import { describe, expect, it, vi } from 'vitest'
import { buildLaunchOverrides, validateLaunchOverrides, type LaunchOverridesDeps } from './launchOverrides.js'
import { GRID_CONFLICTING_ENV_VARS, type GridLaunchOverride } from './gridLaunch.js'

const GRID: GridLaunchOverride = {
  networkId: 'grid-abc',
  networkName: 'Team grid',
  baseUrl: 'https://grid.example/grid-abc/relay/v1',
  apiKey: 'gridkey-abc123',
  model: 'gpt-5',
}

function deps(overrides: Partial<LaunchOverridesDeps> = {}) {
  const calls: string[] = []
  const d: LaunchOverridesDeps = {
    machine: () => ({ hermesSystemManaged: false }),
    writeGridConfigDir: async (key) => { calls.push(`writeConfig:${key}`); return `/state/grid-engine-config/${key}` },
    tmuxSupportsSessionEnv: async () => true,
    installCodexHooks: (home) => { calls.push(`hooks:${home}`) },
    // No Codex configuration unless a test says so — otherwise every relaunch built here would
    // consult the config.toml of whoever is running the suite.
    readCodexConfig: () => null,
    ...overrides,
  }
  return { d, calls }
}

describe('buildLaunchOverrides — a relaunch comes back where the agent was', () => {
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
    const result = await buildLaunchOverrides(d, 'pi', { gridLaunch: GRID }, 'agent-1')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(calls).toEqual(['writeConfig:agent-1'])
    expect(result.overrides.env.PI_CODING_AGENT_DIR).toBe('/state/grid-engine-config/agent-1')
    expect(result.overrides.clearEnv).not.toContain('PI_CODING_AGENT_DIR')
  })

  it('refuses rather than falling back when the grid cannot be honoured', async () => {
    expect(await buildLaunchOverrides(deps().d, 'cursor', { gridLaunch: GRID }, 'a')).toMatchObject({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED' })
    expect(await buildLaunchOverrides(deps({ tmuxSupportsSessionEnv: async () => false }).d, 'claude', { gridLaunch: GRID }, 'a'))
      .toMatchObject({ ok: false, error: 'TMUX_TOO_OLD_FOR_GRID', detail: expect.stringContaining('Team grid') })
    expect(await buildLaunchOverrides(deps({ writeGridConfigDir: async () => { throw new Error('disk full') } }).d, 'pi', { gridLaunch: GRID }, 'a'))
      .toMatchObject({ ok: false, error: 'GRID_CONFIG_FAILED', detail: expect.stringContaining('disk full') })
  })

  it('validation refuses the same launches without writing anything', async () => {
    const { d, calls } = deps({ tmuxSupportsSessionEnv: async () => false })
    expect(await validateLaunchOverrides(d, 'claude', { gridLaunch: GRID })).toMatchObject({ ok: false, error: 'TMUX_TOO_OLD_FOR_GRID' })
    expect(await validateLaunchOverrides(d, 'cursor', { gridLaunch: GRID })).toMatchObject({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED' })
    expect(await validateLaunchOverrides(d, 'pi', { gridLaunch: null, codexHome: '/x' })).toEqual({ ok: true })
    expect(await validateLaunchOverrides(deps().d, 'pi', { gridLaunch: GRID })).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('a Codex profile gets its CODEX_HOME, its hooks and its own provider, and clears nothing', async () => {
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
        clearEnv: [],
      },
    })
    expect(calls).toEqual(['hooks:/home/u/.codex-work'])
  })

  it('an agent on its own login gets nothing — its own variables are the point', async () => {
    const { d, calls } = deps()
    expect(await buildLaunchOverrides(d, 'claude', {}, 'a')).toEqual({ ok: true, overrides: { env: {}, extraArgs: [], clearEnv: [] } })
    expect(await buildLaunchOverrides(d, 'claude', { gridLaunch: null, codexHome: null }, 'a')).toMatchObject({ ok: true })
    expect(calls).toEqual([])
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
  // codex-cli 0.155.1; see `engines/codex/ownLoginProvider.ts`.

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
    expect(own).toEqual({ ok: true, overrides: { env: {}, extraArgs: ['--agent', 'harness-compute'], clearEnv: [] } })
    const home = await buildLaunchOverrides(deps().d, 'opencode', { agent: 'harness-compute', subscriptionModel: 'anthropic/claude' }, 'a')
    expect(home).toMatchObject({ ok: true, overrides: { extraArgs: ['-m', 'anthropic/claude', '--agent', 'harness-compute'] } })
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
