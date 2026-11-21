/** Native executable facts used by launch control, without loading an interpreter. */
import { execFile } from 'node:child_process'
import { executableIdentity } from './nativeExecutable.js'
import { resolve } from 'node:path'
import { resolveBinaryOnPath } from '../../lib/binaryOnPath.js'
import { windowsEngineArgv } from '../../lib/windows/launch.js'

import { parseMajor, type VersionRule, type VersionProbe, type NativeVersionProbe } from './versionData.js'
export { executableSnapshot, parseMajor, parseRelease, releaseAtLeast } from './versionData.js'
export type { VersionRule, VersionProbe, NativeVersionProbe, NativeExecutableSnapshot, Release } from './versionData.js'

export function nativeVersionProbe(rule: VersionRule, binary: () => string, environment?: NodeJS.ProcessEnv, execute: typeof execFile = execFile): NativeVersionProbe {
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
      return executableIdentity(file)
    },
    read: () => new Promise<string>((done, failed) => {
      const file = path()
      if (!file) { failed(new Error('Native executable is unavailable')); return }
      let argv: string[]
      // Windows: an npm shim's script under node, never the shim through cmd.exe (lib/windows/launch.ts).
      try { argv = windowsEngineArgv('the engine', [file, ...rule.args], { environment: environment ?? process.env }) } catch (error) { failed(error); return }
      const child = execute(argv[0]!, argv.slice(1), {
        env: environment, encoding: 'utf8', timeout: rule.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true,
      }, (error, stdout) => { if (error) failed(error); else done(stdout) })
      child.stdin?.end()
    }),
  }
}

/** Compatibility behavior: one answer per installed file; absent files have no cache key.
 * Whole-launch preparation replaces this legacy cache policy with its snapshot. */
const publishing = new WeakMap<Map<string, unknown>, Map<string, object>>()
export async function probedVersion<T>(read: (output: string) => T | null, probe: VersionProbe, memo: Map<string, T | null>): Promise<T | null> {
  const identity = probe.identity()
  if (identity !== null && memo.has(identity)) return memo.get(identity) ?? null
  const attempts = publishing.get(memo) ?? new Map<string, object>()
  publishing.set(memo, attempts)
  const ticket = {}
  if (identity !== null) attempts.set(identity, ticket)
  let version: T | null
  try { version = read(await probe.read()) } catch { version = null }
  // An upgrade may replace the executable while --version is in flight. The
  // answer belongs only to the complete file identity inspected before spawning.
  const current = identity === probe.identity()
  if (identity !== null) {
    // A late failed read cannot erase a newer successful observation of this
    // file. The synchronous implementation could never overlap in this way.
    if (attempts.get(identity) !== ticket) return current ? version : null
    attempts.delete(identity)
    if (current) memo.set(identity, version)
  }
  if (!current) return null
  return version
}

export function majorVersion(rule: VersionRule, probe: VersionProbe, memo: Map<string, number | null>): Promise<number | null> {
  return probedVersion(output => parseMajor(rule, output), probe, memo)
}
