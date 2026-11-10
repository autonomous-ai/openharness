
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
/** A person as readers get them: [withAvatarView], without the name they chose before their name followed their account
 *  (personNames.ts nameFromAccount). A person with neither stored is read as `withAvatarView` reads them, with no copy. */
export function personView<T extends { avatar?: Avatar }>(holder: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  if (!('chosenName' in holder) && !('nameFollowsAccount' in holder)) return withAvatarView(holder)
  const { chosenName: _chosen, nameFollowsAccount: _follows, ...rest } = holder as T & { chosenName?: unknown; nameFollowsAccount?: unknown }
  return withAvatarView(rest as T)
}
