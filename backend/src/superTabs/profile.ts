import { z } from 'zod'
import { fail, person, type Actor, type SuperTabState } from './model.js'

/** The emoji a status may wear. Desktop offers each with its words (focus, coffee, lunch, out, away, sick). */
export const STATUS_EMOJI = ['🎯', '☕', '🍽️', '🌴', '🚶', '🤒'] as const
export const MAX_STATUS_LENGTH = 80

/** A person's short status, shown beside their avatar until `until` passes; then readers drop it. */
export interface PersonStatus { text: string; emoji: (typeof STATUS_EMOJI)[number] | null; until: string | null }

// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
export const statusSchema = z.object({
  text: z.string().trim().min(1).max(MAX_STATUS_LENGTH).refine(printable, 'Use printable words.'),
  emoji: z.enum(STATUS_EMOJI).nullable().optional(),
  until: z.iso.datetime().nullable().optional(),
}).strict()

/** `member.status`: a person sets or clears their own status. Members read it with the rest of the Swarm, nobody else. */
export function setStatus(state: SuperTabState, actor: Actor, status: z.infer<typeof statusSchema> | null, now: number): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Only a person has a status.', 403)
  const member = person(state, actor.userId)
  if (!status) return void delete member.status
  const until = status.until ? new Date(status.until).toISOString() : null
  if (until && Date.parse(until) <= now) fail('STATUS_EXPIRED', 'Choose a time that has not passed yet.', 400)
  member.status = { text: status.text, emoji: status.emoji ?? null, until }
}
