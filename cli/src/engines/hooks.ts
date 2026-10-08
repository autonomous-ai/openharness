import type { EngineHooks, HookAdmission, HookSession } from './facets/hooks.js'
import { hooks as claude } from './claude/hooks.js'
import { hooks as codex } from './codex/hooks.js'

/** Hook-only lookup: installation and the HTTP door do not need history readers or launch code. */
export const engineHooks = { claude, codex }

export function hooksFor(name: string | null | undefined): EngineHooks | undefined {
  return name && Object.hasOwn(engineHooks, name) ? engineHooks[name as keyof typeof engineHooks] : undefined
}

/** A broken admission check must never let a delegated session claim its parent's pane. */
export function admitHook(engine: string, body: HookSession): HookAdmission {
  try { return hooksFor(engine)?.admit?.(body) ?? { accepted: true } } catch (error) {
    console.warn(`[hooks] ${engine} admission failed:`, error instanceof Error ? error.message : error)
    return { accepted: false, reason: 'engine_hook_failed' }
  }
}
