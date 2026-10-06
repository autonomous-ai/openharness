/**
 * Recaps: the dial's and the window's turn cards and the phone's notifications, through the commander
 * mirror. A recap is an excerpt of the answer, cut as the turn ends; a sub-agent's turn end is not
 * announced; recaps are stored under the engine session and asked for by agent.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 7: docs/design/2026-10-03-harnessd.md).
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentNotifications } from '../../lib/agentNotifications.js'
import { CommanderMirror, SUBAGENT_IDLE_MS, type CommanderMirrorOpts } from '../../lib/commander.js'
import { deriveTurnSummary } from '../../lib/deviceRecap.js'
import type { LastTurnText } from '../../lib/normalize.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { TurnActivity } from '../../lib/turnActivity.js'
import type { OrchestratorService } from '../../orchestrator/service.js'

type CommanderFrame = Parameters<CommanderMirrorOpts['send']>[0]
type WebFrame = Parameters<CommanderMirrorOpts['sendWeb']>[0]

export interface RecapDeps {
  notifications: AgentNotifications
  turnActivity: Pick<TurnActivity, 'snapshot'>
  /** The dial (`sendCommander`, `hasActiveCommander`) and the app (`send`). */
  clients: { sendCommander(frame: CommanderFrame): void; send(frame: WebFrame): void; hasActiveCommander(): boolean }
  deviceIsWatching: () => boolean
  cableWatchingLocal: () => boolean
  bySession: (sessionId: string) => RegisteredSession | undefined
  resolve: (id: string) => RegisteredSession | undefined
  /** A stopped agent's archived record (stoppedAgents.get). */
  stopped: (agentId: string) => RegisteredSession | null
  /** The orchestrator's role for an agent: a specialist, or the director. */
  orchestratorRoleOf: OrchestratorService['roleOf']
  readLastTurn: (sessionId: string) => Promise<LastTurnText | null>
  dataDir: string
  recapForce: boolean
  recapWithoutDevice: () => boolean
}

export function createRecaps({
  notifications, turnActivity, clients, deviceIsWatching, cableWatchingLocal, bySession, resolve, stopped,
  orchestratorRoleOf, readLastTurn, dataDir, recapForce, recapWithoutDevice,
}: RecapDeps) {
  // The recap is an excerpt of the answer, cut the moment the turn ends — no model in the loop. The
  // window, the phone and the dial show it beside the whole answer, so a model's rewrite (which cost
  // about 9 s of every turn) said again what the screen already showed.
  const summarizer: Pick<CommanderMirrorOpts, 'summarize' | 'summarizeIsLocal'> = {
    summarize: async (text) => deriveTurnSummary(text),
    summarizeIsLocal: true,
  }
  /**
   * A turn that belongs to a SUB-AGENT: an Orchestrator specialist, or its Director while specialists
   * are still out.
   *
   * Hoisted out of the commander's options because the dial is no longer the only screen that has to
   * know. The cable learns it as `silent` on the summary card; the window and the phone learn it as
   * `subagent` on `turn_ended` (see emitSessionEvents) — the phone notifies on neither. One rule, asked twice — the two surfaces used to disagree
   * here, and a four-specialist project put ONE row on the dial and FIVE marks in the window.
   *
   * ⚠️ The commander ORs this with its own `abandoned` state — a held turn released because a
   * sub-agent went silent — which lives inside it and is not reachable from here. That case is rare
   * (a killed or crashed sub-agent) and costs the window one extra mark, not five.
   */
  const isSubagentSession = (sessionId: string): boolean => {
    const agentId = bySession(sessionId)?.agentId
    if (!agentId) return false
    // Asked at every turn's end, from the transcript's line handler. Reading the orchestrator makes its
    // folder, which throws on a full disk (e2e/diskfull.e2e.ts): announced as anyone's, the turn keeps its end.
    let role: ReturnType<typeof orchestratorRoleOf>
    try { role = orchestratorRoleOf(agentId) } catch { return false }
    return role?.role === 'worker' || (role?.role === 'director' && role.busy)
  }
  const mirror = new CommanderMirror({
    notifications,
    notifyWithoutDevice: true,
    verifiedWorking: sessionId => turnActivity.snapshot(sessionId)?.state === 'working',
    send: (frame) => clients.sendCommander(frame),
    sendWeb: (frame) => clients.send(frame), // turn_summary_pending / turn_summary → web indicator
    hasDevice: () => deviceIsWatching(),        // device-gate the LLM recap (mirror node)
    // Live cards stream to whatever is actually rendering. The dial has one screen and it is always the
    // one in front of the user, so a cable session counts as active by construction.
    active: () => clients.hasActiveCommander() || cableWatchingLocal(),
    ...summarizer,
    nameFor: (sessionId) => { const s = bySession(sessionId); return s ? projectDisplayName(s) : undefined },
    agentIdFor: (sessionId) => bySession(sessionId)?.agentId,
    // An Orchestrator specialist's turn end, or the Director's while specialists are still out, is not
    // announced: the person asked to hear from the main agent once, not from every sub-agent.
    isSubagent: (sessionId: string) => isSubagentSession(sessionId),
    // A claude sub-agent still at work is one whose transcript is still growing:
    // `<session>/subagents/agent-<id>.jsonl` beside the parent's (the same file enrichSubagentStats
    // reads). Written in the last SUBAGENT_IDLE_MS = alive; the held turn end waits for it.
    subagentActive: (sessionId, agentId) => {
      const transcriptPath = bySession(sessionId)?.transcriptPath
      if (!transcriptPath) return false
      try {
        const at = statSync(join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`)).mtimeMs
        return Date.now() - at < SUBAGENT_IDLE_MS
      } catch { return false }
    },
    readLastTurn,
    dataDir,
    recapForce,
    alwaysGenerate: () => recapWithoutDevice(),
  })
  // Recaps are STORED under the engine session id — that is what lets `--resume` bring the last recap
  // back under a brand-new agent — but they are ASKED FOR by agent id, which is the only id the device
  // and the voice router know. Resolve across the two, or every tile restores empty.
  const recent = (id: string, n: number) => mirror.recent(resolve(id)?.sessionId || stopped(id)?.sessionId || id, n)
  const recentAsks = (id: string, n?: number) => mirror.recentAsks(resolve(id)?.sessionId || stopped(id)?.sessionId || id, n)
  /**
   * The reply to `agent_recent`: an agent's last turn summaries and the person's last questions. Asked
   * by a device restoring its tiles at boot, so it holds only what was summarized (recap and body),
   * never a resurrected full-text card, and nothing until a turn was summarized.
   *
   * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
   */
  const agentRecent = (payload: Record<string, unknown>): Record<string, unknown> => {
    const projectId = payload.agentId as string | undefined
    if (!projectId) return { error: 'MISSING_AGENT_ID' }
    const n = Math.max(1, Math.min(5, Number(payload.n) || 2))
    const events = recent(projectId, n)
    // ASKS TRAVEL AS THEIR OWN LIST, beside the events rather than inside them. A question exists
    // the moment it is asked; a recap exists once the turn has been answered and summarised. They
    // are different lengths on any machine where a turn ended without one, so a reply that folds
    // the questions into the event rows loses exactly the newest ones — and a REMOTE agent then
    // reaches the router with nothing but its name.
    const asks = recentAsks(projectId, n)
    return { agentId: projectId, events, asks }
  }
  return { mirror, isSubagentSession, recent, recentAsks, agentRecent }
}

export type Recaps = ReturnType<typeof createRecaps>
