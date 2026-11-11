// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
export const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** A person or agent as readers get them: without the name they chose before their name followed their account (personNames.ts
 *  nameFromAccount), and without an avatar stored before the avatar read path went, whose object key stays on the server (goes
 *  with the avatar objects' removal, S19). One with none of these stored is read as stored, with no copy. */
export function personView<T extends object>(holder: T): T {
  if (!('chosenName' in holder) && !('nameFollowsAccount' in holder) && !('avatar' in holder)) return holder
  const { chosenName: _chosen, nameFollowsAccount: _follows, avatar: _avatar, ...rest } = holder as T & { chosenName?: unknown; nameFollowsAccount?: unknown; avatar?: unknown }
  return rest as T
}
