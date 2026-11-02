import type { ReviewedAnswer } from './questionInbox.js'
// The daemon's view of the OTHER machines the owner has, and the one lane that reaches them.
//
// Split out of cableHost.ts so the cable protocol layer never learns the word "relay": everything the dial
// can ask for is answered either from this process (the cabled computer's own registry) or through this
// interface, and `DaemonCableHost` is the single place that decides which.
//
// THE LOCAL MACHINE NEVER COMES THROUGH HERE. Its agents, turns and recaps are in this process already;
// routing them through the cloud to reach a dial plugged into this very computer would add a network
// round trip, a failure mode and an audience — for nothing.
import type { CableAgent } from './cableSession.js'
import type { RecentTurn } from './cableHost.js'
import type { Tier } from '../lib/notifyTier.js'

/** One of the owner's machines, as the fleet knows it. The local row is added by the host, not here. */
/**
 * Why `online()` failed, as the `code` on what it rejects with, so the dial's plug-in retry (cableHost.ts) tries again
 * only what nothing else will (follow-up to #2483, both security reviews):
 * - LANE_TOKEN_UNAVAILABLE: the token could not be read just now (a refresh lost to a network blip). No socket was
 *   made, so the lane has no close to retry from: only the caller can try again.
 * - LANE_SESSION_OVER: the session is over (signed out, a refresh refused, SSO asking for a new sign-in). Trying again
 *   cannot fix it; the next sign-in and plug-in do.
 * Any other failure was the socket's, and the lane's own reconnect retries it (deviceLink.ts onClose).
 */
export const LANE_TOKEN_UNAVAILABLE = 'TOKEN_UNAVAILABLE'
export const LANE_SESSION_OVER = 'SESSION_OVER'

export interface FleetMachine {
  machineId: string
  name: string
  /** `ready` = reachable now · `offline` = known but not reachable · `unknown` = the list itself is stale
   *  · `needs-link` = reachable, but this daemon holds no pinned key for it, so nothing can be read. */
  state: 'ready' | 'offline' | 'unknown' | 'needs-link'
  authMode: 'self' | 'managed' | 'remote' | 'provider'
}

/** A refusal that a person can act on. `message` reaches the dial's screen verbatim. */
export class FleetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FleetError'
  }
}

/** A card from an attached machine, already translated into the dial's four kinds. */
export type FleetEvent =
  | { machineId: string; kind: 'processing' | 'done' | 'summary' | 'error'; agentId: string; text: string; recap: string; subagent?: boolean; update?: string
      /** A summary's tier, as that machine's recaps decided it (services/recaps.ts): the dial follows it. */
      tier?: Tier }
  | { machineId: string; kind: 'question'; agentId: string; requestId: string; questions: unknown }
  | { machineId: string; kind: 'questionClosed'; agentId: string; requestId: string }
  | { machineId: string; kind: 'state'; state: FleetMachine['state'] }

/**
 * Everything the dial needs from a machine that is NOT this computer.
 *
 * Deliberately an interface: it lets the whole cable half be built, tested and flashed against a fleet
 * that knows only the local machine, long before a lane to anywhere else exists.
 */
export interface MachineFleet {
  /**
   * The owner's machines, EXCLUDING this computer.
   *
   * Must resolve rather than reject when the backend is unreachable — `source` is how a short list
   * explains itself, and a dial whose daemon is offline still has one machine that works perfectly.
   */
  list(): Promise<{ machines: FleetMachine[]; source: 'backend' | 'local' | 'signed-out' }>
  /**
   * Come online for the dial: hold a socket to the backend, attached to no machine.
   *
   * Connecting and attaching are different things. A held socket buys device presence and a LIVE machine
   * list — the wheel's dots stop being a REST snapshot up to a minute old — without making any machine
   * believe a commander is watching it.
   */
  online(): Promise<void>
  /** Attach to a machine, which is also how the backend learns where the dial is. Throws on refusal. */
  select(machineId: string): Promise<void>
  /**
   * Let go of whatever `select` acquired.
   *
   * `immediate` is the difference between "the user looked away" and "the dial is gone". Going back to
   * the local machine lingers, so flicking between two machines does not pay a dial each way; the cable
   * dropping closes the lane now, because the thing it was being held for is no longer there.
   */
  release(immediate?: boolean): void
  listAgents(machineId: string): Promise<CableAgent[]>
  sendTurn(machineId: string, agentId: string, text: string): void
  stopTurn(machineId: string, agentId: string): void
  answer(machineId: string, agentId: string, requestId: string, answers: Record<string, string>): void
  answerReviewed?(machineId: string, answer: ReviewedAnswer): void
  updateAgent(machineId: string, agentId: string, model?: string, effort?: string): void
  /** Fork an agent on that machine (`agent_fork`); resolves to the new agent's id, rejects with the
   *  far end's refusal. Optional: a fleet built before forks existed simply cannot. */
  forkAgent?(machineId: string, agentId: string): Promise<string>
  listModels(machineId: string, agentId: string): Promise<string[]>
  recentSummaries(machineId: string, agentId: string): Promise<RecentTurn[]>
  /** The person's own last questions to that agent, newest first — the router's input. */
  recentAsks(machineId: string, agentId: string): Promise<string[]>
  /**
   * How the last round trip to this machine went, or null if nobody has asked it yet.
   *
   * Optional because it is a witness, not a contract: an implementation that keeps no record simply
   * cannot say, and callers must treat "cannot say" the same as "never asked" — never as unreachable.
   */
  reachable?(machineId: string): { ok: boolean; at: number } | null
  /** Cards + liveness from the attached machine. Returns an unsubscribe. */
  onEvent(cb: (event: FleetEvent) => void): () => void
}
