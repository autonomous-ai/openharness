import type { CreationAuthority } from '../lib/agentCreationReceipt.js'
import type { createNativeInstallations } from './kit/nativeInstall.js'
import { inspectNativeLaunch, type NativeLaunchResult, type NativeLaunchSource } from './nativeLaunch.js'
import type { AgentEngine } from './types.js'

/** Installation is its own durable effect. It never contains the agent argv or
 * first prompt, and completing it still requires fresh executable evidence. */
export function createNativeLaunchPreparer({ installations, inspect = inspectNativeLaunch }: {
  installations: Pick<ReturnType<typeof createNativeInstallations>, 'ensure' | 'status'>
  inspect?: typeof inspectNativeLaunch
}) {
  return async (engine: AgentEngine, source: NativeLaunchSource, authority: Pick<CreationAuthority, 'id' | 'current'>): Promise<NativeLaunchResult> => {
    source = { ...source }
    const held = (detail: string): NativeLaunchResult => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail })
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    const found = await inspect(engine, source)
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    if (found.ok) {
      // A helper can create the executable before finishing its other writes.
      // Consult durable history on every ready path, including after a core crash.
      const obligation = await installations.status(engine, authority.id, authority.current)
      if (!authority.current()) return held('Waiting for the original launch request’s authority.')
      return obligation && !obligation.complete ? held(obligation.detail) : found
    }
    if (!found.install || !found.environment) return found
    const installed = await installations.ensure(engine, found.install, found.environment, authority.id, authority.current)
    if (!installed.complete) return held(installed.detail)
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    const prepared = await inspect(engine, source)
    return authority.current() ? prepared : held('Waiting for the original launch request’s authority.')
  }
}
