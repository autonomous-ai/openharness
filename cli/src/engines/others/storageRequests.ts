/** Vendor storage inspection runs here, never in the session-owning process. */
import { access } from 'node:fs/promises'
import { openclawSessionLocation, openclawStateDir } from '../../lib/openclawStore.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { errorKind } from '../../lib/log.js'
import type { ServiceRequests } from '../../core/api.js'
import { randomUUID } from 'node:crypto'
import { env } from '../../config/env.js'
import { backgroundCount, storageSession, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  STORAGE_USER_ROW_SINCE, STORAGE_USER_ROW_WAIT_MS, storageTimeRange, userRowAnswer,
  STORAGE_COMPARE, savedCheckpoint,
  exportStage, exportSource, exportReceipt, storageLifetime, STORAGE_LIFETIME, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS, STORAGE_ENGINES, STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, type StorageSession, type StorageEngine } from '../worker/storageProtocol.js'
import { compareDatabase, exportDatabase } from './checkpoint.js'

export async function hermesBackground(session: StorageSession): Promise<number | null> {
  const { hermesBackgroundCommands } = await import('../hermes/backgroundCommands.js')
  const { findHermesHomeForSession } = await import('../hermes/home.js')
  const home = session.hermesHome || await findHermesHomeForSession(session.sessionId).catch(() => null) || env.HERMES_HOME
  return hermesBackgroundCommands(home, session.sessionId)
}

const USER_ROW_SINCE = `SELECT 1 FROM transcript_events WHERE message_role = 'user' AND created_at > ? AND created_at <= ?
  AND session_id IN (SELECT session_id FROM session_windows WHERE session_key = ?) LIMIT 1;`

/** Unknown location or read failure supplies no evidence that a first task was taken, or that a close is empty. */
export async function openclawUserRowSince(
  key: string, pane: { pid: number; stateDir?: string | null }, since: number,
  openFiles?: (pid: number) => Promise<string[]>, until = Number.MAX_SAFE_INTEGER,
): Promise<boolean | null> {
  if (!storageTimeRange(since, until)) return null
  try {
    const held = pane.stateDir || await openclawStateDir(pane.pid, openFiles)
    if (!held) return null
    const location = await openclawSessionLocation(key, { pid: pane.pid, stateDir: held })
    if (!location) return null
    location.verify()
    try { await access(location.path) } catch (error) {
      location.verify()
      // Permissions and I/O failures cannot prove an empty conversation.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
    location.verify()
    const read = await sqliteReadAll(location.path, USER_ROW_SINCE, [since, until, key],
      { timeoutMs: 1_000, busyTimeoutMs: 250, maxBuffer: 1024 })
    location.verify()
    return read.ok ? read.rows.length > 0 : null
  } catch (error) {
    console.error('[engine-others] STORAGE_USER_ROW_UNAVAILABLE · ' + errorKind(error))
    return null
  }
}

export function openclawUserRows(session: StorageSession, since: number, until: number): Promise<boolean | null> {
  return openclawUserRowSince(session.sessionId, { pid: session.pid ?? 0, stateDir: session.openclawStateDir }, since, undefined, until)
}

export function otherStorageRequests(deps: { background?: typeof hermesBackground; userRowSince?: typeof openclawUserRows; export?: typeof exportDatabase; compare?: typeof compareDatabase; recycle?: () => void } = {}): ServiceRequests {
  const lifetime = { pid: process.pid, nonce: randomUUID() }
  let pending = 0
  const privateRequest = (payload: Record<string, unknown>, asker: { owner: boolean; local: boolean; connection?: string }) =>
    asker.owner && asker.local && asker.connection === undefined && payload.version === STORAGE_VERSION
      && (payload.requestId === undefined || (typeof payload.requestId === 'string' && payload.requestId.length <= 200))
  const read = (kind: 'background' | 'export' | 'compare' | 'userRow'): ServiceRequests[string] => async (payload, asker, closed) => {
    const background = kind === 'background', userRow = kind === 'userRow', compare = kind === 'compare'
    const failure = (error = 'ENGINE_UNAVAILABLE') => ({ version: STORAGE_VERSION, error })
    if (!privateRequest(payload, asker) || !storageSession(payload.session)
      || (background ? payload.engine !== 'hermes' : userRow ? payload.engine !== 'openclaw' || !storageTimeRange(payload.since, payload.until) : !STORAGE_ENGINES.includes(payload.engine as StorageEngine)
        || !exportSource(payload.source) || (compare ? !savedCheckpoint(payload.checkpoint)
          : !exportStage(payload.stage) || !storageLifetime(payload.lifetime)
            || payload.lifetime.pid !== lifetime.pid || payload.lifetime.nonce !== lifetime.nonce))
      || Object.keys(payload).some(key => !(background ? ['version', 'engine', 'session', 'requestId']
        : userRow ? ['version', 'engine', 'session', 'since', 'until', 'requestId']
        : compare ? ['version', 'engine', 'session', 'checkpoint', 'source', 'requestId']
        : ['version', 'engine', 'session', 'stage', 'source', 'lifetime', 'requestId']).includes(key))) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure()
    if (pending >= STORAGE_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending++
    const waitMs = background ? STORAGE_BACKGROUND_WAIT_MS : userRow ? STORAGE_USER_ROW_WAIT_MS : STORAGE_EXPORT_WAIT_MS
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {}
    const deadline = performance.now() + waitMs
    const ended = new Promise<Record<string, unknown>>(resolve => {
      abort = () => { active = false; resolve(failure()) }
      closed?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { abort(); (deps.recycle ?? (() => process.exit(1)))() }, waitMs)
    })
    const work = Promise.resolve().then<unknown>(() => background
      ? (deps.background ?? hermesBackground)(payload.session as StorageSession)
      : userRow ? (deps.userRowSince ?? openclawUserRows)(payload.session as StorageSession, payload.since as number, payload.until as number)
      : compare ? (deps.compare ?? compareDatabase)(payload.engine as StorageEngine, payload.session as StorageSession,
        payload.checkpoint as never, payload.source as never, () => active && performance.now() < deadline)
      : (deps.export ?? exportDatabase)(payload.engine as StorageEngine, payload.session as StorageSession,
        payload.stage as never, payload.source as never, () => active && performance.now() < deadline))
      .then(answer => {
        if (!active) return failure()
        if (compare && answer === null) console.error('[engine-others] STORAGE_COMPARE_UNAVAILABLE')
        const valid = background ? backgroundCount(answer) : userRow || compare ? userRowAnswer(answer) : exportReceipt(answer)
        return valid && Buffer.byteLength(JSON.stringify(answer)) <= STORAGE_REPLY_BYTES
          ? { version: STORAGE_VERSION, answer } : failure('ENGINE_INVALID_REPLY')
      }, (caughtFailure) => { console.error(('[engine-others] STORAGE_READ_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)); return failure() })
      .finally(() => { pending-- })
    try { return await Promise.race([work, ended]) }
    finally { active = false; clearTimeout(timer); closed?.removeEventListener('abort', abort) }
  }
  return {
    [STORAGE_BACKGROUND]: read('background'),
    [STORAGE_EXPORT]: read('export'),
    [STORAGE_COMPARE]: read('compare'),
    [STORAGE_USER_ROW_SINCE]: read('userRow'),
    [STORAGE_CAPABILITIES]: (payload, asker) => {
      if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== STORAGE_VERSION
        || !STORAGE_ENGINES.includes(payload.engine as StorageEngine)) return { version: STORAGE_VERSION, error: 'ENGINE_INVALID_REQUEST' }
      return { version: STORAGE_VERSION, engine: payload.engine, storage: STORAGE_VERSION, storageCompare: STORAGE_VERSION }
    },
    [STORAGE_LIFETIME]: (payload, asker) => {
      if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== STORAGE_VERSION
        || !STORAGE_ENGINES.includes(payload.engine as StorageEngine)
        || Object.keys(payload).some(key => !['version', 'engine', 'requestId'].includes(key))) return { version: STORAGE_VERSION, error: 'ENGINE_INVALID_REQUEST' }
      return { version: STORAGE_VERSION, answer: lifetime }
    },
  }
}
