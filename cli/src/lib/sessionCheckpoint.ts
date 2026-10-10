/** Disk checkpoints made only when closing a session, never by a resource sampler. */
import { constants, existsSync } from 'node:fs'
import { lstat, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { atomicWriteJson, engineKeepsTranscriptFile, type RegisteredSession } from './registry.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { nativeFileKey } from '../engines/kit/nativePaths.js'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { sqliteReadAll } from './sqliteRead.js'
import { hermesDbPath } from '../engines/hermes/contract.js'
import { findResumedTranscript } from './sessionRepair.js'

export class SessionCheckpointError extends Error {
  readonly code = 'HISTORY_NOT_SAVED'
}

/** Native SQLite files can have live WAL writers. Export this conversation's rows through a
 * read-only connection; never copy an incomplete .db or replace an engine's shared store. */
async function databaseHistory(s: RegisteredSession): Promise<Record<string, unknown>> {
  let database: string
  let selections: [string, string][]
  switch (s.engine) {
    case 'opencode': case 'kilo':
      database = s.engine === 'opencode' ? join(env.OPENCODE_DATA_DIR, 'opencode.db') : join(env.KILO_DATA_DIR, 'kilo.db')
      selections = [['session', 'id = ?'], ['message', 'session_id = ?'],
        ['part', 'message_id IN (SELECT id FROM message WHERE session_id = ?)']]
      break
    case 'hermes':
      database = hermesDbPath(s.hermesHome ?? env.HERMES_HOME)
      selections = [['sessions', 'id = ?'], ['messages', 'session_id = ?']]
      break
    case 'devin':
      database = join(env.DEVIN_HOME, 'sessions.db')
      selections = [['sessions', 'id = ?'], ['message_nodes', 'session_id = ?']]
      break
    default: throw new SessionCheckpointError('This engine has no supported history checkpoint yet. The session is still open.')
  }
  const tables: Record<string, unknown[]> = {}
  for (const [table, where] of selections) {
    const result = await sqliteReadAll(database, `SELECT * FROM ${table} WHERE ${where};`, [s.sessionId])
    if (!result.ok || (table === selections[0][0] && result.rows.length !== 1)) {
      throw new SessionCheckpointError('Could not read the saved conversation. The session has not been closed.')
    }
    tables[table] = result.rows
  }
  return { database, tables }
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

export class SessionCheckpointStore {
  constructor(private readonly directory = join(env.ADAPTER_DATA_DIR, 'session-checkpoints')) {}

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

  async save(s: RegisteredSession, options: { screen?: string | null } = {}): Promise<void> {
    secureStateDirectory(dirname(this.directory))
    secureStateDirectory(this.directory)
    const key = this.key(s)
    const manifest = join(this.directory, `${key}.json`)
    const file = `${key}-${randomUUID()}.history`
    const temporary = join(this.directory, `${file}.tmp`)
    const destination = join(this.directory, file)
    let committed = false
    let previous: Checkpoint | null = null
    try {
      try { previous = JSON.parse(readPrivateStateFile(manifest, 16384)) as Checkpoint } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      let source = s.transcriptPath ?? (s.engine === 'pi' && s.sessionId
        ? await findResumedTranscript('pi', s.sessionId, { cwd: s.cwd ?? undefined }) : null)
      const authority = s.sessionId && source && engineKeepsTranscriptFile(s.engine)
        ? controlTranscriptEvidence(s.engine, s.sessionId, source, s.codexHome ?? undefined, s.cwd) : undefined
      if (authority) source = authority.path
      const saveScreen = () => { if (options.screen != null && s.sessionId) {
        // Save even when the native transcript is unchanged: a newly typed draft
        // belongs to the terminal, not to that transcript. Never submit it.
        atomicWriteJson(join(this.directory, `${key}.screen.json`), { version: 1, agentId: s.agentId,
          sessionId: s.sessionId, savedAt: Date.now(), screen: options.screen })
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
          savedAt: checkpoint.savedAt, screen: options.screen })
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
        const history = await databaseHistory(s)
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { await handle.writeFile(JSON.stringify({ version: 1, sessionId: s.sessionId, engine: s.engine, ...history })) }
        finally { await handle.close() }
      }
      const handle = await open(temporary, constants.O_RDWR | constants.O_NOFOLLOW)
      try {
        const copied = await handle.stat()
        if (!copied.isFile() || copied.nlink !== 1) throw new Error('unsafe checkpoint')
        checkpoint.bytes = copied.size
        await handle.sync()
      } finally { await handle.close() }
      await rename(temporary, destination)
      authority?.verify()
      saveScreen()
      // Publish only after data is durable. A failed save keeps the preceding checkpoint intact.
      atomicWriteJson(manifest, checkpoint)
      committed = true
      if (previous?.file && previous.file !== file && previousFileSafe(previous.file)) {
        await rm(join(this.directory, previous.file), { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error instanceof SessionCheckpointError || (error as { code?: unknown } | null)?.code === 'IDENTITY_UNAVAILABLE') throw error
      throw new SessionCheckpointError('Could not back up this conversation to disk. Check free space and try again; its existing history is kept.')
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      if (!committed) await rm(destination, { force: true }).catch(() => {})
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
