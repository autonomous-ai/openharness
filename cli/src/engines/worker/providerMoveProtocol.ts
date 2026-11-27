/** Private and bounded: core asks Codex's worker to fork a conversation for its new provider (#4145). */
import type { ProviderMoveAsk, ProviderMoved } from '../facets/providerMove.js'
import { boundedEnvironment, record } from './protocol.js'

export const PROVIDER_MOVE_VERSION = 1
export const PROVIDER_MOVE_CAPABILITIES = 'engine_provider_move_capabilities'
export const PROVIDER_MOVE = 'engine_provider_move'
/** Past the move's own bounds (engines/codex/providerMove.ts): four steps of up to 30 s each, the app-server's initialize, its
 *  model list, the catalog's instructions and the fork. A worker past it is recycled. */
export const PROVIDER_MOVE_WAIT_MS = 150_000
/** Retargets are rare and each is one person's: two at once, the rest refused rather than queued behind them. */
export const PROVIDER_MOVE_IN_FLIGHT = 2
export const PROVIDER_MOVE_QUEUED = 0
export const PROVIDER_MOVE_ENV_BYTES = 1024 * 1024
const PATH_CHARS = 32_768
const ARGS_MAX = 256
/** A conversation id, or the engine's reason in a line. */
export const PROVIDER_MOVE_REPLY_BYTES = 2 * 1024

const path = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= PATH_CHARS && !value.includes('\0')

export function providerMoveAsk(value: unknown): value is ProviderMoveAsk {
  if (!record(value)) return false
  const { sessionId, toGrid, args, command, env, cwd } = value
  const keys = Object.keys(value).length
  return keys === (cwd === undefined ? 5 : 6) && typeof sessionId === 'string' && !!sessionId && sessionId.length <= 200
    && typeof toGrid === 'boolean' && path(command) && (cwd === undefined || path(cwd))
    && Array.isArray(args) && args.length <= ARGS_MAX && args.every(arg => typeof arg === 'string' && arg.length <= PATH_CHARS && !arg.includes('\0'))
    && boundedEnvironment(env, PROVIDER_MOVE_ENV_BYTES)
}

export function providerMoved(value: unknown): value is ProviderMoved {
  if (!record(value) || Object.keys(value).length !== 1) return false
  if ('threadId' in value) return typeof value.threadId === 'string' && !!value.threadId && value.threadId.length <= 200
  return typeof value.refused === 'string' && value.refused.length <= 500
}
