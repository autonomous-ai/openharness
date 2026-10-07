/**
 * Whether a script is the installed copy of the CLI (`~/.harness/cli/cli.js`), the one the updater
 * replaces. A dev or repo run (`tsx`, or `node dist/cli.js` from a checkout) never updates itself: it would
 * swap the published bundle into ~/.harness/cli and restart, hijacking the version being developed. Matched
 * by inode, so a symlink or a realpath does not fool it; by path when either cannot be read.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

export function isInstalledCopy(scriptPath: string, cliDir: string): boolean {
  const installed = join(cliDir, 'cli.js')
  try { return statSync(scriptPath).ino === statSync(installed).ino } catch { return scriptPath === installed }
}
