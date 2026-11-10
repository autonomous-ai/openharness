// Task #3462 (docs/plans/2026-11-06-crew-wake-move-times-plan.md): each wake of an asleep agent is recorded when it finishes: its
// start, the moment the agent runs again, and its reason, as one row in its project's chat that only the server reads
// (NOTICE_READERS `crew-timing`). Only a Buddy wakes now (buddySleep.ts, buddyEngine.ts call startWake); the sweep on machine
// reports calls finishedWakes. Goes with Buddies (S17).
import { agentDisplayName } from './agentNames.js'
import { stableId, type Agent, type Author, type MessageDraft, type SuperTabState } from './model.js'
import { agentProjectId, projectsOf } from './projects.js'

export const CREW_TIMING_KIND = 'crew-timing'
export interface CrewTiming { what: 'wake'; agentId: string; startedAt: number; runningAt: number; reason: string }

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

/** The row recording one finished wake or move: read by no person, and waking no one. Named by the member and
 *  the start, so a retried write is the same row. */
function timingRow(state: SuperTabState, timing: CrewTiming): MessageDraft | null {
  const place = placeFor(state, timing.agentId)
  if (!place) return null
  const name = agentDisplayName(state.agents, timing.agentId) ?? timing.agentId
  return { id: stableId('crew-timing', timing.what, timing.agentId, String(timing.startedAt)), conversationId: place.conversationId, author: place.author,
    replyTo: null, recipients: [], text: `${name} woke in ${seconds(timing.runningAt - timing.startedAt)} s (${timing.reason}).`,
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

/** A timing row's record, or null for any other row or one that does not hold together. */
export function crewTimingOf(source: unknown): CrewTiming | null {
  const s = source as Partial<CrewTiming> & { kind?: unknown } | null | undefined
  if (!s || s.kind !== CREW_TIMING_KIND || s.what !== 'wake' || typeof s.agentId !== 'string' || typeof s.reason !== 'string'
    || typeof s.startedAt !== 'number' || typeof s.runningAt !== 'number' || s.runningAt < s.startedAt) return null
  return { what: s.what, agentId: s.agentId, startedAt: s.startedAt, runningAt: s.runningAt, reason: s.reason }
}
