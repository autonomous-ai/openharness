/**
 * The Store packages' Windows transport, on a real named pipe (task #2161, audit W1): no package sends anything to the daemon's
 * TCP port, and each reaches the daemon over its pipe with the pipe auth. The cases are node:test ones in
 * store/tools/windows-pipe.test.mjs, since a Store package stands alone and has no vitest. This runs them on the Windows jobs
 * (windows.yml runs every spec in src/lib/windows); elsewhere they run against a socket of the pipe's name, in the store checks.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Store packages on Windows', () => {
  it.runIf(process.platform === 'win32')('reach the daemon over its proven pipe, and send nothing to its port', () => {
    const run = spawnSync(process.execPath, ['--test', join('..', 'store', 'tools', 'windows-pipe.test.mjs')], { encoding: 'utf8', timeout: 120_000 })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    expect(run.stdout).toMatch(/^# fail 0$/m)
  }, 130_000)
})
