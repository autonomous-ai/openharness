import { z } from 'zod'
import { agent, fail, person, type Actor, type SuperTabState } from './model.js'
import { agentProjectId, projectAgent } from './projects.js'

// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
export const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** Pictures a person may pick instead of uploading one; Desktop draws each. */
export const AVATAR_PRESETS = ['fox', 'owl', 'cat', 'panda', 'octopus', 'cactus', 'rocket', 'sun'] as const
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
/** A person as readers get them: [withAvatarView], and without the status and time zone that Swarms from before v4 stored for them.
 *  Nothing sets either any more (2026-11-09) and no app draws them, so a status with no end would only haunt an older app for
 *  ever. The stored values can go from 2026-12-09. */
export function personView<T extends { avatar?: Avatar }>(person: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  const { status: _status, timeZone: _timeZone, ...rest } = person as T & { status?: unknown; timeZone?: unknown }
  return withAvatarView(rest as T)
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

/** `agent.avatar`: the person who contributed the agent, or any agent of its project (project instructions, phase 4), sets or
 *  clears its avatar. */
export function setAgentAvatar(state: SuperTabState, actor: Actor, agentId: string, choice: AvatarChoice, upload: AvatarUpload | undefined): void {
  const target = agent(state, agentId)
  const allowed = actor.kind === 'person' ? actor.userId === target.contributorId : projectAgent(state, actor, agentProjectId(state, target))
  if (!allowed) fail('FORBIDDEN', 'Only the agent\'s contributor or an agent of its project can change its avatar.', 403)
  if (!choice) return void delete target.avatar
  target.avatar = chosen(choice, upload)
}
