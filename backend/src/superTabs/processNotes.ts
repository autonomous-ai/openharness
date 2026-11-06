/**
 * What changed for PMs (task #3581, anh Dee 11-06: lamp's PM did not know the Swarm v2 process, and nothing told a running PM
 * that a release changed how PMs work). A release that changes the coordinator's tool sheet (cli lib/swarmToolSheets.ts, which
 * pins the note it was announced with) or the built-in PM schedule (pmSchedule.ts PM_SCHEDULE_TEXT, pinned by `schedule`)
 * adds a note here, newest last. Each project's PM is woken once for the newest note it has not confirmed, and its wakes and
 * inbox list every note it has not confirmed as owed until it confirms the newest with `process.confirm`; the board's pulse names it until then (pulse.ts).
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
  {
    id: '2026-11-06-v2-text',
    text: 'Your built-in PM text now opens with the Swarm v2 process, which replaces every process line in your project\'s instructions: '
      + 'they keep only your project\'s own facts. Review and test steps open by themselves when a pull request is ready; don\'t open them by '
      + 'hand. Lost, stalled and idle notices are information: the Swarm hands lost work on, nudges stalled workers and stops idle Engineers '
      + 'by itself, so don\'t repeat those by hand. A rule a program can check belongs in code, not in your instructions.',
    schedule: '52cb6172d956',
  },
]

export const latestProcessNote = (): ProcessNote | undefined => PROCESS_NOTES.at(-1)

/** Every note after the newest one [project]'s PM confirmed, oldest first: all of them when it confirmed none (SecAlder's review:
 *  a PM that missed a note still reads it when the next one ships). Confirming the newest clears them all. */
export function unconfirmedNotes(project: Pick<SwarmProject, 'processNote'>): ProcessNote[] {
  return PROCESS_NOTES.slice(noteIndex(project.processNote?.confirmed) + 1)
}

/** The newest note [project]'s PM has not confirmed, or null: the one a wake is for and the board names. */
export const unconfirmedNote = (project: Pick<SwarmProject, 'processNote'>): ProcessNote | null => unconfirmedNotes(project).at(-1) ?? null

/** [id]'s place in PROCESS_NOTES, or -1 for none or an unknown one. */
export const noteIndex = (id: string | undefined): number => PROCESS_NOTES.findIndex(note => note.id === id)

/** Whether [project] has an agent marked crew (crew.ts). */
export const hasCrew = (state: SuperTabState, project: SwarmProject): boolean =>
  state.agents.some(a => !!a.crew && agentProjectId(state, a) === project.id)

/** The what-changed notes [project]'s PM owes, oldest first, for its wakes and its inbox (inbox.ts owedLines), until it confirms it. */
export function noteLines(project: SwarmProject): string[] {
  const notes = unconfirmedNotes(project)
  const newest = notes.at(-1)
  if (!newest) return []
  return [...notes.map(note => `What changed for PMs (note ${note.id}): ${note.text}`),
    `Confirm you read ${notes.length > 1 ? 'them' : 'it'}: command process.confirm {"projectId":"${project.id}","noteId":"${newest.id}"}.`]
}

/** What [project]'s PM hears at each wake about the process (pmSchedule.ts): its unconfirmed notes, and, while the project has no
 *  crew, that it has none (the brief: "at its next wake until it marks one"). Neither wakes the PM by itself but the note's
 *  first time. */
export function processLines(state: SuperTabState, project: SwarmProject): string[] {
  return [
    ...noteLines(project),
    ...hasCrew(state, project) ? [] : ['No crew yet in this project: mark its standing agents once with crew.add {agentId, role, lane}. Until then this line comes with every wake.'],
  ]
}
