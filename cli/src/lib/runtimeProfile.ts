/** Inline compatibility composition. Supervised core must not import this module. */
import type { RegisteredSession } from './registry.js'
import { runtimeFor } from '../engines/runtime.js'
import { LegacyRuntimeProfileManager } from './runtimeProfileManager.js'

export * from './runtimeProfileManager.js'
export { codexEffortAllowed } from '../engines/codex/runtimeProfile.js'

export function supportsNativeRuntimeControl(session: RegisteredSession): boolean {
  return !session.gateway && (runtimeFor(session.engine)?.supportsControl(session) ?? false)
}

export class RuntimeProfileManager extends LegacyRuntimeProfileManager {
  constructor() { super(runtimeFor) }
}
