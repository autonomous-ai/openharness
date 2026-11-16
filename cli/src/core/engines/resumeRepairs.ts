/** Core keeps publication authority and transcript ordering; the worker only stages private files. */
import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { controlTranscriptEvidence } from '../../engines/transcriptBindings.js'
import { NativeFiles } from '../../engines/kit/nativeFiles.js'
import { verifyNativePathFacts } from '../../engines/kit/nativePaths.js'
import { launchContract } from '../../engines/launches.js'
import { REPAIR_LIMITS, ResumePreparationError, type HistoryRepair, type ResumeSource } from '../../engines/facets/resumeRepair.js'
import { repairAnswer, repairDirectory, repairFile, repairPath, repairSource, sameRepairFile,
  RESUME_REPAIR_CAPABILITIES, RESUME_REPAIR_LOCATE, RESUME_REPAIR_PREPARE, RESUME_REPAIR_RELEASE,
  RESUME_REPAIR_REPLY_BYTES, RESUME_REPAIR_VERSION, RESUME_REPAIR_WAIT_MS, type RepairAnswer } from '../../engines/worker/resumeRepairProtocol.js'
import { record } from '../../engines/worker/protocol.js'
import type { TailHold } from '../../watcher/watcher.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'
import { boundedControl } from './controlTransport.js'

export interface ResumeRepairsDeps extends SnapshotTransportDeps {
  handles(engine: string): boolean
  /** Explicit inline/older-master compatibility, reviewed for removal 2026-12-15. Never a worker fallback. */
  inline?: (source: ResumeSource, current: () => boolean) => Promise<HistoryRepair>
  hold(sessionId: string, file: string, timeoutMs: number): Promise<TailHold | null>
  setTail(sessionId: string, offset: number): void
}
const unavailable = (): HistoryRepair => ({ repairedItems: 0, unrepaired: 'unavailable' })
const failure = (answer: RepairAnswer): HistoryRepair | null => {
  if ('refused' in answer) throw new ResumePreparationError(answer.refused, `Resume history preparation refused (${answer.refused})`)
  return 'directoryKey' in answer ? null : answer
}

export function createResumeRepairs(deps: ResumeRepairsDeps) {
  const transport = createSnapshotTransport(deps, { version: RESUME_REPAIR_VERSION, capabilities: RESUME_REPAIR_CAPABILITIES,
    capability: 'resumeRepair', inFlight: 2, queued: 0, waitMs: RESUME_REPAIR_WAIT_MS, replyBytes: RESUME_REPAIR_REPLY_BYTES })
  let generation = 0
  const active = new Set<string>()
  return {
    connected(service: string): void { if (service === 'engine-codex') generation++; transport.connected(service) },
    disconnected(service: string): void { if (service === 'engine-codex') generation++; transport.disconnected(service) },
    async prepare(source: ResumeSource, current: () => boolean): Promise<HistoryRepair> {
      if (source.engine !== 'codex' || !source.sessionId) return { repairedItems: 0 }
      if (!deps.handles(source.engine)) {
        const answer = await deps.inline?.(source, current) ?? unavailable()
        if (answer.repairedBytes !== undefined) deps.setTail(source.sessionId, answer.repairedBytes)
        return answer
      }
      source = { engine: source.engine, sessionId: source.sessionId, transcriptPath: source.transcriptPath, codexHome: source.codexHome }
      if (!repairSource(source)) return unavailable()
      if (active.size >= 2 || active.has(source.sessionId)) return { repairedItems: 0, unrepaired: 'busy' }
      active.add(source.sessionId)
      const token = randomUUID(), expires = Date.now() + RESUME_REPAIR_WAIT_MS, deadline = performance.now() + RESUME_REPAIR_WAIT_MS
      let expectedGeneration = generation, file: string | undefined, hold: TailHold | null = null
      let asked = false, settled = false
      const remaining = () => Math.max(1, Math.min(expires - Date.now(), deadline - performance.now()))
      const allowed = () => current() && generation === expectedGeneration && Date.now() < expires && performance.now() < deadline && !hold?.expired
      const bounded = <T>(work: Promise<T>): Promise<T> => boundedControl(work, remaining(), () => new Error('RESUME_REPAIR_UNAVAILABLE'))
      try {
        if (!current()) return { repairedItems: 0, unrepaired: 'cancelled' }
        const located = await transport.read('codex', RESUME_REPAIR_LOCATE, { source }, value =>
          record(value) && Object.keys(value).length === 1 && (value.file === null || repairPath(value.file)) || repairAnswer(value)) as { file: string | null } | RepairAnswer
        // Initial on-demand worker startup is admitted by snapshotTransport; subsequent changes revoke publication.
        expectedGeneration = generation
        if (!allowed()) return { repairedItems: 0, unrepaired: 'cancelled' }
        if (!('file' in located)) return failure(located) ?? unavailable()
        if (!located.file) return { repairedItems: 0 }
        const proof = controlTranscriptEvidence('codex', source.sessionId, located.file, source.codexHome ?? undefined, undefined, 'candidate-only')
        const paths = new NativeFiles(), location = paths.locate(proof.path)!
        const route = paths.paths.snapshot()
        file = location.path
        if (lstatSync(proof.path).isSymbolicLink()) return unavailable()
        if (location.info.size > BigInt(REPAIR_LIMITS.maxBytes)) return { repairedItems: 0, unrepaired: 'too_large' }
        const original = repairFile(location.info)
        proof.verify(original.key)
        asked = true
        const answer = await bounded(transport.read('codex', RESUME_REPAIR_PREPARE, { preparation: { source, token, file, original, expires } }, repairAnswer)) as RepairAnswer
        if (!allowed()) return { repairedItems: 0, unrepaired: 'cancelled' }
        if (!('directoryKey' in answer)) return failure(answer)!
        hold = await bounded(deps.hold(source.sessionId, proof.path, remaining()).then(value => {
          if (settled) value?.release()
          return value
        }))
        if (!allowed()) return { repairedItems: 0, unrepaired: 'cancelled' }
        const directory = repairDirectory(file, token), staged = new NativeFiles(), parent = staged.locate(directory)!
        const backup = staged.locate(join(directory, 'backup'))!, history = staged.locate(join(directory, 'history'))!
        const privateFile = (entry: typeof backup) => entry.info.isFile() && !entry.info.isSymbolicLink() && entry.info.nlink === 1n
          && (process.platform === 'win32' || (entry.info.mode & 0o077n) === 0n)
          && (typeof process.getuid !== 'function' || entry.info.uid === BigInt(process.getuid()))
        if (parent.path !== directory || backup.path !== join(directory, 'backup') || history.path !== join(directory, 'history')
          || !parent.info.isDirectory() || parent.info.isSymbolicLink() || repairFile(parent.info).key !== answer.directoryKey
          || process.platform !== 'win32' && (parent.info.mode & 0o077n) !== 0n
          || typeof process.getuid === 'function' && parent.info.uid !== BigInt(process.getuid())
          || !privateFile(backup) || !privateFile(history) || !sameRepairFile(repairFile(backup.info), answer.backup)
          || !sameRepairFile(repairFile(history.info), answer.history) || answer.backup.size !== original.size
          || answer.repairedItems > original.size) return unavailable()
        proof.verify(original.key); verifyNativePathFacts(route); staged.verify()
        if (!sameRepairFile(repairFile(lstatSync(file, { bigint: true })), original)) return unavailable()
        if (!allowed()) return { repairedItems: 0, unrepaired: 'cancelled' }
        const backupPath = `${file}${launchContract('codex')!.resumeRepair!.backup}${token}`
        // A cleanup may remove private names concurrently. A hard link never overwrites a previous backup, and
        // cleanup can never remove this published name. Rename failure leaves the original and backup complete.
        linkSync(backup.path, backupPath)
        if (!allowed()) return { repairedItems: 0, unrepaired: 'cancelled' }
        // The history it replaces keeps a private name, so the rename never drops its last link here: the kernel freed a
        // 200 MB rollout's pages on the core loop, past 50 ms on a shared runner (#4330). The worker's cleanup frees it.
        linkSync(file, join(directory, 'original'))
        renameSync(history.path, file)
        deps.setTail(source.sessionId, answer.repairedBytes)
        return { repairedItems: answer.repairedItems, repairedBytes: answer.repairedBytes, backupPath }
      } catch (error) {
        if (error instanceof ResumePreparationError) throw error
        return unavailable()
      } finally {
        settled = true
        hold?.release()
        active.delete(source.sessionId)
        // A lost acknowledgement is harmless: the worker expires its bounded private inventory.
        if (asked) void deps.call('engine-codex', RESUME_REPAIR_RELEASE, { version: RESUME_REPAIR_VERSION, token }, 1000).catch(() => {})
      }
    },
  }
}
