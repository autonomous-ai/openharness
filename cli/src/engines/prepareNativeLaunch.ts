import type { CreationAuthority } from '../lib/agentCreationReceipt.js'
import type { createNativeInstallations, NativeInstallation } from './kit/nativeInstall.js'
import { engineName } from '../lib/agentNames.js'
import { inspectNativeLaunch, type NativeLaunchResult, type NativeLaunchSource } from './nativeLaunch.js'
import type { AgentEngine } from './types.js'

export type NativeLaunchAuthority = Pick<CreationAuthority, 'id' | 'current'> & { readonly launchToken?: string }

/** Installation is its own durable effect. It never contains the agent argv or
 * first prompt, and completing it still requires fresh executable evidence. */
export function createNativeLaunchPreparer({ installations, inspect = inspectNativeLaunch }: {
  installations: Pick<ReturnType<typeof createNativeInstallations>, 'ensure' | 'status'>
  inspect?: typeof inspectNativeLaunch
}) {
  return async (engine: AgentEngine, source: NativeLaunchSource, authority: NativeLaunchAuthority): Promise<NativeLaunchResult> => {
    source = { ...source }
    const options = { launchToken: authority.launchToken }
    const held = (detail: string): Extract<NativeLaunchResult, { ok: false }> => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail })
    // What an unfinished installation means for this launch, in words a person waiting reads: an installer at work
    // says which engine (`harness new` waits longer for it, lib/newCommand.ts); this request's own failed installer
    // is a refusal with its reason, never a hold that says the launch continues (a fresh Ubuntu VM, 2026-10-12).
    const unfinished = (installation: Extract<NativeInstallation, { complete: false }>): NativeLaunchResult =>
      installation.failed ? { ...held(`${engineName(engine)} could not be installed: ${installation.detail}`), refusal: 'ENGINE_INSTALL_FAILED' }
        : installation.running ? { ...held(`Installing ${engineName(engine)}. The harness starts once it is installed.`), installing: true }
        : held(installation.detail)
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    const found = await inspect(engine, source, options)
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    if (found.ok || found.refusal) {
      // A helper can create the executable before finishing its other writes.
      // Consult durable history on every ready path, including after a core crash.
      // An executable that fails meanwhile may be one such half-written install:
      // held while its installer is unsettled, refused only after.
      const obligation = await installations.status(engine, authority.id, authority.current)
      if (!authority.current()) return held('Waiting for the original launch request’s authority.')
      return obligation && !obligation.complete ? unfinished(obligation) : found
    }
    if (!found.install || !found.environment) return found
    const installed = await installations.ensure(engine, found.install, found.environment, authority.id, authority.current)
    if (!installed.complete) return unfinished(installed)
    if (!authority.current()) return held('Waiting for the original launch request’s authority.')
    const prepared = await inspect(engine, source, options)
    return authority.current() ? prepared : held('Waiting for the original launch request’s authority.')
  }
}
