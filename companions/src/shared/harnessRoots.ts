/**
 * Where Harness keeps its data and its state: the CLI's rule (cli/src/config/harnessHome.ts), written again here
 * because this package ships alone. On Linux the XDG roots once the data root exists, else `~/.harness` while that
 * exists, else the XDG roots; macOS and Windows keep `~/.harness`.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

export function harnessRoots(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform, exists: (path: string) => boolean = existsSync): { data: string; state: string } {
  // The given platform's join, not the host's, so one platform can build (and test) the other's paths.
  const legacy = (platform === 'win32' ? win32 : posix).join(home, '.harness')
  if (platform !== 'linux') return { data: legacy, state: legacy }
  // XDG holds a relative value invalid, so it counts as unset, as an empty one does.
  const base = (name: string, fallback: string) => {
    const value = env[name]
    return value && posix.isAbsolute(value) ? value : posix.join(home, fallback)
  }
  const xdg = { data: posix.join(base('XDG_DATA_HOME', '.local/share'), 'harness'), state: posix.join(base('XDG_STATE_HOME', '.local/state'), 'harness') }
  return exists(xdg.data) || !exists(legacy) ? xdg : { data: legacy, state: legacy }
}
