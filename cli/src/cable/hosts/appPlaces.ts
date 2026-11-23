/**
 * Where the Claude and ChatGPT apps keep their stores and programs on each OS
 * (docs/plans/2026-11-20-dial-app-sessions-win-linux-design.md). Pure values, no I/O, so every OS's answer is tested on
 * any computer. A folder variable counts only when it is non-empty and absolute for that OS, as herdrSocketPath reads
 * it (herdrClient.ts); otherwise the profile's default stands in.
 */
import { type PlatformPath, posix, win32 } from 'node:path'

/** The package family of the Claude app from the Microsoft Store: Windows keeps its `%APPDATA%` writes under it. */
export const CLAUDE_MSIX_FAMILY = 'Claude_pzs8sxrjxfjjc'

/** A Claude store root and the folders a watch can wait on while it is missing: the root, then each folder above it,
 *  nearest first, down to the stop folder. */
export interface ClaudeStoreRoot { root: string; watch: readonly string[] }

const SESSIONS = 'claude-code-sessions'

/**
 * The root at `stop` joined with `below`, and its watch chain. A stop folder that is the home folder is left out: a
 * watch on home would wake on every file anyone makes there.
 */
function chained(path: PlatformPath, home: string, stop: string, below: readonly string[]): ClaudeStoreRoot {
  const chain = [stop]
  for (const name of below) chain.push(path.join(chain.at(-1)!, name))
  if (path.relative(stop, home) === '') chain.shift()
  return { root: chain.at(-1)!, watch: chain.reverse() }
}

/** The Claude app's session stores, in the order they are read: on Windows the MSIX app's private copy first, since
 *  that app reads its own copy before `%APPDATA%`. */
export function claudeStoreRoots(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): ClaudeStoreRoot[] {
  if (platform === 'darwin') return [chained(posix, home, posix.join(home, 'Library', 'Application Support', 'Claude'), [SESSIONS])]
  if (platform === 'win32') {
    const set = (value: string | undefined): value is string => !!value && win32.isAbsolute(value)
    const local = set(env.LOCALAPPDATA) ? env.LOCALAPPDATA : win32.join(home, 'AppData', 'Local')
    const roaming = set(env.APPDATA) ? env.APPDATA : win32.join(home, 'AppData', 'Roaming')
    return [
      chained(win32, home, win32.join(local, 'Packages'), [CLAUDE_MSIX_FAMILY, 'LocalCache', 'Roaming', 'Claude', SESSIONS]),
      chained(win32, home, roaming, ['Claude', SESSIONS]),
    ]
  }
  if (platform === 'linux') {
    const xdg = env.XDG_CONFIG_HOME
    const config = xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, '.config')
    return [chained(posix, home, config, ['Claude', SESSIONS])]
  }
  return []
}

/**
 * Where the ChatGPT app is looked for, `appsDir` (`HARNESS_APPLICATIONS_DIR`, the end-to-end tests' seam) in place of
 * the computer's own folder when it is absolute. On Windows the app is a Store package, asked for by name, so only the
 * seam gives a place: the package's own `app\ChatGPT.exe` under a folder named for it.
 */
export function chatGptPlaces(platform: NodeJS.Platform, appsDir: string | undefined, home: string): string[] {
  if (platform === 'win32') return appsDir && win32.isAbsolute(appsDir) ? [win32.join(appsDir, 'OpenAI.Codex', 'app', 'ChatGPT.exe')] : []
  const apps = appsDir && posix.isAbsolute(appsDir) ? appsDir : undefined
  if (platform === 'darwin') return [posix.join(apps ?? '/Applications', 'ChatGPT.app'), posix.join(home, 'Applications', 'ChatGPT.app')]
  // The .deb and the .rpm both install the program here.
  if (platform === 'linux') return [posix.join(apps ?? '/usr/lib', 'chatgpt', 'ChatGPT')]
  return []
}
