/**
 * Where Harness keeps its data and its state: the CLI's rule (cli/src/config/harnessHome.ts), written again here
 * because this package ships alone. On Linux the XDG roots once the data root holds its marker (`.harness-root`, a
 * file: a folder of its name is none), else `~/.harness` while that exists, else the XDG roots; macOS and Windows keep
 * `~/.harness`.
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** A regular file, through a link as the installers' `test -f` looks; a folder, or nothing, is none. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function harnessRoots(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform, exists: (path: string) => boolean = existsSync, isFile: (path: string) => boolean = isRegularFile): { data: string; state: string } {
  // The given platform's join, not the host's, so one platform can build (and test) the other's paths.
  const legacy = (platform === 'win32' ? win32 : posix).join(home, '.harness')
  if (platform !== 'linux') return { data: legacy, state: legacy }
  // XDG holds a relative value invalid, so it counts as unset, as an empty one does.
  const base = (name: string, fallback: string) => {
    const value = env[name]
    return value && posix.isAbsolute(value) ? value : posix.join(home, fallback)
  }
  const xdg = { data: posix.join(base('XDG_DATA_HOME', '.local/share'), 'harness'), state: posix.join(base('XDG_STATE_HOME', '.local/state'), 'harness') }
  return isFile(posix.join(xdg.data, '.harness-root')) || !exists(legacy) ? xdg : { data: legacy, state: legacy }
}
