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
  if (!rules.includes('.gitignore')) missing.push('.gitignore')
  // Publish whole bytes: a killed launch must not leave session files visible to Git.
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', mode)
  try {
    try { writeFileSync(fd, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
