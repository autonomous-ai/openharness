import type { ServiceRequests } from '../../core/api.js'
import type { MoveProvider } from '../facets/providerMove.js'
import { providerMoveAsk, providerMoved, PROVIDER_MOVE, PROVIDER_MOVE_CAPABILITIES, PROVIDER_MOVE_IN_FLIGHT, PROVIDER_MOVE_REPLY_BYTES,
  PROVIDER_MOVE_VERSION, PROVIDER_MOVE_WAIT_MS } from './providerMoveProtocol.js'
import { snapshotRequests } from './snapshotRequests.js'

export interface ProviderMoveRequestDeps { load?: () => Promise<MoveProvider>; recycle?: () => void }

const FIELDS = ['sessionId', 'toGrid', 'args', 'command', 'env', 'cwd'] as const

/** Codex's worker forks a conversation for its new provider; when to move, and the relaunch, are core's. */
export function engineProviderMoveRequests(deps: ProviderMoveRequestDeps = {}): ServiceRequests {
  const askOf = (payload: Record<string, unknown>) => Object.fromEntries(FIELDS.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]))
  return snapshotRequests<MoveProvider>({
    engine: 'codex', version: PROVIDER_MOVE_VERSION, capabilities: PROVIDER_MOVE_CAPABILITIES, capability: 'providerMove',
    inFlight: PROVIDER_MOVE_IN_FLIGHT, waitMs: PROVIDER_MOVE_WAIT_MS, replyBytes: PROVIDER_MOVE_REPLY_BYTES,
    load: deps.load ?? (async () => (await import('../providerMoves.js')).providerMoveFor('codex')!),
    recycle: () => (deps.recycle ?? (() => process.exit(1)))(),
    methods: {
      [PROVIDER_MOVE]: {
        fields: FIELDS, accepts: payload => providerMoveAsk(askOf(payload)),
        answer: (move, payload) => move(askOf(payload) as never),
        valid: answer => providerMoved(answer),
      },
    },
  })
}
