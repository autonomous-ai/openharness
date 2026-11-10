/**
 * Steps inside a task (design docs/plans/2026-11-02-task-steps-design.md). A step is a linked group (`reviewOf` names its
 * task) with a name the project's instructions gave. Swarm v4 opens none (2026-11-10); a Swarm from before still stores some,
 * which the task readers that remain tell apart until they go with the task records (slice S13).
 */
import type { Conversation } from './model.js'

/** Whether [group] is a step of a task: any linked group, named or not. Ken, 2026-11-02: a PM that opened "Test: PR #2514"
 *  the old way, a minute after saving the steps workflow, still heard every Tester post; what reaches the PM must not rest on
 *  an agent remembering the workflow. */
export const isStep = (group: Pick<Conversation, 'reviewOf'>): boolean => !!group.reviewOf

/** A step's name: the one it was opened with, else its title (a linked group opened without one). */
export const stepName = (group: Pick<Conversation, 'step' | 'title'>): string => group.step ?? group.title
