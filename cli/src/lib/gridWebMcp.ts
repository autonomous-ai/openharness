/**
 * The grid's web tools, and how each harness is told where to find them.
 *
 * Its own module rather than more of `gridLaunch.ts` because it answers a different question: that
 * file decides where an agent's INFERENCE goes, this one decides what the agent can reach while it
 * thinks. They meet only in the engine contracts.
 *
 * A grid already pays for web search and already meters it, and grid ADR 0041 mounted it on the
 * CONTROL PLANE (`/v1/grid/web-mcp`) precisely so a harness can reach it while the grid itself is
 * asleep. What that ADR could not do is put it in front of an agent nobody configured by hand — so
 * this does, for an agent the desktop launches onto a grid. The credential is the one already in
 * `GridLaunchOverride.apiKey`: ADR 0041 D-b asks for the per-grid access token and requires no scope
 * of it, `consumer` included, which is exactly what the desktop mints.
 *
 * The harnesses `grid mcp config` prints for, plus the ones since measured the same way — what every
 * entry here has in common is that its header handling was read off the wire rather than off a vendor
 * page. An engine with no wiring here launches on the grid exactly as it did before, with no web
 * tools.
 *
 * ⚠️ **The key still never reaches a file or an argv**, which is `gridLaunch.ts`'s rule and NOT ADR
 * 0041's. That ADR rejects the environment outright, and it is right about the caller it was written
 * for: a person pasting a block into their own dotfile has no environment to reference, and a
 * 365-day token in an interactive shell is readable by every child of it. Here the daemon owns both
 * ends — the variable exists only in the pane's own environment, put there by `tmux new-session -e`
 * — and every harness measured offers a reference:
 *
 *   * Claude Code expands `${VAR}` inside `--mcp-config`, in the JSON-STRING form too, so it needs
 *     no file at all and its argv carries the variable's NAME.
 *   * Codex reads `env_http_headers`, settable entirely through `-c`.
 *   * opencode expands `{env:VAR}` in `headers`, in the config file the launch already writes it.
 *   * Copilot CLI expands `${VAR}` too, in the same JSON-string form, behind
 *     `--additional-mcp-config`.
 *   * Grok expands `${VAR}` in `headers` too, in the config file its private home already needs.
 *
 * Measured 2026-09-08 against a header-logging listener on loopback — Claude Code 2.1.263, Codex
 * 0.144.6, opencode 1.18.29, the first two being the versions ADR 0041 itself measured — and Copilot
 * CLI 1.0.83 the same way on 2026-09-09. Each sent `Authorization: Bearer <the variable's value>` on
 * every request, the GET discovery included.
 *
 * ⚠️ The reference syntax is NOT interchangeable, which is why each was measured rather than
 * assumed. Copilot expands `${VAR}` and sends `${env:VAR}` and `{env:VAR}` through VERBATIM — the
 * opencode spelling would have put the literal string on the wire and the tools would have failed
 * authentication with nothing naming why.
 */

import {
  HARNESS_MCP_SERVER_NAME,
  HARNESS_MCP_TOOL_NAMES,
  HARNESS_WEB_READ_TOOL_NAME,
  HARNESS_WEB_SEARCH_TOOL_NAME,
} from './harnessWebTools.js'

/**
 * The variable Codex reads its header out of.
 *
 * Its own rather than the launch's key variable, because `env_http_headers` holds the WHOLE header
 * value while every other reference here wants the bare key — ADR 0041 D-d calls confusing the two
 * "a silent 401". `bearer_token_env_var` does take the bare key and would need no second variable;
 * it is rejected for the reason that ADR gives beside it, that it sends no header at all during
 * discovery.
 */
export const GRID_MCP_AUTH_VAR = 'GRID_MCP_AUTHORIZATION'

/** The header value [GRID_MCP_AUTH_VAR] carries — the whole of it, not the key. */
export function mcpAuthorizationHeader(apiKey: string): string {
  return `Bearer ${apiKey}`
}

/**
 * The `{ mcpServers: … }` document Claude Code and Copilot CLI both read, as a JSON string rather
 * than a file — `--mcp-config` for the first, `--additional-mcp-config` for the second.
 *
 * One function because it is one document, byte for byte: the same keys, and the same `${…}`
 * expansion performed by each harness when it reads the config. So this names [keyVar] and never the
 * key itself, and nothing is written to disk. That variable belongs to the launch, which is why it
 * arrives as an argument rather than being imported: this module is about what an agent can reach,
 * not about the key it reaches with.
 *
 * Copilot's `tools` filter is deliberately absent. Its CLI documents the default as `"*"`, so
 * writing one would restate the default for one harness in a document the other does not read.
 *
 * Neither flag is accompanied by anything that narrows the config to this server alone — Claude
 * Code's `--strict-mcp-config` would drop every MCP server the user configured for themselves, and
 * Copilot's flag is *additional* by name and by behaviour. Picking a grid adds web tools; it does
 * not take an agent's own tools away.
 */
export function mcpServersConfig(mcpUrl: string, keyVar: string): string {
  return JSON.stringify({
    mcpServers: {
      [HARNESS_MCP_SERVER_NAME]: {
        type: 'http',
        url: mcpUrl,
        headers: { Authorization: `Bearer \${${keyVar}}` },
      },
    },
  })
}

/**
 * Claude Code's own `WebSearch` and `WebFetch`, taken off every Claude agent launched onto a grid.
 *
 * Neither works without Anthropic's API behind the base URL, for two different reasons:
 *
 *  * `WebSearch` is not a tool Claude Code runs. Invoking it sends a second Messages request carrying
 *    the `web_search_20250305` SERVER tool, which Anthropic's API executes and nothing else does. The
 *    grid refuses it outright (autonomous-grid's CLI seat rejects every typed tool on the Anthropic
 *    wire, `_reject_server_tools` in `shared/agent/cli_seat.py`) and the pane prints `API Error: 400
 *    Unsupported tool type: web_search_20250305`.
 *  * `WebFetch` DOES fetch the page from this machine — and then summarises it through a haiku call
 *    on the SAME base URL. The grid's relay serves only the models its nodes run and answers any
 *    other name `503 no_providers_available` (grid-src `private_server/relay.py`; only the reserved
 *    `auto` is routed), so the fetch succeeds and the tool still fails. An earlier version of this
 *    comment left `WebFetch` enabled on the belief that a local fetch made it safe; it does not.
 *
 * The cost is not the failed calls: a model offered a familiar dead tool reaches for it FIRST, spends
 * turns on the refusal, and only then finds `mcp__harness__web_search`, the search the grid actually
 * serves, in the same tool list. So both are removed on every grid launch, not only one carrying an
 * MCP url — the refusal does not depend on whether a replacement was wired, and a tool that can only
 * fail is a trap either way. Moving the agent back to its own login rebuilds its argv without this,
 * so the built-in tools return with the login they work against. A bare tool name here REMOVES the
 * tool from what the model is offered rather than refusing the call, which is the point — a
 * call-time refusal would still let the model reach for it first.
 *
 * ⚠️ **The `=` is load-bearing.** The flag is VARIADIC, so the two-token form swallows every argument
 * after it up to the next flag. Nothing positional follows a grid's args today —
 * `buildEngineCommandArgv` appends them last — but that is an ordering this should not depend on.
 * The comma form is the one `claude --help` documents ("Comma or space-separated list", 2.1.272);
 * it keeps the whole list in that one token.
 *
 * Measured 2026-09-11 against a Messages listener on loopback, Claude Code 2.1.268: the main request
 * offered 21 tools with `WebSearch` among them, and 20 with `--disallowedTools=WebSearch` — the prompt
 * after the flag intact. The two-token form read that same prompt as a second tool name ("Permission
 * deny rule … matches no known tool") and sent no Messages request at all. Measured again 2026-09-15
 * on 2.1.272 with this exact token: the request carried neither `WebSearch` nor `WebFetch`, and every
 * other tool — a plugin's 26 MCP tools included — was still offered.
 */
export const CLAUDE_DISALLOW_WEB_TOOLS_ARG = '--disallowedTools=WebSearch,WebFetch'

/**
 * The harness web tools, pre-approved for every Claude Code agent launched onto a grid WITH them.
 *
 * The server is the daemon's own doing, and Claude Code's permission system has no way to know that:
 * a call to `mcp__harness__web_search` is, to it, an MCP tool from a server it never saw configured.
 * In `default` mode that is a prompt per call; in `auto` mode the classifier DENIED it outright —
 * seen on a real pane (2026-09-15, Claude Code 2.1.272, `permissions.defaultMode: auto`): "The MCP
 * web search tool was blocked by the auto-mode classifier", after which the model fell back to curl.
 * The tools were put there on purpose, so they are allowed on purpose: an allow rule is honoured
 * before a prompt and before the classifier.
 *
 * Only when there IS a server to allow — with no MCP url the names would match nothing — and only
 * for the two tools by name (see [HARNESS_MCP_TOOL_NAMES]). The same one-token `=` form as
 * [CLAUDE_DISALLOW_WEB_TOOLS_ARG], for the same variadic reason.
 */
export const CLAUDE_ALLOW_WEB_TOOLS_ARG = `--allowedTools=${HARNESS_MCP_TOOL_NAMES.join(',')}`

/**
 * What a Claude Code agent on a grid is told about the web in its system prompt, and the flag that
 * makes Claude Code deliver it to a conversation already under way.
 *
 * [CLAUDE_DISALLOW_WEB_TOOLS_ARG] takes `WebSearch` and `WebFetch` out of the tool LIST, and the list
 * is not the only place a model reads tool names from. An agent is moved onto a grid mid-conversation
 * far more often than launched onto one, and the conversation it resumes carries every turn it had
 * on the Subscription model — `WebSearch` calls that SUCCEEDED, results and all. A model imitates
 * those ahead of reading the list. Seen on a real pane (2026-09-16, Claude Code 2.1.273,
 * `deepseek/deepseek-v4-flash-0731` resumed after three `WebSearch` turns on Sonnet 5): the first
 * response carried three `WebSearch` calls, each refused "No such tool available: WebSearch", and
 * only the next turn reached for `mcp__harness__web_search`. That request's tool list had no
 * `WebSearch` in it — read off the transcript's own `prompt_snapshot` record; the history did.
 *
 * So the prompt says it in words: which tools are gone, that earlier turns are no evidence they are
 * back, and what to call instead. Words lower the odds; they cannot make them zero, because the
 * history is exactly what `--resume` exists to keep. The only zero is a history that never held
 * `WebSearch` — routing the Subscription model's web through this server too — and that is a product
 * decision, not this module's.
 *
 * ⚠️ **`--append-system-prompt` alone never reaches a resumed conversation.** Claude Code records
 * the system prompt on a conversation's first request and replays that record on every later request
 * and resume, "even when a later launch passes different text" (`--system-prompt-snapshot`, default
 * `on`, `claude --help` 2.1.273). Measured 2026-09-16 on a session resumed with
 * `--append-system-prompt` carrying a marker: the model answered that no marker was present and no
 * new record was written; with `--system-prompt-snapshot off` on the same launch it answered with
 * the marker. A later launch WITHOUT the flag — the move back to the Subscription model — replayed
 * the original record, so nothing said here follows the agent off the grid. `off` gives up the
 * prompt's cache stability, which a grid relay does not offer anyway: `cache_read_input_tokens` was
 * 0 on every grid response in that transcript.
 *
 * Two texts, because a degraded launch (no MCP url) has nothing to point at: naming a tool the model
 * was not given would send it down the same road as the dead one. Neither says "grid" — a model
 * narrates its system prompt back to the user ("WebSearch got disabled mid-session. I'll use the
 * harness web search tool instead."), and the user's vocabulary is "Subscription" and "Local".
 *
 * Two tokens each, unlike the tool-list flags above: `<prompt>` and `<on|off>` take exactly one
 * value, so nothing after them can be swallowed — and the two-token form is the one measured. Argv is
 * positional all the way to `exec "$@"` (`engineLaunch.ts`), so the spaces and backticks in the text
 * never meet a shell.
 */
export const CLAUDE_SYSTEM_PROMPT_SNAPSHOT_OFF_ARGS: readonly string[] = ['--system-prompt-snapshot', 'off']

/** The sentence both texts share: the tools, the history, and the instruction. */
const CLAUDE_WEB_TOOLS_GONE = 'The built-in `WebSearch` and `WebFetch` tools are not available in this session, '
  + 'even where earlier turns of this conversation used them — do not call them'

function claudeGridSystemPrompt(webToolsWired: boolean): string {
  if (!webToolsWired) {
    return `This session has no web tools. ${CLAUDE_WEB_TOOLS_GONE}; `
      + 'tell the user the web cannot be searched or read from here instead.'
  }
  return `Web tools in this session come from the \`${HARNESS_MCP_SERVER_NAME}\` MCP server only: `
    + `\`${HARNESS_WEB_SEARCH_TOOL_NAME}\` searches the web and \`${HARNESS_WEB_READ_TOOL_NAME}\` reads pages. `
    + `${CLAUDE_WEB_TOOLS_GONE}; call the \`${HARNESS_MCP_SERVER_NAME}\` tools instead.`
}

/**
 * The prompt for a Claude Code grid launch, and the flag that lets it through — see
 * [CLAUDE_SYSTEM_PROMPT_SNAPSHOT_OFF_ARGS]. [webToolsWired] is whether the launch carries the server
 * (`webSearch: 'on'`), so the text and the status the app shows cannot disagree.
 */
export function claudeGridPromptArgs(webToolsWired: boolean): string[] {
  return [...CLAUDE_SYSTEM_PROMPT_SNAPSHOT_OFF_ARGS, '--append-system-prompt', claudeGridSystemPrompt(webToolsWired)]
}

/**
 * Codex's native `web_search`, turned off on every Codex agent launched onto a grid.
 *
 * The native tool is a feature of OpenAI's Responses API — the request carries a `web_search` tool
 * spec the endpoint executes — and a grid's relay is not that endpoint. Same trap as Claude Code's:
 * a model offered it reaches for it before the MCP tool that works. Codex's own config knob for it
 * is `web_search`, set through the same `-c` overrides the provider block already uses.
 *
 * Verified on codex-cli 0.154.0 rather than read off a page: `--strict-config -c web_search="…"` is
 * accepted, its variants are `disabled`, `cached`, `indexed`, `live`, and `web_search_mode` — the
 * spelling one might guess from the binary's strings — is refused as an unknown field. The runtime
 * type is a `Constrained<WebSearchMode>` that "must always support Disabled", so no admin policy
 * (`allowed_web_search_modes`) can refuse this value.
 *
 * The value is quoted as JSON because a `-c` value is parsed as TOML, like every override beside it.
 *
 * Claude Code and Codex are the only engines that lose a native web tool, checked rather than
 * assumed (2026-09-15):
 *
 *  * opencode's `websearch` is its own MCP call to Exa or Parallel (`packages/core/src/tool/
 *    websearch.ts`) and `webfetch` converts the page locally — neither goes through the model
 *    provider, so both keep working on a grid and there is nothing to take away.
 *  * Hermes' `web_search` / `web_extract` run on its own search-provider keys, not on inference.
 *  * Copilot CLI and Grok document no knob for their web tools; inventing one would be this module
 *    guessing at another program's internals, which its refusals exist to avoid.
 */
export const CODEX_DISABLE_WEB_SEARCH_ARGS: readonly string[] = ['-c', 'web_search="disabled"']

/**
 * The same server as Codex `-c` overrides, which is how its provider is configured too — so this
 * needs no config file either. Values are quoted as JSON because a `-c` value is parsed as TOML.
 *
 * The name is spelled exactly as [HARNESS_MCP_SERVER_NAME] here, like everywhere else — a dotted `-c`
 * path takes a TOML bare key, and any respelling for this one harness would rename its TOOLS too:
 * an agent would see one `mcp__…__web_search` on Codex and another everywhere else, so a prompt or
 * skill naming one would silently miss on the other. (When the name carried a hyphen, codex 0.144.6
 * read it back from `-c` without complaint; a bare word needs no such care.)
 */
export function codexMcpArgs(mcpUrl: string): string[] {
  return [
    '-c', `mcp_servers.${HARNESS_MCP_SERVER_NAME}.url=${JSON.stringify(mcpUrl)}`,
    '-c', `mcp_servers.${HARNESS_MCP_SERVER_NAME}.env_http_headers.Authorization=${JSON.stringify(GRID_MCP_AUTH_VAR)}`,
  ]
}

/**
 * Hermes keeps its MCP servers in one place — `mcp_servers` in `~/.hermes/config.yaml`
 * (`tools/mcp_tool_config.py`) — and offers no per-invocation flag for them. What it does offer is
 * a **managed-scope overlay**: `HERMES_MANAGED_DIR` names a directory whose `config.yaml` is
 * `_deep_merge`d over the user's (`hermes_cli/managed_scope.get_managed_dir`,
 * `hermes_cli/config._merge_managed_overlay`). That merge recurses dict-over-dict, so pinning
 * `mcp_servers.harness` leaves every server the user configured for themselves in place — the same
 * promise `--strict-mcp-config`'s absence makes for Claude Code.
 *
 * Two things were checked before choosing it over `HERMES_HOME`, which also redirects config:
 *
 *  * `HERMES_HOME` moves the WHOLE home — `auth.json`, sessions, memory, skills — so an agent
 *    launched under one would come up unauthenticated and amnesiac. That is a far worse trade than
 *    having no web tools.
 *  * A managed DIRECTORY is not a managed INSTALL: `config.get_managed_system()` reads
 *    `HERMES_MANAGED` or a `.managed` marker file and never consults this variable, so nothing here
 *    makes Hermes think a package manager owns it and start refusing its own updates.
 *
 * ⚠️ **The overlay REPLACES a system scope rather than adding to it** — `get_managed_dir` prefers
 * this variable over `/etc/hermes`. On a machine where an administrator pinned settings there, this
 * directory would silently take their policy away for the agent's lifetime, so the caller drops it
 * on such a machine and the agent launches without web tools instead. That check belongs where
 * machine facts are read; see `cli.ts`.
 *
 * Emitted as JSON, which is a subset of YAML: Hermes parses this file with a YAML loader, and
 * hand-rolling YAML quoting for a URL and a `${VAR}` is a way to be subtly wrong for free.
 */
export const HERMES_MANAGED_DIR_VAR = 'HERMES_MANAGED_DIR'

/**
 * Where Hermes looks for a managed scope when [HERMES_MANAGED_DIR_VAR] is unset
 * (`managed_scope._DEFAULT_MANAGED_DIR`).
 *
 * Exported so the caller can see whether an administrator got here first. Not consulted in this
 * module: a contract that stats the filesystem answers differently on two machines, and its spec
 * would pass or fail depending on which one ran it.
 */
export const HERMES_SYSTEM_MANAGED_DIR = '/etc/hermes'

/** The one file [HERMES_MANAGED_DIR_VAR] is read for. */
export const HERMES_MANAGED_CONFIG_FILE = 'config.yaml'

/** Hermes' overlay: the grid's web tools, and nothing else. */
export function hermesManagedConfig(mcpUrl: string, keyVar: string): string {
  return `${JSON.stringify({
    mcp_servers: {
      [HARNESS_MCP_SERVER_NAME]: {
        url: mcpUrl,
        // Hermes interpolates `${VAR}` Cursor-style against the process environment
        // (`tools/mcp_tool_config._ENV_VAR_PATTERN`), so the key stays out of this file too.
        headers: { Authorization: `Bearer \${${keyVar}}` },
      },
    },
  }, null, 2)}\n`
}

/**
 * Grok's config directory, which is also the only lever it offers for MCP servers.
 *
 * Grok reads `[mcp_servers]` from three layers — `$GROK_HOME/config.toml`, then `.grok/config.toml`
 * walked from the repo root down to the cwd — and offers no per-invocation flag for them at all:
 * `grok --help` has no `--mcp-config`, and the binary contains no such string. Every other route was
 * measured against grok 1.0.24 and rejected on evidence rather than on reading:
 *
 *  * **Project scope (`.grok/config.toml`) is what the docs steer you to, and it does not start.**
 *    A repo-local server is gated on folder trust — `grok mcp doctor` answers "folder untrusted
 *    (repo-local (project-scoped) server not started for an untrusted folder)" and the server never
 *    runs. An agent the desktop launches has nobody to click through that, which is the same reason
 *    this file exists at all. It would also write into the USER'S repo, and a project layer
 *    *replaces* a same-named global server outright rather than merging with it.
 *  * **`CLAUDE_CONFIG_DIR` does not redirect MCP discovery.** Grok does read `~/.claude.json` for
 *    servers, so the variable looks like the seam — but it is not consulted for that. Pointed at a
 *    directory holding a `.claude.json` with this very server, `grok mcp list` reported none, and in
 *    the binary the string sits among session-import fields (`isSidechain`, `rollout_path`), not
 *    config paths. `GROK_CONFIG`, `GROK_CONFIG_PATH` and `GROK_MANAGED_CONFIG` were each tried as a
 *    file and as a directory: none of them moved a server either.
 *
 * So it is `GROK_HOME`, which the launch already owns a private directory for — and which comes with
 * one consequence that has to be paid rather than ignored. See [grokGridHomeLinks].
 *
 * Measured 2026-09-09 against the same header-logging listener on loopback as the harnesses above:
 * with a user-scope server in a private `GROK_HOME`, Grok started it with no trust prompt and sent
 * `Authorization: Bearer <the variable's value>` on every request.
 */
export const GROK_HOME_VAR = 'GROK_HOME'

/** The one file [GROK_HOME_VAR] is written for here. */
export const GROK_CONFIG_FILE = 'config.toml'

/**
 * The directories a private [GROK_HOME_VAR] must borrow back from the user's real one.
 *
 * `GROK_HOME` moves Grok's whole state directory, and `sessions/` is in it — which for this repo is
 * not a cosmetic loss. The daemon resolves transcripts under its OWN `env.GROK_HOME` (`cli.ts`,
 * `findGrokTranscript`), and for grok specifically a missing transcript means the agent is never
 * registered at all — `cli.ts` returns early on `!transcriptPath` for cursor and grok. A grid-launched
 * Grok agent under an un-borrowed home would therefore write its session somewhere the harness does
 * not look, and go invisible: no transcript, no resume, no session repair.
 *
 * Symlinking the directory back is what keeps the two halves pointing at one place. Verified by
 * running Grok headless under such a home: the session landed in the real `~/.grok/sessions/<encoded
 * cwd>/`, which is exactly where `findGrokTranscript` reads.
 *
 * Deliberately a SHORT list rather than "everything but config.toml". Each entry is state this repo
 * or the user would miss, and a link that turns out to be unnecessary costs nothing, while inventing
 * links for Grok's caches would be this module guessing at another program's internals — the thing
 * its refusals exist to avoid. `auth.json` is NOT here on purpose: a grid launch authenticates with
 * `XAI_API_KEY`, so borrowing the user's xAI credential would hand a grid agent a login it was
 * deliberately not given.
 */
export const GROK_GRID_HOME_LINKS: readonly string[] = ['sessions']

/**
 * Grok's user-scope config: the grid model, and — when there are any — the grid's web tools.
 *
 * TOML rather than JSON because this is the only format Grok reads here. Values are JSON-encoded,
 * which is valid TOML for a string and gets the escaping right for free.
 *
 * ## Why the model block is not optional
 *
 * `GROK_MODELS_BASE_URL` + `XAI_API_KEY` looks like the whole contract — Grok's own docs present the
 * pair that way — but it only redirects WHERE requests go, not WHICH credential is chosen. Grok's
 * documented resolution order is:
 *
 *     api_key → env_key → auth_provider → session token → XAI_API_KEY
 *
 * `XAI_API_KEY` is LAST, behind the OIDC session token. A private `GROK_HOME` still ends up with an
 * `auth.json` (Grok writes one on first run, and the desktop's own login flows put one there), so the
 * session token outranks the grid key and every request goes out signed as the user's xAI login —
 * which the relay rejects.
 *
 * Measured on a live pane (2026-09-09, grok 1.0.24) that had been moved onto the autonomous.ai grid:
 *
 *     auth: first-party API key probe  verdict=Unusable elapsed_ms=351 timeout_ms=400
 *     auth 401 attribution … consumer=OaiCompatClient  auth_mode=Oidc  remedy=ManualLogin
 *
 * — and the pane printed "Authentication required: your session has expired". The probe is Grok
 * asking `api.x.ai` whether the key is one of ITS keys; a grid JWT is not, so it answers 400 in
 * ~380ms and Grok files the key as unusable. The failure is therefore also a RACE: on a slower link
 * the same probe exceeds its own 400ms timeout, comes back `Unknown`, and Grok keeps the key and
 * works. Two panes launched minutes apart on one machine disagreed for exactly this reason
 * (402ms → `Unknown`, worked; 351ms → `Unusable`, 401), which is what made this look intermittent.
 *
 * Declaring the model with `env_key` moves the grid key from last place to SECOND, above the session
 * token, so the choice no longer depends on a probe or on whether an `auth.json` happens to exist.
 * The key is still only referenced — `env_key` names the variable; nothing secret is written here.
 *
 * [model] may be the relay's ROUTER id rather than a real model, and that is a supported case rather
 * than a degraded one: the relay answers `Auto` like any other id, so a user who picked no model gets
 * a block declaring the router and the grid keeps choosing per request. Verified end to end — Grok
 * under `[model."Auto"]` answered through the router with `auth_mode=null` and no probe. What must
 * NOT happen is no block at all: that is the path back to the session token and the 401.
 *
 * ⚠️ The MCP server name is spelled exactly as [HARNESS_MCP_SERVER_NAME], as it is for Codex and for
 * the same reason — Grok namespaces MCP tools as `<server>__<tool>`, so respelling it here would
 * rename its tools too.
 *
 * The MCP key is referenced the same way: Grok interpolates `${VAR}` in `headers` against the process
 * environment, measured on the wire.
 */
export function grokGridConfig(
  mcpUrl: string | undefined,
  keyVar: string,
  model: string,
  baseUrl: string,
): string {
  // The model block first: it is what makes the launch authenticate at all, so a config that carried
  // only web tools would be a pane with tools it cannot reach.
  let config = `[model.${JSON.stringify(model)}]\n`
    + `model = ${JSON.stringify(model)}\n`
    + `base_url = ${JSON.stringify(baseUrl)}\n`
    + `env_key = ${JSON.stringify(keyVar)}\n`
  if (mcpUrl) {
    config += `\n[mcp_servers.${HARNESS_MCP_SERVER_NAME}]\n`
      + `url = ${JSON.stringify(mcpUrl)}\n`
      + `headers = { Authorization = ${JSON.stringify(`Bearer \${${keyVar}}`)} }\n`
  }
  return config
}
