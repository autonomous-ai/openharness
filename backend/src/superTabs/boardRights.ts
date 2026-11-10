/**
 * Who may do what in a project switched to the Board way of working (task #3819, Phase 2 of
 * docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06). Swarm v4 retired the settings' commands
 * (2026-11-10), so nobody switches a project or changes who steers it now, and its chat is every reader's again. A project
 * switched before keeps its proposal cards (proposalCards.ts), where setting P0 still belongs to those who steer it: its owner,
 * the Swarm's owner and its stored top decider (`decider`).
 */
import type { SuperTabState } from './model.js'
import { canReadProject, ownsProject, type SwarmProject } from './projects.js'


/** Whether [project] works the Board way. */
export const switched = (project: Pick<SwarmProject, 'boardMode'>): boolean => project.boardMode === true

/** Whether [userId] is a member of the Swarm who reads [project]: a person who left keeps no right. */
function readsProject(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  const person = state.people.find(p => p.id === userId)
  return !!person && canReadProject(state, { kind: 'person', userId: person.id, email: person.email ?? '' }, project)
}

/** Whether [userId] steers [project]: sets P0 on any card (its owners, the Swarm's owner and its decider). */
export function steers(state: SuperTabState, project: SwarmProject, userId: string): boolean {
  return ownsProject(state, userId, project) || (userId === state.ownerId && state.people.some(p => p.id === userId))
    || (!!project.decider && project.decider === userId && readsProject(state, project, userId))
}
