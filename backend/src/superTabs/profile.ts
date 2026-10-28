import { z } from 'zod'
import { agent, fail, person, type Actor, type SuperTabState } from './model.js'
import { agentProjectId, ledProject } from './projects.js'

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

/** Pictures a person may pick instead of uploading one; Desktop draws each. */
export const AVATAR_PRESETS = ['fox', 'owl', 'cat', 'panda', 'octopus', 'cactus', 'rocket', 'sun'] as const
/** What a member or agent shows: an uploaded picture or a preset. Absent: the default, initials for a person, a pattern from
 *  the name for an agent (Desktop). An upload keeps its object's key in the private avatar bucket; readers never get the key,
 *  only a short-lived signed link with each read (avatarLinks.ts). */
export type Avatar = { kind: 'upload'; key: string } | { kind: 'preset'; key: (typeof AVATAR_PRESETS)[number] }
/** An avatar as readers get it: an upload says only that there is one. */
export type AvatarView = { kind: 'upload' } | Extract<Avatar, { kind: 'preset' }>
export const avatarView = (avatar: Avatar): AvatarView => avatar.kind === 'upload' ? { kind: 'upload' } : avatar
/** [holder] as readers get it, its avatar's stored key left out. */
export function withAvatarView<T extends { avatar?: Avatar }>(holder: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  return holder.avatar ? { ...holder, avatar: avatarView(holder.avatar) } : holder
}
export const avatarChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z.object({ kind: z.literal('preset'), key: z.enum(AVATAR_PRESETS) }).strict(),
]).nullable()
type AvatarChoice = z.infer<typeof avatarChoice>
/** The avatar upload a command names, found by the store: this actor's, an avatar, and not used yet. */
export interface AvatarUpload { id: string; key: string }

function chosen(choice: NonNullable<AvatarChoice>, upload: AvatarUpload | undefined): Avatar {
  if (choice.kind === 'preset') return choice
  if (upload?.id !== choice.id) fail('AVATAR_UNAVAILABLE', 'Upload this picture again before using it.', 400)
  return { kind: 'upload', key: upload.key }
}

/** `member.avatar`: a person sets or clears their own avatar. */
export function setMemberAvatar(state: SuperTabState, actor: Actor, choice: AvatarChoice, upload: AvatarUpload | undefined): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Set an agent\'s avatar with its own command.', 403)
  const member = person(state, actor.userId)
  if (!choice) return void delete member.avatar
  member.avatar = chosen(choice, upload)
}

/** `agent.avatar`: the person who contributed the agent, or the Lead of its project, sets or clears its avatar. */
export function setAgentAvatar(state: SuperTabState, actor: Actor, agentId: string, choice: AvatarChoice, upload: AvatarUpload | undefined): void {
  const target = agent(state, agentId)
  const allowed = actor.kind === 'person' ? actor.userId === target.contributorId
    : ledProject(state, actor.agentId)?.id === agentProjectId(state, target)
  if (!allowed) fail('FORBIDDEN', 'Only the agent\'s contributor or its project\'s Lead can change its avatar.', 403)
  if (!choice) return void delete target.avatar
  target.avatar = chosen(choice, upload)
}
