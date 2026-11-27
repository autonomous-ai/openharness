/**
 * Core's side of moving a conversation between a grid and the own login (#4145): Codex forks it, starting with instructions
 * that fit its new provider, in its supervised worker, which spawns `codex app-server` for it. Core decides when, and resumes
 * the fork; a move that fails or cannot be asked throws, and the retarget continues in a plain fork (lib/restartAgent.ts).
 */
import type { MoveConversation, MoveProvider, ProviderMoveAsk, ProviderMoved } from '../../engines/facets/providerMove.js'
import { providerMoveAsk, providerMoved, PROVIDER_MOVE, PROVIDER_MOVE_CAPABILITIES, PROVIDER_MOVE_IN_FLIGHT, PROVIDER_MOVE_QUEUED,
  PROVIDER_MOVE_REPLY_BYTES, PROVIDER_MOVE_VERSION, PROVIDER_MOVE_WAIT_MS } from '../../engines/worker/providerMoveProtocol.js'
import { EngineReadError, setEnvironment } from '../../engines/worker/protocol.js'
import { createSnapshotTransport, type SnapshotTransportDeps } from './snapshotTransport.js'

export interface ProviderMovesDeps extends SnapshotTransportDeps {
  /** The engine's move runs in its supervised worker. */
  handles(engine: string): boolean
  /** Explicit inline mode and older masters only; a failed worker never selects it. */
  inline(engine: string): MoveProvider | undefined
}

export function createProviderMoves(deps: ProviderMovesDeps) {
  const transport = createSnapshotTransport(deps, { version: PROVIDER_MOVE_VERSION, capabilities: PROVIDER_MOVE_CAPABILITIES,
    capability: 'providerMove', inFlight: PROVIDER_MOVE_IN_FLIGHT, queued: PROVIDER_MOVE_QUEUED, waitMs: PROVIDER_MOVE_WAIT_MS,
    replyBytes: PROVIDER_MOVE_REPLY_BYTES })
  const move: MoveConversation = async (engine, { env, ...rest }) => {
    const ask: ProviderMoveAsk = { ...rest, env: setEnvironment(env) }
    if (!providerMoveAsk(ask)) throw new EngineReadError('ENGINE_INVALID_REQUEST')
    const moved: ProviderMoved | undefined = deps.handles(engine)
      ? await transport.read(engine, PROVIDER_MOVE, { ...ask }, providerMoved) as ProviderMoved
      : await deps.inline(engine)?.(ask)
    if (!moved) throw new Error(`${engine} has no provider move here`)
    if ('refused' in moved) throw new Error(moved.refused)
    return moved.threadId
  }
  return { connected: transport.connected, disconnected: transport.disconnected, move }
}

export type ProviderMoves = ReturnType<typeof createProviderMoves>
