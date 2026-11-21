/**
 * The dial eval's network guard, typed: every eval test, tier A in this process and tier B's daemon through the preload,
 * runs under it, and a connection to anything but this machine fails the test (netGuard.cjs holds the one implementation).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export interface NetAttempt {
  api: 'net' | 'tls' | 'dgram' | 'dns'
  host: string
  port: number | null
  pid: number
  /** HARNESSD_SERVICE under `__service`, `core` (`__run`), `master` (`__harnessd`), else `node`. */
  process: string
}

interface Guard {
  isLocal(host: string | undefined): boolean
  install(record: (attempt: NetAttempt) => void): () => void
}

export const NET_GUARD_PRELOAD = fileURLToPath(new URL('./netGuard.cjs', import.meta.url))
export const NET_GUARD_FILE_ENV = 'HARNESS_E2E_NET_GUARD_FILE'

const guard = createRequire(import.meta.url)(NET_GUARD_PRELOAD) as Guard

export function isLocal(host: string | undefined): boolean {
  return guard.isLocal(host)
}

/** Guards this process; `taken` hands over the attempts refused since its last call. */
export function guardThisProcess(): { taken(): NetAttempt[]; uninstall(): void } {
  let attempts: NetAttempt[] = []
  const uninstall = guard.install((attempt) => { attempts.push(attempt) })
  return {
    taken() {
      const taken = attempts
      attempts = []
      return taken
    },
    uninstall,
  }
}

/** What the preload wrote to `file`: the processes it was loaded into and the attempts it refused there. */
export function readNetGuard(file: string): { loaded: Array<{ pid: number; process: string }>; attempts: NetAttempt[] } {
  const loaded: Array<{ pid: number; process: string }> = []
  const attempts: NetAttempt[] = []
  if (!existsSync(file)) return { loaded, attempts }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    const { kind, ...rest } = JSON.parse(line) as { kind: 'loaded' | 'attempt' } & NetAttempt
    if (kind === 'loaded') loaded.push({ pid: rest.pid, process: rest.process })
    else attempts.push(rest)
  }
  return { loaded, attempts }
}

/** The env that preloads the guard into a Node and its children, ahead of the NODE_OPTIONS given. */
export function netGuardEnv(file: string, nodeOptions?: string): { NODE_OPTIONS: string; HARNESS_E2E_NET_GUARD_FILE: string } {
  // Quoted, and a backslash or quote escaped, as Node reads NODE_OPTIONS: a path with a space or a Windows path holds.
  const preload = `--require="${NET_GUARD_PRELOAD.replace(/[\\"]/g, '\\$&')}"`
  return { NODE_OPTIONS: nodeOptions ? `${preload} ${nodeOptions}` : preload, [NET_GUARD_FILE_ENV]: file }
}

export function describeAttempt(a: NetAttempt): string {
  return `${a.process} ${a.api} ${a.port === null ? a.host : `${a.host}:${a.port}`}`
}
