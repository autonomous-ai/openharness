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

/** What a command line says of the gateway: Codex's routing is its argv, so its absence there is a finding; another engine's is not in its argv to read. */
export function gatewayFromArgv(engine: AgentEngine, args: string): 'ori' | null | undefined {
  if (engine !== 'codex') return undefined
  return argvNamesOpenRouterProvider(args) ? 'ori' : null
}
