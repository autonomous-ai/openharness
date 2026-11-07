/**
 * What changed for PMs (task #3581, anh Dee 11-06: lamp's PM did not know the Swarm v2 process, and nothing told a running PM
 * that a release changed how PMs work). A release that changes the coordinator's tool sheet (cli lib/swarmToolSheets.ts, which
 * pins the note it was announced with) or the built-in PM schedule (pmSchedule.ts PM_SCHEDULE_TEXT, pinned by `schedule`)
 * adds a note here, newest last. Each project's PM is woken once for the newest note it has not confirmed, and its wakes and
 * inbox list every note it has not confirmed as owed until it confirms the newest with `process.confirm`; the board's pulse names it until then (pulse.ts).
 */
import type { SuperTabState } from './model.js'
import { agentProjectId, type SwarmProject } from './projects.js'
import { REBASE_SWARMS } from './migration/rebase.js'

/** One note: its id, its words for the PM, and the built-in schedule's fingerprint when it was written. `rebasedOnly`: for the
 *  Swarms whose instructions moved onto the base (migration/rebase.ts REBASE_SWARMS) alone, as the text it announces is. */
export interface ProcessNote { id: string; text: string; schedule: string; rebasedOnly?: true }

/** Whether [swarm] is one whose instructions moved onto the base (migration/rebase.ts): its PM reads the v2 process text. */
export const isRebasedSwarm = (swarm: Pick<SuperTabState, 'id'>): boolean => REBASE_SWARMS.some(rebased => rebased.tabId === swarm.id)

export const PROCESS_NOTES: readonly ProcessNote[] = [
  {
    id: '2026-11-06-crew',
    text: 'Swarm v2: mark your project\'s standing crew once (crew.add with a role and a lane: backend, cli, desktop, mobile or docs), '
      + 'and give each task a lane (work.lane): the Swarm hands a free crew member its lane\'s next task by itself. Start a new agent only '
      + 'to replace a broken one. Your tool sheet says it; '
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
    // Diego 11-06 (#4097): the v2 text replaces process lines only where the instructions moved onto the base.
    rebasedOnly: true,
  },
]

export const latestProcessNote = (): ProcessNote | undefined => PROCESS_NOTES.at(-1)

/** Every note after the newest one [project]'s PM confirmed, oldest first: all of them when it confirmed none (SecAlder's review:
 *  a PM that missed a note still reads it when the next one ships). Confirming the newest clears them all. A note for the
 *  rebased Swarms is none of another Swarm's. */
export function unconfirmedNotes(swarm: Pick<SuperTabState, 'id'>, project: Pick<SwarmProject, 'processNote'>): ProcessNote[] {
  const rebased = isRebasedSwarm(swarm)
  return PROCESS_NOTES.slice(noteIndex(project.processNote?.confirmed) + 1).filter(note => rebased || !note.rebasedOnly)
}

/** The newest note [project]'s PM has not confirmed, or null: the one a wake is for and the board names. */
export const unconfirmedNote = (swarm: Pick<SuperTabState, 'id'>, project: Pick<SwarmProject, 'processNote'>): ProcessNote | null =>
  unconfirmedNotes(swarm, project).at(-1) ?? null

/** [id]'s place in PROCESS_NOTES, or -1 for none or an unknown one. */
export const noteIndex = (id: string | undefined): number => PROCESS_NOTES.findIndex(note => note.id === id)

/** Whether [project] has an agent marked crew (crew.ts). */
export const hasCrew = (state: SuperTabState, project: SwarmProject): boolean =>
  state.agents.some(a => !!a.crew && agentProjectId(state, a) === project.id)

/** The what-changed notes [project]'s PM owes, oldest first, for its wakes and its inbox (inbox.ts owedLines), until it confirms it. */
export function noteLines(swarm: Pick<SuperTabState, 'id'>, project: SwarmProject): string[] {
  const notes = unconfirmedNotes(swarm, project)
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
    ...noteLines(state, project),
    ...hasCrew(state, project) ? [] : ['No crew yet in this project: mark its standing agents once with crew.add {agentId, role, lane}. Until then this line comes with every wake.'],
  ]
}
