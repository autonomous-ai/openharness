import { z } from 'zod'
import { type Conversation } from './model.js'

/**
 * Why a task is held, as a Swarm from before v4 stored it: a not-before date on the Next-up queue (work.queue), or an agent's
 * blocked or needs_human status (work.status); both commands are retired (2026-11-10), so readers read only what is stored. Not
 * the delivery `holdReason` (holdReason.ts), which is a host's reason for not typing a message yet.
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

/** What a reader shows for a held task: its reason, else "no reason" for a hold from before reasons. Absent when it is not held. */
export function heldView(group: Conversation): HeldView | undefined {
  const status = group.assignment?.status
  if (group.notBefore !== undefined) return group.hold ?? { kind: 'none' }
  if (status === 'blocked' || status === 'needs_human') return group.assignment!.hold ?? { kind: 'none' }
  return undefined
}
