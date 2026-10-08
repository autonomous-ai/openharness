/**
 * The engines' declared session stores (engines/{claude,codex}/sessionStore.ts): data only, imported by what
 * reads them in core (lib/engineHomes.ts, engines/sessionFiles.ts, lib/sessionRepair.ts, the registry) with
 * nothing else in the way, so none of those loads an engine's code.
 */
import { sessionStore as claude } from './claude/sessionStore.js'
import { sessionStore as codex } from './codex/sessionStore.js'
import type { SessionStoreContract } from './facets/sessionStore.js'
import type { AgentEngine } from './types.js'

export const sessionStoreContracts = { claude, codex } satisfies Record<string, SessionStoreContract>
export type SessionStoreEngine = keyof typeof sessionStoreContracts

/** Whether `engine` declares a session store. Any name: a session row's engine is a string. */
export function isSessionStoreEngine(engine: AgentEngine | string): engine is SessionStoreEngine {
  return Object.hasOwn(sessionStoreContracts, engine)
}

/** An engine's session store, for an engine that declares one. */
export function sessionStoreOf(engine: AgentEngine | string): SessionStoreContract | undefined {
  return isSessionStoreEngine(engine) ? sessionStoreContracts[engine] : undefined
}
