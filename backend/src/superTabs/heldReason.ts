import { z } from 'zod'
import { fail, type Conversation, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'

/**
 * Why a task is held: a not-before date on the Next-up queue (work.queue), or an agent's blocked or needs_human status
 * (work.status). Exactly four reasons are real (anh Dee's Swarm redesign, 2026-11-05; #3390); the server refuses a hold that
 * names none (HOLD_REASON_MISSING), and the refusal lists the four. Not the delivery `holdReason` (holdReason.ts), which is a
 * host's reason for not typing a message yet.
 */
export const heldReason = z.discriminatedUnion('kind', [
  /** Waits on another task of the project. */
  z.object({ kind: z.literal('task'), taskNumber: z.number().int().positive().safe() }).strict(),
  /** Waits on a person who was asked, and what happens at `defaultAt` if they have not answered. */
  z.object({ kind: z.literal('person'), personId: z.string().min(1).max(200), defaultAt: z.iso.datetime() }).strict(),
  /** Waits for a quota or a machine to reset at `at`. */
  z.object({ kind: z.literal('reset'), what: z.enum(['quota', 'machine']), at: z.iso.datetime() }).strict(),
  /** The task's requester asked for it later. */
  z.object({ kind: z.literal('requester') }).strict(),
])
export type HeldReason = z.infer<typeof heldReason>

/** What a hold looks like where no reason was recorded: every hold from before reasons, shown as "no reason". */
export type HeldView = HeldReason | { kind: 'none' }

export const HELD_REASON_KINDS = ['task', 'person', 'reset', 'requester'] as const
/** The refusal's words: the four kinds, each with the fields it takes, so the next command can be right. */
export const HELD_REASON_HELP = 'Say why it is held, with "hold" set to one of: {"kind":"task","taskNumber":N} (waits on task #N); '
  + '{"kind":"person","personId":"PERSON","defaultAt":"ISO time"} (waits on a person already asked, and when the default applies); '
  + '{"kind":"reset","what":"quota"|"machine","at":"ISO time"} (waits for a reset); {"kind":"requester"} (the requester asked for later).'

/** A hold with no reason is refused, naming the four kinds. */
export function missingReason(): never {
  return fail('HOLD_REASON_MISSING', `A held task needs a reason. ${HELD_REASON_HELP}`, 400)
}

/**
 * The facts a reason claims, checked against the Swarm: the task it waits on is another task of this project, the person is a
 * member, the requester exists. A reason that is not true is no reason.
 */
export function checkReason(state: SuperTabState, group: Conversation, reason: HeldReason): void {
  if (reason.kind === 'task') {
    const project = groupProject(state, group).id
    const other = state.conversations.find(c => c.number === reason.taskNumber && !c.archived && groupProject(state, c).id === project)
    if (!other || other.id === group.id) fail('HOLD_REASON_MISSING', `Task #${reason.taskNumber} is not another open task of this project. ${HELD_REASON_HELP}`, 400)
  }
  else if (reason.kind === 'person') {
    if (!state.people.some(p => p.id === reason.personId)) fail('HOLD_REASON_MISSING', `${reason.personId} is not a member of this Swarm. ${HELD_REASON_HELP}`, 400)
  }
  else if (reason.kind === 'requester' && !group.requesterId) {
    fail('HOLD_REASON_MISSING', `This task has no requester who could have asked for later. ${HELD_REASON_HELP}`, 400)
  }
}

/** What a reader shows for a held task: its reason, else "no reason" for a hold from before reasons. Absent when it is not held. */
export function heldView(group: Conversation): HeldView | undefined {
  const status = group.assignment?.status
  if (group.notBefore !== undefined) return group.hold ?? { kind: 'none' }
  if (status === 'blocked' || status === 'needs_human') return group.assignment!.hold ?? { kind: 'none' }
  return undefined
}
