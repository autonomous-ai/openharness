/** Disk checkpoints made only when closing a session, never by a resource sampler. */
import { constants, existsSync } from 'node:fs'
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { engineKeepsTranscriptFile, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { nativeFileKey } from '../engines/kit/nativePaths.js'
import { atomicWriteJson, readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { findResumedTranscript } from './sessionRepair.js'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'
import { databaseCheckpointEvidence, type DatabaseCheckpointProof } from './databaseCheckpoint.js'
import type { ExportStage, ExportReceipt, ExportOwnership, ExportSource } from '../engines/worker/storageProtocol.js'

export class SessionCheckpointError extends Error {
  readonly code = 'HISTORY_NOT_SAVED'
}


type Checkpoint = {
  version: 1
  agentId: string
  sessionId: string
  engine: string
  codexHome: string | null
  savedAt: number
  source: string | null
  sourceSize?: number
  sourceMtime?: number
  sourceInode?: number
  sourceKey?: string
  sourceCtime?: string
  file: string
  bytes: number
}

export interface CheckpointDeps {
  exportDatabase?(session: RegisteredSession, stage: ExportStage, ownership: ExportOwnership, source: ExportSource): Promise<ExportReceipt>
}
export class SessionCheckpointStore {
  private readonly stages: CheckpointStages
  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'session-checkpoints'), private readonly deps: CheckpointDeps = {}) {
    this.stages = new CheckpointStages(join(directory, '.stages'))
  }
  /** The core calls once before it accepts any close or purge. */
  prepare(): Promise<void> { return this.stages.prepare() }

  private key(s: RegisteredSession): string {
    return createHash('sha256').update(JSON.stringify([s.agentId, s.engine, s.codexHome ?? null, s.sessionId])).digest('hex')
  }

  /** Exact files for this conversation only; no workspace or directory removal. */
  deletionFiles(s: RegisteredSession): string[] {
    if (!existsSync(this.directory)) return []
    secureStateDirectory(this.directory, false)
    const key = this.key(s), manifest = join(this.directory, `${key}.json`)
    const files = [join(this.directory, `${key}.screen.json`)].filter(existsSync)
    if (!existsSync(manifest)) return files
    const saved = JSON.parse(readPrivateStateFile(manifest, 16384)) as Checkpoint
    if (saved.version !== 1 || saved.agentId !== s.agentId || saved.sessionId !== s.sessionId
      || saved.engine !== s.engine || !previousFileSafe(saved.file) || !saved.file.startsWith(key + '-')) {
      throw new Error('The saved checkpoint does not match this harness.')
    }
    const history = join(this.directory, saved.file)
    return [...files, ...(existsSync(history) ? [history] : []), manifest]
  }

  async save(s: RegisteredSession, options: { screen?: string | null; current?: () => boolean; databaseProof?: DatabaseCheckpointProof } = {}): Promise<void> {
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const key = this.key(s)
    const manifest = join(this.directory, `${key}.json`)
    const file = `${key}-${randomUUID()}.history`
    let temporary = join(this.directory, `${file}.tmp`)
    let stage: CheckpointStage | undefined
    let databaseStageRequested = false
    let databaseProof = options.databaseProof
    const current = () => {
      if (stage && performance.now() >= stage.deadline) throw Object.assign(new Error('checkpoint disk wait expired'), { code: 'CHECKPOINT_STAGE_TIMEOUT' })
      if (options.current?.() === false) throw new SessionCheckpointError('The session changed while saving. Its previous checkpoint is kept.')
      databaseProof?.verify()
    }
    const destination = join(this.directory, file)
    let committed = false
    let previous: Checkpoint | null = null
    try {
      current()
      try { previous = JSON.parse(readPrivateStateFile(manifest, 16384)) as Checkpoint } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      let source = s.transcriptPath ?? (s.engine === 'pi' && s.sessionId
        ? await findResumedTranscript('pi', s.sessionId, { cwd: s.cwd ?? undefined }) : null)
      const authority = s.sessionId && source && engineKeepsTranscriptFile(s.engine)
        ? controlTranscriptEvidence(s.engine, s.sessionId, source, s.codexHome ?? undefined, s.cwd) : undefined
      if (authority) source = authority.path
      const saveScreen = () => { current(); if (options.screen != null && s.sessionId) {
        // Save even when the native transcript is unchanged: a newly typed draft
        // belongs to the terminal, not to that transcript. Never submit it.
        atomicWriteJson(join(this.directory, `${key}.screen.json`), { version: 1, agentId: s.agentId,
          sessionId: s.sessionId, savedAt: Date.now(), screen: options.screen }, 'trust')
      } }
      const checkpoint: Checkpoint = { version: 1, agentId: s.agentId, sessionId: s.sessionId,
        engine: s.engine, codexHome: s.codexHome ?? null, savedAt: Date.now(), source: null, file, bytes: 0 }
      // Pi announces a session ID before it writes any history. In particular,
      // missing credentials can leave it here indefinitely. Preserve the screen
      // just as for an unbound chat; a known transcript, or one backed up before, must still save.
      // A resumed chat is not evidence of history: one stopped before its first reply resumes with an
      // ID, no path and no file, and refusing it left the window impossible to close.
      const unwrittenPi = s.engine === 'pi' && !source && !previous?.source
      if (!s.sessionId || s.engine === 'terminal' || unwrittenPi) {
        // A shell or unused chat has no native conversation. Save its terminal
        // instead; the close service owns the activity check and confirmation.
        if (options.screen == null) {
          if (previous?.version === 1 && previous.sessionId === s.sessionId && previousFileSafe(previous.file)
            && (await lstat(join(this.directory, previous.file)).catch(() => null))?.isFile()) return
          throw new SessionCheckpointError('Could not save this terminal before closing it. Keep it open and try again.')
        }
        atomicWriteJson(temporary, { version: 1, agentId: s.agentId, sessionId: s.sessionId, engine: s.engine, cwd: s.cwd,
          savedAt: checkpoint.savedAt, screen: options.screen }, 'trust')
      } else if (engineKeepsTranscriptFile(s.engine)) {
        if (!source) {
          throw new SessionCheckpointError('The conversation file is unavailable. The session has not been closed.')
        }
        // copyFile reopens a pathname in another thread. An ancestor could briefly
        // point elsewhere, copying B while both surrounding path checks still see A.
        // Read from the exact descriptor our native evidence confirms, with bounded memory.
        // A saved path may be a legitimate alias. The opened descriptor must match
        // the proven physical file before we copy a byte, including after ancestor swaps.
        const input = await open(source, constants.O_RDONLY | constants.O_NONBLOCK)
          .catch(() => { throw new IdentityReadUnavailable('the source transcript could not be opened') })
        let reuseCheckpoint = false
        try {
          let before = await input.stat({ bigint: true }).catch(() => { throw new IdentityReadUnavailable('the source transcript could not be inspected') })
          authority!.verify(nativeFileKey(before))
          if (!before.isFile() || !Number.isSafeInteger(Number(before.size))) throw new IdentityReadUnavailable('the source transcript has an unconfirmed type or size')
          if (before.size === 0n) throw new SessionCheckpointError('This conversation is still being saved. Keep it open and try again shortly.')
          const previousFile = previous?.file && previousFileSafe(previous.file)
            ? await lstat(join(this.directory, previous.file)).catch(() => null) : null
          before = await input.stat({ bigint: true }).catch(() => { throw new IdentityReadUnavailable('the source transcript became unreadable') })
          authority!.verify(nativeFileKey(before))
          // Older manifests did not bind a copied descriptor. Rebuild those once;
          // subsequent quiet exits can reuse this exact, completely saved incarnation.
          if (previous?.version === 1 && previous.source === source && previous.sourceKey === nativeFileKey(before)
            && previous.sourceSize === Number(before.size) && previous.sourceCtime === String(before.ctimeNs)
            && previousFile?.isFile() && previousFile.nlink === 1 && (previousFile.mode & 0o777) === 0o600
            && previousFile.size === Number(before.size)) {
            authority!.verify(nativeFileKey(before))
            reuseCheckpoint = true
          } else {
            await copyCheckpointDescriptor(input, temporary, Number(before.size))
            const after = await input.stat({ bigint: true }).catch(() => { throw new IdentityReadUnavailable('the source transcript became unreadable') })
            authority!.verify(nativeFileKey(after))
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
              throw new IdentityReadUnavailable('the conversation changed while saving; waiting for a stable copy')
            }
            Object.assign(checkpoint, { source, sourceSize: Number(after.size), sourceMtime: Number(after.mtimeMs),
              sourceInode: Number(after.ino), sourceKey: nativeFileKey(after), sourceCtime: String(after.ctimeNs) })
          }
        } finally { await input.close().catch(() => { throw new IdentityReadUnavailable('the source transcript could not be closed') }) }
        if (reuseCheckpoint) { authority!.verify(); saveScreen(); return }
      } else {
        databaseProof ??= await databaseCheckpointEvidence(s, () => { current(); return true })
        if (!databaseProof) throw new SessionCheckpointError('The conversation location is unavailable. The session has not been closed.')
        current()
        if (databaseProof.source === null) {
          if (s.engine !== 'openclaw' || previous) throw new SessionCheckpointError('The conversation location is unavailable. The session has not been closed.')
          saveScreen()
          return
        }
        if (!this.deps.exportDatabase) throw new SessionCheckpointError('Could not read the saved conversation. The session has not been closed.')
        databaseStageRequested = true
        stage = await this.stages.acquire()
        current()
        temporary = stage.stage.path
        const receipt = await this.deps.exportDatabase(s, stage.stage, stage, databaseProof.source).catch(() => {
          throw new SessionCheckpointError('Could not read the saved conversation. The session has not been closed.')
        })
        current()
        await stage.verify(receipt)
        if (receipt.empty) {
          if (s.engine !== 'openclaw' || previous) throw new SessionCheckpointError('Could not read the saved conversation. The session has not been closed.')
          saveScreen()
          return
        }
        checkpoint.bytes = receipt.bytes
      }
      if (stage) await stage.publish(destination, current)
      else {
        const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW)
        try {
          const copied = await handle.stat()
          if (!copied.isFile() || copied.nlink !== 1) throw new Error('unsafe checkpoint')
          checkpoint.bytes = copied.size
          await handle.sync()
        } finally { await handle.close() }
        current()
        await rename(temporary, destination)
      }
      current()
      authority?.verify()
      saveScreen()
      // Publish only after data is durable. A failed save keeps the preceding checkpoint intact.
      current()
      atomicWriteJson(manifest, checkpoint, 'trust')
      committed = true
      if (previous?.file && previous.file !== file && previousFileSafe(previous.file)) {
        await rm(join(this.directory, previous.file), { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error instanceof SessionCheckpointError || (error as { code?: unknown } | null)?.code === 'IDENTITY_UNAVAILABLE') throw error
      if ((error as { code?: unknown } | null)?.code === 'CHECKPOINT_STAGES_BUSY') {
        throw new SessionCheckpointError('History saving is held by unfinished operations. Stop and restart Harness; if it remains held, contact support. Its existing history is kept.')
      }
      if ((error as { code?: unknown } | null)?.code === 'CHECKPOINT_STAGE_PIN_UNAVAILABLE') {
        throw new SessionCheckpointError('History saving is unavailable on this filesystem. Its existing history is kept; check that the data folder supports hard links.')
      }
      if ((error as { code?: unknown } | null)?.code === 'CHECKPOINT_STAGE_TIMEOUT') {
        console.error('[checkpoint] STAGE_OPERATION_TIMEOUT')
        throw new SessionCheckpointError('History saving timed out while waiting for disk. Its existing history is kept; try again.')
      }
      throw new SessionCheckpointError('Could not back up this conversation to disk. Check free space and try again; its existing history is kept.')
    } finally {
      if (stage) await stage.close()
      else if (!databaseStageRequested) await rm(temporary, { force: true }).catch(() => {})
      if (!databaseStageRequested && !committed) await rm(destination, { force: true }).catch(() => {})
    }
  }
}

/** A finite snapshot length and one reusable chunk; no transcript-sized JS buffer. */
async function copyCheckpointDescriptor(input: FileHandle, path: string, size: number): Promise<void> {
  const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const buffer = Buffer.alloc(Math.min(size, 128 * 1024))
    let position = 0
    while (position < size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - position), position)
        .catch(() => { throw new IdentityReadUnavailable('the source transcript became unreadable') })
      if (!bytesRead) throw new IdentityReadUnavailable('the conversation changed while saving; waiting for a stable copy')
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written)
        if (!bytesWritten) throw new Error('checkpoint write made no progress')
        written += bytesWritten
      }
      position += bytesRead
    }
  } finally { await output.close() }
}

const previousFileSafe = (file: string): boolean => /^[a-f0-9]{64}-[a-f0-9-]{36}\.history$/.test(file)

export const sessionCheckpoints = new SessionCheckpointStore()
