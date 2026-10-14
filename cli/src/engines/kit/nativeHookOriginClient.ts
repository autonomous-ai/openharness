/** Injected into the standalone legacy hook; no daemon configuration or registry. */
import { prepareProcessImageHelper, type ProcessImageArtifact } from '../../lib/nativeProcessImageArtifact.js'
import { probeNativeProcessControl, type NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget, NATIVE_EVIDENCE_MS, nativeUnavailable } from './nativeEvidence.js'
import { captureNativeHookClientOrigin, encodeNativeHookOriginHeader } from './nativeHookOrigin.js'

declare const __DARWIN_PROCESS_IMAGES__: string | undefined

export async function __HARNESS_CAPTURE_HOOK_ORIGIN__(selfPid: number, callerPid: number,
  remainingMs: number, runtimeDirectory: string,
): Promise<string> {
  const timeout = Math.min(NATIVE_EVIDENCE_MS, remainingMs)
  const budget = new NativeEvidenceBudget(timeout)
  budget.step()
  let prepared: Promise<{ path: string; key: string } | null> | undefined
  const helpers: NativeControlHelpers = {
    prepare: () => prepared ??= (async () => {
      const source = typeof __DARWIN_PROCESS_IMAGES__ === 'undefined' ? undefined : __DARWIN_PROCESS_IMAGES__
      if (typeof source !== 'string') return null
      const artifact = JSON.parse(source) as ProcessImageArtifact
      const path = await prepareProcessImageHelper(artifact, runtimeDirectory)
      return path ? { path, key: artifact.sha256 } : null
    })(),
    invalidate: () => { prepared = Promise.resolve(null) },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Include a stuck file open or helper preparation in the caller's original
    // deadline. Late reads cannot post, replace the origin or perform an effect.
    const origin = await Promise.race([
      captureNativeHookClientOrigin(selfPid, callerPid, budget,
        (pids, scope) => probeNativeProcessControl(pids, 0, scope, false, helpers)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('the original native hook capture deadline was reached')), timeout)
      }),
    ])
    budget.step()
    return encodeNativeHookOriginHeader(origin)
  } catch (error) {
    return nativeUnavailable(error instanceof Error ? error.message : 'the original native hook caller is unavailable')
  } finally { clearTimeout(timer) }
}
