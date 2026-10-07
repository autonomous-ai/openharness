/**
 * The recaps in their own process: the edge host's, by default (`harness __service recaps`, harnessd's
 * `SERVICE_HOSTS`).
 *
 * The same recaps as in the core's process (services/recaps.ts), on a core API built here. The core tells
 * this process each turn's lifecycle (`service_event lifecycle`) and never waits for it; a turn it misses
 * while this process is down, hung or slow simply has no recap. What the recaps would put in front of a
 * person (a device's turn card, the apps' recap) goes back to the core as a notice, which the core sends on
 * after checking its type. A turn's final answer, which the recap is cut from, is asked of the core
 * (`service_query lastTurn`): the transcript is the core's to read.
 *
 * What the core reads back in line (an agent's last turns and asks, and whether its card is busy) it reads
 * from what this process last told it (`service_notice recaps`), whenever a session's changes, and all of
 * them each time it connects: a core that restarted holds nothing until then (core/recapsLink.ts).
 */
import type { CoreApi, TurnCardFrame, TurnLifecycle, TurnSummaryFrame, RecapWatchers } from '../core/api.js'
import type { LastTurnText } from '../lib/normalize.js'
import { processCoreApi } from './processCoreApi.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { createRecaps } from './recaps.js'

export interface RecapsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests. */
  create?: typeof createRecaps
}

/** What the recaps ask of the core in their own process; the rest of the core API answers as nothing. */
export interface RecapsCoreWays {
  turnCard(frame: TurnCardFrame): void
  turnSummary(frame: TurnSummaryFrame): void
  lastTurn(sessionId: string): Promise<LastTurnText | null>
}

/** The core API the recaps run on in their own process: the light services' (processCoreApi.ts), with
 *  the three ways the recaps reach the core. */
export function recapsCoreApi(dataDir: string, ways: RecapsCoreWays): CoreApi {
  const api = processCoreApi(dataDir, 'recaps')
  return {
    ...api,
    transcripts: { ...api.transcripts, lastTurn: ways.lastTurn },
    clients: { ...api.clients, turnCard: ways.turnCard, turnSummary: ways.turnSummary },
  }
}

/** Whether what the core sent reads as a lifecycle event: its kind, and the watchers beside it. */
const isLifecycle = (payload: Record<string, unknown>): payload is { event: TurnLifecycle; watchers: RecapWatchers } =>
  !!payload.event && typeof payload.event === 'object' && typeof (payload.event as { kind?: unknown }).kind === 'string'
  && !!payload.watchers && typeof payload.watchers === 'object'

export function runRecapsService(options: RecapsServiceOptions): ServiceProcess {
  let core: CoreConnection | null = null
  /** What the current connection was last told of each session: whether its card was busy, and which of
   *  its stored recaps' revisions. A change is said once; a new connection is told everything. */
  const told = new Map<string, string>()

  const tell = (sessionId: string): void => {
    if (!core) return
    const said = `${recaps.mirror.busy(sessionId)}:${recaps.mirror.revision(sessionId)}`
    if (told.get(sessionId) === said) return
    told.set(sessionId, said)
    core.notice?.('recaps', { sessionId, recaps: recaps.port.recaps(sessionId) })
  }

  const recaps = (options.create ?? createRecaps)(recapsCoreApi(options.dataDir, {
    // Lost with the connection, as a card to a device that went away is: the next turn's card follows.
    turnCard: (frame) => { core?.notice?.('card', { frame }) },
    turnSummary: (frame) => { core?.notice?.('summary', { frame }) },
    // Asked of the core, which reads the transcript; no answer without one (the recap then is none).
    lastTurn: async (sessionId) => {
      if (!core) return null
      const answer = await core.query('lastTurn', { sessionId })
      return answer.turn && typeof answer.turn === 'object' ? answer.turn as LastTurnText : null
    },
  }), { changed: tell })

  const run = options.run ?? runServiceProcess
  return run({
    name: 'recaps',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask the recaps nothing: the core answers them from what this process tells it. The core
    // itself asks one thing, when a dial attaches: the cards of every turn still at work.
    requests: { liveCards: async () => ({ cards: await recaps.port.liveCards() }) },
    onEvent: (payload) => {
      if (payload.kind === 'lifecycle' && isLifecycle(payload)) recaps.port.lifecycle(payload.event, payload.watchers)
    },
    onConnected: (connection) => {
      core = connection
      told.clear()
      for (const sessionId of recaps.mirror.sessions()) tell(sessionId)
    },
    onDisconnected: () => { core = null },
  })
}
