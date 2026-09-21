import { describe, expect, it } from 'vitest'
import {
  anthropicBaseUrl,
  buildGridEngineLaunch,
  describeGridLaunch,
  gridCapableEngines,
  gridConflictingEnvToClear,
  gridProviderId,
  gridEnvVarNames,
  parseGridLaunchOverride,
  relayBaseUrl,
  type GridLaunchMachine,
  type GridLaunchOverride,
} from './gridLaunch.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { buildEngineLaunchArgv } from './engineLaunch.js'

/** The shape the desktop actually sends, with values read off the live control plane. */
const WIRE = {
  networkId: 'grid-3378218621364f16',
  networkName: 'autonomous.ai',
  baseUrl: 'https://grid.autonomous.ai/grid-3378218621364f16/relay/v1',
  apiKey: 'gridkey-abc123',
}
const RELAY_V1 = WIRE.baseUrl
const RELAY = 'https://grid.autonomous.ai/grid-3378218621364f16/relay'

const OVERRIDE: GridLaunchOverride = { ...WIRE }
const WITH_MODEL: GridLaunchOverride = { ...WIRE, model: 'GLM-4.7-Flash' }
/** The control plane's web-tools mount, trailing slash and all — see `GridLaunchOverride.mcpUrl`. */
const MCP_URL = 'https://api-grid.autonomous.ai/v1/grid/web-mcp/'
const WITH_MCP: GridLaunchOverride = { ...WITH_MODEL, mcpUrl: MCP_URL }
/** The ordinary machine: nobody has pinned Hermes settings in /etc/hermes. */
const PLAIN_MACHINE: GridLaunchMachine = { hermesSystemManaged: false }

function launchOf(engine: AgentEngine, override = WITH_MODEL, machine = PLAIN_MACHINE) {
  const built = buildGridEngineLaunch(engine, override, machine)
  if (!built.ok) throw new Error(`${engine} was refused: ${built.detail}`)
  return built.launch
}

describe('parseGridLaunchOverride', () => {
  it('reads absent as absent, not as a failure', () => {
    // The whole no-regression promise rests on this: a client with no grid selected sends no field,
    // and must create agents exactly the way it did before grids existed.
    expect(parseGridLaunchOverride(undefined)).toEqual({ state: 'absent' })
    expect(parseGridLaunchOverride(null)).toEqual({ state: 'absent' })
  })

  it('accepts the desktop payload, with and without a model', () => {
    expect(parseGridLaunchOverride(WIRE)).toEqual({ state: 'ok', override: OVERRIDE })
    expect(parseGridLaunchOverride({ ...WIRE, model: 'glm-5.2' }))
      .toEqual({ state: 'ok', override: { ...OVERRIDE, model: 'glm-5.2' } })
  })

  it('names every missing field at once rather than one per round trip', () => {
    const result = parseGridLaunchOverride({ networkId: 'g1' })
    expect(result.state).toBe('invalid')
    expect(result).toMatchObject({ reason: 'grid is missing networkName, baseUrl, apiKey' })
  })

  it('refuses a baseUrl that is not an http(s) address', () => {
    for (const baseUrl of ['relay.example/v1', 'file:///etc/passwd', 'ws://relay.example/v1']) {
      expect(parseGridLaunchOverride({ ...WIRE, baseUrl }).state).toBe('invalid')
    }
  })

  it('refuses control characters, which would corrupt an environment or an argv silently', () => {
    expect(parseGridLaunchOverride({ ...WIRE, apiKey: 'abc\u0007def' }).state).toBe('invalid')
    expect(parseGridLaunchOverride({ ...WIRE, model: 'glm\n5.2' }).state).toBe('invalid')
  })

  it('refuses a present-but-empty model instead of quietly dropping the choice', () => {
    expect(parseGridLaunchOverride({ ...WIRE, model: '   ' }).state).toBe('invalid')
  })

  it('refuses a grid that is not an object', () => {
    expect(parseGridLaunchOverride('autonomous.ai').state).toBe('invalid')
    expect(parseGridLaunchOverride([WIRE]).state).toBe('invalid')
  })
})

describe('relay base URLs', () => {
  it('keeps the /v1 an OpenAI client needs and drops the one Claude Code appends itself', () => {
    expect(relayBaseUrl(RELAY_V1)).toBe(RELAY_V1)
    expect(relayBaseUrl(RELAY)).toBe(RELAY_V1)
    expect(anthropicBaseUrl(RELAY_V1)).toBe(RELAY)
    expect(anthropicBaseUrl(RELAY)).toBe(RELAY)
  })

  it('is trailing-slash tolerant and leaves a lookalike path alone', () => {
    expect(anthropicBaseUrl(`${RELAY}/v1/`)).toBe(RELAY)
    expect(relayBaseUrl(`${RELAY}//`)).toBe(RELAY_V1)
    expect(anthropicBaseUrl(`${RELAY}/av1`)).toBe(`${RELAY}/av1`)
  })
})

describe('the launch each engine gets', () => {
  it('points Claude Code at the Messages root with the bearer variable only', () => {
    expect(launchOf('claude')).toEqual({
      env: {
        ANTHROPIC_BASE_URL: RELAY,
        ANTHROPIC_AUTH_TOKEN: WIRE.apiKey,
        ANTHROPIC_MODEL: 'GLM-4.7-Flash',
      },
      args: [
        // The built-in web tools no grid can run — see "takes Claude Code's built-in web tools away".
        '--disallowedTools=WebSearch,WebFetch',
        // …and the words that tell the model so, delivered to a resumed conversation too — see "tells
        // Claude Code in its system prompt".
        '--system-prompt-snapshot', 'off',
        '--append-system-prompt', expect.stringContaining('WebSearch'),
      ],
      // No MCP url in this override, so no web tools — and the app is told so.
      webSearch: 'unavailable',
    })
    // Setting it too makes Claude Code warn that auth may not work, and it decides nothing.
    expect(launchOf('claude').env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('configures Codex on its command line, keeping the key in the environment', () => {
    const launch = launchOf('codex')
    expect(launch.env).toEqual({ GRID_API_KEY: WIRE.apiKey })
    expect(launch.args.join(' ')).toContain(`model_providers.grid.base_url="${RELAY_V1}"`)
    expect(launch.args.join(' ')).toContain('model_providers.grid.env_key="GRID_API_KEY"')
    // Codex speaks the Responses dialect and rejects `wire_api = "chat"`.
    expect(launch.args.join(' ')).toContain('model_providers.grid.wire_api="responses"')
    expect(launch.args).toContain('-m')
    expect(launch.args).toContain('GLM-4.7-Flash')
  })

  it('uses the OpenAI-compatible pair for Hermes, with the model on the command line too', () => {
    const launch = launchOf('hermes')
    expect(launch.env).toEqual({
      OPENAI_BASE_URL: RELAY_V1,
      OPENAI_API_KEY: WIRE.apiKey,
      HERMES_INFERENCE_MODEL: 'GLM-4.7-Flash',
    })
    // The variable alone was measured to decide nothing: the pane this daemon opens is hermes'
    // INTERACTIVE CLI, which reads its model from `-m` then config.yaml and from no environment
    // tier — and a grid move relaunches it as `hermes --resume <id>`, which puts the model stored
    // on the session row back unless argv carried an explicit `-m`. The pill read GLM-4.7-Flash
    // out of the environment while the pane ran the config's DeepSeek-V4-Flash-0731.
    expect(launch.args).toEqual(['-m', 'GLM-4.7-Flash'])
  })

  it('does NOT use that pair for opencode, which would not honour it', () => {
    // OpenCode reads the endpoint but keeps its compiled-in `openai` catalogue, so the pair produced
    // an engine naming models the grid had never heard of. It declares a provider instead — see the
    // `opencode declares the grid as a provider` block below.
    expect(launchOf('opencode').env).toEqual({ GRID_API_KEY: WIRE.apiKey })
  })

  it('declares the model for Grok, because the documented variable pair loses to its session token', () => {
    // `GROK_MODELS_BASE_URL` + `XAI_API_KEY` is the pair Grok documents, and it is not enough:
    // `XAI_API_KEY` is LAST in Grok's credential order, behind the OIDC session token that a private
    // GROK_HOME still acquires. Measured on a live pane — `auth_mode=Oidc`, `remedy=ManualLogin`, and
    // "Authentication required" in the pane — while the relay answered 200 to the same key by curl.
    // Declaring the model with `env_key` moves the grid key above the session token.
    const launch = launchOf('grok')
    expect(launch.env).toEqual({
      GROK_MODELS_BASE_URL: RELAY_V1,
      XAI_API_KEY: WIRE.apiKey,
      GRID_API_KEY: WIRE.apiKey,
    })
    expect(launch.args).toEqual(['-m', 'GLM-4.7-Flash'])
    // The config is written whether or not there are web tools: it is the credential that needs it.
    const config = launch.configDir?.files.find((f) => f.name === 'config.toml')?.content ?? ''
    expect(config).toContain('[model."GLM-4.7-Flash"]')
    expect(config).toContain('env_key = "GRID_API_KEY"')
    expect(config).toContain(`base_url = "${RELAY_V1}"`)
  })

  it('gives Grok a config even with no web tools to declare', () => {
    // It used to write one only for MCP servers, on the reasoning that a launch with nothing to
    // configure should leave the user's ~/.grok alone. That left the credential on the losing side of
    // Grok's resolution order, so a grid agent authenticated as the user's own xAI login.
    const launch = launchOf('grok', { ...WITH_MODEL, mcpUrl: undefined })
    const config = launch.configDir?.files.find((f) => f.name === 'config.toml')?.content ?? ''
    expect(config).toContain('env_key = "GRID_API_KEY"')
    expect(config).not.toContain('mcp_servers')
  })

  it('uses the documented BYOK trio for Copilot', () => {
    expect(launchOf('copilot').env).toEqual({
      COPILOT_PROVIDER_BASE_URL: RELAY_V1,
      COPILOT_PROVIDER_API_KEY: WIRE.apiKey,
      COPILOT_MODEL: 'GLM-4.7-Flash',
    })
  })

  it('gives Pi a config directory of ours, never the user\'s own', () => {
    const launch = launchOf('pi')
    expect(launch.env).toEqual({ GRID_API_KEY: WIRE.apiKey })
    expect(launch.args).toEqual(['--model', 'grid/GLM-4.7-Flash'])
    const configDir = launch.configDir
    expect(configDir?.envVar).toBe('PI_CODING_AGENT_DIR')
    const models = configDir?.files.find((file) => file.name === 'models.json')
    expect(models).toBeDefined()
    const parsed = JSON.parse(models!.content) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string }>
    }
    expect(parsed.providers.grid.baseUrl).toBe(RELAY_V1)
    // `openai-completions` makes Pi post to <base>/chat/completions, which the relay serves.
    expect(parsed.providers.grid.api).toBe('openai-completions')
    // An env REFERENCE. Writing the key itself would put a live credential on disk, outliving the
    // agent and every reason it existed.
    expect(parsed.providers.grid.apiKey).toBe('$GRID_API_KEY')
    expect(models!.content).not.toContain(WIRE.apiKey)
  })

  it('hands Pi back the skills the redirection would otherwise hide', () => {
    const settings = launchOf('pi').configDir?.files.find((file) => file.name === 'settings.json')
    const parsed = JSON.parse(settings!.content) as Record<string, unknown>
    expect((parsed.skills as string[])[0]).toContain('.pi')
    // The Grid app set `defaultProjectTrust: always` because it drove Pi headless with nobody there
    // to answer. Here a person is sitting in front of the pane, so the trust prompt stays theirs.
    expect(parsed).not.toHaveProperty('defaultProjectTrust')
  })

  it('routes Pi through Auto when the user picked no model, rather than refusing', () => {
    // Pi's provider block has to name a model, so "none" cannot be left blank — but the answer is
    // the router's own id, the way OpenCode's block already does it, not a refusal. This was
    // GRID_MODEL_REQUIRED, which made Pi the one grid-capable engine the New agent dialog could
    // never start: that dialog always creates on Auto and offers no model field.
    const launch = launchOf('pi', OVERRIDE)
    expect(launch.args).toEqual(['--model', 'grid/Auto'])
    const models = launch.configDir?.files.find((file) => file.name === 'models.json')
    const parsed = JSON.parse(models!.content) as {
      providers: Record<string, { models: { id: string; name: string }[] }>
    }
    // Named in the block too, not just in argv — Pi resolves `grid/Auto` against this list.
    expect(parsed.providers.grid.models.map((m) => m.id)).toEqual(['Auto'])
  })

  it('never puts the key in argv, or on disk, for any engine', () => {
    // `ps` is world-readable for the life of the process; the environment is not.
    for (const engine of gridCapableEngines()) {
      const launch = launchOf(engine)
      expect(launch.args.join(' '), engine).not.toContain(WIRE.apiKey)
      expect(Object.values(launch.env), engine).toContain(WIRE.apiKey)
      for (const file of launch.configDir?.files ?? []) {
        expect(file.content, `${engine}/${file.name}`).not.toContain(WIRE.apiKey)
      }
    }
  })

  it('leaves the model to the engine when the user picked none', () => {
    expect(launchOf('claude', OVERRIDE).env).not.toHaveProperty('ANTHROPIC_MODEL')
    expect(launchOf('hermes', OVERRIDE).env).not.toHaveProperty('HERMES_INFERENCE_MODEL')
    expect(launchOf('hermes', OVERRIDE).args).toEqual([])
    expect(launchOf('codex', OVERRIDE).args).not.toContain('-m')
  })

  it('refuses Copilot without a model rather than letting it fail inside the app', () => {
    const built = buildGridEngineLaunch('copilot', OVERRIDE, PLAIN_MACHINE)
    expect(built).toMatchObject({ ok: false, error: 'GRID_MODEL_REQUIRED' })
  })

  it('declares the router for Grok when the user picked no model, rather than refusing', () => {
    // The credential rides on a declared model block, so SOMETHING has to be named — but that is the
    // contract's problem, not a question to put back to the user. `Auto` is the New Agent dialog's
    // default, and refusing it would turn the common path into a wall at the moment of clicking
    // Create. The relay serves the router id like any other model, and Grok launched against
    // `[model."Auto"]` answered through it with no probe and no 401.
    const launch = launchOf('grok', OVERRIDE)
    expect(launch.args).toEqual(['-m', 'Auto'])
    const config = launch.configDir?.files.find((f) => f.name === 'config.toml')?.content ?? ''
    expect(config).toContain('[model."Auto"]')
    expect(config).toContain('env_key = "GRID_API_KEY"')
  })
})

describe('the engines that cannot', () => {
  it('refuses each one with a reason specific to that engine', () => {
    const capable = new Set(gridCapableEngines())
    const refused = ENGINES.filter((engine) => !capable.has(engine))
    expect(refused.length).toBeGreaterThan(0)
    for (const engine of refused) {
      const built = buildGridEngineLaunch(engine, OVERRIDE, PLAIN_MACHINE)
      expect(built.ok).toBe(false)
      if (built.ok) continue
      expect(built.error).toBe('GRID_ENGINE_UNSUPPORTED')
      expect(built.detail).toContain(OVERRIDE.networkName)
      // "unsupported" alone tells nobody whether to wait, change a setting, or pick another engine.
      expect(built.detail).not.toContain('it has no known way to change its endpoint')
      expect(built.detail).toContain('Engines that can:')
    }
  })

  it('lists exactly the engines with a verified vendor contract', () => {
    expect([...gridCapableEngines()].sort())
      .toEqual(['claude', 'codex', 'copilot', 'grok', 'hermes', 'opencode', 'pi'])
  })
})

describe('describeGridLaunch', () => {
  it('names the grid and the model, and never the key', () => {
    const line = describeGridLaunch('claude', WITH_MODEL, 'on')
    expect(line).toContain('autonomous.ai')
    expect(line).toContain('GLM-4.7-Flash')
    expect(line).not.toContain(WIRE.apiKey)
    expect(describeGridLaunch('claude', OVERRIDE, 'on')).not.toContain(WIRE.apiKey)
  })

  it('names the web-search status — the daemon log is where a degraded launch says why', () => {
    expect(describeGridLaunch('claude', WITH_MCP, 'on')).toContain('web search on')
    expect(describeGridLaunch('claude', WITH_MODEL, 'unavailable')).toContain('web search unavailable')
    expect(describeGridLaunch('pi', WITH_MCP, 'unsupported')).toContain('web search unsupported')
    // The url is the control plane's address, not a secret — but it is also not the log's business.
    expect(describeGridLaunch('claude', WITH_MCP, 'on')).not.toContain(MCP_URL)
  })

  it('says why, for the two answers this module decides itself', () => {
    expect(describeGridLaunch('hermes', WITH_MCP, 'unsupported')).toContain('/etc/hermes pins')
    expect(describeGridLaunch('pi', WITH_MCP, 'unsupported')).toContain('no MCP client')
    // `unavailable` was decided — and its reason logged — by the url resolver, not here.
    expect(describeGridLaunch('claude', WITH_MODEL, 'unavailable')).toMatch(/web search unavailable$/)
  })
})

describe('gridEnvVarNames', () => {
  // Derived from the contract rather than listed by hand: a second list would drift the first time
  // an engine's contract gained a variable, and the symptom would be a "cleared" agent still running
  // on the grid it was supposedly moved off.
  it('names every variable claude is launched with', () => {
    // GRID_API_KEY among them: the probe asks for a launch with web tools, and moving an agent to
    // another grid has to take the old grid's MCP credential out of the pane with everything else.
    expect(gridEnvVarNames('claude').sort())
      .toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'GRID_API_KEY'])
  })

  it("names the scope Hermes' web tools are written into", () => {
    // Cleared on a retarget like every other variable here. It points at a directory holding one
    // grid's credential reference; an agent moved to another grid must not keep reading it.
    expect(gridEnvVarNames('hermes')).toContain('HERMES_MANAGED_DIR')
  })

  it("names codex's MCP header variable, which no other engine uses", () => {
    expect(gridEnvVarNames('codex')).toContain('GRID_MCP_AUTHORIZATION')
    expect(gridEnvVarNames('claude')).not.toContain('GRID_MCP_AUTHORIZATION')
  })

  it('includes the config-dir pointer for an engine that uses one', () => {
    expect(gridEnvVarNames('pi')).toContain('PI_CODING_AGENT_DIR')
  })

  it('covers every variable a launch WITH web tools sets, so returning to the own login clears them all', () => {
    // This is what `cli.ts` hands `tmux clearEnv` on a clearGrid retarget. A variable a web-tools
    // launch set but this list missed would leave the pane holding an MCP credential after the agent
    // was told it is back on its subscription model.
    for (const engine of gridCapableEngines()) {
      const launch = launchOf(engine, WITH_MCP)
      const set = [...Object.keys(launch.env), ...(launch.configDir ? [launch.configDir.envVar] : [])]
      for (const name of set) expect(gridEnvVarNames(engine), `${engine} sets ${name}`).toContain(name)
    }
  })

  it('is empty for an engine that cannot be pointed at a grid', () => {
    expect(gridEnvVarNames('amp')).toEqual([])
  })
})

describe('gridConflictingEnvToClear', () => {
  const override = {
    networkId: 'grid-x',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-x/relay/v1',
    apiKey: 'RELAY-KEY',
  }
  const clearedFor = (engine: AgentEngine, model?: string): string[] => {
    const built = buildGridEngineLaunch(engine, model ? { ...override, model } : override, PLAIN_MACHINE)
    if (!built.ok) throw new Error(`${engine} refused: ${JSON.stringify(built)}`)
    return gridConflictingEnvToClear(built.launch)
  }

  it('never clears a variable the same launch sets', () => {
    for (const engine of ['claude', 'codex', 'opencode', 'hermes', 'grok', 'copilot', 'pi'] as const) {
      const built = buildGridEngineLaunch(engine, { ...override, model: 'a-model' }, PLAIN_MACHINE)
      if (!built.ok) throw new Error(`${engine} refused`)
      const set = new Set(Object.keys(built.launch.env))
      if (built.launch.configDir) set.add(built.launch.configDir.envVar)
      for (const name of gridConflictingEnvToClear(built.launch)) {
        expect(set.has(name), `${engine} both sets and clears ${name}`).toBe(false)
      }
    }
  })

  it("clears the key that redirected OpenCode away from the grid it was handed", () => {
    // The regression this exists for: OpenCode was given OPENAI_BASE_URL for a grid, found an
    // inherited ANTHROPIC_API_KEY, and spent it on api.anthropic.com instead.
    expect(clearedFor('opencode')).toContain('ANTHROPIC_API_KEY')
    // And OPENAI_* goes too, now that opencode brings its own provider: leaving the user's own
    // OpenAI key in place would re-arm the built-in catalogue this launch exists to get away from.
    expect(clearedFor('opencode')).toContain('OPENAI_BASE_URL')
    expect(clearedFor('opencode')).toContain('OPENAI_API_KEY')
    // Its own variable is the one thing kept.
    expect(clearedFor('opencode')).not.toContain('GRID_API_KEY')
  })

  it('clears the personal Anthropic key even for Claude, whose grid uses the bearer variable', () => {
    // Claude Code warns when both are set and the relay wants the Bearer; leaving the API key behind
    // is what let a dotfile decide which one won.
    expect(clearedFor('claude')).toContain('ANTHROPIC_API_KEY')
    expect(clearedFor('claude')).not.toContain('ANTHROPIC_AUTH_TOKEN')
    expect(clearedFor('claude')).not.toContain('ANTHROPIC_BASE_URL')
  })

  it('keeps ANTHROPIC_MODEL only when the launch pins one', () => {
    expect(clearedFor('claude')).toContain('ANTHROPIC_MODEL')
    expect(clearedFor('claude', 'DeepSeek-V4-Flash-0731')).not.toContain('ANTHROPIC_MODEL')
  })

  it('leaves codex its GRID_API_KEY and clears every vendor variable around it', () => {
    const cleared = clearedFor('codex')
    expect(cleared).not.toContain('GRID_API_KEY')
    expect(cleared).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']))
  })
})

describe('opencode declares the grid as a provider', () => {
  const base: GridLaunchOverride = {
    networkId: 'grid-x',
    networkName: 'autonomous.ai',
    baseUrl: 'https://grid.autonomous.ai/grid-x/relay/v1',
    apiKey: 'RELAY-KEY',
  }
  const launch = (model?: string) => {
    const built = buildGridEngineLaunch('opencode', model ? { ...base, model } : base, PLAIN_MACHINE)
    if (!built.ok) throw new Error('opencode refused')
    return built.launch
  }
  const config = (model?: string) => JSON.parse(launch(model).configDir!.files[0].content)

  it('slugifies a grid name into something a person can type as <id>/<model>', () => {
    expect(gridProviderId('autonomous.ai')).toBe('autonomous-ai')
    expect(gridProviderId('private autonomous')).toBe('private-autonomous')
    expect(gridProviderId('macOS')).toBe('macos')
    // Nothing left to slug: an empty provider key would make the config unparseable.
    expect(gridProviderId('...')).toBe('grid')
  })

  it('never writes a top-level `model`, which OpenCode validates against a closed enum', () => {
    // A private grid's model is not in that enum, so this key would make OpenCode refuse the whole
    // config at startup — arriving as a dead pane well after the launch looked fine.
    expect(config('DeepSeek-V4-Flash-0731')).not.toHaveProperty('model')
    expect(config()).not.toHaveProperty('model')
  })

  it('selects the model on argv instead, which is not schema-validated', () => {
    expect(launch('DeepSeek-V4-Flash-0731').args).toEqual(['-m', 'autonomous-ai/DeepSeek-V4-Flash-0731'])
  })

  it("falls back to the grid's router when no model was chosen", () => {
    expect(launch().args).toEqual(['-m', 'autonomous-ai/Auto'])
  })

  it('writes EXACTLY ONE model, which is what the probe reads back', () => {
    // `readOpencodeGridAssignment` answers "which model is this agent on" from this file alone,
    // precisely so it never has to parse a live process's argv — which flickered. A second entry
    // here would leave that question unanswerable and the probe would go back to saying nothing.
    expect(Object.keys(config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].models))
      .toEqual(['DeepSeek-V4-Flash-0731'])
    expect(Object.keys(config().provider['autonomous-ai'].models)).toEqual(['Auto'])
  })

  it('keeps the key out of the file and references it from the environment', () => {
    const written = launch('DeepSeek-V4-Flash-0731')
    expect(written.configDir!.files[0].content).not.toContain('RELAY-KEY')
    expect(written.env).toEqual({ GRID_API_KEY: 'RELAY-KEY' })
    expect(config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].options.apiKey)
      .toBe('{env:GRID_API_KEY}')
  })

  it('does not set OPENAI_* beside its own provider', () => {
    // Those would re-arm OpenCode's built-in `openai` provider, whose compiled-in catalogue is what
    // picked a model the grid answered 503 for.
    expect(launch('DeepSeek-V4-Flash-0731').env).not.toHaveProperty('OPENAI_BASE_URL')
    expect(launch('DeepSeek-V4-Flash-0731').env).not.toHaveProperty('OPENAI_API_KEY')
  })

  it('passes the relay root through verbatim — the SDK appends the path itself', () => {
    expect(config().provider['autonomous-ai'].options.baseURL).toBe(base.baseUrl)
  })

  it('omits `limit` entirely rather than writing half of one', () => {
    // OpenCode requires `context` and `output` together and rejects the config given only one.
    const models = config('DeepSeek-V4-Flash-0731').provider['autonomous-ai'].models
    for (const entry of Object.values(models)) expect(entry).not.toHaveProperty('limit')
  })

  it('points OPENCODE_CONFIG at the file, not at the directory holding it', () => {
    expect(launch().configDir!.envVar).toBe('OPENCODE_CONFIG')
    expect(launch().configDir!.pointAt).toBe('opencode.json')
  })
})

describe('web tools (grid ADR 0041)', () => {
  const claudeMcpJson = (override = WITH_MCP) => {
    const args = launchOf('claude', override).args
    const at = args.indexOf('--mcp-config')
    expect(at, 'claude was not given --mcp-config').toBeGreaterThanOrEqual(0)
    return JSON.parse(args[at + 1] as string)
  }
  const copilotMcpJson = (override = WITH_MCP) => {
    const args = launchOf('copilot', override).args
    const at = args.indexOf('--additional-mcp-config')
    expect(at, 'copilot was not given --additional-mcp-config').toBeGreaterThanOrEqual(0)
    return JSON.parse(args[at + 1] as string)
  }
  const codexArg = (key: string, override = WITH_MCP): string | undefined => {
    const args = launchOf('codex', override).args
    return args.find((arg) => arg.startsWith(`${key}=`))
  }
  const opencodeConfig = (override = WITH_MCP) =>
    JSON.parse(launchOf('opencode', override).configDir!.files[0]!.content)

  it('accepts the desktop payload carrying an MCP url', () => {
    expect(parseGridLaunchOverride({ ...WIRE, mcpUrl: MCP_URL }))
      .toEqual({ state: 'ok', override: { ...OVERRIDE, mcpUrl: MCP_URL } })
  })

  it('refuses an mcpUrl that is not an http(s) address', () => {
    for (const mcpUrl of ['api-grid.autonomous.ai/v1/grid/web-mcp/', 'file:///etc/passwd', '']) {
      expect(parseGridLaunchOverride({ ...WIRE, mcpUrl }).state, mcpUrl).toBe('invalid')
    }
  })

  it('hands Claude Code the server as a --mcp-config JSON string', () => {
    expect(claudeMcpJson().mcpServers['harness'])
      .toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer ${GRID_API_KEY}' } })
  })

  it('leaves the user their own MCP servers', () => {
    // --strict-mcp-config would drop every server they configured for themselves. A grid adds web
    // tools; it does not take an agent's own tools away.
    expect(launchOf('claude', WITH_MCP).args).not.toContain('--strict-mcp-config')
  })

  it('hands Copilot the SAME document, under its own flag', () => {
    // Measured 2026-09-09 against a header-logging listener on loopback, Copilot CLI 1.0.83: it
    // expands `${VAR}` in a header exactly as Claude Code does, and sends `${env:VAR}` and
    // `{env:VAR}` through verbatim — so the opencode spelling would have put the literal string on
    // the wire and failed authentication with nothing naming why.
    expect(copilotMcpJson().mcpServers['harness'])
      .toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer ${GRID_API_KEY}' } })
    // One document, not two that merely look alike — this is what makes the shared builder honest.
    const at = launchOf('copilot', WITH_MCP).args.indexOf('--additional-mcp-config')
    const claudeAt = launchOf('claude', WITH_MCP).args.indexOf('--mcp-config')
    expect(launchOf('copilot', WITH_MCP).args[at + 1])
      .toBe(launchOf('claude', WITH_MCP).args[claudeAt + 1])
  })

  it("leaves Copilot the user's own MCP servers too", () => {
    // The flag is `--additional-mcp-config`: it augments ~/.copilot/mcp-config.json for the session
    // rather than replacing it, which is why no dotfile is written and none of theirs is dropped.
    expect(launchOf('copilot', WITH_MCP).args.filter((arg) => arg.startsWith('--')))
      .toEqual(['--additional-mcp-config'])
  })

  it("points Codex at it through env_http_headers, which carries the WHOLE header value", () => {
    expect(codexArg('mcp_servers.harness.url')).toBe(`mcp_servers.harness.url="${MCP_URL}"`)
    expect(codexArg('mcp_servers.harness.env_http_headers.Authorization'))
      .toBe('mcp_servers.harness.env_http_headers.Authorization="GRID_MCP_AUTHORIZATION"')
    // Bearer included — `bearer_token_env_var` takes a bare token, this one does not, and ADR 0041
    // D-d calls confusing the two a silent 401.
    expect(launchOf('codex', WITH_MCP).env.GRID_MCP_AUTHORIZATION).toBe(`Bearer ${WIRE.apiKey}`)
  })

  it('declares it in the config file opencode already gets', () => {
    expect(opencodeConfig().mcp['harness'])
      .toEqual({
        type: 'remote',
        url: MCP_URL,
        enabled: true,
        headers: { Authorization: 'Bearer {env:GRID_API_KEY}' },
      })
  })

  it('gives Hermes a managed-scope overlay, since it takes no flag for MCP', () => {
    const dir = launchOf('hermes', WITH_MCP).configDir
    expect(dir?.envVar).toBe('HERMES_MANAGED_DIR')
    // The directory itself, like Pi — Hermes reads `config.yaml` out of the scope it is handed.
    expect(dir?.pointAt).toBeUndefined()
    const file = dir?.files.find((f) => f.name === 'config.yaml')
    expect(file, 'hermes was given no config.yaml').toBeDefined()
    // Emitted as JSON on purpose: it is a subset of YAML, and Hermes parses this with a YAML loader.
    expect(JSON.parse(file!.content)).toEqual({
      mcp_servers: {
        'harness': {
          url: MCP_URL,
          headers: { Authorization: 'Bearer ${GRID_API_KEY}' },
        },
      },
    })
  })

  it("merges into the user's Hermes config rather than replacing it", () => {
    // `_deep_merge` recurses dict-over-dict, so pinning one server under `mcp_servers` keeps every
    // server they configured for themselves. Nothing outside that key may appear here — a second
    // top-level key would pin a setting of theirs that nobody asked us to pin.
    const file = launchOf('hermes', WITH_MCP).configDir!.files[0]!
    expect(Object.keys(JSON.parse(file.content))).toEqual(['mcp_servers'])
  })

  it('calls the server `harness` in every harness — the user never reads "grid"', () => {
    // The tools are named after it — an agent sees `mcp__harness__web_search` — so a harness that
    // spells it differently gets differently-named tools, and a prompt or skill naming one silently
    // misses on the other. The name is also what `/mcp` and a permission prompt show, which is why
    // it is the product's name and not the grid's.
    expect(Object.keys(claudeMcpJson().mcpServers)).toEqual(['harness'])
    expect(Object.keys(copilotMcpJson().mcpServers)).toEqual(['harness'])
    expect(Object.keys(opencodeConfig().mcp)).toEqual(['harness'])
    expect(Object.keys(JSON.parse(launchOf('hermes', WITH_MCP).configDir!.files[0]!.content).mcp_servers))
      .toEqual(['harness'])
    expect(codexArg('mcp_servers.harness.url')).toBeDefined()
    const grok = launchOf('grok', WITH_MCP).configDir!.files[0]!.content
    expect(grok).toContain('[mcp_servers.harness]')
    for (const engine of ['claude', 'codex', 'copilot', 'opencode', 'hermes', 'grok'] as const) {
      const launch = launchOf(engine, WITH_MCP)
      const written = [...launch.args, ...(launch.configDir?.files ?? []).map((f) => f.content)].join('\n')
      expect(written, engine).not.toContain('grid-web')
    }
  })

  it('never writes the key to disk or to an argv', () => {
    for (const engine of ['claude', 'codex', 'copilot', 'opencode', 'hermes'] as const) {
      const launch = launchOf(engine, WITH_MCP)
      for (const arg of launch.args) expect(arg, `${engine} argv`).not.toContain(WIRE.apiKey)
      for (const file of launch.configDir?.files ?? []) {
        expect(file.content, `${engine} ${file.name}`).not.toContain(WIRE.apiKey)
      }
      // It reaches the engine the one way this module allows.
      expect(Object.values(launch.env).some((value) => value.includes(WIRE.apiKey))).toBe(true)
    }
  })

  it('survives the interactive-shell wrapper the pane actually launches through', () => {
    // The one that would be catastrophic to get wrong. An engine is started as
    // `zsh -lic 'unset …; exec "$@"' harness-engine <engine> …`, and if that shell were to expand
    // the argument, `${GRID_API_KEY}` would become the key — in a command line `ps` shows to every
    // user on the machine. `exec "$@"` passes positionals through untouched, which is what keeps
    // the reference a reference; this pins it against a future change to the wrapper.
    for (const engine of ['claude', 'copilot'] as const) {
      const launch = launchOf(engine, WITH_MCP)
      const argv = buildEngineLaunchArgv(engine, { extraArgs: launch.args })
      expect(argv.join(' '), engine).toContain('Bearer ${GRID_API_KEY}')
      expect(argv.join(' '), engine).not.toContain(WIRE.apiKey)
    }
  })

  it("takes Claude Code's built-in web tools away on every grid launch, web tools or not", () => {
    // `WebSearch` is an Anthropic SERVER tool (`web_search_20250305`) that no grid runs, and
    // `WebFetch` summarises through a haiku call on the same base URL, which the relay answers
    // `503 no_providers_available`. Both are dead on a grid, with or without a replacement, and a
    // model offered a dead tool reaches for it first.
    for (const override of [OVERRIDE, WITH_MODEL, WITH_MCP]) {
      expect(launchOf('claude', override).args).toContain('--disallowedTools=WebSearch,WebFetch')
    }
    // ONE token. The flag is variadic, so the two-token form would swallow any positional after it as
    // another tool name — measured on Claude Code 2.1.268, it then sent no request at all.
    expect(launchOf('claude', WITH_MCP).args).not.toContain('--disallowedTools')
    expect(launchOf('claude', WITH_MCP).args).not.toContain('--disallowedTools=WebSearch')
  })

  it('tells Claude Code in its system prompt that the built-in web tools are gone — on every grid launch', () => {
    // `--disallowedTools` empties the tool LIST of them, and the list is not the only place a model
    // reads tool names from. A conversation moved onto a grid mid-way still carries the `WebSearch`
    // turns it had on the Subscription model, and a model imitates those ahead of reading the list —
    // seen on a real pane (2026-09-16, Claude Code 2.1.273, a DeepSeek model resumed after three
    // `WebSearch` turns on Sonnet 5): one response carrying three `WebSearch` calls, each refused "No
    // such tool available", before the next turn found `mcp__harness__web_search`. The list of that
    // request had no `WebSearch` in it; the history did. So the prompt says so in words.
    for (const override of [OVERRIDE, WITH_MODEL, WITH_MCP]) {
      const args = launchOf('claude', override).args
      const at = args.indexOf('--append-system-prompt')
      expect(at, 'claude was not given --append-system-prompt').toBeGreaterThanOrEqual(0)
      const prompt = args[at + 1] as string
      expect(prompt).toContain('WebSearch')
      expect(prompt).toContain('WebFetch')
      // Earlier turns are the whole problem, so the text names them rather than leaving the model to
      // weigh a tool list against a history that contradicts it.
      expect(prompt).toMatch(/earlier turns/)
      // Principle 4 of the plan: a model narrates its system prompt back to the user ("WebSearch got
      // disabled mid-session. I'll use the harness web search tool instead."), so "grid" is not in it.
      expect(prompt.toLowerCase()).not.toContain('grid')
    }
  })

  it('makes that prompt reach a conversation the agent was already in the middle of', () => {
    // Claude Code records the system prompt on a conversation's first request and replays the record
    // on every later request and resume, "even when a later launch passes different text"
    // (`--system-prompt-snapshot`, default `on`, 2.1.273). Measured 2026-09-16 on a resumed session:
    // with `--append-system-prompt` alone the model never saw the text and no new record was written;
    // with `--system-prompt-snapshot off` on the same launch it did — and a later launch WITHOUT the
    // flag (the move back to the Subscription model) replayed the original record, so nothing said
    // on the grid follows the agent off it. A move onto a grid is nearly always such a resume.
    for (const override of [OVERRIDE, WITH_MODEL, WITH_MCP]) {
      const args = launchOf('claude', override).args
      const at = args.indexOf('--system-prompt-snapshot')
      expect(at, 'claude was not given --system-prompt-snapshot').toBeGreaterThanOrEqual(0)
      expect(args[at + 1]).toBe('off')
    }
  })

  it('points the prompt at the harness tools only when they were wired', () => {
    const promptOf = (override: GridLaunchOverride): string => {
      const args = launchOf('claude', override).args
      return args[args.indexOf('--append-system-prompt') + 1] as string
    }
    // With a server: name the replacements, so the model has somewhere to go.
    expect(promptOf(WITH_MCP)).toContain('mcp__harness__web_search')
    expect(promptOf(WITH_MCP)).toContain('mcp__harness__web_read')
    // Without one — a degraded launch, or an older desktop — naming a tool the model was not given
    // would send it down the same road as the dead one, so the prompt says there are no web tools.
    expect(promptOf(WITH_MODEL)).not.toContain('mcp__harness__')
    expect(promptOf(WITH_MODEL)).toMatch(/no web tools/)

  })

  it("pre-approves the harness web tools for Claude Code, so a permission mode cannot take them away", () => {
    // The tools are the daemon's own gift to the agent, and Claude Code's permission system does not
    // know that: in `default` mode every call prompts, and in `auto` mode the classifier DENIED
    // `mcp__harness__web_search` outright on a real pane (2026-09-15) — the model then fell back to
    // curl. An allow rule is honoured before either, so the two tools are listed by name.
    expect(launchOf('claude', WITH_MCP).args).toContain('--allowedTools=mcp__harness__web_search,mcp__harness__web_read')
    // ONE token, for the same reason as `--disallowedTools=`: the flag is variadic.
    expect(launchOf('claude', WITH_MCP).args).not.toContain('--allowedTools')
    // Nothing to approve when nothing was wired.
    expect(launchOf('claude', WITH_MODEL).args.some((a) => a.startsWith('--allowedTools'))).toBe(false)
  })

  it("turns Codex's native web search off on every grid launch, web tools or not", () => {
    // The native tool is an API-side feature of OpenAI's Responses endpoint. Verified on codex-cli
    // 0.154.0 with `--strict-config`: the key is `web_search`, the variants `disabled`, `cached`,
    // `indexed`, `live`, and `web_search_mode` is refused as unknown.
    for (const override of [OVERRIDE, WITH_MODEL, WITH_MCP]) {
      const args = launchOf('codex', override).args
      const at = args.indexOf('web_search="disabled"')
      expect(at, 'codex was not told to disable web_search').toBeGreaterThan(0)
      expect(args[at - 1]).toBe('-c')
    }
  })

  it('adds no web tools when the desktop sends no mcpUrl', () => {
    // An older desktop, and the no-regression promise: no server it did not ask for. Claude's flags
    // are not web tools but the removal of two no grid can run, and the words that say so — with no
    // replacement named, since none was wired. See the tests above.
    expect(launchOf('claude', WITH_MODEL).args).toEqual([
      '--disallowedTools=WebSearch,WebFetch',
      '--system-prompt-snapshot', 'off',
      '--append-system-prompt', expect.not.stringContaining('mcp__harness__'),
    ])
    expect(launchOf('claude', WITH_MODEL).env.GRID_API_KEY).toBeUndefined()
    expect(launchOf('grok', WITH_MODEL).configDir!.files[0]!.content).not.toContain('mcp_servers')
    expect(launchOf('copilot', WITH_MODEL).args).toEqual([])
    expect(launchOf('copilot', WITH_MODEL).env.GRID_API_KEY).toBeUndefined()
    expect(codexArg('mcp_servers.harness.url', WITH_MODEL)).toBeUndefined()
    expect(launchOf('codex', WITH_MODEL).env.GRID_MCP_AUTHORIZATION).toBeUndefined()
    expect(opencodeConfig(WITH_MODEL).mcp).toBeUndefined()
    // Hermes had no config directory at all before web tools, so it goes back to having none.
    expect(launchOf('hermes', WITH_MODEL).configDir).toBeUndefined()
    expect(launchOf('hermes', WITH_MODEL).env.GRID_API_KEY).toBeUndefined()
  })
})

describe('web search status — what the app is told about the launch it got', () => {
  // Every engine with MCP wiring, which is every grid-capable one but Pi.
  const WIRED: AgentEngine[] = ['claude', 'codex', 'opencode', 'hermes', 'grok', 'copilot']

  it('is on when the MCP url is present and the engine wired it', () => {
    for (const engine of WIRED) expect(launchOf(engine, WITH_MCP).webSearch, engine).toBe('on')
  })

  it('is unavailable when the url is absent — the grid could not be asked for it', () => {
    for (const engine of WIRED) expect(launchOf(engine, WITH_MODEL).webSearch, engine).toBe('unavailable')
  })

  it('is unsupported for Pi, which has no MCP client, url or no url', () => {
    expect(launchOf('pi', WITH_MCP).webSearch).toBe('unsupported')
    expect(launchOf('pi', WITH_MODEL).webSearch).toBe('unsupported')
  })

  it('is unsupported for Hermes on a machine whose settings are pinned in /etc/hermes, and writes no overlay there', () => {
    // The overlay REPLACES the system scope rather than adding to it, so on such a machine it is
    // dropped — a decision the builder makes, so every caller (create, retarget, restore) agrees.
    const launch = launchOf('hermes', WITH_MCP, { hermesSystemManaged: true })
    expect(launch.webSearch).toBe('unsupported')
    expect(launch.configDir).toBeUndefined()
    // The variable exists only to be referenced by the overlay, so it goes with it.
    expect(launch.env.GRID_API_KEY).toBeUndefined()
    expect(launch.env.HERMES_MANAGED_DIR).toBeUndefined()
  })

  it('takes nothing else from Hermes on such a machine — inference is still pointed at the grid', () => {
    const pinned = launchOf('hermes', WITH_MCP, { hermesSystemManaged: true })
    const plain = launchOf('hermes', WITH_MCP)
    expect(pinned.env).toMatchObject({ OPENAI_BASE_URL: plain.env.OPENAI_BASE_URL, OPENAI_API_KEY: plain.env.OPENAI_API_KEY })
    expect(pinned.args).toEqual(plain.args)
  })

  it('is unsupported for Hermes on such a machine even with no url — the pin is the fact that lasts', () => {
    expect(launchOf('hermes', WITH_MODEL, { hermesSystemManaged: true }).webSearch).toBe('unsupported')
  })

  it('leaves every other engine alone on such a machine', () => {
    for (const engine of WIRED.filter((e) => e !== 'hermes')) {
      expect(launchOf(engine, WITH_MCP, { hermesSystemManaged: true }).webSearch, engine).toBe('on')
    }
  })

  it('says on exactly when the launch it describes names the server — for every engine, both machines', () => {
    // "The engine wired it" is not taken on trust from the contract that reports it: the launch
    // either carries the `harness` server (in argv or in a file it writes) or it does not, and the
    // status must agree with that. A future contract that took a url and forgot to wire it, or
    // wired it and reported otherwise, fails here.
    const names = (launch: ReturnType<typeof launchOf>): string =>
      [...launch.args, ...(launch.configDir?.files.map((f) => f.content) ?? [])].join('\n')
    for (const machine of [PLAIN_MACHINE, { hermesSystemManaged: true }]) {
      for (const engine of gridCapableEngines()) {
        for (const override of [WITH_MCP, WITH_MODEL]) {
          const built = buildGridEngineLaunch(engine, override, machine)
          if (!built.ok) continue // copilot without a model — refused, nothing to describe
          const wired = names(built.launch).includes('harness')
          expect(built.launch.webSearch === 'on', `${engine} · mcpUrl ${!!override.mcpUrl} · pinned ${machine.hermesSystemManaged}`)
            .toBe(wired)
        }
      }
    }
  })
})
