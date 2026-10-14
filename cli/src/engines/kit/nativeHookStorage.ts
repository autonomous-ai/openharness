/** Eager, configuration-free composition shared by core and native hook clients. */
import { probeNativeProcessControl, type NativeControlHelpers } from '../../lib/nativeProcessControlProbe.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { createNativeHookCatalog } from './nativeHookCatalog.js'
import { createNativeHookStagePool } from './nativeHookStaging.js'
import { captureNativeHookWriter, nativeHookWriterDead } from './nativeHookWriter.js'

export type NativeHookStorage = Awaited<ReturnType<typeof openNativeHookStorage>>

/** Opening requires an existing private local root. Callers decide when to open;
 * daemon readiness does not await it. No completed process/death probe is cached. */
export async function openNativeHookStorage(root: string, helpers: NativeControlHelpers) {
  const probe = (pids: readonly number[], budget: NativeEvidenceBudget) =>
    probeNativeProcessControl(pids, 0, budget, false, helpers)
  const writer = await captureNativeHookWriter(root, new NativeEvidenceBudget(), probe, helpers)
  let pool: ReturnType<typeof createNativeHookStagePool> | undefined
  try {
    pool = createNativeHookStagePool({ root, ...writer,
      dead: owner => nativeHookWriterDead(root, owner, new NativeEvidenceBudget(), probe, helpers),
    })
    const catalog = createNativeHookCatalog({ root, verifyRoot: writer.verifyWriter, pool })
    const stages = pool
    let closing: Promise<void> | undefined
    return {
      effects: catalog.effects,
      readEffects: catalog.readEffects,
      outbox: catalog.outbox,
      readOutbox: catalog.readOutbox,
      close(): Promise<void> {
        // Catalog.close revokes synchronously. Wait for actual journal I/O,
        // then acquisitions and stage cleanup; only the pool closes the writer.
        return closing ??= (async () => { await catalog.close(); await stages.close() })()
          .catch(error => { closing = undefined; throw error })
      },
    }
  } catch (error) {
    if (pool) await pool.close()
    else writer.closeWriter()
    throw error
  }
}
