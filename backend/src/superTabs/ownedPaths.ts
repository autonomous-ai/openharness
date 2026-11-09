/** A task's owned paths (WorkTask.owns), compared: cross-project overlap alerts (commands.ts alertOverlaps) and the helper
 *  check (members.ts helperCheck) read them alike. */

/** The repo path an owns entry names, or null for anything else (a phrase, a glob), which is never compared. */
export function ownedPath(entry: string): string | null {
  const path = entry.trim().replace(/^\.\//, '').replace(/\/+$/, '')
  return /^[\w.@-]+(\/[\w.@-]+)*$/.test(path) ? path : null
}

/** Whether two owned paths overlap: the same path, or one a folder of the other. */
export const pathsOverlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
