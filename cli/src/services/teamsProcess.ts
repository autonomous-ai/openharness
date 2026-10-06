/**
 * The teams' prompt scopes in their own process (`harness __service teams`, with `HARNESSD_SERVICES=teams`).
 *
 * The same scopes as in the core's process (teams/promptScope.ts), fed the core's changes as numbered
 * events (core/teamsLink.ts) and applied here in order, exactly once:
 * - An event this process already has is skipped.
 * - One that arrives too early (the one before it went missing) makes it ask the core again.
 * - Each connection starts by telling the core the last event it applied. The core answers with the
 *   events it lacks, or tells it to start over.
 *
 * Each event is applied at the time it happened, so one replayed later ages as it would have: a message
 * stays matchable for the same five minutes. After applying events, the process tells the core where
 * each agent it touched stands. That is what the socket's team features read back.
 */
import type { PromptScopes, TeamsEvent } from '../core/api.js'
import { SwarmPromptScopes } from '../teams/promptScope.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'

export interface TeamsServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for scopes they can watch; given the clock to read. */
  scopes?: (now: () => number) => PromptScopes
  log?: (line: string) => void
}

/** The most undos kept for writes that may yet fail. A write fails within seconds; these are minutes. */
export const KEPT_UNDOS = 1_024

export function runTeamsService(options: TeamsServiceOptions): ServiceProcess {
  const log = options.log ?? ((line: string) => console.warn(line))
  const make = options.scopes ?? ((now: () => number) => new SwarmPromptScopes(now))
  /** The time of the event being applied: every call into the scopes is made from one. */
  let clock = 0
  const now = (): number => clock
  let scopes = make(now)
  /** The core whose events the scopes hold, and the last of them applied. */
  let core: string | null = null
  let applied = 0
  let connection: CoreConnection | null = null
  /** The connection whose first question is answered: events may be applied as they come on it. */
  let synced: CoreConnection | null = null
  /** Each prepared write's undo, by its event: an unprepare names the write it takes back. */
  const undos = new Map<number, () => void>()
  const touched = new Set<string>()
  let acking = false

  /** One event, in its place: counted as applied even when it cannot be, so the stream goes on. */
  const apply = (event: TeamsEvent): void => {
    applied = event.seq
    clock = event.at
    try {
      switch (event.kind) {
        case 'prepare':
          undos.set(event.seq, scopes.prepare(event.agentId, event.text, event.tabId, event.deliveryId))
          if (undos.size > KEPT_UNDOS) undos.delete(undos.keys().next().value!)
          break
        case 'unprepare': {
          const undo = undos.get(event.of)
          undos.delete(event.of)
          undo?.()
          break
        }
        case 'started': scopes.started(event.agentId, event.text, event.source, event.engine); break
        case 'raw': scopes.raw(event.agentId, Buffer.from(event.bytes, 'base64'), event.tabId, event.pasted); break
        case 'forget': scopes.forget(event.agentId); break
        case 'replied': scopes.replied(event.agentId, event.teamId, event.questionId); break
        // A kind a newer core says: nothing this process knows how to do.
        default: break
      }
      touched.add(event.agentId)
    } catch (error) {
      log(`[teams] event ${event.seq} could not be applied · ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Tell the core how far this process got, and where each agent it touched stands; once per burst. */
  const acknowledge = (via: CoreConnection): void => {
    if (acking) return
    acking = true
    queueMicrotask(() => {
      acking = false
      const report = Object.fromEntries([...touched].map((agentId) => [agentId, scopes.current(agentId)]))
      touched.clear()
      void via.query('ack', { core, applied, scopes: report }).catch(() => {})
    })
  }

  /** Ask the core for what this process lacks, and apply it before anything new. */
  const sync = (via: CoreConnection): void => {
    synced = null
    void via.query('hello', { core, applied }).then((answer) => {
      if (connection !== via || typeof answer.core !== 'string' || typeof answer.base !== 'number' || !Array.isArray(answer.events)) return
      if (answer.reset === true) {
        scopes = make(now)
        undos.clear()
      }
      core = answer.core
      applied = answer.base
      for (const event of answer.events as TeamsEvent[]) if (event?.core === core && event.seq === applied + 1) apply(event)
      synced = via
      acknowledge(via)
    }, () => {})
  }

  const run = options.run ?? runServiceProcess
  const service = run({
    name: 'teams',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask teams nothing here: the team features answer them in the core's socket.
    requests: {},
    onEvent: (payload) => {
      const event = payload.event as TeamsEvent | undefined
      if (payload.kind !== 'event' || !synced || event?.core !== core || typeof event.seq !== 'number' || event.seq <= applied) return
      // The one before it never came: ask the core again rather than skip it.
      if (event.seq !== applied + 1) { sync(synced); return }
      apply(event)
      acknowledge(synced)
    },
    onConnected: (via) => {
      connection = via
      sync(via)
    },
  })
  return { stop: () => service.stop() }
}
