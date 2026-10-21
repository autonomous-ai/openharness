/**
 * Whether a script is the installed copy of the CLI, the one the updater replaces: `~/.harness/cli/cli.js` on macOS and
 * Linux; on Windows a version folder's, `~\.harness\cli\<version>\cli.js` (lib/windows/cliVersions.ts). A dev or repo
 * run (`tsx`, or `node dist/cli.js` from a checkout) never updates itself: it would swap the published bundle into
 * ~/.harness/cli and restart, hijacking the version being developed. Matched by inode, so a symlink or a realpath does
 * not fool it; by path when either cannot be read. Windows has no symlinks here (spec, Decision 4): by path, as Windows
 * compares them.
 */
import { statSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { VERSION_FOLDER } from './windows/cliVersions.js'

export function isInstalledCopy(scriptPath: string, cliDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const parts = win32.relative(cliDir, scriptPath).split('\\')
    return parts.length === 2 && VERSION_FOLDER.test(parts[0]!) && parts[1]!.toLowerCase() === 'cli.js'
  }
  const installed = join(cliDir, 'cli.js')
  try { return statSync(scriptPath).ino === statSync(installed).ino } catch { return scriptPath === installed }
}
