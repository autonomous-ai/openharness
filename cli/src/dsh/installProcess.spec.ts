import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { env } from '../config/env.js'
import { cloneInstall } from './install.js'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn,
}))

let directory: string
let previous: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harness-git-drain-'))
  previous = env.DSH_DIR
  env.DSH_DIR = directory
})
afterEach(() => {
  env.DSH_DIR = previous
  spawn.mockReset()
  rmSync(directory, { recursive: true, force: true })
})

it('waits for Git stderr to drain after exit before classifying a failed clone', async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() })
  spawn.mockReturnValue(child)
  const lines: string[] = []
  const pending = cloneInstall('https://example.test/repo.git', undefined, undefined, line => lines.push(line), [])
  let settled = false
  void pending.then(() => { settled = true })

  // Node can report process exit before the final pipe data. Only close means
  // the output is complete, including the reason used to decide a retry.
  child.emit('exit', 128, null)
  await setImmediate()
  const settledBeforeOutput = settled
  child.stderr.emit('data', Buffer.from('error: RPC failed; curl 28 Operation too slow\nfatal: early EOF'))
  child.emit('close', 128, null)

  expect(await pending).toEqual({
    ok: false, error: 'CLONE_FAILED',
    detail: 'git clone exited 128: error: RPC failed; curl 28 Operation too slow · fatal: early EOF · gave up after 1 attempts',
  })
  expect(settledBeforeOutput).toBe(false)
  expect(lines).toEqual(['error: RPC failed; curl 28 Operation too slow', 'fatal: early EOF'])
})
