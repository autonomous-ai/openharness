/**
 * Pointing an agent at an Autonomous Grid instead of the engine's own login.
 *
 * The desktop app lets a user pick a grid (and optionally a model), mints a short-lived relay key for
 * it, and sends the result as `payload.grid` on `agent_create` / `agent_retarget`. Nothing about that
 * reaches an engine by itself: this CLI is what spawns the engine, so this module turns that payload
 * into the launch — environment, and where the vendor demands it, argv.
 *
 * The one place that payload is kept is the registry row (`RegisteredSession.gridLaunch`, in a 0600
 * file this daemon owns) — so a restart, or a pane recreated after a reboot, relaunches onto the SAME
 * grid with the SAME key rather than silently coming back on the engine's own login. Nothing THIS
 * module writes (argv, a config directory) ever carries the key; that rule is unchanged.
 *
 * ## Every entry here is the vendor's own documented contract
 *
 * The relay speaks two dialects — Anthropic Messages at `<grid>/relay`, and OpenAI
 * chat/completions + responses at `<grid>/relay/v1` — so an engine can be pointed at it only if the
 * engine itself offers a way to change its endpoint. Those ways differ, and none of them is
 * guessable: `ANTHROPIC_BASE_URL` for Claude Code, `-c model_providers.*` argv for Codex,
 * `GROK_MODELS_BASE_URL` for Grok, `COPILOT_PROVIDER_BASE_URL` for Copilot. Each entry below cites
 * where it was read from.
 *
 * An engine with no entry is REFUSED, and the refusal names why for that engine specifically. Three
 * shapes of "no" appear, and they are worth telling apart because only one of them could ever change
 * on our side:
 *
 *   * **Wrong protocol.** The engine CAN be re-pointed, but at its own vendor's API rather than an
 *     OpenAI- or Anthropic-shaped one. Cursor Agent reads `CURSOR_API_ENDPOINT` (default
 *     `https://api2.cursor.sh`, read out of the shipped bundle) and Antigravity reads
 *     `GOOGLE_GEMINI_BASE_URL` — handing either the relay would send it a dialect the relay does not
 *     serve (grid ADR 0012 lists Gemini as a future data edit, not a served endpoint). A knob
 *     existing is not the same as a knob that helps, and pointing one of these at a grid would fail
 *     inside the app with an error naming neither.
 *   * **Config-file only** (pi, kilo): the provider block has to be written into the user's own
 *     dotfile. Editing another tool's configuration on someone's behalf is a side effect that
 *     outlives the agent, so this module does not do it.
 *   * **Nothing documented** (muse, commandcode, amp, devin): no vendor documentation describes an
 *     endpoint override. These are the entries that could gain a contract tomorrow — with a cited
 *     source, not a plausible-looking variable name.
 *
 * Refusing is the point. Silently launching against the engine's own login would put the agent
 * somewhere other than where the user said, spend the wrong account, and look like it worked.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEngine } from '../engines/types.js'
import { isOpencodeV2 } from '../engines/opencode/version.js'
import {
  anthropicBaseUrl, API_NETWORK_PREFIX, GRID_KEY_VAR, GRID_ROUTER_MODEL, isApiLaunch, relayBaseUrl,
  type GridEngineLaunch, type GridLaunchAnswer, type GridLaunchMachine, type GridLaunchOverride, type GridLaunchRequest,
  type GridLaunchResult, type GridWebSearchStatus,
} from './gridLaunchWire.js'
import {
  CLAUDE_ALLOW_WEB_TOOLS_ARG,
  CLAUDE_DISALLOW_WEB_TOOLS_ARG,
  claudeGridPromptArgs,
  CODEX_DISABLE_WEB_SEARCH_ARGS,
  mcpServersConfig,
  codexMcpArgs,
  GRID_MCP_AUTH_VAR,
  GROK_CONFIG_FILE,
  GROK_GRID_HOME_LINKS,
  GROK_HOME_VAR,
  grokGridConfig,
  HERMES_MANAGED_CONFIG_FILE,
  HERMES_MANAGED_DIR_VAR,
  HERMES_SYSTEM_MANAGED_DIR,
  hermesManagedConfig,
  mcpAuthorizationHeader,
} from './gridWebMcp.js'
import { HARNESS_MCP_SERVER_NAME } from './harnessWebTools.js'

export * from './gridLaunchWire.js'

/** Where Pi keeps the skills the user manages, handed back through our own settings.json. */
function userPiSkillsDir(): string {
  return join(homedir(), '.pi', 'agent', 'skills')
}

/**
 * Grok's real state directory — the one a private [GROK_HOME_VAR] borrows `sessions/` from.
 *
 * `homedir()` rather than the daemon's own `env.GROK_HOME`, deliberately and for the reason stated
 * beside [HERMES_SYSTEM_MANAGED_DIR]: a contract that reads process configuration answers
 * differently depending on who launched it. The two agree in every deployment that matters — the
 * daemon's `GROK_HOME` defaults to exactly this — and a machine that has moved it has moved the
 * transcripts the daemon reads too, which is a question for the caller, not for a pure contract.
 */
function userGrokHome(): string {
  return join(homedir(), '.grok')
}

/** The file OpenCode's `OPENCODE_CONFIG` is pointed at. */
const OPENCODE_CONFIG_FILE = 'opencode.json'

/**
 * A grid's name as an OpenCode provider id.
 *
 * The id is what a person types as `<id>/<model>`, so it has to survive being typed: lowercase, no
 * spaces, no dots. Grid names carry all three — `autonomous.ai`, `private autonomous`, `macOS` — so
 * this is a real transformation rather than a formality.
 *
 *     autonomous.ai       -> autonomous-ai
 *     private autonomous  -> private-autonomous
 *     macOS               -> macos
 *
 * A name that leaves nothing behind (punctuation only) falls back to `grid`, because an empty
 * provider key would make the config unparseable rather than merely odd.
 */
export function gridProviderId(networkName: string): string {
  const slug = networkName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'grid'
}

/**
 * The provider id OpenCode's generated config declares for [override].
 *
 * A saved API is `api-<connection id>`, never its bare name: OpenCode ships built-in providers under
 * names like `openrouter`, and a config block with the same id is merged into the built-in one rather
 * than replacing it.
 */
function opencodeProviderId(override: GridLaunchOverride): string {
  return isApiLaunch(override)
    ? `api-${gridProviderId(override.networkId.slice(API_NETWORK_PREFIX.length))}`
    : gridProviderId(override.networkName)
}

/**
 * The provider block OpenCode reads, as JSON.
 *
 * Four things here are load-bearing, each of which breaks the engine differently when got wrong:
 *
 *  1. **No top-level `model` key on v1.** OpenCode 1.x's schema `$ref`s a CLOSED enum of known public
 *     models with no wildcard branch, so naming a private grid's model there makes OpenCode refuse
 *     the whole config at startup — a failure that arrives as a dead pane, long after the launch
 *     looked fine. The model is selected on argv instead, which is not schema-validated. v2 is the
 *     other way round: its TUI has no `-m`, and it accepts `model` naming the provider declared here
 *     (measured on 2.0.18: a fresh `--standalone` pane opened on it), so on v2 the key is written.
 *  2. **`baseURL` is the relay root verbatim.** It already ends in `/relay/v1`; the SDK appends
 *     `/chat/completions` itself, so any "normalising" here 404s every request.
 *  3. **`apiKey` is `{env:…}`, not the key.** Nothing written to disk by this module may contain a
 *     credential. This diverges from the advice a person following OpenCode's own docs gets — there
 *     the literal is recommended, because an unset variable silently becomes an empty string and a
 *     human-launched OpenCode has no guarantee the variable is set. Here it IS guaranteed: the
 *     daemon puts it in the pane's environment with `tmux new-session -e` before the engine starts.
 *  4. **`limit` only when the window is known, and then BOTH halves.** OpenCode requires `context`
 *     and `output` together and rejects the config given only one. It is how OpenCode knows how much
 *     room is left, so without it a session ran on until the relay refused a request as too long,
 *     never having compacted. Absent when the relay did not report a window: inventing one would be
 *     worse than OpenCode's own defaults. `output` is a quarter of the window, capped at OpenCode's
 *     own 32K output ceiling — it is also what OpenCode holds back from the window for the reply, so
 *     a larger share would compact a small window after every other turn.
 */
/** OpenCode's own ceiling on a reply, which it also reserves out of the window. */
const OPENCODE_OUTPUT_MAX = 32_000

function opencodeOutputLimit(contextWindow: number): number {
  return Math.min(OPENCODE_OUTPUT_MAX, Math.floor(contextWindow / 4))
}

function opencodeGridConfig(
  provider: string,
  override: GridLaunchOverride,
  model: string,
  v2: boolean,
): string {
  // EXACTLY ONE model, and that is deliberate: it is what the agent was created with.
  //
  // Offering the router alongside it would let someone switch inside OpenCode, which reads as a
  // kindness until you ask what the agent is running on. The probe that answers that
  // (`readOpencodeGridAssignment`) reads this file, so a file naming two models can only say which
  // one is live by parsing the engine's argv — and an argv is a live process's business, which it
  // may rewrite. One model here makes the answer a fact about a file that cannot change under us.
  //
  // Choosing a different model is what every other engine here does too: per agent, at creation.
  const models: Record<string, { name: string; limit?: { context: number; output: number } }> = {
    [model]: {
      name: model,
      ...(override.contextWindow
        ? { limit: { context: override.contextWindow, output: opencodeOutputLimit(override.contextWindow) } }
        : {}),
    },
  }
  return `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    // v2 only — see point 1 above. A resumed session keeps its own model whatever this says; the
    // caller switches that one through the API (`sessionModel`).
    ...(v2 ? { model: `${provider}/${model}` } : {}),
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        // The grid's name as written — this is what a person reads in the model picker, so it keeps
        // its dots and its capitals while the id beside it does not.
        name: override.networkName,
        options: {
          baseURL: relayBaseUrl(override.baseUrl),
          apiKey: `{env:${GRID_KEY_VAR}}`,
        },
        models,
      },
    },
    // The grid's web tools, referencing the key exactly the way `apiKey` above does — opencode's own
    // `{env:…}`, so this file still contains no credential.
    ...(override.mcpUrl
      ? {
        mcp: {
          [HARNESS_MCP_SERVER_NAME]: {
            type: 'remote',
            url: override.mcpUrl,
            enabled: true,
            headers: { Authorization: `Bearer {env:${GRID_KEY_VAR}}` },
          },
        },
      }
      : {}),
  }, null, 2)}\n`
}

interface GridEngineContract {
  build: (override: GridLaunchOverride, machine: GridLaunchMachine) => GridEngineLaunch
  /** The engine cannot start against a grid without being told which model to ask for. */
  requiresModel?: boolean
}

/**
 * The variable an engine is told to read the key from, where the engine supports that indirection.
 *
 * Codex names it in `env_key`; Pi's `models.json` writes it as a `$VAR` reference. Both exist so the
 * credential can stay in the environment while the configuration that points at it is not secret.
 */

/** The provider id our generated config declares. Pi selects it as `--model <id>/<model>`. */
const GRID_PROVIDER_ID = 'grid'

/**
 * The status for an engine whose contract wires the server whenever there is a url to wire — which
 * is every contract but Pi's, and Hermes's only when the machine lets it.
 */
const webSearchWhenWired = (override: GridLaunchOverride): GridWebSearchStatus =>
  override.mcpUrl ? 'on' : 'unavailable'

/**
 * Pi's provider block, as the Grid app shipped and unit-tested it
 * (`autonomous-grid-app`, `pi_grid_config.dart` at 36d00c95, before Pi was dropped from that app for
 * reasons about ITS chat UI — a fourth agent nobody reached for, and a 180 MB private Node
 * toolchain — none of which apply here, where the user installs Pi themselves).
 *
 * `api: openai-completions` makes Pi post to `<base>/chat/completions`, which is what the relay
 * serves. The context/cost numbers are Pi's own bookkeeping for its display; the grid decides what
 * the model really takes.
 */
function piModelsJson(baseUrl: string, model: string, contextWindow?: number): string {
  return JSON.stringify({
    providers: {
      [GRID_PROVIDER_ID]: {
        name: 'Autonomous Grid',
        baseUrl,
        api: 'openai-completions',
        // An env reference, not the key — nothing secret is written to disk.
        apiKey: `$${GRID_KEY_VAR}`,
        models: [{
          id: model,
          name: model,
          reasoning: false,
          input: ['text'],
          // The real window when the relay reported one — the same fault as every engine here:
          // told 200K, Pi never compacted before a smaller server refused the request.
          contextWindow: contextWindow ?? 200000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)
}

/**
 * Pi's settings for the directory we own, which exists to hand back the one thing the redirection
 * takes away: the skills the user keeps in their real `~/.pi/agent/skills`.
 *
 * Deliberately NOT `defaultProjectTrust: always`. The Grid app set it because it drove Pi headless,
 * one process per turn, with nobody there to answer a prompt. Here the user is sitting in front of
 * an interactive pane, and silently pre-trusting every folder they open an agent in would be this
 * daemon deciding something it was not asked to decide.
 */
function piSettingsJson(userSkillsDir: string): string {
  return JSON.stringify({ skills: [userSkillsDir] }, null, 2)
}

/**
 * Every engine that can be pointed at a grid, and how.
 *
 * `undefined` is a refusal with a reason attached in [GRID_ENGINE_REFUSALS]; see the module comment
 * for why a missing entry is never filled in with a plausible-looking guess.
 */
const GRID_ENGINE_CONTRACTS: Partial<Record<AgentEngine, GridEngineContract>> = {
  // The grid CLI's own launch target (`autonomous-grid/shared/launch/claude.py`), so these are the
  // vendor's names as that team verified them rather than this repo's reading of them.
  claude: {
    build: (override) => {
      const webSearch = webSearchWhenWired(override)
      return {
        env: {
          ANTHROPIC_BASE_URL: anthropicBaseUrl(override.baseUrl),
          // The bearer variable, and ONLY it. Claude Code warns when ANTHROPIC_AUTH_TOKEN and
          // ANTHROPIC_API_KEY are both set, and the relay prefers the Bearer header anyway — so
          // ANTHROPIC_API_KEY would decide nothing, while colliding with the variable a user's own
          // Anthropic key lives in.
          ANTHROPIC_AUTH_TOKEN: override.apiKey,
          // `grid launch claude` deliberately sets no model variable, on the grounds that a launcher
          // has no standing to choose a user's model. That reasoning does not carry here: the desktop
          // app ASKED, and this is the answer. Left unset when the user picked no model.
          ...(override.model ? { ANTHROPIC_MODEL: override.model } : {}),
          // The window to compact within. A grid model's id is one Claude Code does not recognise, so
          // it assumes 200K and compacts only near that — on a smaller server, never, because the
          // server refuses the request first. This is the documented variable for exactly that
          // case (code.claude.com/docs/en/model-config, "unrecognized model IDs").
          ...(override.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(override.contextWindow) } : {}),
          // Only when there are web tools to reach: the variable exists to be referenced by the config
          // below, and setting it otherwise would leave a key in the pane that nothing reads.
          ...(override.mcpUrl ? { [GRID_KEY_VAR]: override.apiKey } : {}),
        },
        args: [
          // On every grid launch, web tools or not: the built-in search is an Anthropic server tool
          // that no grid runs, and the built-in fetch summarises through a model the grid does not
          // serve. See `CLAUDE_DISALLOW_WEB_TOOLS_ARG`.
          CLAUDE_DISALLOW_WEB_TOOLS_ARG,
          // With the server comes its approval: a tool the daemon wired in and a permission mode then
          // refuses is worse than no tool at all. See `CLAUDE_ALLOW_WEB_TOOLS_ARG`.
          ...(override.mcpUrl
            ? ['--mcp-config', mcpServersConfig(override.mcpUrl, GRID_KEY_VAR), CLAUDE_ALLOW_WEB_TOOLS_ARG]
            : []),
          // And the words. An agent moved here mid-conversation reads `WebSearch` off its own history
          // before it reads the list, so the prompt names what is gone and — when one was wired — what
          // replaces it, delivered past the recorded prompt a resume would otherwise replay. See
          // `claudeGridPromptArgs`.
          ...claudeGridPromptArgs(webSearch === 'on'),
        ],
        webSearch,
      }
    },
  },

  // Codex configures its provider entirely on the command line — `-c key=value` overrides anything
  // `~/.codex/config.toml` would have said, which is how `ori codex` points it at OpenRouter without
  // touching a dotfile (see `gatewayRuntime.ts`). Key names verified against the grid repo's
  // `docs/codex-quickstart.md` and `-c` against codex-cli 0.144.6 on this machine.
  //
  // The key travels in the environment under `env_key`, never in argv.
  codex: {
    build: (override) => ({
      env: {
        [GRID_KEY_VAR]: override.apiKey,
        ...(override.mcpUrl ? { [GRID_MCP_AUTH_VAR]: mcpAuthorizationHeader(override.apiKey) } : {}),
      },
      args: [
        '-c', 'model_provider="grid"',
        '-c', 'model_providers.grid.name="Autonomous Grid"',
        '-c', `model_providers.grid.base_url="${relayBaseUrl(override.baseUrl)}"`,
        '-c', `model_providers.grid.env_key="${GRID_KEY_VAR}"`,
        // Mandatory: Codex speaks the Responses dialect and rejects `wire_api = "chat"`.
        '-c', 'model_providers.grid.wire_api="responses"',
        // The relay streams HTTP SSE, not WebSocket.
        '-c', 'model_providers.grid.supports_websockets=false',
        // On every grid launch, web tools or not: the native search is a Responses-API feature no
        // grid serves. See `CODEX_DISABLE_WEB_SEARCH_ARGS`.
        ...CODEX_DISABLE_WEB_SEARCH_ARGS,
        ...(override.mcpUrl ? codexMcpArgs(override.mcpUrl) : []),
        ...(override.model ? ['-m', override.model] : []),
        // The window, and where to compact inside it. Codex knows neither for a model it does not
        // recognise, so it never compacted and the relay refused the request as too long instead.
        // 90% leaves the summary request itself room to fit.
        ...(override.contextWindow
          ? [
            '-c', `model_context_window=${override.contextWindow}`,
            '-c', `model_auto_compact_token_limit=${Math.floor(override.contextWindow * 0.9)}`,
          ]
          : []),
      ],
      webSearch: webSearchWhenWired(override),
    }),
  },

  // opencode's simplest documented custom provider: the OpenAI-compatible pair
  // (https://opencode.ai/docs/providers). The model is left to the app — its `--model` wants a
  // `provider/model` pair whose provider id is not documented for the env-var route, and inventing
  // one would send it looking for a model that does not exist.
  // OpenCode is the one engine here that an endpoint variable alone cannot steer, and the reason is
  // worth stating because `OPENAI_BASE_URL` looks like it should be enough — the grid CLI's own
  // `grid info --env` exports exactly that pair, and it is enough for hermes.
  //
  // OpenCode's `openai` provider carries a COMPILED-IN model catalogue (49 entries: gpt-4o,
  // gpt-5.6-terra-pro, …). It sends requests to `OPENAI_BASE_URL` but never asks that endpoint what
  // it serves, so pointing it at a grid gives an engine that will only ever name models the grid has
  // never heard of. Measured: it selected `gpt-5.6-terra-pro` and the relay answered
  //
  //   503 · No providers available for this model. This grid serves: DeepSeek-V4-Flash-0731, …
  //
  // and `-m openai/DeepSeek-V4-Flash-0731` — naming a real grid model under its built-in provider —
  // made OpenCode's own server throw instead.
  //
  // So it takes the shape codex and pi take: DECLARE a provider. `OPENCODE_CONFIG` names a config
  // file, this daemon writes one into a directory it owns, and the grid arrives as a provider whose
  // models are the grid's own ids. The user's `~/.config/opencode/opencode.json` is never opened.
  //
  // ## v2 (2.0.18, measured)
  //
  // The TUI rejects `-m` and exits 1, so the model goes in the config file instead (see
  // `opencodeGridConfig`, point 1). And by default the TUI attaches to ONE background service shared
  // by every OpenCode on the machine, which never sees a pane's `OPENCODE_CONFIG`: a session put on a
  // provider declared only here showed the service's default model in its footer. `--standalone`
  // gives the pane its own server, which reads the file — the same session then showed the declared
  // model. A resumed session keeps its stored model either way, so `sessionModel` is what the caller
  // switches it to before the relaunch.
  opencode: {
    build: (override, machine) => {
      const provider = opencodeProviderId(override)
      // No model chosen means the grid routes — `Auto` is the router's own id, and the relay serves
      // it (verified: 200). It is a real id to OpenCode either way, which is what matters: the
      // provider block has to name something, and leaving the model out entirely puts OpenCode back
      // on its own catalogue and the 503 above.
      const model = override.model ?? GRID_ROUTER_MODEL
      const v2 = isOpencodeV2(machine.opencodeMajor)
      return {
        // The key travels in the environment and is REFERENCED from the file, never written into it
        // — the rule every config-file engine here follows.
        env: { [GRID_KEY_VAR]: override.apiKey },
        // Deliberately NOT `OPENAI_BASE_URL`/`OPENAI_API_KEY`. Setting them would re-arm the built-in
        // `openai` provider beside ours, and its catalogue is what chose the model the grid refused.
        args: v2 ? ['--standalone'] : ['-m', `${provider}/${model}`],
        configDir: {
          envVar: 'OPENCODE_CONFIG',
          pointAt: OPENCODE_CONFIG_FILE,
          files: [{
            name: OPENCODE_CONFIG_FILE,
            content: opencodeGridConfig(provider, override, model, v2),
          }],
        },
        webSearch: webSearchWhenWired(override),
        sessionModel: `${provider}/${model}`,
      }
    },
  },

  // Nous Research's documented trio for a custom OpenAI-compatible endpoint
  // (hermes-agent/website/docs/reference/environment-variables.md) — plus the model on the command
  // line, which is the only place hermes reads it from in the mode this daemon actually launches.
  //
  // `HERMES_INFERENCE_MODEL` is read by `hermes -z` and by the gateway behind `hermes --tui`. The
  // pane opened here is neither: it is the INTERACTIVE CLI, whose model resolution is `-m` then
  // config.yaml and no env tier at all (`cli.py:_init_model_and_provider`, "Priority: CLI args >
  // env vars > config file" — the env half is about the provider). And a grid move relaunches as
  // `hermes --resume <id>`, which restores the model stored on the session row unless argv carried
  // an explicit `-m`; that flag is the documented opt-out ("resume must not clobber an explicit -m
  // with the session's stored model", `cli.py` / `cli_model_switch_mixin.py`).
  //
  // Measured on 2026-09-08 before this line existed: the pane's environment said
  // `HERMES_INFERENCE_MODEL=GLM-4.7-Flash` — which is what the desktop's model pill read back and
  // printed — while hermes itself ran DeepSeek-V4-Flash-0731, the default in the user's own
  // ~/.hermes/config.yaml and the model persisted on the resumed session's row.
  //
  // The variable stays beside the flag: `-z`/`--tui` read it, and it is how `gridAssignment.ts`
  // answers "which model is this agent on" for hermes without parsing a live process's argv.
  //
  // ⚠️ The ENDPOINT has no such flag. Hermes's custom-provider resolver deliberately ignores
  // `OPENAI_BASE_URL` ("config.yaml is the single source of truth for endpoint URLs",
  // `runtime_provider_backends.py`) and the CLI exposes no `--base-url`, so moving a hermes agent
  // between grids moves its model but leaves its requests on whatever relay config.yaml names. The
  // only lever left is `HERMES_HOME`, which would take state.db and the user's skills with it and
  // break the resume this move depends on.
  //
  // ⚠️ The overlay is the ONE thing here a machine can refuse. `HERMES_MANAGED_DIR` REPLACES
  // `/etc/hermes` rather than adding to it — so on a machine where an administrator pinned Hermes
  // settings there, writing ours would take their policy away for as long as the agent runs. The
  // agent still launches on the grid; it launches without web tools, which is the smaller loss and
  // the one the app can say out loud (`unsupported`). The machine fact arrives from the caller
  // (`GridLaunchMachine`); the decision is made here so create, retarget and restore cannot differ.
  hermes: {
    build: (override, machine) => {
      const overlay = !machine.hermesSystemManaged && override.mcpUrl
        ? hermesManagedConfig(override.mcpUrl, GRID_KEY_VAR)
        : undefined
      return {
        env: {
          OPENAI_BASE_URL: relayBaseUrl(override.baseUrl),
          OPENAI_API_KEY: override.apiKey,
          ...(override.model ? { HERMES_INFERENCE_MODEL: override.model } : {}),
          // Referenced by the overlay below, so it exists only when there is an overlay to read it.
          ...(overlay ? { [GRID_KEY_VAR]: override.apiKey } : {}),
        },
        args: override.model ? ['-m', override.model] : [],
        // Hermes reads its MCP servers from one config file and takes no flag for them, so the web
        // tools arrive as a managed-scope overlay merged over the user's own — see `gridWebMcp.ts`,
        // including why this is `HERMES_MANAGED_DIR` and not `HERMES_HOME`.
        ...(overlay
          ? {
            configDir: {
              envVar: HERMES_MANAGED_DIR_VAR,
              files: [{ name: HERMES_MANAGED_CONFIG_FILE, content: overlay }],
            },
          }
          : {}),
        // The pin outranks the url: a machine that cannot take the overlay cannot take it whether or
        // not the grid offered one, and that is the fact a person can act on.
        webSearch: machine.hermesSystemManaged ? 'unsupported' : webSearchWhenWired(override),
      }
    },
  },

  // xAI's own Grok CLI (the one this repo discovers under `~/.grok`, whose transcripts carry the
  // `_x.ai/session/update` method). Its docs: "Grok fetches the model list from {base_url}/models",
  // and "when you set models_base_url, Grok uses API key auth instead of session auth" — the second
  // half of which does NOT hold in practice: measured, the variable moves where requests go but not
  // which credential is picked, and the session token still wins. See `grokGridConfig`. The model has
  // no documented variable, so it goes in argv AND into the config block that carries the credential.
  //
  // Its web tools cost it a private home. Grok reads `[mcp_servers]` from its config file and takes
  // no flag for them, and the only layer that both starts unattended and is not the user's own file
  // is `$GROK_HOME/config.toml` — the project layer is gated on a folder-trust prompt nobody is
  // there to answer, and `CLAUDE_CONFIG_DIR` does not move MCP discovery at all. See `gridWebMcp.ts`,
  // which measured each of them.
  //
  // ⚠️ `GROK_HOME` moves the WHOLE state directory, `sessions/` included — and for grok that is not
  // cosmetic: `cli.ts` drops an observed grok agent entirely when it can find no transcript, so an
  // un-borrowed home would launch an agent the harness never registers. The directory is linked back
  // rather than moved; [GROK_GRID_HOME_LINKS] says which, and why the list stops where it does.
  //
  // ⚠️ The private home is NOT optional, and the reason is the credential order rather than the web
  // tools. `XAI_API_KEY` is the LAST thing Grok reaches for — behind the OIDC session token — so an
  // agent launched with the documented variable pair alone authenticates as the user's own xAI login
  // and the relay answers 401. The config block declares the model with `env_key`, which outranks the
  // session token; `grokGridConfig` carries the measurement. So every grid launch writes a config,
  // web tools or not, and the user's own `~/.grok` is still never opened.
  grok: {
    // Deliberately NOT `requiresModel`. The credential rides on a declared model block, so a launch
    // does need SOME model named — but that is this contract's problem to solve, not a question to
    // put back to the user. No model picked means the grid routes, and the relay serves its router id
    // like any other model (verified: `{"model":"Auto"}` → 200, answered by DeepSeek-V4-Flash-0731),
    // so `Auto` is what the block declares. Verified end to end: Grok launched against `[model."Auto"]`
    // with `env_key` answered a prompt through the router with `auth_mode=null` and no probe.
    //
    // Making this `requiresModel` was the first fix here and it was the wrong one: it turned "Auto",
    // the default the New Agent dialog shows, into a refusal at the moment of clicking Create —
    // trading a 401 the user could not diagnose for a wall they could not get past. Same trade
    // OpenCode faced, same answer (see `GRID_ROUTER_MODEL` in its contract above).
    build: (override) => {
      // One name, used in three places that must agree: argv, the config block's header, and the
      // `model` field inside it. A mismatch would declare a credential for a model Grok never asks for.
      const model = override.model ?? GRID_ROUTER_MODEL
      return {
        env: {
          GROK_MODELS_BASE_URL: relayBaseUrl(override.baseUrl),
          // Kept even though the config below is what actually wins. It is the documented pair for a
          // custom endpoint, it is what `gridAssignment.ts` reads back, and on a build whose config
          // layer we have misjudged it is still the credential Grok would reach for last.
          XAI_API_KEY: override.apiKey,
          // Referenced by `env_key` in the config, which is always written — so this always is too.
          [GRID_KEY_VAR]: override.apiKey,
        },
        args: ['-m', model],
        // ⚠️ ALWAYS a config directory now, web tools or not. It used to be written only when there
        // were MCP servers to declare, on the reasoning that a launch with nothing to configure should
        // leave the user's `~/.grok` alone — but the credential order (see `grokGridConfig`) means the
        // config is what makes the grid key win over the OIDC session token. Without it a grid agent
        // authenticates as the user's xAI login and the relay answers 401.
        configDir: {
          envVar: GROK_HOME_VAR,
          files: [{
            name: GROK_CONFIG_FILE,
            content: grokGridConfig(
              override.mcpUrl,
              GRID_KEY_VAR,
              model,
              relayBaseUrl(override.baseUrl),
            ),
          }],
          links: GROK_GRID_HOME_LINKS.map((name) => ({ name, target: join(userGrokHome(), name) })),
        },
        webSearch: webSearchWhenWired(override),
      }
    },
  },

  // Pi reads its providers out of a config DIRECTORY, and `PI_CODING_AGENT_DIR` moves that
  // directory. So it gets a private one per agent: the provider block lands there, the user's
  // ~/.pi/agent/models.json is never opened, and their skills are handed back through settings.json.
  //
  // The provider block has to name the model it serves, and Pi selects it as `grid/<model>` — so
  // something must always be named. No model chosen means the grid routes: `Auto` is the router's
  // own id and the relay answers it like any other, exactly as OpenCode's block above relies on.
  //
  // This used to be `requiresModel: true`, which refused the launch outright. That made Pi the one
  // grid-capable engine a person could not start from the New agent dialog at all, since the dialog
  // always creates on Auto and no longer offers a model field — a dead end, not a prompt to go and
  // pick something.
  pi: {
    build: (override) => {
      const model = override.model ?? GRID_ROUTER_MODEL
      return {
        env: { [GRID_KEY_VAR]: override.apiKey },
        args: ['--model', `${GRID_PROVIDER_ID}/${model}`],
        configDir: {
          envVar: 'PI_CODING_AGENT_DIR',
          files: [
            { name: 'models.json', content: piModelsJson(relayBaseUrl(override.baseUrl), model, override.contextWindow) },
            { name: 'settings.json', content: piSettingsJson(userPiSkillsDir()) },
          ],
        },
        // Pi has no MCP client, so there is nothing to hand the server to — with or without a url.
        webSearch: 'unsupported',
      }
    },
  },

  // GitHub's documented BYOK path for Copilot CLI (docs.github.com … /use-byok-models). Copilot
  // will not start against a custom provider without being told the model, so that is enforced
  // here rather than left to fail inside the app.
  //
  // Web tools ride the same JSON document Claude Code is handed, under Copilot's own flag. The flag
  // is `--additional-mcp-config` rather than a `--mcp-config`: it AUGMENTS `~/.copilot/mcp-config.json`
  // for the session, which is the behaviour wanted here and the reason no dotfile is written.
  copilot: {
    requiresModel: true,
    build: (override) => ({
      env: {
        COPILOT_PROVIDER_BASE_URL: relayBaseUrl(override.baseUrl),
        COPILOT_PROVIDER_API_KEY: override.apiKey,
        ...(override.model ? { COPILOT_MODEL: override.model } : {}),
        // Same rule as claude: the variable exists only to be referenced by the config below, so it
        // is set only when there is a config to reference it.
        ...(override.mcpUrl ? { [GRID_KEY_VAR]: override.apiKey } : {}),
      },
      args: override.mcpUrl
        ? ['--additional-mcp-config', mcpServersConfig(override.mcpUrl, GRID_KEY_VAR)]
        : [],
      webSearch: webSearchWhenWired(override),
    }),
  },
}

/**
 * Why an engine cannot be pointed at a grid, in words the person who picked it can act on.
 *
 * Every engine without a contract has an entry: "unsupported" on its own tells a user nothing about
 * whether to wait for a release, change a setting, or pick another engine.
 */
const GRID_ENGINE_REFUSALS: Partial<Record<AgentEngine, string>> = {
  // NOTE: pi is NOT here — it is supported through a private config directory. Kilo is, because its
  // CLI has no OpenAI-compatible provider to configure at all, in any directory.
  cursor: 'Cursor Agent can only be re-pointed at another Cursor API (CURSOR_API_ENDPOINT), '
    + 'not at an OpenAI-compatible relay',
  agy: 'Antigravity speaks the Gemini API, which this relay does not serve',
  kilo: 'the Kilo CLI has no OpenAI-compatible provider option yet (its own issues #5840, #6315)',
  amp: 'Amp documents no way to change where it sends inference',
  devin: 'Devin runs on its own hosted service and documents no endpoint override',
  muse: 'Muse Code documents no way to change its endpoint',
  commandcode: 'Command Code documents no way to change its endpoint',
  terminal: 'a terminal runs no engine to point at a grid — start one inside it and it will use its own login',
}

/** Engines that can be pointed at a grid today, for error text that names what to pick instead: the contracts'
 *  own list, which the core's declared one (lib/gridLaunchWire.ts `GRID_CAPABLE_ENGINES`) is held equal to. */
export function contractEngines(): AgentEngine[] {
  return Object.keys(GRID_ENGINE_CONTRACTS) as AgentEngine[]
}

/**
 * How `engine` must be launched to reach `override` on a machine like `machine`, or why it cannot be.
 *
 * `machine` is required rather than defaulted on purpose: the one fact in it is a policy an
 * administrator set, and a caller that forgot to read it would write the overlay that policy exists
 * to refuse — the exact failure moving the decision in here was meant to end.
 */
export function buildGridEngineLaunch(
  engine: AgentEngine,
  override: GridLaunchOverride,
  machine: GridLaunchMachine,
): GridLaunchResult {
  const contract = GRID_ENGINE_CONTRACTS[engine]
  if (!contract) {
    const reason = GRID_ENGINE_REFUSALS[engine] ?? 'it has no known way to change its endpoint'
    return {
      ok: false,
      error: 'GRID_ENGINE_UNSUPPORTED',
      detail: `${engine} cannot run on grid ${override.networkName}: ${reason}. `
        + `It would have run on its own login instead. Engines that can: ${contractEngines().join(', ')}.`,
    }
  }
  if (contract.requiresModel && !override.model) {
    return {
      ok: false,
      error: 'GRID_MODEL_REQUIRED',
      detail: `${engine} will not start against a grid without a model. `
        + `Pick one for ${override.networkName} and try again.`,
    }
  }
  return { ok: true, launch: contract.build(override, machine) }
}

/** A placeholder override, used only to ask a contract which variables it sets. Never launched. */
const PROBE_OVERRIDE: GridLaunchOverride = {
  networkId: 'probe',
  networkName: 'probe',
  baseUrl: 'https://example.invalid/probe/relay/v1',
  apiKey: 'probe',
  model: 'probe',
  // Present so the probe reports the variables a launch WITH web tools sets. Retarget clears what
  // this answers, and a probe that left them out would move an agent to another grid while its old
  // grid's MCP credential stayed in the pane — the exact staleness the doc comment below warns of.
  mcpUrl: 'https://example.invalid/v1/grid/web-mcp/',
  // Present for the same reason: a launch that knew its window sets a variable (Claude Code's), and
  // moving back to the own login must take it out of the pane with the rest.
  contextWindow: 131072,
}

/**
 * Which environment variables pointing [engine] at a grid sets.
 *
 * Asked of the contract by building one, rather than kept as a second list beside it. A hand-written
 * list would be correct exactly until an engine's contract gained a variable, and the symptom of it
 * being stale is the worst kind: an agent moved back to its own login that quietly keeps talking to
 * the grid, reporting success the whole way.
 *
 * Empty for an engine that has no contract — there is nothing to clear because nothing was set.
 */
export function contractEnvVarNames(engine: AgentEngine): string[] {
  // No pin, for the same reason the probe carries an MCP url: this asks which variables a launch
  // WITH web tools sets, so that clearing them covers the fullest launch this engine can get.
  const built = buildGridEngineLaunch(engine, PROBE_OVERRIDE, { hermesSystemManaged: false })
  if (!built.ok) return []
  const names = Object.keys(built.launch.env)
  if (built.launch.configDir) names.push(built.launch.configDir.envVar)
  return names
}

/**
 * The models service's answer to the core (`ModelsPort.gridLaunch`): the launch `request.engine` takes to reach
 * `request.override` and the override it was built from. `refresh` repeats a saved API's launch with its endpoint
 * and key as saved now (`refreshApi`, lib/apiModels.ts), and a removed or unusable API is refused before anything
 * is built, as a relaunch always refused it.
 */
export function answerGridLaunch(
  request: GridLaunchRequest,
  refreshApi: (override: GridLaunchOverride) => { override: GridLaunchOverride; apiBase?: string } | { error: string; detail: string },
): GridLaunchAnswer {
  let override = request.override
  let apiBase: string | undefined
  if (request.refresh) {
    const refreshed = refreshApi(override)
    if ('error' in refreshed) return { ok: false, error: refreshed.error, detail: refreshed.detail }
    override = refreshed.override
    apiBase = refreshed.apiBase
  }
  const built = buildGridEngineLaunch(request.engine, override, request.machine)
  const base = apiBase ? { apiBase } : {}
  if (!built.ok) return { ...built, ...base }
  return { ok: true, launch: built.launch, override, ...base }
}
