/** Native executable facts used by launch control, without loading an interpreter. */
import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'

export interface VersionRule { output: RegExp; args: readonly string[]; timeoutMs: number }
export interface VersionProbe { identity(): string | null; read(): string | Promise<string> }
export interface NativeVersionProbe extends VersionProbe { command(): string | null }
export interface NativeExecutableSnapshot {
  command: string
  identity: string
  current(): boolean
}

/** Retain the file used by the probe through later preparation and dispatch. */
export function executableSnapshot(probe: NativeVersionProbe): NativeExecutableSnapshot | null {
  const command = probe.command(), identity = probe.identity()
  return command && identity ? { command, identity, current: () => probe.identity() === identity } : null
}

export function parseMajor(rule: VersionRule, output: string): number | null {
  const match = rule.output.exec(output)
  return match ? Number(match[1]) : null
}

export function nativeVersionProbe(rule: VersionRule, binary: () => string, environment?: NodeJS.ProcessEnv): NativeVersionProbe {
  // One attempt resolves one command. Previously identity() and read() resolved
  // independently, so a PATH/config change could cache B's answer under A's key.
  let selected: string | null | undefined
  const path = () => {
    if (selected === undefined) {
      const command = binary()
      selected = command.includes('/') ? resolve(command) : resolveBinaryOnPath(command)
    }
    return selected
  }
  return {
    command: path,
    identity: () => {
      const file = path()
      if (!file) return null
      try {
        const target = realpathSync(file), info = statSync(file, { bigint: true })
        if (!info.isFile()) return null
        return `${file}:${target}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
      } catch { return null }
    },
    read: () => new Promise<string>((done, failed) => {
      const file = path()
      if (!file) { failed(new Error('Native executable is unavailable')); return }
      const child = execFile(file, [...rule.args], {
        env: environment, encoding: 'utf8', timeout: rule.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      }, (error, stdout) => { if (error) failed(error); else done(stdout) })
      child.stdin?.end()
    }),
  }
}

/** Compatibility behavior: one answer per installed file; absent files have no cache key.
 * Whole-launch preparation replaces this legacy cache policy with its snapshot. */
const publishing = new WeakMap<Map<string, number | null>, Map<string, object>>()
export async function majorVersion(rule: VersionRule, probe: VersionProbe, memo: Map<string, number | null>): Promise<number | null> {
  const identity = probe.identity()
  if (identity !== null && memo.has(identity)) return memo.get(identity) ?? null
  const attempts = publishing.get(memo) ?? new Map<string, object>()
  publishing.set(memo, attempts)
  const ticket = {}
  if (identity !== null) attempts.set(identity, ticket)
  let major: number | null
  try { major = parseMajor(rule, await probe.read()) } catch { major = null }
  // An upgrade may replace the executable while --version is in flight. The
  // answer belongs only to the complete file identity inspected before spawning.
  const current = identity === probe.identity()
  if (identity !== null) {
    // A late failed read cannot erase a newer successful observation of this
    // file. The synchronous implementation could never overlap in this way.
    if (attempts.get(identity) !== ticket) return current ? major : null
    attempts.delete(identity)
    if (current) memo.set(identity, major)
  }
  if (!current) return null
  return major
}
