/**
 * The home another process uses, worked out from its own environment, never from the daemon's: a sandboxed or
 * re-homed agent names its home in its environment, and the daemon's `HOME` is not its. The rule is Hermes's own
 * (`hermes_constants.py` `hermes_root_for_environment`, `_platform_default_hermes_home`, `get_process_hermes_home`):
 * names looked up upper-cased, `%NAME%`, `${NAME}`, `$NAME` and a leading `~` expanded from that environment alone,
 * and no answer where it would depend on anything outside it. Reads nothing but its arguments.
 */
import path from 'node:path'

/** Where an engine keeps its home: the variable naming it, the folder under the user's folder by default (another on
 *  Windows), and the variable whose value is appended to that folder as it is. */
export interface ProcessHomeRule { variable: string; folder: string; windowsFolder: string; suffix: string }

const REFERENCE = /%([^%]+)%|\$\{([^}]+)\}|\$([A-Za-z0-9_-]+)/g
const MAX_LENGTH = 4096
const CONTROL = /[\u0000-\u001f\u007f]/u

/** The home a process started with `environment` uses, or `undefined` when the environment alone cannot say. */
export function homeFromEnvironment(rule: ProcessHomeRule, environment: Readonly<Record<string, string>>, platform: NodeJS.Platform): string | undefined {
  const names = upperCased(environment)
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const user = (names[windows ? 'USERPROFILE' : 'HOME'] ?? '').trim() || undefined
  const raw = (names[rule.variable] ?? '').trim()
  if (!raw) {
    const folder = (windows ? rule.windowsFolder : rule.folder) + (names[rule.suffix] ?? '')
    if (!windows) return user && paths.join(user, folder)
    const local = (names.LOCALAPPDATA ?? '').trim()
    if (local) return paths.join(local, folder)
    return user && paths.join(user, 'AppData', 'Local', folder)
  }
  let unknown = false
  let expanded = raw.replace(REFERENCE, (_match, ...groups: (string | undefined)[]) => {
    const value = names[groups.slice(0, 3).find((group) => group !== undefined)!.toUpperCase()]
    if (value === undefined) unknown = true
    return value ?? ''
  })
  if (unknown) return undefined
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    if (!user) return undefined
    expanded = user + expanded.slice(1)
  }
  if (!paths.isAbsolute(expanded) || expanded.length > MAX_LENGTH || CONTROL.test(expanded)) return undefined
  return withoutTrailingSeparators(expanded, paths)
}

/** Whether the process set the home's variable itself, so its home is not worked out from `HOME`. */
export function homeIsNamed(rule: ProcessHomeRule, environment: Readonly<Record<string, string>>): boolean {
  return (upperCased(environment)[rule.variable] ?? '').trim() !== ''
}

// Windows names are case-insensitive, and Hermes looks every name up upper-cased on every platform.
function upperCased(environment: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).map(([name, value]) => [name.toUpperCase(), value]))
}

// The root itself (`/`, `C:\`) keeps its separator: without it it is no longer the same folder.
function withoutTrailingSeparators(home: string, paths: path.PlatformPath): string {
  const root = paths.parse(home).root.length
  let end = home.length
  while (end > root && (home[end - 1] === '/' || (paths === path.win32 && home[end - 1] === '\\'))) end--
  return home.slice(0, end)
}
