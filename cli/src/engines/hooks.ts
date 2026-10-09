import type { EngineHooks, HookAdmission, HookContract, HookSession } from './facets/hooks.js'
import { hooks as claude } from './claude/hookContract.js'
import { hooks as codex } from './codex/hookContract.js'
import { installHookSettings, type HookEngine } from './kit/hookSettings.js'
import { isChildSession, knownTranscript } from './kit/hookRules.js'
import { closeTurnOnStop } from './kit/stopHook.js'

/**
 * The engines' hooks as they declare them: data only. Installation, the hook server and turn closing load
 * no engine code and wait on no engine worker: hooks are how sessions bind and turns close, which are the
 * core's (docs/design/2026-10-08-engine-hooks.md).
 */
export const hookContracts = { claude, codex } satisfies Record<string, HookContract>

/** An engine's hooks as core calls them: the kit's mechanics, run on that engine's declaration. */
function composed(engine: HookEngine, { settings, children, sessionFile, stopClosesTurns }: HookContract): EngineHooks {
  return {
    install: (port) => installHookSettings(engine, settings, port),
    installIn: (port, home) => installHookSettings(engine, settings, port, home),
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
export const engineHooks = { claude: composed('claude', claude), codex: composed('codex', codex) }

export function hooksFor(name: string | null | undefined): EngineHooks | undefined {
  return name && Object.hasOwn(engineHooks, name) ? engineHooks[name as keyof typeof engineHooks] : undefined
}

/**
 * A broken admission check must never let a delegated session claim its parent's pane. The hook server asks
 * this before it credits a prompt or registers, and `registry.register` asks it again, so the two agree.
 */
export function admitHook(engine: string, body: HookSession): HookAdmission {
  try { return hooksFor(engine)?.admit?.(body) ?? { accepted: true } } catch (error) {
    console.warn(`[hooks] ${engine} admission failed:`, error instanceof Error ? error.message : error)
    return { accepted: false, reason: 'engine_hook_failed' }
  }
}
