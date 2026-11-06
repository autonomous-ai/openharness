/**
 * What changed for PMs (task #3581, anh Dee 11-06: lamp's PM did not know the Swarm v2 process, and nothing told a running PM
 * that a release changed how PMs work). A release that changes the coordinator's tool sheet (cli lib/swarmToolSheets.ts, which
 * pins the note it was announced with) or the built-in PM schedule (pmSchedule.ts PM_SCHEDULE_TEXT, pinned by `schedule`)
 * adds a note here, newest last. Each project's PM is woken once for the newest note it has not confirmed, and its wakes and
 * inbox list it as owed until it sends `process.confirm`; the board's pulse names it until then (pulse.ts).
 */
import type { SuperTabState } from './model.js'
import { agentProjectId, type SwarmProject } from './projects.js'

/** One note: its id, its words for the PM, and the built-in schedule's fingerprint when it was written. */
export interface ProcessNote { id: string; text: string; schedule: string }

export const PROCESS_NOTES: readonly ProcessNote[] = [
  {
    id: '2026-11-06-crew',
    text: 'Swarm v2: mark your project\'s standing crew once (crew.add with a role and a lane: backend, cli, desktop, mobile or docs), '
      + 'and give each task a lane (work.lane): the Swarm hands a free crew member its lane\'s next task by itself. Start a new agent only '
      + 'to replace a broken one. Answer each person\'s message once, in its place (answer). Your tool sheet says it; '
      + '`harness super-tab help tools` has every rule.',
    schedule: '058d05641d40',
  },
]

export const latestProcessNote = (): ProcessNote | undefined => PROCESS_NOTES.at(-1)

/** The newest note [project]'s PM has not confirmed, or null. */
export function unconfirmedNote(project: Pick<SwarmProject, 'processNote'>): ProcessNote | null {
  const note = latestProcessNote()
  return note && project.processNote?.confirmed !== note.id ? note : null
}

/** Whether [project] has an agent marked crew (crew.ts). */
export const hasCrew = (state: SuperTabState, project: SwarmProject): boolean =>
  state.agents.some(a => !!a.crew && agentProjectId(state, a) === project.id)

/** The what-changed note [project]'s PM owes, for its wakes and its inbox (inbox.ts owedLines), until it confirms it. */
export function noteLines(project: SwarmProject): string[] {
  const note = unconfirmedNote(project)
  return note ? [`What changed for PMs (note ${note.id}): ${note.text} Confirm you read it: command process.confirm {"projectId":"${project.id}","noteId":"${note.id}"}.`] : []
}

/** What [project]'s PM hears at each wake about the process (pmSchedule.ts): its unconfirmed note, and, while the project has no
 *  crew, that it has none (the brief: "at its next wake until it marks one"). Neither wakes the PM by itself but the note's
 *  first time. */
export function processLines(state: SuperTabState, project: SwarmProject): string[] {
  return [
    ...noteLines(project),
    ...hasCrew(state, project) ? [] : ['No crew yet in this project: mark its standing agents once with crew.add {agentId, role, lane}. Until then this line comes with every wake.'],
  ]
}
