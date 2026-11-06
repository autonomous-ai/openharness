/**
 * Who may do what in a project switched to the Board way of working (task #3819, Phase 2 of
 * docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06). A project's owner switches it on (`boardMode`).
 * In a switched project, writing in its chat is the Can chat right: its owner and the Swarm's owner always, and the people
 * the owner granted (`canChat`). Setting P0 and pausing belong to those who steer it: its owner, the Swarm's owner and its
 * top decider (`decider`). A project not switched keeps today's rules. The server checks every one of these (commands.ts,
 * store.ts poster), so an older app is held to them too.
 */
import type { SuperTabState } from './model.js'
import { canReadProject, ownsProject, type SwarmProject } from './projects.js'

/** Whether [project] works the Board way. */
export const switched = (project: Pick<SwarmProject, 'boardMode'>): boolean => project.boardMode === true

/** Whether [userId] is a member of the Swarm who reads [project]: a person who left keeps no right. */
export function readsProject(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  const person = state.people.find(p => p.id === userId)
  return !!person && canReadProject(state, { kind: 'person', userId: person.id, email: person.email ?? '' }, project)
}

/** Whether [userId] owns [project] or the Swarm: who sets its Board settings. */
export function ownsBoard(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  return ownsProject(state, userId, project) || (userId === state.ownerId && state.people.some(p => p.id === userId))
}

/** Whether [userId] steers [project]: sets P0 on any card and pauses or resumes any task (its owners and its decider). */
export function steers(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  return ownsBoard(state, project, userId) || (!!project.decider && project.decider === userId && readsProject(state, project, userId))
}

/** Whether [userId] may write in [project]'s chat once it is switched: its owners, and the people granted Can chat. */
export function canChat(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  return ownsBoard(state, project, userId) || (!!project.canChat?.includes(userId) && readsProject(state, project, userId))
}
