import type { CreationAuthority } from '../lib/agentCreationReceipt.js'
import type { createNativeInstallations, NativeInstallation } from './kit/nativeInstall.js'
import { engineName } from '../lib/agentNames.js'
import { inspectNativeLaunch, type NativeLaunchResult, type NativeLaunchSource } from './nativeLaunch.js'
import type { AgentEngine } from './types.js'

/** Installation is its own durable effect. It never contains the agent argv or
 * first prompt, and completing it still requires fresh executable evidence. */
export function createNativeLaunchPreparer({ installations, inspect = inspectNativeLaunch, downloading }: {
  installations: Pick<ReturnType<typeof createNativeInstallations>, 'ensure' | 'status'>
  inspect?: typeof inspectNativeLaunch
  /** Whether Desktop Harness is downloading the engine now (kit/downloadMarker.ts `engineDownloading`). */
  downloading: (engine: AgentEngine) => Promise<boolean>
}) {
  return async (engine: AgentEngine, source: NativeLaunchSource, authority: Pick<CreationAuthority, 'id' | 'current'>): Promise<NativeLaunchResult> => {
    source = { ...source }
    const held = (detail: string): Extract<NativeLaunchResult, { ok: false }> => ({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail })
    const stale = () => held('Waiting for the original launch request’s authority.')
    // What an unfinished installation means for this launch, in words a person waiting reads: an installer at work
    // says which engine (`harness new` waits longer for it, lib/newCommand.ts); this request's own failed installer
    // is a refusal with its reason, never a hold that says the launch continues (a fresh Ubuntu VM, 2026-10-12).
    const unfinished = (installation: Extract<NativeInstallation, { complete: false }>): NativeLaunchResult =>
      installation.failed ? { ...held(`${engineName(engine)} could not be installed: ${installation.detail}`), refusal: 'ENGINE_INSTALL_FAILED' }
        : installation.running ? { ...held(`Installing ${engineName(engine)}. The harness starts once it is installed.`), installing: true }
        : held(installation.detail)
    // Desktop Harness is downloading this engine on a fresh computer (kit/downloadMarker.ts): a missing engine, or one
    // whose check fails, is that download not finished yet. Held as an install (`installing`, which `harness new` waits
    // for as long) and tried again until the download ends, rather than installed beside it or refused for what it has
    // written so far, which failed Desktop launches on brand-new Macs (6 to 25 on 2026-10-16). Asked as the look
    // begins and again after it: a probe that began while the download was writing is no evidence against it, even
    // when the download has ended by the time the probe answers (the next attempt looks again, afresh). A ready engine
    // costs that one look at a marker that is not there.
    const downloadHold = (): NativeLaunchResult => authority.current()
      ? { ...held(`Downloading ${engineName(engine)}. The harness starts once it is downloaded.`), installing: true } : stale()
    if (!authority.current()) return stale()
    // Read before the look starts, not beside it: a look that began first could see the half-written engine while
    // the marker was there and answer after the marker had gone, and the read beside it, still opening the file,
    // saw no marker either (PR CI, #1394). No marker costs one failed open; a live one, its `ps`.
    const before = await downloading(engine).catch(() => false)
    const downloaded = async () => before || await downloading(engine).catch(() => false)
    const found = await inspect(engine, source)
    if (!authority.current()) return stale()
    if (found.ok || found.refusal) {
      // A helper can create the executable before finishing its other writes.
      // Consult durable history on every ready path, including after a core crash.
      // An executable that fails meanwhile may be one such half-written install:
      // held while its installer is unsettled, refused only after.
      const obligation = await installations.status(engine, authority.id, authority.current)
      if (!authority.current()) return stale()
      if (obligation && !obligation.complete) return unfinished(obligation)
      if (found.ok) return found
      return await downloaded() ? downloadHold() : found
    }
    if (!found.install || !found.environment) return found
    if (await downloaded()) return downloadHold()
    if (!authority.current()) return stale()
    const installed = await installations.ensure(engine, found.install, found.environment, authority.id, authority.current)
    if (!installed.complete) return unfinished(installed)
    if (!authority.current()) return stale()
    const prepared = await inspect(engine, source)
    return authority.current() ? prepared : stale()
  }
}
