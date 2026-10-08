/**
 * "Is the process that wrote this lock still the process that wrote it?" — shared by every on-disk
 * lock the CLI keeps (registry.json.lock, adapter.spawn.lock).
 *
 * A bare pid is not enough: pids are recycled, so a crashed owner's pid can belong to an unrelated
 * process by the time anyone checks. The start marker pins the process GENERATION — Linux exposes it
 * in /proc/<pid>/stat (field 22, starttime in clock ticks); elsewhere `ps -o lstart` gives it to the
 * second, which is coarse but has never collided in practice. A marker that cannot be read at all
 * degrades to "alive if the pid exists", which is what Windows gets.
 */

import { readFileSync } from 'fs'
import { execFileSync } from 'node:child_process'
import { psEnv } from './childLocale.js'

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Linux: when `pid` started, in clock ticks since boot; null elsewhere or once it has exited. */
export function processStartTicks(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // `pid (comm) S ...`: comm may hold spaces and parentheses, so fields count from the LAST `)`.
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19])
    return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
  } catch { return null }
}

export function processStartMarker(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  const ticks = processStartTicks(pid)
  if (ticks !== null) return `linux:${ticks}`
  try {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 1_000, env: { ...psEnv(), TZ: 'UTC' },
    }).trim()
    return started ? `ps-c:${started}` : null
  } catch { return null }
}

export interface LockGeneration {
  startMarker?: unknown
  generationMarker?: unknown
}

/** Older readers compare every nonempty marker literally. Leave their field empty for the new
 * locale-pinned format so they use PID liveness during an upgrade, never steal a live new lock.
 * New readers retain PID-reuse detection through the separate versioned field. */
export function processLockIdentity(pid: number): { startMarker: string; generationMarker: string } {
  const generationMarker = processStartMarker(pid) ?? ''
  return { startMarker: generationMarker.startsWith('ps-c:') ? '' : generationMarker, generationMarker }
}

export function lockStartMarker(owner: LockGeneration | null | undefined): string {
  return typeof owner?.generationMarker === 'string' ? owner.generationMarker
    : typeof owner?.startMarker === 'string' ? owner.startMarker : ''
}

export function lockOwnerAlive(pid: number, startMarker: string): boolean {
  if (!processExists(pid)) return false
  if (!startMarker) return true
  const current = processStartMarker(pid)
  // Legacy ps markers inherited the writer's locale. They cannot be compared
  // safely with a new reader's timestamp; keep that live owner until it exits.
  const comparable = current !== null && ['linux:', 'ps-c:'].some(
    (prefix) => startMarker.startsWith(prefix) && current.startsWith(prefix),
  )
  return !comparable || current === startMarker
}
