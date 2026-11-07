import { author, stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { ledProject, projectsOf, type SwarmProject } from './projects.js'
import { workOver } from './decisions.js'
import { digestOf, localNow } from './digest.js'
import { DEFAULT_TIME_ZONE } from './costs/reflection.js'
import { taskLiveness } from './liveness.js'
import { archivable } from './tidy.js'
import { processLines, unconfirmedNote } from './processNotes.js'

// Every project's coordinator runs the same built-in schedule, woken by the Swarm on its own poll instead of a timer of its
// own (Ken, 2026-11-04; docs/plans/2026-11-04-pm-built-in-schedule-design.md): a Codex PM may have no timer, and a restart
// lost one. A line in the project's own instructions about the same job wins; the coordinator judges that. Each wake says
// what its jobs are: the Swarm adds no text of its own to the instructions the coordinator reads (anh Dee, 11-07, #4673).

/** The schedule's clock: slot n starts at n * 30 minutes, in UTC. */
export const SCHEDULE_SLOT_MS = 30 * 60_000
export const scheduleSlot = (now: number): number => Math.floor(now / SCHEDULE_SLOT_MS)
export const scheduleMessageId = (tabId: string, projectId: string, slot: number): string => stableId('schedule', tabId, projectId, String(slot))

const isLead = (state: SuperTabState, group: Conversation) => projectsOf(state).some(p => p.leadConversationId === group.id)
const inProject = (group: Conversation, projectId: string) => (group.projectId ?? 'lead') === projectId

/** Whether the sweep has anything to do among the loaded groups: a task no agent is moving (none assigned, its agent lost, or
 *  it waits on a person or is stuck), or a finished group the Swarm may archive (tidy.ts archivable: tidying on, its step's
 *  task ended) that the auto-archive never takes, since neither it nor, for a step, its task links a pull request. A task an
 *  agent is working on is the stalled and lost notices' (liveness.ts). Steps belong to their task's Engineer. */
export function sweepDue(state: SuperTabState, projectId: string, now: number): boolean {
  return state.conversations.some(group => {
    if (group.kind || group.audience || group.archived || !inProject(group, projectId) || isLead(state, group)) return false
    if (workOver(state, group)) {
      const task = group.reviewOf ? state.conversations.find(c => c.id === group.reviewOf) : undefined
      return archivable(state, group, now) && !group.pullRequestUrls?.length && !task?.pullRequestUrls?.length
    }
    // A paused task waits on whoever paused it, not on the PM (boardRights.ts, task #3819).
    if (group.reviewOf || group.paused) return false
    if (!group.assignment) return true
    const liveness = taskLiveness(state, group, now)
    return liveness?.state === 'orphaned' || (liveness?.state === 'waiting' && (liveness.why === 'person' || liveness.why === 'blocked'))
  })
}

/** The jobs a wake carries: the open-task sweep, and what people taught the coordinator since its last wake. The daily tidy
 *  is its own message (tidyRequest). */
export type ScheduleJob = 'sweep' | 'heard' | 'process'

const JOB_LINES: Record<ScheduleJob, string> = {
  sweep: '- Open-task sweep: every open task, unassigned ones included, ends with an owner working on it, a question to a person by name '
    + 'with a default and a time, or a close with its reason; then archive every finished task the Swarm left open with no pull request.',
  heard: '- What people taught you: read only what people sent you since the last wake, and save each correction or lasting rule the '
    + 'instructions don\'t have yet, naming who said it.',
  process: '- What changed for PMs: read the note below, work by it, and confirm it (task #3581).',
}

/** The wake's words: the slot's local time, the jobs due, and that the project's own schedule wins. It names no reread of the
 *  instructions (anh Dee, 11-05, #3387, undoing #3151's 7-9k tokens a wake): the CLI tells the coordinator when they change
 *  (cli superTabs/instructionsNotice.ts). */
export function scheduleText(project: SwarmProject, slot: number, jobs: readonly ScheduleJob[] = ['sweep'], owed: readonly string[] = []): string {
  const zone = digestOf(project)?.timeZone ?? DEFAULT_TIME_ZONE
  return [`Built-in schedule, ${localNow(zone, slot * SCHEDULE_SLOT_MS).time} (${zone}). This is a scheduled request from the Swarm, not a new task.`,
    ...jobs.map(job => JOB_LINES[job]),
    // What the PM owes about the process (processNotes.ts, task #3581): a note to confirm, a project with no crew.
    ...owed,
    'Skip a job your project\'s instructions schedule on their own clock. Set no timer of your own for this one, and delete one you set before.'].join('\n')
}

/** What a due wake asks of the coordinator: its slot, its jobs and its message. */
export interface ScheduledWake { slot: number; jobs: ScheduleJob[]; draft: MessageDraft; processNote?: string }

/** The coordinator's slot and its wake, when a slot is due and a job has something to do: the sweep has a task to settle
 *  (sweepDue), a person wrote to the coordinator since its last wake (parts/commit.ts heardAt on the chat written to: who
 *  wrote where, never the words; task #3022), or it is a new local day and the instructions changed since the last tidy. Null otherwise, and then
 *  nothing is recorded: a slot written with no wake would move the Swarm's head, and every reader's copy, each 30 minutes
 *  while nothing happened (#2946 review, 1), so the slot stays due and the next poll checks again, in memory over the loaded
 *  state. Null too in a paused Swarm, which stays due until it resumes, or for an agent that leads no project. The caller
 *  records it with recordWake in the poll's own write, and sends nothing while its last wake is still unread (store.ts). */
export function scheduleRequest(state: SuperTabState, target: Agent, now: number): ScheduledWake | null {
  if (state.paused) return null
  const project = ledProject(state, target.id)
  const slot = scheduleSlot(now)
  const schedule = project?.schedule
  if (!project || slot <= (schedule?.lastSlot ?? -1)) return null
  // The chats of its project the poll loaded, each marked where a person wrote to the coordinator (parts/commit.ts).
  const since = schedule?.heardAt ?? 0
  const heard = state.conversations.some(c => !c.archived && (c.heardAt ?? 0) > since && (c.id === project.leadConversationId || inProject(c, project.id)))
  // A what-changed note the PM has not confirmed wakes it once (task #3581); after that it rides on the wakes due anyway.
  const note = unconfirmedNote(state, project)
  const tell = !!note && project.processNote?.told !== note.id
  const jobs: ScheduleJob[] = [
    ...sweepDue(state, project.id, now) ? ['sweep' as const] : [],
    ...heard ? ['heard' as const] : [],
    ...tell ? ['process' as const] : [],
  ]
  if (!jobs.length) return null
  return { slot, jobs, ...tell ? { processNote: note!.id } : {}, draft: { id: scheduleMessageId(state.id, project.id, slot), conversationId: project.leadConversationId,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }), text: scheduleText(project, slot, jobs, processLines(state, project)),
    replyTo: null, recipients: [target.id], source: { kind: 'schedule-request', projectId: project.id, slot } } }
}

/** Records [wake] on [project] in the poll's write: its slot always, so a held-back wake is not retried every poll; and, when
 *  message [wakeId] carried it, that message and the jobs it asked for. A wake held back (null: the last one is still unread)
 *  leaves the people job due for the next slot. */
export function recordWake(project: SwarmProject, wake: ScheduledWake, now: number, wakeId: string | null): void {
  const before = project.schedule
  if (!wakeId) {
    project.schedule = { ...before, lastSlot: wake.slot }
    return
  }
  project.schedule = { ...before, lastSlot: wake.slot, wakeId, ...wake.jobs.includes('heard') ? { heardAt: now } : {} }
  if (wake.processNote) project.processNote = { ...project.processNote, told: wake.processNote }
}

/**
 * The daily tidy (Ken, 11-05, #3151): out of the 30-minute wake into its own message, in the project's 23:00 hour beside the
 * nightly reflection (lib/routingReflection.ts), when people rarely write. A tidy from lamp's revision 70 to 71 dropped Leo's
 * rule as impossible and the "(0xken15, 4 Nov)" of a rule it kept, so the message has the coordinator sort every line it drops
 * and check its save against the revision before; the server backs the person's rules (ruleGuard.ts). It counts only when a
 * save follows (tidySaved): until then it is due again the next night, which says the last one was skipped.
 */
export const TIDY_HOUR = '23'
export const tidyMessageId = (tabId: string, projectId: string, day: string): string => stableId('tidy', tabId, projectId, day)

const TIDY_LINES = [
  '- Reread the instructions once and, in one save, merge duplicate lines and drop stale ones, so they get shorter.',
  '- Sort every line you drop into one of three kinds: merged (its meaning is kept elsewhere, with who said it), expired (a step or '
    + 'date that has passed), or a person\'s rule that is gone. Restore a person\'s rule that is gone, or ask the person who gave it '
    + 'and keep it until they answer: never drop or weaken a person\'s rule on your own judgment, even one you think cannot be done.',
  '- List every line you drop with its kind in the save\'s dropped list: the History keeps it with the revision. The save\'s '
    + 'summary only counts them (for example "3 merged, 1 expired").',
  '- After the save, compare it with the previous revision: every person\'s rule, and who gave it, must still be there. The Swarm '
    + 'refuses a save that drops one without that person\'s own approval message.',
  '- Mark that save as the tidy ("tidy": true): the tidy counts as done only when its save is made; without one, tomorrow\'s '
    + 'message says it was skipped.',
]

/** What a due tidy asks: the project's local date, whether the last one was skipped, and its message. */
export interface ScheduledTidy { day: string; skipped: boolean; draft: MessageDraft }

/** The coordinator's tidy, in its project's 23:00 hour once a local date, when the instructions changed since the last tidy
 *  that was saved, or the last one asked was never saved. Null otherwise, in a paused Swarm, or for an agent that leads no
 *  project. The caller records it with recordTidy in the poll's own write. */
export function tidyRequest(state: SuperTabState, target: Agent, now: number): ScheduledTidy | null {
  if (state.paused) return null
  const project = ledProject(state, target.id)
  if (!project) return null
  const zone = digestOf(project)?.timeZone ?? DEFAULT_TIME_ZONE
  const { date: day, time } = localNow(zone, now)
  const schedule = project.schedule
  // Revision 1 is the project's first document: nothing has been added to it yet.
  const changed = (project.instructionsRevision ?? 0) > (schedule?.tidiedRevision ?? 1)
  if (!time.startsWith(`${TIDY_HOUR}:`) || day === schedule?.tidiedOn || !(changed || schedule?.tidyPending)) return null
  const skipped = !!schedule?.tidyPending
  const text = [`Daily tidy, ${time} (${zone}). This is a scheduled request from the Swarm, not a new task.`,
    ...skipped ? ['Yesterday\'s tidy was skipped: no save followed it.'] : [], ...TIDY_LINES].join('\n')
  return { day, skipped, draft: { id: tidyMessageId(state.id, project.id, day), conversationId: project.leadConversationId,
    author: author(state, { kind: 'agent', agentId: target.id, machineOwnerId: target.machineOwnerId }), text,
    replyTo: null, recipients: [target.id], source: { kind: 'tidy-request', projectId: project.id, on: day } } }
}

/** Records [tidy] on [project] in the poll's write: asked on its date, pending until a save follows. */
export function recordTidy(project: SwarmProject, tidy: ScheduledTidy): void {
  project.schedule = { lastSlot: -1, ...project.schedule, tidiedOn: tidy.day, tidyPending: true }
}

/** The coordinator's save at [revision] while a tidy is pending: the tidy is done (commands.ts instructions.save). */
export function tidySaved(project: SwarmProject, revision: number): void {
  if (!project.schedule?.tidyPending) return
  const { tidyPending: _done, ...rest } = project.schedule
  project.schedule = { ...rest, tidiedRevision: revision }
}
