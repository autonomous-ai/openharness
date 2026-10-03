/** Disk checkpoints made only when closing a session, never by a resource sampler. */
import { constants, existsSync } from 'node:fs'
import { chmod, copyFile, lstat, open, rename, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { atomicWriteJson, engineKeepsTranscriptFile, validTranscriptPath, type RegisteredSession } from './registry.js'
import { readPrivateStateFile, secureStateDirectory } from './secureState.js'
import { sqliteReadAll } from './sqliteRead.js'
import { hermesDbPath } from '../engines/hermes/home.js'

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
      if (options.screen != null && s.sessionId) {
        // Save even when the native transcript is unchanged: a newly typed draft
        // belongs to the terminal, not to that transcript. Never submit it.
        atomicWriteJson(join(this.directory, `${key}.screen.json`), { version: 1, agentId: s.agentId,
          sessionId: s.sessionId, savedAt: Date.now(), screen: options.screen })
      }
      const checkpoint: Checkpoint = { version: 1, agentId: s.agentId, sessionId: s.sessionId,
        engine: s.engine, codexHome: s.codexHome ?? null, savedAt: Date.now(), source: null, file, bytes: 0 }
      if (!s.sessionId || s.engine === 'terminal') {
        // A shell or unused chat has no native conversation. Save its terminal
        // instead; the close service owns the activity check and confirmation.
        if (options.screen == null) {
          if (previous?.version === 1 && previous.sessionId === s.sessionId && previousFileSafe(previous.file)
            && (await lstat(join(this.directory, previous.file)).catch(() => null))?.isFile()) return
          throw new SessionCheckpointError('Could not save this terminal before closing it. Keep it open and try again.')
        }
        atomicWriteJson(temporary, { version: 1, agentId: s.agentId, engine: s.engine, cwd: s.cwd,
          savedAt: checkpoint.savedAt, screen: options.screen })
      } else if (engineKeepsTranscriptFile(s.engine)) {
        const source = s.transcriptPath
        if (!source || !validTranscriptPath(s.engine, source, s.codexHome ?? undefined)) {
          throw new SessionCheckpointError('The conversation file is unavailable. The session has not been closed.')
        }
        const before = await stat(source)
        if (before.size === 0) throw new SessionCheckpointError('This conversation is still being saved. Keep it open and try again shortly.')
        const previousFile = previous?.file && previousFileSafe(previous.file)
          ? await lstat(join(this.directory, previous.file)).catch(() => null) : null
        // A second checkpoint after a quiet exit need not copy the same history twice.
        if (previous?.version === 1 && previous.source === source && previous.sourceInode === before.ino
          && previous.sourceSize === before.size && previous.sourceMtime === before.mtimeMs
          && previousFile?.isFile() && previousFile.nlink === 1 && (previousFile.mode & 0o777) === 0o600
          && previousFile.size === before.size) return
        // APFS/reflink when available, ordinary file copy otherwise. No transcript-sized JS buffer.
        await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
        await chmod(temporary, 0o600)
        const after = await stat(source)
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          throw new SessionCheckpointError('The conversation changed while saving. Please try closing it again.')
        }
        Object.assign(checkpoint, { source, sourceSize: after.size, sourceMtime: after.mtimeMs, sourceInode: after.ino })
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
      // Publish only after data is durable. A failed save keeps the preceding checkpoint intact.
      atomicWriteJson(manifest, checkpoint)
      committed = true
      if (previous?.file && previous.file !== file && previousFileSafe(previous.file)) {
        await rm(join(this.directory, previous.file), { force: true }).catch(() => {})
      }
    } catch (error) {
      if (error instanceof SessionCheckpointError) throw error
      throw new SessionCheckpointError('Could not back up this conversation to disk. Check free space and try again; its existing history is kept.')
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      if (!committed) await rm(destination, { force: true }).catch(() => {})
    }
  }
}

const previousFileSafe = (file: string): boolean => /^[a-f0-9]{64}-[a-f0-9-]{36}\.history$/.test(file)

export const sessionCheckpoints = new SessionCheckpointStore()
