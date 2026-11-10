import { z } from 'zod'
import { agent, fail, person, type Actor, type SuperTabState } from './model.js'
import { agentProjectId, projectAgent } from './projects.js'
import { PICTURES_RETIRED } from './retired.js'

// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
export const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** The built-in pictures a person or an agent may wear. Nothing sets one any more (2026-11-09), but each that was set is still read,
 *  and Desktop and the phone draw it. */
const AVATAR_PRESETS = ['fox', 'owl', 'cat', 'panda', 'octopus', 'cactus', 'rocket', 'sun'] as const
/** What a member or agent shows: an uploaded picture or a preset. Absent: the default, initials for a person, a pattern from
 *  the name for an agent (Desktop). An upload keeps its object's key on the server; readers never get the key, only a link with
 *  each read (avatarLinks.ts), signed for an hour wherever the picture is kept. */
export type Avatar = { kind: 'upload'; key: string } | { kind: 'preset'; key: (typeof AVATAR_PRESETS)[number] }
/** An avatar as readers get it: an upload says only that there is one. */
export type AvatarView = { kind: 'upload' } | Extract<Avatar, { kind: 'preset' }>
export const avatarView = (avatar: Avatar): AvatarView => avatar.kind === 'upload' ? { kind: 'upload' } : avatar
/** [holder] as readers get it, its avatar's stored key left out. */
export function withAvatarView<T extends { avatar?: Avatar }>(holder: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  return holder.avatar ? { ...holder, avatar: avatarView(holder.avatar) } : holder
}
/** A person as readers get them: [withAvatarView], and without the status and time zone that Swarms from before v4 stored for them,
 *  or the name they chose before their name followed their account (personNames.ts nameFromAccount). Nothing sets a status or a
 *  zone any more (2026-11-09) and no app draws them, so a status with no end would only haunt an older app for ever. A person with
 *  none of these stored is read as `withAvatarView` always read them, with no copy. The stored values can go from 2026-12-09. */
export function personView<T extends { avatar?: Avatar }>(holder: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  if (!('status' in holder) && !('timeZone' in holder) && !('chosenName' in holder) && !('nameFollowsAccount' in holder)) return withAvatarView(holder)
  const { status: _status, timeZone: _timeZone, chosenName: _chosen, nameFollowsAccount: _follows, ...rest } =
    holder as T & { status?: unknown; timeZone?: unknown; chosenName?: unknown; nameFollowsAccount?: unknown }
  return withAvatarView(rest as T)
}
/** What an older app sends as a picture: an upload's id, a built-in one, or none. Parsed whole, so a picture is refused in words
 *  (PICTURES_RETIRED) rather than as a malformed command. */
export const avatarChoice = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), id: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z.object({ kind: z.literal('preset'), key: z.enum(AVATAR_PRESETS) }).strict(),
]).nullable()
type AvatarChoice = z.infer<typeof avatarChoice>

/** Clearing is all a picture command still does (2026-11-09): a new picture is refused in words. */
function clearOnly(holder: { avatar?: Avatar }, choice: AvatarChoice): void {
  if (choice) fail(PICTURES_RETIRED.code, PICTURES_RETIRED.message, PICTURES_RETIRED.status)
  delete holder.avatar
}

/** `member.avatar`: a person clears their own picture. */
export function setMemberAvatar(state: SuperTabState, actor: Actor, choice: AvatarChoice): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Set an agent\'s avatar with its own command.', 403)
  clearOnly(person(state, actor.userId), choice)
}

/** `agent.avatar`: the person who contributed the agent, or any agent of its project (project instructions, phase 4), clears its
 *  picture. */
export function setAgentAvatar(state: SuperTabState, actor: Actor, agentId: string, choice: AvatarChoice): void {
  const target = agent(state, agentId)
  const allowed = actor.kind === 'person' ? actor.userId === target.contributorId : projectAgent(state, actor, agentProjectId(state, target))
  if (!allowed) fail('FORBIDDEN', 'Only the agent\'s contributor or an agent of its project can change its avatar.', 403)
  clearOnly(target, choice)
}
