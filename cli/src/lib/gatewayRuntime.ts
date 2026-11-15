/**
 * Is this pane's engine talking to a GATEWAY instead of its vendor's own API?
 *
 * `ori claude` (OpenRouter's launcher) does not stay in the process tree: it resolves the vendor binary
 * and `execve`s itself away, so `ps` shows a plain `claude`/`codex` and discovery finds the agent with no
 * help from here. What survives the exec is the ROUTING: argv for Codex (`-c model_provider=openrouter …`,
 * which is how `ori codex` configures the provider at all), the environment for every other engine.
 *
 * The daemon never reads another process's environment, so the gateway comes from two places: Codex's
 * argv, read here by discovery, and for Claude Code, OpenCode and Hermes a header their hook sends from
 * its own environment (`hookServer.ts` `hookFacts`). A positive answer makes the runtime profile
 * display-only: nothing may type `/model` into a pane whose catalog we cannot enumerate.
 */

import type { AgentEngine } from '../engines/types.js'

/** `ori codex` passes its provider as argv, so codex panes are recognized without reading any env. */
export function argvNamesOpenRouterProvider(args: string): boolean {
  return /(?:^|\s)-c\s+model_provider=openrouter(?:\s|$)/.test(args)
    || /model_providers\.openrouter\./.test(args)
}

/** The engines whose gateway only their hook can say: discovery never speaks over it, and a bind takes the hook's word. */
export const HOOK_GATEWAY_ENGINES: ReadonlySet<AgentEngine> = new Set(['claude', 'opencode', 'hermes'])

/**
 * What a command line says of the gateway: Codex's routing is its argv, so its absence there is a finding. An engine
 * whose hook says it has nothing to read here. Any other has no gateway Harness can see: null, so a row clears one an
 * older build stored.
 */
export function gatewayFromArgv(engine: AgentEngine, args: string): 'ori' | null | undefined {
  if (engine === 'codex') return argvNamesOpenRouterProvider(args) ? 'ori' : null
  return HOOK_GATEWAY_ENGINES.has(engine) ? undefined : null
}
