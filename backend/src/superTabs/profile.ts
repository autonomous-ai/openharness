// Control, format (bidi overrides, zero-width) and line/paragraph separators: words that hide their real shape.
export const printable = (value: string) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)

/** A person as readers get them: without the name they chose before their name followed their account (personNames.ts
 *  nameFromAccount). A person with neither stored is read as stored, with no copy. */
export function personView<T extends object>(holder: T): T {
  if (!('chosenName' in holder) && !('nameFollowsAccount' in holder)) return holder
  const { chosenName: _chosen, nameFollowsAccount: _follows, ...rest } = holder as T & { chosenName?: unknown; nameFollowsAccount?: unknown }
  return rest as T
}
