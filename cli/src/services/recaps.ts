/**
 * Recaps: each turn's recap, the devices' turn cards and the notification a finished turn rings
 * (lib/commander.ts), built from the turn lifecycle the core tells this service as it happens
 * (`RecapsPort.lifecycle`, core/api.ts).
 *
 * A session runs the same without it. The core never waits on it: it tells it what happened and goes on,
 * so a recaps service that is down, slow or failing costs a turn its recap and its card, never its end.
 * What the core reads back (an agent's last turns and asks, for a device restoring its tiles, the router,
 * a fork and the handoff) it reads from this service's port, in its process, or from what this service
 * last reported, in its own (core/recapsLink.ts, services/recapsProcess.ts). The recaps it keeps are its
 * own files in the data folder (`summaries*.json`), as they were when this ran inside the core.
 *
 * What the mirror used to read from the core in line (who an engine session belongs to, its name, whether
 * a device watches, whether a turn is verifiably working) comes with each event instead, as the core knew
 * it when it said it, so that the same code runs whichever process it is in.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import type { CoreApi, CorePorts, RecapSession, RecapsPort, RecapWatchers, TurnCardFrame, TurnLifecycle } from '../core/api.js'
import { AgentNotifications } from '../lib/agentNotifications.js'
import { CommanderMirror, SUBAGENT_IDLE_MS } from '../lib/commander.js'
import { deriveTurnSummary } from '../lib/deviceRecap.js'

export interface RecapsOptions {
  /** What a session's recaps hold, or whether its card is busy, may have changed: the recaps' own process
   *  tells the core (services/recapsProcess.ts). */
  changed?: (sessionId: string) => void
  /** The test override that streams every card with no device there (`RECAP_FORCE`). */
  recapForce?: boolean
  /** Whether a recap is cut for every turn, a device watching or not (`RECAP_WITHOUT_DEVICE`). */
  recapWithoutDevice?: () => boolean
}

/** The service: its port, and the mirror itself for its process's own reads (services/recapsProcess.ts). */
export interface Recaps {
  port: RecapsPort
  mirror: CommanderMirror
}

/** Start the recaps in the core's process: its port is the core's way in. */
export function startRecaps(core: CoreApi, ports: CorePorts): void {
  ports.recaps = createRecaps(core).port
}

export function createRecaps(core: CoreApi, options: RecapsOptions = {}): Recaps {
  /** Each session as the core last described it. */
  const sessions = new Map<string, RecapSession>()
  /** Whether each session's turn was verifiably working at the core's last heartbeat. */
  const working = new Map<string, boolean>()
  let watchers: RecapWatchers = { device: false, active: false }
  // Shared by the turns' ends and the questions put to the person: a turn waiting on an answer is not
  // announced as done (lib/agentNotifications.ts). The core tells this service both.
  const notifications = new AgentNotifications()
  const mirror = new CommanderMirror({
    notifications,
    notifyWithoutDevice: true,
    // Presentation lease only: the heartbeat's own reading of the turn, as the core said it with the beat.
    verifiedWorking: (sessionId) => working.get(sessionId) === true,
    send: (frame) => core.clients.turnCard(frame),
    // turn_summary_pending / turn_summary → the web indicator.
    sendWeb: (frame) => core.clients.turnSummary(frame as Parameters<CoreApi['clients']['turnSummary']>[0]),
    hasDevice: () => watchers.device,
    // Live cards stream to whatever is actually rendering. The dial has one screen and it is always the
    // one in front of the user, so the core counts a cable session as active by construction.
    active: () => watchers.active,
    // The recap is an excerpt of the answer, cut the moment the turn ends — no model in the loop. The
    // window, the phone and the dial show it beside the whole answer, so a model's rewrite (which cost
    // about 9 s of every turn) said again what the screen already showed.
    summarize: async (text) => deriveTurnSummary(text),
    summarizeIsLocal: true,
    nameFor: (sessionId) => sessions.get(sessionId)?.name,
    agentIdFor: (sessionId) => sessions.get(sessionId)?.agentId,
    // An Orchestrator specialist's turn end, or the Director's while specialists are still out, is not
    // announced: the person asked to hear from the main agent once, not from every sub-agent.
    isSubagent: (sessionId) => sessions.get(sessionId)?.subagent ?? false,
    // A claude sub-agent still at work is one whose transcript is still growing:
    // `<session>/subagents/agent-<id>.jsonl` beside the parent's. Written in the last SUBAGENT_IDLE_MS =
    // alive; the held turn end waits for it.
    subagentActive: (sessionId, agentId) => {
      const transcriptPath = sessions.get(sessionId)?.transcriptPath
      if (!transcriptPath) return false
      try {
        const at = statSync(join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`)).mtimeMs
        return Date.now() - at < SUBAGENT_IDLE_MS
      } catch { return false }
    },
    readLastTurn: (sessionId) => core.transcripts.lastTurn(sessionId),
    dataDir: core.dataDir,
    recapForce: options.recapForce ?? env.RECAP_FORCE,
    alwaysGenerate: () => options.recapWithoutDevice?.() ?? env.RECAP_WITHOUT_DEVICE,
    changed: options.changed,
  })

  const know = (session: RecapSession): string => {
    const subagent = session.subagent ?? sessions.get(session.sessionId)?.subagent ?? false
    sessions.set(session.sessionId, { ...session, subagent })
    return session.sessionId
  }

  const lifecycle = (event: TurnLifecycle, seen: RecapWatchers): void => {
    watchers = seen
    switch (event.kind) {
      case 'events': mirror.ingest(event.events, know(event.session), { replay: event.replay }); return
      case 'beat': {
        const sessionId = know(event.session)
        working.set(sessionId, event.working)
        mirror.heartbeat(sessionId)
        return
      }
      case 'cancelled': mirror.cancel(know(event.session)); return
      case 'forgotten': mirror.forget(know(event.session)); return
      case 'stopped': mirror.noteEngineStopped(event.sessionId); return
      case 'rebound': mirror.inheritSummary(event.from, event.to); return
      case 'purged':
        sessions.delete(event.sessionId)
        working.delete(event.sessionId)
        mirror.deleteHistory(event.sessionId)
        return
      case 'asked': notifications.asked(event.sessionId, event.requestId); return
      case 'answered': notifications.answered(event.sessionId, event.requestId); return
      case 'rejoined': {
        const now = new Set(event.working)
        for (const sessionId of new Set([...working.keys(), ...now])) working.set(sessionId, now.has(sessionId))
        mirror.replayAll()
        return
      }
    }
  }

  return {
    port: {
      lifecycle,
      recaps: (sessionId) => mirror.snapshot(sessionId),
      liveCards: async () => mirror.liveCards() as TurnCardFrame[],
    },
    mirror,
  }
}
