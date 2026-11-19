/**
 * The devices' pipe on Windows (spec "The devices pipe's API"): `devices.json` in the data folder names the pipe and
 * the devices process's pid, and `devices-token` proves each request and answer, as the daemon's token proves its
 * pipe (lib/windows/pipeAuth.ts). Each start serves a new pipe, so clients read the record at each call, and dial it
 * only while the recorded process is not proven gone: once it is, any account can create a pipe of that name.
 * Outside the core: the core never opens this pipe.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidAlive, recordedProcessDead, type HostLiveness } from '../lib/processProof.js'
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

/** Written whole, owner only: a temp file beside it, renamed into place. Throws when it cannot. */
export function writeDevicesRecord(dataDir: string, record: DevicesRecord): void {
  const target = devicesRecordPath(dataDir)
  // A new file (`wx`), so its mode is the one given and nothing already there is written through.
  const temporary = join(dataDir, `.${DEVICES_RECORD_FILE}.${process.pid}.${randomBytes(6).toString('hex')}`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ pipe: record.pipe, pid: record.pid })}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
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
 * The daemon pipe's liveness (lib/windows/daemonPipe.ts), copied because that file is the core's and keeps its own.
 * The table is loaded only when asked, because it brings the pty host's launcher.
 */
const WINDOWS_LIVENESS: HostLiveness = {
  alive: pidAlive,
  rows: async () => (await import('../lib/windows/processTable.js')).windowsProcessRows(null),
}

/** Where the recorded devices process stands proven, and since when. */
export interface DevicesProof {
  /** The devices' pipe and token for [dataDir], or null when there is nothing to dial. */
  pipe(dataDir: string): Promise<PipeTarget | null>
  /** Drops the proof held for [dataDir]: the next call reads the table. */
  forget(dataDir: string): void
}

interface HeldProof { pipe: string; pid: number; mtimeMs: number; provenAt: number }

/**
 * A process's proofs, one per data folder. Each call reads the record and the token, and checks the pid. The table is
 * read when no proof is held for this pipe, pid and record time, or the one held is PROOF_MAX_AGE_MS old.
 */
export function createDevicesProof(options: { liveness?: HostLiveness; now?: () => number } = {}): DevicesProof {
  const liveness = options.liveness ?? WINDOWS_LIVENESS
  const now = options.now ?? Date.now
  const held = new Map<string, HeldProof>()
  return {
    async pipe(dataDir) {
      const found = readRecordFile(dataDir, process.platform)
      const token = found && readDaemonToken(dataDir, DEVICES_TOKEN_FILE)
      if (!found || !token) return null
      const { record, mtimeMs } = found
      if (!liveness.alive(record.pid)) {
        held.delete(dataDir)
        return null
      }
      const target = { pipe: record.pipe, token }
      const proof = held.get(dataDir)
      if (proof && proof.pipe === record.pipe && proof.pid === record.pid && proof.mtimeMs === mtimeMs
        && now() - proof.provenAt < PROOF_MAX_AGE_MS) return target
      held.delete(dataDir)
      // Read here rather than inside recordedProcessDead, so a proof is held only when the table answered: no table is
      // no proof of death, nor of life, and the next call asks it again. The pid was checked just above.
      const rows = await liveness.rows?.().catch(() => null) ?? null
      if (await recordedProcessDead(devicesRecordPath(dataDir), record.pid, { alive: () => true, rows: async () => rows })) return null
      if (rows) held.set(dataDir, { pipe: record.pipe, pid: record.pid, mtimeMs, provenAt: now() })
      return target
    },
    forget(dataDir) {
      held.delete(dataDir)
    },
  }
}

/** This process's proofs: a one-shot command proves by the table each time, a long-lived watch once a minute. */
export const devicesProof: DevicesProof = createDevicesProof()

export function devicesPipe(dataDir: string, proof: DevicesProof = devicesProof): Promise<PipeTarget | null> {
  return proof.pipe(dataDir)
}
