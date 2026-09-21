/**
 * The web-tools MCP server an agent on a Local model is given: what it is called, and how a call to
 * it renders.
 *
 * Its own module because two halves of the daemon that otherwise never meet both need the name.
 * The launch side (`gridWebMcp.ts`, `gridLaunch.ts`) writes it into each engine's MCP config; the
 * transcript side (`normalize.ts`, the Codex normalizer) reads it back out of a tool name to pick a
 * card. One constant, derived both ways, so a rename cannot leave the cards behind — and neither
 * side has to import the other.
 */

/**
 * What the server is called in the harness's own listing — an agent sees
 * `mcp__harness__web_search`, `/mcp` lists `harness`, a permission prompt names `harness`.
 *
 * ⚠️ Deliberately NOT `SERVER_NAME` in autonomous-grid's `cli/mcp_config.py` (`grid-web`). The grid
 * is an implementation detail of a Local model; the user's vocabulary is "Subscription" and
 * "Local", and a tool called `mcp__grid-web__…` in a permission prompt is the one place the word
 * would otherwise reach them. The cost is real and accepted: a person who ALSO ran `grid mcp config`
 * by hand for their own dotfile sees two servers offering the same two tools. That person has
 * chosen to know about the grid; everyone else has not.
 */
export const HARNESS_MCP_SERVER_NAME = 'harness'

/** The two tools the server offers, as the control plane names them (grid-apis `web_mcp.py`). */
const WEB_SEARCH_TOOL = 'web_search'
const WEB_READ_TOOL = 'web_read'

/**
 * How an engine spells a tool from this server: Claude Code's `mcp__<server>__<tool>`, which Codex
 * uses too (its `non_prefixed_mcp_tool_names` feature is off by default on 0.154.0).
 */
const mcpToolName = (tool: string): string => `mcp__${HARNESS_MCP_SERVER_NAME}__${tool}`

/** `mcp__harness__web_search` — the name a Claude Code or Codex agent calls, and is told to call. */
export const HARNESS_WEB_SEARCH_TOOL_NAME = mcpToolName(WEB_SEARCH_TOOL)

/** `mcp__harness__web_read`, likewise. */
export const HARNESS_WEB_READ_TOOL_NAME = mcpToolName(WEB_READ_TOOL)

/**
 * The server's tools as an engine names them — the list a launch pre-approves. Exactly the two the
 * control plane serves, by name rather than as a server-wide `mcp__harness` rule: a tool the server
 * grows later is one nobody here has looked at, and it should prompt like any other.
 */
export const HARNESS_MCP_TOOL_NAMES: readonly string[] = [HARNESS_WEB_SEARCH_TOOL_NAME, HARNESS_WEB_READ_TOOL_NAME]

/** The canonical card the desktop and web already render, and the input shape it reads. */
export interface HarnessWebToolCard {
  tool: 'WebSearch' | 'WebFetch'
  input: Record<string, unknown>
}

/** Which native card a tool name from this server maps to, or null for any other tool. */
export function harnessWebToolKind(name: string | undefined): HarnessWebToolCard['tool'] | null {
  if (name === HARNESS_WEB_SEARCH_TOOL_NAME) return 'WebSearch'
  if (name === HARNESS_WEB_READ_TOOL_NAME) return 'WebFetch'
  return null
}

/**
 * `web_read`'s list of pages as the one `url` the WebFetch card reads. One rule, used both for a
 * structured call and for a code-mode call read back out of its source (`codex/subagent.ts`).
 */
export function webReadUrl(urls: readonly unknown[]): string {
  return urls.filter((u): u is string => typeof u === 'string' && u.trim() !== '').join(', ')
}

/**
 * The native card for a call to this server's tools, or null for any other tool.
 *
 * The user sees an agent searching the web, not which road it took: on a Local model the search is
 * `mcp__harness__web_search` and on a Subscription model it is `WebSearch`, and the transcript
 * should not look different for it. Mapping here means the server name never reaches a card even
 * if something upstream slips.
 *
 * `web_search` takes `{query, num_results}` and already carries the `query` the WebSearch card
 * reads. `web_read` takes `{urls: [...]}` (up to five) while the WebFetch card reads `url`, so the
 * list is joined into one; the original key is kept alongside, as every engine normalizer does, so
 * an expanded card still shows what the tool was actually given.
 */
export function harnessWebTool(name: string | undefined, input: unknown): HarnessWebToolCard | null {
  const tool = harnessWebToolKind(name)
  if (!tool) return null
  const args = input && typeof input === 'object' && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {}
  if (tool === 'WebSearch') return { tool, input: args }
  const url = typeof args.url !== 'string' && Array.isArray(args.urls) ? webReadUrl(args.urls) : ''
  return { tool, input: url ? { ...args, url } : args }
}
