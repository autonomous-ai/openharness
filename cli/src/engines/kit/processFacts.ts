/**
 * Facts read off a live process, as an engine's discovery contract declares them (facets/discovery.ts).
 * Moved from lib/tmux.ts (Claude's native install) and lib/codexHomeProbe.ts, whose every answer this
 * reproduces (engines/discovery.golden.spec.ts). Read on every discovery pass, so a declaration is compiled
 * once, not per row.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { DiscoveryContract } from '../facets/discovery.js'

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

/**
 * The profile home a process carries in its environment, when it is not the machine's default: a path,
 * or `null` for the default, an unset variable, or one that is relative, too long or holds a control
 * character (never a guess). Compared through real paths, as the same folder may be named two ways.
 */
export function profileFromEnv(profile: NonNullable<DiscoveryContract['profile']>, processEnv: Record<string, string>, defaultHome: string): string | null {
  const home = processEnv[profile.variable]
  if (!home || !isAbsolute(home) || home.length > 4096 || /[\x00-\x1f\x7f]/.test(home)) return null
  return canonical(home) === canonical(defaultHome) ? null : home
}
