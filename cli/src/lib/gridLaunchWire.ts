/**
 * A grid launch as the core holds it: what the desktop sends and the registry keeps (`GridLaunchOverride`),
 * checked before anything is built from it; what a built launch hands the pane (`GridEngineLaunch`); and the data
 * every launch reads without asking anyone. That data is the vendor variables a grid launch clears, the variables
 * each engine's grid launch sets (cleared when an agent leaves a grid), and the engines a grid can run.
 *
 * Building a launch is the models service's (lib/gridLaunch.ts, `ModelsPort.gridLaunch`,
 * docs/design/2026-10-08-launch-port.md): the per-engine contracts and their web-tools wiring never load in the
 * core. The declared lists here are held equal to what those contracts produce (lib/gridLaunch.spec.ts).
 */
import type { AgentEngine } from '../engines/types.js'

/** The variable an engine is told to read the key from, where the engine supports that indirection. Codex names it
 *  in `env_key`; Pi's `models.json` writes it as a `$VAR` reference. */
export const GRID_KEY_VAR = 'GRID_API_KEY'
/** The variable the web tools' MCP authorization header rides in (lib/gridWebMcp.ts). */
export const GRID_MCP_AUTH_VAR = 'GRID_MCP_AUTHORIZATION'
/** Where Hermes is pointed at the managed scope that carries its web tools (lib/gridWebMcp.ts). */
export const HERMES_MANAGED_DIR_VAR = 'HERMES_MANAGED_DIR'
/** Where an administrator pins Hermes's settings: a machine with it gets no overlay (`GridLaunchMachine`). */
export const HERMES_SYSTEM_MANAGED_DIR = '/etc/hermes'
/** Grok's whole state directory, which a grid launch redirects (lib/gridWebMcp.ts). */
export const GROK_HOME_VAR = 'GROK_HOME'

/** What the desktop sends, once validated. Mirrors `GridAgentOverride` in the desktop app. */
export interface GridLaunchOverride {
  networkId: string
  /** The grid's display name — for log lines and error text, never for routing. */
  networkName: string
  /**
   * The grid's OpenAI-compatible relay root, as the control plane reports it: `<grid>/relay/v1`.
   * Per-engine forms are derived from this; see [relayBaseUrl] and [anthropicBaseUrl].
   */
  baseUrl: string
  /** Short-lived, minted per launch. Never logged, never placed in argv; persisted only in the registry
   *  row (see the module header), so a relaunch can repeat this launch. */
  apiKey: string
  /** Absent means "whatever the engine asks for" — the relay's own default. */
  model?: string
  /**
   * The grid's web-tools MCP endpoint, on the CONTROL PLANE — `…/v1/grid/web-mcp/`, trailing slash
   * included, because without it the mount answers 307 and not every client follows one.
   *
   * Deliberately not derived here from [baseUrl]. That is the RELAY, and grid ADR 0041 D-a takes the
   * relay out of this path on purpose: a relay is per-grid, can be asleep, and for a self-hosted grid
   * is a LAN address a harness may not reach. The control plane's address is also not ours to guess —
   * it is whichever one the user's Grid CLI is signed into, and this machine may have no Grid session
   * at all. The desktop knows; this does not.
   *
   * Absent means no web tools, which is exactly what an older desktop sends.
   */
  mcpUrl?: string
  /**
   * The model's context window in tokens, as the grid's relay reports it (`context_window` on its
   * `/models` row) — the size the engine serving it was actually started with.
   *
   * ⚠️ Every coding agent here assumes a window for a model it does not recognise, and a grid model
   * is never one it recognises: Claude Code assumes 200K, Codex and OpenCode know nothing at all. An
   * agent that does not know the real window never compacts before it — the server rejects the
   * request as too long first, and the session dies where it should have summarised. So each engine
   * is TOLD, in its own dialect ([contextWindowHint] and the contracts below).
   *
   * Absent means the relay did not say, and each engine keeps its own assumption, as before.
   */
  contextWindow?: number
}

/**
 * The `networkId` of a launch onto a saved API (`apiModels.ts`) rather than a grid: `api:<connection id>`.
 * The same contracts below run it — an OpenAI-compatible API such as OpenRouter is reached exactly the
 * way a grid's relay is — but nothing grid-specific (waking, the grid's picture) applies to it.
 */
export const API_NETWORK_PREFIX = 'api:'

export function isApiLaunch(launch: Pick<GridLaunchOverride, 'networkId'> | null | undefined): boolean {
  return !!launch?.networkId.startsWith(API_NETWORK_PREFIX)
}

/** The smallest window believed. Anything below it is not a model a coding agent can run on, and a
 *  value that small is likelier a misreport than a real engine — better to say nothing than to have
 *  an agent compact every turn. */
const MIN_CONTEXT_WINDOW = 4096
/** The largest believed: no engine serves more, and a bigger number is a unit error. */
const MAX_CONTEXT_WINDOW = 16 * 1024 * 1024

/** A context window worth handing an engine, or undefined. Lenient on purpose, unlike every other
 *  field here: this is a hint, and a malformed one must cost only the hint — refusing the whole
 *  override would strand a persisted launch that is otherwise fine. */
export function contextWindowHint(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW && value <= MAX_CONTEXT_WINDOW
    ? value : undefined
}

export type GridOverrideParse =
  | { state: 'absent' }
  | { state: 'ok'; override: GridLaunchOverride }
  | { state: 'invalid'; reason: string }

/**
 * Control characters have no place in a URL, a token or a model id, and every one of these values
 * ends up in a process environment or an argv. Rejecting them keeps a malformed frame from producing
 * an engine whose launch is subtly not what either side thinks it is.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

function requiredString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || CONTROL_CHARS.test(trimmed)) return null
  return trimmed
}

/**
 * Why [value] is not an address an engine can be handed, or null when it is one.
 *
 * Anything else — a `file:` URL, a bare hostname, a path — would fail inside the engine with an
 * error naming neither the grid nor this frame. Shared by the two URL fields rather than written
 * twice, so they cannot drift into disagreeing about what an address is.
 */
function urlProblem(field: string, value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return `grid ${field} is not a URL`
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `grid ${field} must be http(s), got ${parsed.protocol}`
  }
  return null
}

/**
 * `payload.grid` as a validated override, or the reason it is not one.
 *
 * Absent is a first-class answer, not a failure: a build with no grid selected sends no `grid` field
 * at all, and must create agents exactly the way it always did.
 */
export function parseGridLaunchOverride(raw: unknown): GridOverrideParse {
  if (raw === undefined || raw === null) return { state: 'absent' }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid', reason: 'grid must be an object' }
  const source = raw as Record<string, unknown>
  const networkId = requiredString(source, 'networkId')
  const networkName = requiredString(source, 'networkName')
  const baseUrl = requiredString(source, 'baseUrl')
  const apiKey = requiredString(source, 'apiKey')
  const missing = [
    networkId ? null : 'networkId',
    networkName ? null : 'networkName',
    baseUrl ? null : 'baseUrl',
    apiKey ? null : 'apiKey',
  ].filter((name): name is string => name !== null)
  if (missing.length) return { state: 'invalid', reason: `grid is missing ${missing.join(', ')}` }
  const badBaseUrl = urlProblem('baseUrl', baseUrl as string)
  if (badBaseUrl) return { state: 'invalid', reason: badBaseUrl }
  const hasModel = source.model !== undefined && source.model !== null
  const model = hasModel ? requiredString(source, 'model') : undefined
  if (hasModel && !model) return { state: 'invalid', reason: 'grid model must be a non-empty string' }
  const hasMcpUrl = source.mcpUrl !== undefined && source.mcpUrl !== null
  const mcpUrl = hasMcpUrl ? requiredString(source, 'mcpUrl') : undefined
  if (hasMcpUrl && !mcpUrl) return { state: 'invalid', reason: 'grid mcpUrl must be a non-empty string' }
  const badMcpUrl = mcpUrl ? urlProblem('mcpUrl', mcpUrl) : null
  if (badMcpUrl) return { state: 'invalid', reason: badMcpUrl }
  const contextWindow = contextWindowHint(source.contextWindow)
  return {
    state: 'ok',
    override: {
      networkId: networkId as string,
      networkName: networkName as string,
      baseUrl: baseUrl as string,
      apiKey: apiKey as string,
      ...(model ? { model } : {}),
      ...(mcpUrl ? { mcpUrl } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    },
  }
}

/** The OpenAI-compatible relay root — what every engine here wants except Claude Code. */
export function relayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * The relay root Claude Code wants.
 *
 * The app appends `/v1/messages` itself, so the `/v1` an OpenAI SDK needs would 404 every request
 * here — the same one-character difference that makes `grid launch claude --print-env` a separate
 * command from `grid info --env` in the grid CLI. Idempotent: a base that already lacks `/v1` comes
 * back unchanged.
 */
export function anthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -'/v1'.length) : trimmed
}

/**
 * The relay's routing strategy, used when the user picked no particular model.
 *
 * Not a model: send a request naming it and the grid chooses one. It is `owned_by: grid-router` in
 * the relay's `/models`, and the relay answers it like any other id — which is what lets a provider
 * block that must name SOMETHING name this.
 */
export const GRID_ROUTER_MODEL = 'Auto'

/**
 * One directory the per-agent config directory borrows from elsewhere, as a symlink.
 *
 * For an engine whose variable redirects its WHOLE home rather than just its provider config: the
 * private directory has to hand back the parts the daemon still reads. Grok is the only such engine
 * — see `GROK_GRID_HOME_LINKS` in `gridWebMcp.ts`.
 */
export interface GridConfigLink {
  /** Name inside the per-agent directory. Never a path. */
  name: string
  /** Absolute path the link points at — the user's real directory. */
  target: string
}

/** One file to write into the per-agent config directory a launch is given. */
export interface GridConfigFile {
  /** File name inside the directory. Never a path — this writes one flat directory. */
  name: string
  content: string
}

/**
 * Whether the agent this launch produces can search the web, in the words the app shows.
 *
 *  * `on` — the MCP url was present and the engine's contract wired the server in.
 *  * `unavailable` — no url reached the launch: the grid could not be asked for one (an outdated or
 *    missing `grid` CLI, no sign-in, an unknown grid — `gridMcpUrl.ts` logs which). Inference still
 *    goes to the grid; asking again later can fix it.
 *  * `unsupported` — the engine cannot take the server on this machine at all: Pi has no MCP client,
 *    and Hermes on a machine whose settings are pinned in [HERMES_SYSTEM_MANAGED_DIR] cannot be handed
 *    the overlay without replacing them. Nothing about the grid changes this.
 *
 * Decided HERE, by the same code that decides whether the server is wired, so the two cannot
 * disagree — and stored with the launch rather than re-derived, so a reconnect or a restart reports
 * what the launch actually did. The app reads it as `grid.webSearch` on every agent frame.
 */
export type GridWebSearchStatus = 'on' | 'unavailable' | 'unsupported'

/**
 * A grid launch as the registry keeps it: the override to repeat it with, and what building it
 * decided about web search. One object so the two are written and cleared together — a status
 * without its launch, or a launch without its status, is a row the app would read wrongly.
 */
export interface GridLaunchRecord {
  override: GridLaunchOverride
  webSearch: GridWebSearchStatus
}

/**
 * Facts about THIS machine a contract cannot read for itself.
 *
 * A contract is pure — the module comment on [userGrokHome] says why: one that stats the filesystem
 * answers differently on two machines, and its spec would follow. So the caller reads the machine
 * and hands the answer in, and the contract decides from it. What it decides stays here, where every
 * caller (create, retarget, restore) gets the same answer from the same code.
 */
export interface GridLaunchMachine {
  /**
   * Whether an administrator pinned Hermes settings in [HERMES_SYSTEM_MANAGED_DIR]. Hermes's web
   * tools ride a managed-scope overlay that REPLACES that directory rather than adding to it, so on
   * such a machine the overlay is dropped and the agent launches without web tools.
   */
  hermesSystemManaged: boolean
  /**
   * The installed OpenCode's major version (`engines/opencode/version.ts`); absent or null reads as
   * v1. v2's TUI rejects `-m`, and only a private server (`--standalone`) reads `OPENCODE_CONFIG`.
   */
  opencodeMajor?: number | null
}

/** How one engine is launched against a grid. */
export interface GridEngineLaunch {
  /** Layered over the engine's inherited environment. This is where the key goes, always. */
  env: Record<string, string>
  /** Appended to the engine's argv. Never carries the key — `ps` is world-readable. */
  args: string[]
  /** What this launch gives the agent by way of web search. See [GridWebSearchStatus]. */
  webSearch: GridWebSearchStatus
  /**
   * The `provider/model` a RESUMED session has to be put on before the relaunch, for an engine whose
   * resume restores the session's own stored model whatever argv says. OpenCode only; the caller
   * applies it (`applyOpencodeSessionModel`).
   */
  sessionModel?: string
  /**
   * For an engine that reads its provider out of a config directory rather than an environment
   * variable: files the daemon writes into a directory IT owns, and the variable that points the
   * engine at that directory.
   *
   * This is not "editing the user's dotfiles" — the point of the indirection is that it never
   * touches them. The engine gets a private configuration for this agent, the user's own stays
   * exactly as they left it, and deleting the directory undoes everything. No file written here may
   * contain the key; Pi's provider block references an environment variable instead.
   */
  configDir?: {
    envVar: string
    files: GridConfigFile[]
    /**
     * Point [envVar] at ONE of the written files rather than at the directory holding them.
     *
     * Pi wants the directory (`PI_CODING_AGENT_DIR`); OpenCode's `OPENCODE_CONFIG` wants a config
     * file. Same mechanism — a private directory this daemon owns — differing only in what the
     * engine is handed, so it is a field rather than a second writer.
     */
    pointAt?: string
    /**
     * Directories the private one borrows back from the engine's real home.
     *
     * Only for a variable that redirects a whole home: `GROK_HOME` takes `sessions/` with it, and the
     * daemon reads transcripts from the real one. Empty for every engine whose variable names only a
     * provider config, which is the usual case.
     */
    links?: GridConfigLink[]
  }
}

/**
 * Every variable any grid launch contract (lib/gridLaunch.ts) uses to point an engine somewhere.
 *
 * A grid launch has to CLEAR the ones it does not itself set, because setting the right variable is
 * not enough to decide where an engine goes: an engine picks a provider from whatever credentials it
 * can see, and a stray one wins on its own terms. Measured, twice, on one machine:
 *
 *  * OpenCode, handed `OPENAI_BASE_URL` for a grid, found an inherited `ANTHROPIC_API_KEY` and chose
 *    Claude Sonnet at api.anthropic.com — reporting `invalid x-api-key`, a sentence that names
 *    neither the grid nor the variable that redirected it.
 *  * Claude Code, on the same machine, had its `ANTHROPIC_BASE_URL` deleted by a line in `.zshrc` and
 *    fell back to the same key, with the same unreadable result.
 *
 * The inherited value arrives from further away than a user can reasonably audit. On that machine it
 * came from `.zshrc`, and then — after that was fixed — from a VS Code setting
 * (`claudeCode.environmentVariables`) that seeded the terminal the desktop app was launched from,
 * whose environment the app passed to the daemon, which passed it to the tmux server, which gave it
 * to every pane. Four layers, none visible from the failure.
 *
 * So the launch is the place to settle it: it is the only point that knows the user asked for a grid.
 * Unset here is scoped to the engine's own process and touches nothing on disk — a plain terminal on
 * the same machine keeps every variable it had.
 *
 * The list is deliberately OUR OWN vars rather than a survey of every provider an engine supports.
 * Enumerating those is unbounded and would go stale silently; these are the ones the contracts use, so
 * this list can be right about them (lib/gridLaunch.spec.ts holds it to them).
 */
export const GRID_CONFLICTING_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'XAI_API_KEY',
  'GROK_MODELS_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_MODEL',
  'HERMES_INFERENCE_MODEL',
  GRID_KEY_VAR,
  GRID_MCP_AUTH_VAR,
  HERMES_MANAGED_DIR_VAR,
  GROK_HOME_VAR,
]

/**
 * The variables this launch must clear: everything in [GRID_CONFLICTING_ENV_VARS] the launch does not
 * itself set.
 *
 * Set-then-unset would be a bug, so the two sets are computed from one another rather than listed
 * twice — a contract that gains a variable stops clearing it in the same edit.
 */
export function gridConflictingEnvToClear(launch: Pick<GridEngineLaunch, 'env' | 'configDir'>): string[] {
  const provided = new Set(Object.keys(launch.env))
  if (launch.configDir) provided.add(launch.configDir.envVar)
  return GRID_CONFLICTING_ENV_VARS.filter((name) => !provided.has(name))
}



export type GridLaunchResult =
  | { ok: true; launch: GridEngineLaunch }
  | { ok: false; error: string; detail: string }

/** What the core asks the models service to build (`ModelsPort.gridLaunch`). `refresh`: a relaunch, which repeats
 *  the row's launch with a saved API's endpoint and key as saved now. */
export interface GridLaunchRequest {
  engine: AgentEngine
  override: GridLaunchOverride
  machine: GridLaunchMachine
  refresh?: boolean
}

/**
 * What the models service answers: the launch and the override it was built from (refreshed, for a saved API); or
 * why the engine cannot be pointed there. `apiBase` is a saved API's endpoint the answer read, which the core's
 * grid assignment recognises from then on (lib/gridAssignment.ts).
 */
export type GridLaunchAnswer =
  | { ok: true; launch: GridEngineLaunch; override: GridLaunchOverride; apiBase?: string }
  | { ok: false; error: string; detail: string; apiBase?: string }

/**
 * Why a launch has no web search, in the daemon log's words — for the two answers the contracts decide
 * themselves (lib/gridLaunch.ts). `unavailable` is decided elsewhere (`gridMcpUrl.ts`), which logs its own
 * reason the moment it gives up, so nothing is repeated here.
 */
function webSearchReason(engine: AgentEngine, webSearch: GridWebSearchStatus): string | null {
  if (webSearch !== 'unsupported') return null
  if (engine === 'pi') return 'Pi has no MCP client'
  if (engine === 'hermes') {
    return `${HERMES_SYSTEM_MANAGED_DIR} pins this machine's Hermes settings, and the overlay carrying `
      + 'the web tools would replace it'
  }
  return null
}

/** One log line naming where an agent was sent — grid, model, engine, and whether it got web
 *  search (with the reason when the contracts are what took it away). Never the key, never
 *  the MCP url. The core's to say, from a launch it holds (create's, or the record a relaunch built). */
export function describeGridLaunch(
  engine: AgentEngine,
  override: GridLaunchOverride,
  webSearch: GridWebSearchStatus,
): string {
  const reason = webSearchReason(engine, webSearch)
  return `[grid] ${engine} -> ${override.networkName} (${override.networkId})`
    + ` · ${override.model ?? 'model chosen by the engine'} · web search ${webSearch}`
    + (reason ? ` (${reason})` : '')
}

/** Why a grid launch could not be built when the models service is not there to build it. */
export function gridUnavailable(engine: AgentEngine, override: GridLaunchOverride): { ok: false; error: string; detail: string } {
  return {
    ok: false,
    error: isApiLaunch(override) ? 'API_UNAVAILABLE' : 'GRID_UNAVAILABLE',
    detail: `The models service is not running, so ${engine} cannot be put on ${override.networkName}. Try again in a moment.`,
  }
}

/** The engines a grid can run, as the contracts declare them (lib/gridLaunch.ts `GRID_ENGINE_CONTRACTS`), in their
 *  order: what a picker offers a grid model to, and what a refusal names instead. */
export const GRID_CAPABLE_ENGINES: readonly AgentEngine[] = ['claude', 'codex', 'opencode', 'hermes', 'grok', 'pi', 'copilot']

export function gridCapableEngines(): AgentEngine[] {
  return [...GRID_CAPABLE_ENGINES]
}

/**
 * Which variables pointing each engine at a grid sets: its launch's environment and its config directory's
 * variable, for the fullest launch it can get (a model, web tools, a context window). Cleared when an agent leaves
 * a grid for its own login, which asks no service. Declared rather than built here, and held equal to what the
 * contracts build (lib/gridLaunch.spec.ts): a stale list would leave an agent moved back to its own login still
 * talking to the grid.
 */
export const GRID_ENV_VAR_NAMES: Readonly<Partial<Record<AgentEngine, readonly string[]>>> = {
  claude: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', GRID_KEY_VAR],
  codex: [GRID_KEY_VAR, GRID_MCP_AUTH_VAR],
  opencode: [GRID_KEY_VAR, 'OPENCODE_CONFIG'],
  pi: [GRID_KEY_VAR, 'PI_CODING_AGENT_DIR'],
  hermes: ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'HERMES_INFERENCE_MODEL', GRID_KEY_VAR, HERMES_MANAGED_DIR_VAR],
  grok: ['GROK_MODELS_BASE_URL', 'XAI_API_KEY', GRID_KEY_VAR, GROK_HOME_VAR],
  copilot: ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_MODEL', GRID_KEY_VAR],
}

/** The variables a grid launch of `engine` sets; empty for an engine that has no contract. */
export function gridEnvVarNames(engine: AgentEngine): string[] {
  return [...(GRID_ENV_VAR_NAMES[engine] ?? [])]
}
