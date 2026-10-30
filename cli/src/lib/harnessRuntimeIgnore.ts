/** Shared by Store and Swarm launches so session files never become project source. */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Call after validating the workspace's runtime directories as plain directories. */
export function ignoreHarnessRuntime(workspace: string): void {
  const file = join(workspace, '.harness', '.gitignore')
  let mode = 0o600, before = ''
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Harness ignore file is not a plain file: ${file}`)
    mode = stat.mode & 0o777
    before = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const rules = before.split('\n')
  const missing = ['runtime/', 'legacy-AGENTS.md'].filter(rule => !rules.includes(rule))
  // A file that has its rules stays byte for byte: a project may have committed it, and a line added there would be a
  // change in every worktree and every worker's pull request.
  if (!missing.length) return
  // Diego, 10-30: the file itself was left untracked, so every worktree read as uncommitted work and none was ever cleaned
  // up (superTabs/machines.ts removeStoppedWorktree, lib/worktreeSweep.ts). It ignores itself; each launch writes it again.
  // Anchored, so a .gitignore someone adds deeper in .harness still counts (review of #2266); either form is accepted.
  if (!rules.includes('/.gitignore') && !rules.includes('.gitignore')) missing.push('/.gitignore')
  publish(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, mode)
}

/** The file every Harness before #2266 wrote into a fresh workspace, byte for byte; it did not ignore itself. */
export const OLDER_RUNTIME_IGNORE = 'runtime/\nlegacy-AGENTS.md\n'

/** Lead, 10-30 (#2266): the worktrees made before the ignore file ignored itself never read as clean, and they are the ones
 *  piling up (19 on one Mac). The cleanup (lib/worktreeSweep.ts sweepOne) upgrades the exact file an older Harness wrote,
 *  once it has checked git does not track it: true when it did. Any other file, edited by someone or of unknown origin,
 *  and a Harness folder or file that is not plain, stays exactly as it is. */
export function upgradeOlderRuntimeIgnore(workspace: string): boolean {
  const folder = join(workspace, '.harness'), file = join(folder, '.gitignore')
  let mode: number
  try {
    const dir = lstatSync(folder)
    if (!dir.isDirectory() || dir.isSymbolicLink()) return false
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(OLDER_RUNTIME_IGNORE)) return false
    if (readFileSync(file, 'utf8') !== OLDER_RUNTIME_IGNORE) return false
    mode = stat.mode & 0o777
  } catch { return false }
  publish(file, `${OLDER_RUNTIME_IGNORE}/.gitignore\n`, mode)
  return true
}

/** Publish whole bytes: a killed launch must not leave session files visible to Git. */
function publish(file: string, text: string, mode: number): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', mode)
  try {
    try { writeFileSync(fd, text); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
