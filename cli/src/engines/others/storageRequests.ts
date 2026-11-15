/** Vendor storage inspection runs here, never in the session-owning process. */
import type { ServiceRequests } from '../../core/api.js'
import { env } from '../../config/env.js'
import { snapshotRequests } from '../worker/snapshotRequests.js'
import { backgroundCount, storageSession, STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES,
  STORAGE_IN_FLIGHT, STORAGE_REPLY_BYTES, STORAGE_VERSION, type StorageSession } from '../worker/storageProtocol.js'

export async function hermesBackground(session: StorageSession): Promise<number | null> {
  const { hermesBackgroundCommands } = await import('../hermes/backgroundCommands.js')
  const { findHermesHomeForSession } = await import('../hermes/home.js')
  const home = session.hermesHome || await findHermesHomeForSession(session.sessionId).catch(() => null) || env.HERMES_HOME
  return hermesBackgroundCommands(home, session.sessionId)
}

export function otherStorageRequests(deps: { background?: typeof hermesBackground; recycle?: () => void } = {}): ServiceRequests {
  const requests = snapshotRequests({
    engine: 'hermes', version: STORAGE_VERSION, capabilities: STORAGE_CAPABILITIES, capability: 'storage',
    inFlight: STORAGE_IN_FLIGHT, waitMs: STORAGE_BACKGROUND_WAIT_MS, replyBytes: STORAGE_REPLY_BYTES,
    load: async () => deps.background ?? hermesBackground, recycle: deps.recycle ?? (() => process.exit(1)),
    methods: { [STORAGE_BACKGROUND]: { fields: ['session'], accepts: payload => storageSession(payload.session),
      answer: (read, payload) => read(payload.session as StorageSession), valid: backgroundCount } },
  })
  return Object.fromEntries(Object.entries(requests).map(([method, handler]) => [method, (payload, asker, closed) => {
    const { engine, ...snapshot } = payload
    if (engine !== 'hermes') return { version: STORAGE_VERSION, error: 'ENGINE_INVALID_REQUEST' }
    return handler(snapshot, asker, closed)
  }]))
}
