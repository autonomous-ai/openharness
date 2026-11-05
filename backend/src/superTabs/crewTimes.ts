// Task #3462 (docs/plans/2026-11-06-crew-wake-move-times-plan.md): the design promises a crew member "wakes in seconds" and is
// "moved and running again within 5 minutes". Each wake and each move is recorded when it finishes: its start, the moment the
// agent runs again, and its reason, as one row in its project's chat that only the server reads (NOTICE_READERS
// `crew-timing`). The daily scorecard reads the day's rows (scorecard/figures.ts crewTimesOf), so a member removed since, or
// moved to a new agent, still counts. The crew keeper (crewKeep.ts) calls startWake when new work wakes an asleep member,
// and moveTimingRow when a move's new session takes the member over; the sweep on machine reports calls finishedWakes.
import { agentDisplayName } from './agentNames.js'
import { stableId, type Agent, type Author, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, projectsOf } from './projects.js'

export const CREW_TIMING_KIND = 'crew-timing'
export interface CrewTiming { what: 'wake' | 'move'; agentId: string; startedAt: number; runningAt: number; reason: string }

/** New work in [conversationId] woke [agent] at [now]: its wake is timed from here. */
export function startWake(agent: Agent, conversationId: string, now: number): void {
  agent.crewWaking = { at: now, conversationId }
}

/** The project chat a row about [agentId] goes to, and who writes it: the chat's coordinator, or the member itself without one.
 *  Never a lookup that throws: this runs in the sweep on machine reports. */
function placeFor(state: SuperTabState, agentId: string): { conversationId: string; author: Author } | null {
  const member = state.agents.find(a => a.id === agentId)
  if (!member) return null
  const project = projectsOf(state).find(p => p.id === agentProjectId(state, member))
  const chat = project && state.conversations.find(c => c.id === project.leadConversationId)
  if (!chat) return null
  const writer = state.agents.find(a => a.id === chat.leadId) ?? member
  return { conversationId: chat.id, author: { kind: 'agent', id: writer.id, name: writer.name, displayName: agentDisplayName(state.agents, writer.id),
    membershipGeneration: writer.membershipGeneration } }
}

const seconds = (ms: number) => Math.round(ms / 1000)

/** The row recording one finished wake or move: read by the scorecard, by no person, and waking no one. Named by the member and
 *  the start, so a retried write is the same row. */
function timingRow(state: SuperTabState, timing: CrewTiming): MessageDraft | null {
  const place = placeFor(state, timing.agentId)
  if (!place) return null
  const name = agentDisplayName(state.agents, timing.agentId) ?? timing.agentId
  const verb = timing.what === 'wake' ? 'woke' : 'moved and ran again'
  return { id: stableId('crew-timing', timing.what, timing.agentId, String(timing.startedAt)), conversationId: place.conversationId, author: place.author,
    replyTo: null, recipients: [], text: `${name} ${verb} in ${seconds(timing.runningAt - timing.startedAt)} s (${timing.reason}).`,
    source: { kind: CREW_TIMING_KIND, ...timing } }
}

/** Every woken crew member whose machine's reading, made since the wake, lists its session running: its wake is recorded as
 *  timed to the first such reading, and the mark cleared. A reading from before the wake, or none, finishes nothing; with its
 *  project chat not loaded, the time is kept on the mark until a pass that can write the row. */
export function finishedWakes(state: SuperTabState, _now: number): MessageDraft[] {
  const rows: MessageDraft[] = []
  for (const agent of state.agents) {
    const waking = agent.crewWaking
    if (!waking) continue
    const reading = state.machines?.find(m => m.machineId === agent.machineId)?.observation
    if (waking.runningAt === undefined && reading && reading.receivedAt >= waking.at && reading.runningHarnessIds.includes(agent.harnessId)) {
      waking.runningAt = reading.receivedAt
    }
    if (waking.runningAt === undefined) continue
    const task = state.conversations.find(c => c.id === waking.conversationId)
    const row = timingRow(state, { what: 'wake', agentId: agent.id, startedAt: waking.at, runningAt: waking.runningAt,
      reason: task?.number !== undefined ? `work on #${task.number}` : 'new work' })
    // Its project chat not loaded (a dormant one): the time it ran again is kept, and a later pass writes the row.
    if (!row) continue
    delete agent.crewWaking
    rows.push(row)
  }
  return rows
}

/** The row recording a move of the member now [agentId]: from when the keeper picked its machine ([startedAt]) to [now], when
 *  its new session took the member over, for [reason] (the trouble that moved it). */
export function moveTimingRow(state: SuperTabState, agentId: string, startedAt: number, reason: string, now: number): MessageDraft | null {
  return timingRow(state, { what: 'move', agentId, startedAt, runningAt: now, reason })
}

/** A timing row's record, or null for any other row or one that does not hold together. */
export function crewTimingOf(source: unknown): CrewTiming | null {
  const s = source as Partial<CrewTiming> & { kind?: unknown } | null | undefined
  if (!s || s.kind !== CREW_TIMING_KIND || (s.what !== 'wake' && s.what !== 'move') || typeof s.agentId !== 'string' || typeof s.reason !== 'string'
    || typeof s.startedAt !== 'number' || typeof s.runningAt !== 'number' || s.runningAt < s.startedAt) return null
  return { what: s.what, agentId: s.agentId, startedAt: s.startedAt, runningAt: s.runningAt, reason: s.reason }
}
