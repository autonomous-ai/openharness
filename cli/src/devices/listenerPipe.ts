/**
 * The devices' pipe on Windows (spec "The devices pipe's API"): `devices.json` in the data folder names the pipe and
 * the pid of the process the devices run in, and `devices-token` proves each request and answer, as the daemon's token
 * proves its pipe (lib/windows/pipeAuth.ts). Each start serves a new pipe, so clients read the record at each call, and
 * dial it only while the recorded process is not proven gone: once it is, any account can create a pipe of that name.
 * On Windows the devices run in the core's process, so the record holds the core's pid, and the core's process serves
 * this pipe through the inline door alone (services/inline.ts `startDevices`), until Windows services run in their own
 * process. The core's own code never opens it.
 */
import { closeSync, fstatSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { START_SLACK_MS, startMarkerMs, type HostLiveness } from '../lib/processProof.js'
import { ownProcessRuns } from '../lib/ownProcess.js'
import { atomicWriteFile } from '../lib/secureState.js'
import { isPipePath, readDaemonToken } from '../lib/windows/pipeAuth.js'
import type { PipeTarget } from '../lib/windows/pipeClient.js'

export const DEVICES_TOKEN_FILE = 'devices-token'
export const DEVICES_RECORD_FILE = 'devices.json'
/** A record is `{"pipe":…,"pid":…}`, well under this. */
const RECORD_MAX_BYTES = 4_096

export interface DevicesRecord { pipe: string; pid: number }

export function devicesRecordPath(dataDir: string): string {
  return join(dataDir, DEVICES_RECORD_FILE)
}

function parseRecord(text: string, platform: NodeJS.Platform): DevicesRecord | null {
  const value = JSON.parse(text) as { pipe?: unknown; pid?: unknown } | null
  const pipe = value?.pipe
  const pid = value?.pid
  if (typeof pipe !== 'string' || !isPipePath(pipe, platform)) return null
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return null
  return { pipe, pid }
}

/** The record and when it was written, from one open file, so a proof held for that time is for this content. */
function readRecordFile(dataDir: string, platform: NodeJS.Platform): { record: DevicesRecord; mtimeMs: number } | null {
  try {
    const fd = openSync(devicesRecordPath(dataDir), 'r')
    try {
      const { size, mtimeMs } = fstatSync(fd)
      if (size > RECORD_MAX_BYTES) return null
      const record = parseRecord(readFileSync(fd, 'utf8'), platform)
      return record && { record, mtimeMs }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * The record of [dataDir], or null when there is none or it is not one to dial: over 4,096 bytes, not a JSON object, a
 * pipe isPipePath refuses (on Windows anything but a local `\\.\pipe\harness-<id>`), or a pid that is not a positive
 * whole number.
 */
export function readDevicesRecord(dataDir: string, platform: NodeJS.Platform = process.platform): DevicesRecord | null {
  return readRecordFile(dataDir, platform)?.record ?? null
}

/** Written whole, owner only, as every state file is (atomicWriteFile: on Windows a rename refused for a moment is tried
 *  again). A cache: each start writes it anew. Throws when it cannot. */
export function writeDevicesRecord(dataDir: string, record: DevicesRecord): void {
  atomicWriteFile(devicesRecordPath(dataDir), `${JSON.stringify({ pipe: record.pipe, pid: record.pid })}\n`, 'cache')
}

/** Removes the record only while it names [pipe], so a second devices process's record outlives the first's close. */
export function removeDevicesRecord(dataDir: string, pipe: string): void {
  if (readDevicesRecord(dataDir)?.pipe !== pipe) return
  try {
    rmSync(devicesRecordPath(dataDir), { force: true })
  } catch {
    // A close does not fail on it: the record left behind reads as gone once its pid is.
  }
}

/**
 * How long a proof by the process table holds. The watch tells `front` and `tab` up to 10 times a second, and each
 * table read starts the pty host. Between reads the pid is still checked at every call, and every answer still needs
 * the token's proof, so a pid given to another process inside the minute gets that process nothing.
 */
export const PROOF_MAX_AGE_MS = 60_000

/**
 * The daemon pipe's liveness (lib/windows/daemonPipe.ts), copied because that file is the core's and keeps its own,
 * with this account's own processes alone alive. The table is loaded only when asked, because it brings the pty host's
 * launcher.
 */
const WINDOWS_LIVENESS: HostLiveness = {
  alive: ownProcessRuns,
  rows: async () => (await import('../lib/windows/processTable.js')).windowsProcessRows(null),
}

/** What a record proof reads at each call: the record's pipe and pid, when its file was written, and the pipe's token. */
export interface RecordRead { record: { pipe: string; pid: number }; mtimeMs: number; token: Buffer }

/** Where the processes of a process's records stand proven, and since when, one proof per record file. */
export interface RecordProof {
  /** The pipe and token [read] finds for the record at [file], or null when there is nothing to dial. */
  pipe(file: string, read: () => RecordRead | null): Promise<PipeTarget | null>
  /** Drops the proof held for [file]: the next call reads the table. */
  forget(file: string): void
}

interface HeldProof { pipe: string; pid: number; mtimeMs: number; provenAt: number }

/**
 * A process's proofs, one per record file: the devices' (`devices.json`) and the daemon's (deviceClaude/inbox.ts). Each
 * call reads the record and the token, and checks the pid. The table is read when no proof is held for this pipe, pid
 * and record time, or the one held is PROOF_MAX_AGE_MS old.
 */
export function createRecordProof(options: { liveness?: HostLiveness; now?: () => number } = {}): RecordProof {
  const liveness = options.liveness ?? WINDOWS_LIVENESS
  const now = options.now ?? Date.now
  const held = new Map<string, HeldProof>()
  return {
    async pipe(file, read) {
      const found = read()
      if (!found) return null
      const { record, mtimeMs, token } = found
      if (!liveness.alive(record.pid)) {
        held.delete(file)
        return null
      }
      const target = { pipe: record.pipe, token }
      const proof = held.get(file)
      if (proof && proof.pipe === record.pipe && proof.pid === record.pid && proof.mtimeMs === mtimeMs
        && now() - proof.provenAt < PROOF_MAX_AGE_MS) return target
      held.delete(file)
      // recordedProcessDead's rule, judged by [mtimeMs], when the record read above was written: it would stat the file
      // again after the table, and a record rewritten meanwhile would lend its time to this pid. A proof is held only
      // when the table answered: no table is no proof of death, nor of life, and the next call asks it again. The pid
      // was checked just above.
      const rows = await liveness.rows?.().catch(() => null) ?? null
      if (!rows) return target
      const row = rows.find((candidate) => candidate.pid === record.pid)
      const started = row ? startMarkerMs(row.startMarker) : null
      // Not in the table, or started after the record was written: the pid has been given to another process since.
      if (!row || (started !== null && started > mtimeMs + START_SLACK_MS)) return null
      held.set(file, { pipe: record.pipe, pid: record.pid, mtimeMs, provenAt: now() })
      return target
    },
    forget(file) {
      held.delete(file)
    },
  }
}

/** Where the recorded devices process stands proven, and since when. */
export interface DevicesProof {
  /** The devices' pipe and token for [dataDir], or null when there is nothing to dial. */
  pipe(dataDir: string): Promise<PipeTarget | null>
  /** Drops the proof held for [dataDir]: the next call reads the table. */
  forget(dataDir: string): void
}

/** A process's proofs of the devices, one per data folder, each held as a record proof of its `devices.json`. */
export function createDevicesProof(options: { liveness?: HostLiveness; now?: () => number } = {}): DevicesProof {
  const proof = createRecordProof(options)
  return {
    pipe(dataDir) {
      return proof.pipe(devicesRecordPath(dataDir), () => {
        const found = readRecordFile(dataDir, process.platform)
        const token = found && readDaemonToken(dataDir, DEVICES_TOKEN_FILE)
        return found && token ? { ...found, token } : null
      })
    },
    forget(dataDir) {
      proof.forget(devicesRecordPath(dataDir))
    },
  }
}

/** This process's proofs: a one-shot command proves by the table each time, a long-lived watch once a minute. */
export const devicesProof: DevicesProof = createDevicesProof()

export function devicesPipe(dataDir: string, proof: DevicesProof = devicesProof): Promise<PipeTarget | null> {
  return proof.pipe(dataDir)
}
