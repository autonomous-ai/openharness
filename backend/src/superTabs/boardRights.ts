/**
 * Who may do what in a project switched to the Board way of working (task #3819, Phase 2 of
 * docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06). A project's owner switches it on (`boardMode`).
 * In a switched project, writing in its chat is the Can chat right: its owner and the Swarm's owner always, and the people
 * the owner granted (`canChat`). Setting P0 and pausing belong to those who steer it: its owner, the Swarm's owner and its
 * top decider (`decider`). A project not switched keeps today's rules. The server checks every one of these (commands.ts,
 * store.ts poster), so an older app is held to them too.
 */
import { fail, type Actor, type Conversation, type SuperTabState } from './model.js'
import { canReadProject, ownsProject, projectsOf, type SwarmProject } from './projects.js'


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

/** Refuses [actor] writing a message into [group] when it is a switched project's chat and they may not (canChat). Every
 *  path that writes a person's message there calls it: postable (send, uploads, voice), edit, a launch's initial message
 *  and a delivery's resend. Agents and task chats are unchanged. */
export function requireCanChat(state: SuperTabState, actor: Actor, group: Conversation): void {
  if (actor.kind !== 'person') return
  // Only a project's own chat: never groupProject, which refuses a person's Buddy chat (it belongs to no project).
  const project = projectsOf(state).find(p => p.leadConversationId === group.id)
  if (!project || !switched(project) || canChat(state, project, actor.userId)) return
  fail('CHAT_NOT_ALLOWED', 'Only the project owner and the people they allow write in this project\'s chat. Ask the owner for Can chat.', 403)
}

/** Refuses a person's priority in a switched project unless they steer it or it is P1-P3 on a card they requested (the spec's
 *  "Who may do what on the Board"): P0 goes ahead of everything, so only those who steer set it or lower it. [requesterId] is
 *  the card's requester, or the one a new task names; [previous] its priority before. Agents keep today's rights. */
export function requirePriorityRight(state: SuperTabState, actor: Actor, project: SwarmProject, next: string, requesterId: string | undefined,
  previous?: string): void {
  if (actor.kind !== 'person' || !switched(project) || steers(state, project, actor.userId)) return
  if (next !== 'P0' && previous !== 'P0' && requesterId === actor.userId) return
  fail('PRIORITY_FORBIDDEN', 'In this project the owner and its decider set P0 and other people\'s priorities. You set P1-P3 on your own cards.', 403)
}

