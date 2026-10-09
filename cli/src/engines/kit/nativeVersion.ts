/** Native executable facts used by launch control, without loading an interpreter. */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'

export interface VersionRule { output: RegExp; args: readonly string[]; timeoutMs: number }
export interface VersionProbe { identity(): string | null; read(): string }

export function parseMajor(rule: VersionRule, output: string): number | null {
  const match = rule.output.exec(output)
  return match ? Number(match[1]) : null
}

export function nativeVersionProbe(rule: VersionRule, binary: () => string): VersionProbe {
  return {
    identity: () => {
      const bin = binary(), path = bin.includes('/') ? bin : resolveBinaryOnPath(bin)
      if (!path) return null
      try { const info = statSync(path); return `${path}:${info.size}:${info.mtimeMs}` } catch { return null }
    },
    read: () => execFileSync(binary(), [...rule.args], {
      encoding: 'utf8', timeout: rule.timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    }),
  }
}

/** Compatibility behavior: one answer per installed file; absent files have no cache key. */
export function majorVersion(rule: VersionRule, probe: VersionProbe, memo: Map<string, number | null>): number | null {
  const identity = probe.identity()
  if (identity !== null && memo.has(identity)) return memo.get(identity) ?? null
  let major: number | null
  try { major = parseMajor(rule, probe.read()) } catch { major = null }
  if (identity !== null) memo.set(identity, major)
  return major
}
