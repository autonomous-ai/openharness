/** Select executable hook code only when a launch prepares it. Importing core
 * must not depend on a generated artifact, and an old hook cannot stand in for
 * the durable protocol just because its filename is notify.mjs. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { HookPreparationHeld, type HookPreparationProof } from './nativeHookFiles.js'
import { NativePaths, verifyNativePathFacts } from './nativePaths.js'

// This is the settings proof's serialized version, also checked by the guard
// after login rc files. Artifact dependencies never become write destinations.
const version = (info: BigIntStats) => `${info.dev}:${info.ino}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
const held = (reason: string): never => { throw new HookPreparationHeld(`the native hook artifact ${reason}`) }

export function prepareNativeHookArtifact(moduleUrl: string, entryPath = process.argv[1], platform = process.platform, rearmWitness: boolean | 'allocation' = false): {
  path: string; verify(): void; proof: HookPreparationProof
} {
  const directory = dirname(fileURLToPath(moduleUrl))
  const candidates = [...new Set([
    join(directory, 'notify.mjs'),
    ...(entryPath ? [join(dirname(entryPath), 'notify.mjs')] : []),
    join(directory, '..', '..', 'notify.mjs'),
    join(directory, '..', '..', '..', 'dist', 'notify.mjs'),
  ])]
  for (const file of candidates) {
    const paths = new NativePaths(new NativeEvidenceBudget())
    let located
    try { located = paths.resolveSync(file, true) } catch { return held('route cannot be confirmed') }
    if (!located) continue
    const target = located.path, facts = paths.snapshot()
    let stamp: string, fd: number | undefined
    try {
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const info = fstatSync(fd, { bigint: true })
      if (!info.isFile() || info.size > 4 * 1024 * 1024 || (info.mode & 0o022n) !== 0n
        || info.dev !== located.info.dev || info.ino !== located.info.ino) return held('is not a bounded read-only dependency')
      stamp = version(info)
      const bytes = Buffer.alloc(256), size = readSync(fd, bytes, 0, bytes.length, 0)
      const prefix = bytes.subarray(0, size)
      let end = 0
      for (let line = 0; line < 3; line++) {
        end = prefix.indexOf(10, end) + 1
        if (!end) return held('has an incomplete protocol header')
      }
      const header = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(prefix.subarray(0, end))
      const declaration = /^#![^\n]+\n\/\/ harness-native-hook-protocol:1\n\/\/ harness-native-hook-darwin:([01])\n$/.exec(header)
      if (!declaration) {
        return held('does not support the required delivery protocol; rebuild or update the CLI')
      }
      if (rearmWitness && !prefix.subarray(end).toString('utf8').startsWith('// harness-native-rearm-witness:1\n')) {
        return held('does not support the required relaunch witness; rebuild or update the CLI')
      }
      if (rearmWitness === 'allocation' && !prefix.subarray(end).toString('utf8')
        .startsWith('// harness-native-rearm-witness:1\n// harness-native-pane-witness:1\n')) {
        return held('does not support the required pane witness; rebuild or update the CLI')
      }
      if (platform === 'darwin' && declaration[1] !== '1') {
        return held('has no pinned macOS process helper; rebuild with the process-image artifact')
      }
      if (platform !== 'linux' && platform !== 'darwin') return held('does not support this platform')
      if (version(fstatSync(fd, { bigint: true })) !== stamp) return held('changed during inspection')
    } catch (error) {
      if (error instanceof HookPreparationHeld) throw error
      return held('could not be read')
    } finally { if (fd !== undefined) closeSync(fd) }
    const verify = () => {
      try {
        verifyNativePathFacts(facts)
        if (version(lstatSync(target, { bigint: true })) !== stamp) return held('changed after preparation')
      } catch (error) {
        if (error instanceof HookPreparationHeld) throw error
        return held('route changed after preparation')
      }
    }
    verify()
    const proof: HookPreparationProof = {
      files: [{ file, target, stamp, facts }],
      current: () => { try { verify(); return true } catch { return false } },
    }
    return { path: file, verify, proof }
  }
  return held('is missing; build or update the CLI before starting this agent')
}
