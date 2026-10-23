/**
 * `daemon-<configured port>.json` in this user's data folder. It holds the TCP port the daemon actually bound
 * (another OS user's daemon may hold the configured one). On Windows it also holds the daemon's pipe and the core's
 * pid (lib/windows/pipeAuth.ts). Both are new on each start, so a client cannot derive them as it derives a Unix
 * socket's path. Written once the core is bound.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isPipePath } from './windows/pipeAuth.js'

export interface DaemonRecord { port: number; pipe: string | null; pid: number | null }
export interface DaemonPipeRecord { pipe: string; pid: number }

export function daemonRecordPath(dataDir: string, configuredPort: number): string {
  return join(dataDir, `daemon-${configuredPort}.json`)
}

/**
 * The record, or null when there is none or its port is not one. A `pipe` that is not one to dial reads as null: on
 * Windows anything but a local `\\.\pipe\harness-<id>` (lib/windows/pipeAuth.ts `isPipePath`).
 */
export function readDaemonRecord(dataDir: string, configuredPort: number, platform: NodeJS.Platform = process.platform): DaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(daemonRecordPath(dataDir, configuredPort), 'utf8')) as Record<string, unknown> | null
    const port = value?.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    const pipe = typeof value?.pipe === 'string' && isPipePath(value.pipe, platform) ? value.pipe : null
    const pid = typeof value?.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null
    return { port, pipe, pid }
  } catch {
    return null // a first start, or an unreadable old record
  }
}

export function writeDaemonRecord(dataDir: string, configuredPort: number, port: number, pipe?: DaemonPipeRecord): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const target = daemonRecordPath(dataDir, configuredPort)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(pipe ? { port, pipe: pipe.pipe, pid: pipe.pid } : { port }) + '\n', { mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}
