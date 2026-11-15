/**
 * Facts read off a live process, as an engine's discovery contract declares them (facets/discovery.ts).
 * Moved from lib/tmux.ts (Claude's native install) and lib/codexHomeProbe.ts, whose every answer this
 * reproduces (engines/discovery.golden.spec.ts). Read on every discovery pass, so a declaration is compiled
 * once, not per row.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Whether a path is a binary in the declared folder of versions, under any prefix, whatever its separators
 * and case. Compiled once per declaration.
 */
export function versionedInstallMatcher(path: string): (value: string) => boolean {
  const pattern = new RegExp(`(?:^|/)${escape(path)}/[^/]+$`)
  return (value) => pattern.test(value.replace(/\\/g, '/').toLowerCase())
}

function canonical(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** Whether a path could be an engine's home: absolute, at most 1,024 characters, no control character. */
export function homeShaped(home: string): boolean {
  return isAbsolute(home) && home.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(home)
}

/**
 * A reported profile home, when it could be one (`homeShaped`) and is not the machine's default, compared through real
 * paths, as the same folder may be named two ways. `null` for the default and for a value that could not be a home
 * (never a guess).
 */
export function profileHome(home: string, defaultHome: string): string | null {
  if (!homeShaped(home)) return null
  return canonical(home) === canonical(defaultHome) ? null : home
}
