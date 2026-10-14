/** Daemon composition for the configuration-free kernel control probe. */
import type { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { bundledProcessImageHelper, invalidateProcessImageHelper } from './nativeProcessImages.js'
import { probeNativeProcessControl, type NativeControlSnapshot } from './nativeProcessControlProbe.js'

export { controlDescriptors, controlIdentity, linuxProcessStat, parseNativeProcessControl } from './nativeProcessControlProbe.js'
export type { NativeControlRow, NativeControlSnapshot } from './nativeProcessControlProbe.js'

export function nativeProcessControl(pids: readonly number[], parent: number, budget: NativeEvidenceBudget,
  descriptors = true,
): Promise<NativeControlSnapshot> {
  return probeNativeProcessControl(pids, parent, budget, descriptors, {
    prepare: () => bundledProcessImageHelper({ retryUnavailable: true }), invalidate: invalidateProcessImageHelper,
  })
}
