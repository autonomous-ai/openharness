/** Core-selected locations and file generations; vendor rows and SQL stay in the worker. */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { hermesDbPath } from '../engines/hermes/contract.js'
import { observeNativeFile } from '../engines/kit/nativeFileObservation.js'
import { NativeEvidenceBudget, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { NativePaths, nativeFileKey, verifyNativePathFacts } from '../engines/kit/nativePaths.js'
import type { ExportSource } from '../engines/worker/storageProtocol.js'
import { openclawSessionLocation } from './openclawStore.js'
import type { RegisteredSession } from './registry.js'

export interface DatabaseCheckpointProof {
  source: ExportSource
  verify(): void
  /** After confirmed exit, allow expected content flushes while retaining the exact selected location. */
  fresh(): DatabaseCheckpointProof
}

export async function databaseCheckpointEvidence(s: RegisteredSession): Promise<DatabaseCheckpointProof | undefined> {
  let declared: string, locationProof: (() => void) | undefined
  switch (s.engine) {
    case 'opencode': declared = join(env.OPENCODE_DATA_DIR, 'opencode.db'); break
    case 'kilo': declared = join(env.KILO_DATA_DIR, 'kilo.db'); break
    case 'hermes': declared = hermesDbPath(s.hermesHome ?? env.HERMES_HOME); break
    case 'devin': declared = join(env.DEVIN_HOME, 'sessions.db'); break
    case 'openclaw': {
      const location = await openclawSessionLocation(s.sessionId, { pid: s.processIdentity?.pid ?? 0, stateDir: s.openclawStateDir })
      if (!location) return nativeUnavailable('the OpenClaw conversation location is unavailable')
      declared = location.path; locationProof = location.verify; break
    }
    default: return undefined
  }
  const paths = new NativePaths(new NativeEvidenceBudget())
  const location = paths.resolveSync(declared)!
  const route = paths.snapshot()
  const source = { path: location.path, key: nativeFileKey(location.info), database: declared }
  const fresh = (): DatabaseCheckpointProof => {
    locationProof?.(); verifyNativePathFacts(route)
    const files = [source.path, source.path + '-wal', source.path + '-journal']
      .map((path, index) => observeNativeFile(path, { missingOkay: index > 0 }))
    const verify = () => { locationProof?.(); verifyNativePathFacts(route); for (const file of files) file.verify() }
    verify()
    return { source, verify, fresh }
  }
  return fresh()
}
