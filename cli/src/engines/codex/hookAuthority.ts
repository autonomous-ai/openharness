import type { HookContract } from '../facets/hooks.js'

/** Mandatory hook admission and turn rules; no installer or native configuration parser. */
export const hookAuthority = {
  // A delegated session (a Codex sub-agent) runs its hooks from its parent's pane, and its rollout's first
  // record names it a child (`source.subagent`). Registered, it would take the parent's pane and transcript,
  // and its prompt would be credited to the parent: refused before either (hookServer.ts, registry.register).
  children: { type: 'session_meta', child: ['payload', 'source', 'subagent'], reason: 'codex_subagent' }
} satisfies Omit<HookContract, 'settings'>
