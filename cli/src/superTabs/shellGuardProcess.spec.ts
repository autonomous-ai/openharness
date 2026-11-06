import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GUARD_REASONS, machineFacts, shellRefusal } from './shellGuard.js'

it.skipIf(process.platform === 'win32')('protects a real worktree until its child process exits', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guard-worktree-')))
  const repo = join(root, 'repo'), tree = join(root, 'tree')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', timeout: 10_000, windowsHide: true })
  try {
    git('init', repo)
    git('-C', repo, '-c', 'user.name=Guard test', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgsign=false',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'fixture')
    git('-C', repo, 'worktree', 'add', '--detach', tree)
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
      cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
      const command = `git worktree remove '${tree}'`
      expect(shellRefusal(command, machineFacts(repo))).toBe(GUARD_REASONS.liveWorktree(tree, child.pid!))
      child.kill('SIGTERM')
      await exited
      expect(shellRefusal(command, machineFacts(repo))).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
