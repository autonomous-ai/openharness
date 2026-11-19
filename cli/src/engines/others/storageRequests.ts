/** Vendor storage inspection runs here, never in the session-owning process. */
import { errorKind } from '../../lib/log.js'
import type { ServiceRequests } from '../../core/api.js'
import { randomUUID } from 'node:crypto'
import { env } from '../../config/env.js'
import { backgroundCount, storageSession, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  exportStage, exportSource, exportReceipt, storageLifetime, STORAGE_LIFETIME, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS, STORAGE_ENGINES, STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, type StorageSession, type StorageEngine } from '../worker/storageProtocol.js'
import { exportDatabase } from './checkpoint.js'

export async function hermesBackground(session: StorageSession): Promise<number | null> {
  const { hermesBackgroundCommands } = await import('../hermes/backgroundCommands.js')
  const { findHermesHomeForSession } = await import('../hermes/home.js')
  const home = session.hermesHome || await findHermesHomeForSession(session.sessionId).catch(() => null) || env.HERMES_HOME
  return hermesBackgroundCommands(home, session.sessionId)
}

export function otherStorageRequests(deps: { background?: typeof hermesBackground; export?: typeof exportDatabase; recycle?: () => void } = {}): ServiceRequests {
  const lifetime = { pid: process.pid, nonce: randomUUID() }
  let pending = 0
  const privateRequest = (payload: Record<string, unknown>, asker: { owner: boolean; local: boolean; connection?: string }) =>
    asker.owner && asker.local && asker.connection === undefined && payload.version === STORAGE_VERSION
      && (payload.requestId === undefined || (typeof payload.requestId === 'string' && payload.requestId.length <= 200))
  const read = (background: boolean): ServiceRequests[string] => async (payload, asker, closed) => {
    const failure = (error = 'ENGINE_UNAVAILABLE') => ({ version: STORAGE_VERSION, error })
    if (!privateRequest(payload, asker) || !storageSession(payload.session)
      || (background ? payload.engine !== 'hermes' : !STORAGE_ENGINES.includes(payload.engine as StorageEngine)
        || !exportStage(payload.stage) || !exportSource(payload.source) || !storageLifetime(payload.lifetime)
        || payload.lifetime.pid !== lifetime.pid || payload.lifetime.nonce !== lifetime.nonce)
      || Object.keys(payload).some(key => !(background ? ['version', 'engine', 'session', 'requestId']
        : ['version', 'engine', 'session', 'stage', 'source', 'lifetime', 'requestId']).includes(key))) return failure('ENGINE_INVALID_REQUEST')
    if (closed?.aborted) return failure()
    if (pending >= STORAGE_IN_FLIGHT) return failure('ENGINE_BUSY')
    pending++
    const waitMs = background ? STORAGE_BACKGROUND_WAIT_MS : STORAGE_EXPORT_WAIT_MS
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, abort: () => void = () => {}
    const deadline = performance.now() + waitMs
    const ended = new Promise<Record<string, unknown>>(resolve => {
      abort = () => { active = false; resolve(failure()) }
      closed?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { abort(); (deps.recycle ?? (() => process.exit(1)))() }, waitMs)
    })
    const work = Promise.resolve().then<unknown>(() => background
      ? (deps.background ?? hermesBackground)(payload.session as StorageSession)
      : (deps.export ?? exportDatabase)(payload.engine as StorageEngine, payload.session as StorageSession,
        payload.stage as never, payload.source as never, () => active && performance.now() < deadline))
      .then(answer => {
        if (!active) return failure()
        const valid = background ? backgroundCount(answer) : exportReceipt(answer)
        return valid && Buffer.byteLength(JSON.stringify(answer)) <= STORAGE_REPLY_BYTES
          ? { version: STORAGE_VERSION, answer } : failure('ENGINE_INVALID_REPLY')
      }, (caughtFailure) => { console.error(('[engine-others] STORAGE_READ_UNAVAILABLE') + ' · ' + errorKind(caughtFailure)); return failure() })
      .finally(() => { pending-- })
    try { return await Promise.race([work, ended]) }
    finally { active = false; clearTimeout(timer); closed?.removeEventListener('abort', abort) }
  }
  return {
    [STORAGE_BACKGROUND]: read(true),
    [STORAGE_EXPORT]: read(false),
    [STORAGE_CAPABILITIES]: (payload, asker) => {
      if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== STORAGE_VERSION
        || !STORAGE_ENGINES.includes(payload.engine as StorageEngine)) return { version: STORAGE_VERSION, error: 'ENGINE_INVALID_REQUEST' }
      return { version: STORAGE_VERSION, engine: payload.engine, storage: STORAGE_VERSION }
    },
    [STORAGE_LIFETIME]: (payload, asker) => {
      if (!asker.owner || !asker.local || asker.connection !== undefined || payload.version !== STORAGE_VERSION
        || !STORAGE_ENGINES.includes(payload.engine as StorageEngine)
        || Object.keys(payload).some(key => !['version', 'engine', 'requestId'].includes(key))) return { version: STORAGE_VERSION, error: 'ENGINE_INVALID_REQUEST' }
      return { version: STORAGE_VERSION, answer: lifetime }
    },
  }
}
