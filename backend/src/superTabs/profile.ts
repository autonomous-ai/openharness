// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
export const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** The built-in pictures a person or an agent may wear. Nothing sets one any more (2026-11-09), but each that was set is still read,
 *  and Desktop and the phone draw it. */
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
 *  ever. A person with neither stored is read as `withAvatarView` always read them, with no copy. The stored values can go from
 *  2026-12-09. */
export function personView<T extends { avatar?: Avatar }>(holder: T): Omit<T, 'avatar'> & { avatar?: AvatarView } {
  if (!('status' in holder) && !('timeZone' in holder)) return withAvatarView(holder)
  const { status: _status, timeZone: _timeZone, ...rest } = holder as T & { status?: unknown; timeZone?: unknown }
  return withAvatarView(rest as T)
}
