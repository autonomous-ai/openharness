import type { EngineHooks, HookAdmission, HookContract, HookSession } from './facets/hooks.js'
import { hookAuthority as claude } from './claude/hookAuthority.js'
import { hookAuthority as codex } from './codex/hookAuthority.js'
import { isChildSession, knownTranscript } from './kit/hookRules.js'
import { closeTurnOnStop } from './kit/stopHook.js'
import { errorKind } from '../lib/log.js'

/**
 * The engines' mandatory hooks load no installer and wait on no setup worker: hooks bind sessions and close turns, which are the
 * core's (docs/design/2026-10-08-engine-hooks.md).
 */
/** An engine's hooks as core calls them: the kit's mechanics, run on that engine's declaration. */
function composed({ children, sessionFile, stopClosesTurns }: Omit<HookContract, 'settings'>): EngineHooks {
  return {
    ...(sessionFile ? { transcriptFor: (body: HookSession, agent: HookSession | undefined) => knownTranscript(body, agent, sessionFile) } : {}),
    ...(children ? {
      admit: (body: HookSession): HookAdmission => body.transcriptPath && isChildSession(body.transcriptPath, children)
        ? { accepted: false, reason: children.reason }
        : { accepted: true },
    } : {}),
    ...(stopClosesTurns ? { onStop: closeTurnOnStop } : {}),
  }
}

/** Hook-only lookup: installation and the HTTP door do not need history readers or launch code. */
export const engineHooks = { claude: composed(claude), codex: composed(codex) }

export function hooksFor(name: string | null | undefined): EngineHooks | undefined {
  return name && Object.hasOwn(engineHooks, name) ? engineHooks[name as keyof typeof engineHooks] : undefined
}

/**
 * A broken admission check must never let a delegated session claim its parent's pane. The hook server asks
 * this before it credits a prompt or registers, and `registry.register` asks it again, so the two agree.
 */
export function admitHook(engine: string, body: HookSession): HookAdmission {
  try { return hooksFor(engine)?.admit?.(body) ?? { accepted: true } } catch (error) {
    console.warn(`[hooks] ${engine} admission failed:`, errorKind(error))
    return { accepted: false, reason: 'engine_hook_failed' }
  }
}
