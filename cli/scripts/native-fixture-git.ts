import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** Optional Codex plugin Git fetches may outlive their engine. Only clean up
 * processes whose cwd is inside this invocation's private fixture, validating
 * their PID/start marker/executable again immediately before each signal. */
export async function cleanupFixtureGit(root: string): Promise<number> {
  assert(dirname(root) === realpathSync(tmpdir()) && /^harness-resume-native-[A-Za-z0-9]+$/.test(basename(root)),
    "cleanup must name a private native-fixture directory")
  // The caller installs its private environment before importing production
  // modules. Do not initialize the registry from this helper's static imports.
  const { argvTokens, processRows } = await import('../src/lib/tmux.js')
  const owned = async () => {
    const rows = await processRows()
    assert(rows, 'process table must be available to verify fixture cleanup')
    const candidates = rows.filter(row => /^(?:git|git-remote-https?)$/.test(basename(argvTokens(row.args)[0] ?? row.executable)))
    const found = []
    for (const row of candidates) {
      let cwd = ''
      try {
        cwd = process.platform === 'linux' ? await readlink(`/proc/${row.pid}/cwd`)
          : (await exec('lsof', ['-a', '-p', String(row.pid), '-d', 'cwd', '-Fn'], { timeout: 5000 }))
            .stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) ?? ''
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM' || (code === 'ENOENT' && process.platform !== 'linux')) throw error
        continue // The process may have exited during inspection.
      }
      if (cwd === root || cwd.startsWith(`${root}/`)) found.push(row)
    }
    return found
  }
  const initial = await owned()
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const row of initial) {
      const current = await processRows()
      assert(current, 'process table must be available before fixture cleanup')
      if (!current.some(live => live.pid === row.pid && live.startMarker === row.startMarker && live.executable === row.executable && live.args === row.args)) continue
      try { process.kill(row.pid, signal) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!(await owned()).length) { return initial.length }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  assert.equal((await owned()).length, 0, 'fixture-owned Git fetches must exit')
  return initial.length
}
