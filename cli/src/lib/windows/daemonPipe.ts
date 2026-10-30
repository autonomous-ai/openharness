/**
 * The daemon's pipe on Windows, found by the record the core writes (daemonRecord.ts) and checked against the
 * recorded process before anything dials it. Both the daemon's client (daemonEndpoint.ts) and the start-up ask of
 * who serves a data folder (localSocket.ts `servedFolderDeps`) use it; it lives here, apart from either, so neither
 * imports the other.
 */
import { daemonRecordPath, readDaemonRecord } from '../daemonRecord.js'
import { pidAlive, recordedProcessDead, type HostLiveness } from '../processProof.js'
import { readDaemonToken } from './pipeAuth.js'
import type { PipeTarget } from './pipeClient.js'

/**
 * How the daemon of a Windows record is proven gone before its pipe is dialled: its pid, and the process table
 * harness-pty reads (A's proof, processProof.ts). The table is loaded only when asked, because it brings the pty
 * host's launcher, which no Unix client needs.
 */
const WINDOWS_LIVENESS: HostLiveness = {
  alive: pidAlive,
  rows: async () => (await import('./processTable.js')).windowsProcessRows(null),
}

/**
 * The daemon's pipe and token for this data folder on Windows, or null when there is nothing to dial: no record of
 * a pipe and pid, no token, or the recorded process is proven gone. Once that process is gone, any user can create
 * a pipe of the recorded name.
 */
export async function daemonPipe(dataDir: string, configuredPort: number, liveness: HostLiveness = WINDOWS_LIVENESS): Promise<PipeTarget | null> {
  const record = readDaemonRecord(dataDir, configuredPort)
  if (!record?.pipe || !record.pid) return null
  const token = readDaemonToken(dataDir)
  if (!token) return null
  if (await recordedProcessDead(daemonRecordPath(dataDir, configuredPort), record.pid, liveness)) return null
  return { pipe: record.pipe, token }
}

export interface LocalDaemonOptions {
  platform?: NodeJS.Platform
  /** The daemon's pipe on Windows; `daemonPipe` by default. */
  pipe?: (dataDir: string, configuredPort: number) => Promise<PipeTarget | null>
}
