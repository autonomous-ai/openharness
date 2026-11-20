/** Core-selected locations and file generations; vendor rows and SQL stay in the worker. */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { hermesDbPath } from '../engines/hermes/contract.js'
import { observeNativeFiles } from '../engines/kit/nativeFileObservation.js'
import { NativeEvidenceBudget, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { NativePaths, nativeFileKey } from '../engines/kit/nativePaths.js'
import type { ExportSource } from '../engines/worker/storageProtocol.js'
import { openclawSessionLocation } from './openclawStore.js'
import type { RegisteredSession } from './registry.js'

export interface DatabaseCheckpointProof {
  /** Null only for a proven absent OpenClaw store, whose Gateway has not written history. */
  source: ExportSource | null
  verify(): void
  /** After confirmed exit, allow expected content flushes while retaining the exact selected location. */
  fresh(): DatabaseCheckpointProof
}

export async function databaseCheckpointEvidence(s: RegisteredSession, current: () => boolean = () => true): Promise<DatabaseCheckpointProof | undefined> {
  if (!current()) return nativeUnavailable('the checkpoint request is no longer current')
  let declared: string, locationProof: (() => void) | undefined
  switch (s.engine) {
    case 'opencode': declared = join(env.OPENCODE_DATA_DIR, 'opencode.db'); break
    case 'kilo': declared = join(env.KILO_DATA_DIR, 'kilo.db'); break
    case 'hermes': declared = hermesDbPath(s.hermesHome ?? env.HERMES_HOME); break
    case 'devin': declared = join(env.DEVIN_HOME, 'sessions.db'); break
    case 'openclaw': {
      const location = await openclawSessionLocation(s.sessionId, { pid: s.processIdentity?.pid ?? 0,
        stateDir: s.openclawStateDir, processIdentity: s.processIdentity })
      if (!current()) return nativeUnavailable('the checkpoint request changed during native location discovery')
      if (!location) return nativeUnavailable('the OpenClaw conversation location is unavailable')
      declared = location.path; locationProof = location.verify; break
    }
    default: return undefined
  }
  const paths = new NativePaths(new NativeEvidenceBudget())
  const location = paths.resolveSync(declared, s.engine === 'openclaw')
  const verifyRoute = paths.retain()
  if (!location) {
    const verify = () => { locationProof?.(); verifyRoute() }
    const fresh = (): DatabaseCheckpointProof => { verify(); return { source: null, verify, fresh } }
    return fresh()
  }
  const source = { path: location.path, key: nativeFileKey(location.info), database: declared }
  const fresh = (): DatabaseCheckpointProof => {
    locationProof?.()
    // Fence the selected route before an open could traverse a replaced ancestor.
    verifyRoute()
    const files = observeNativeFiles([{ path: source.path },
      { path: source.path + '-wal', missingOkay: true }, { path: source.path + '-journal', missingOkay: true }], paths)
    const verify = () => { locationProof?.(); files.verify() }
    // Capture already checked every route and leaf. A separate location callback still needs a file fence after it.
    if (locationProof) verify()
    return { source, verify, fresh }
  }
  return fresh()
}
