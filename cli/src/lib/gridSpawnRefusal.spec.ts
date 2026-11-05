/**
 * A grid child that cannot start at all.
 *
 * Windows' Smart App Control refuses an unsigned program synchronously: `spawn` THROWS `UNKNOWN`
 * instead of emitting an `error` event. Every grid call promises a result (`never throws`), and three
 * of them hold the counter an install waits on (`gridCalls.ts`), so a throw used to reject a promise
 * no caller catches and leave that install waiting for its whole drain.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withGridCallsPaused } from './gridCalls.js'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { gridExec } from './gridExec.js'
import { handOffToGrid } from './gridHandoff.js'
import { GridFleetRpc } from './gridFleetRpc.js'
import { passThroughToGridLogout } from './gridLogout.js'

let root = ''
const saved = { HARNESS_GRID_BIN: process.env.HARNESS_GRID_BIN, ADAPTER_RUNTIME_DIR: process.env.ADAPTER_RUNTIME_DIR }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'grid-spawn-refusal-'))
  const binary = join(root, 'grid')
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  chmodSync(binary, 0o755)
  process.env.HARNESS_GRID_BIN = binary
  process.env.ADAPTER_RUNTIME_DIR = join(root, 'runtime')
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => {
    throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' })
  })
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  spawnMock.mockReset()
  rmSync(root, { recursive: true, force: true })
})

describe('a grid program that throws on start', () => {
  it('answers with a result from every call instead of rejecting', async () => {
    const exec = await gridExec(['version'])
    expect(exec).toMatchObject({ code: 'GRID_FAILED', exitCode: 1 })
    expect(exec.message).toContain('UNKNOWN')

    const handoff = await handOffToGrid('token')
    expect(handoff).toMatchObject({ code: 'GRID_LOGIN_FAILED', exitCode: 1 })
    expect(handoff.message).toContain('UNKNOWN')

    const fleet = await new GridFleetRpc(process.env).run('owner', 'job', { args: ['version'], timeoutMs: 1_000 })
    expect(fleet).toMatchObject({ ok: false, code: 127 })
    expect(fleet.error).toContain('UNKNOWN')

    const logout = await passThroughToGridLogout([])
    expect(logout).toMatchObject({ ran: false, exitCode: 1 })
    if (!logout.ran) expect(logout.message).toContain('UNKNOWN')
  })

  it('releases the counter an install waits on', async () => {
    await gridExec(['version'])
    await handOffToGrid('token')
    await new GridFleetRpc(process.env).run('owner', 'job', { args: ['version'], timeoutMs: 1_000 })

    // A leaked count makes this wait for its full drain; a released one answers at once.
    const quick = withGridCallsPaused(async () => 'released', 10_000).then(() => 'released')
    const slow = new Promise((resolve) => setTimeout(() => resolve('waiting'), 500))
    await expect(Promise.race([quick, slow])).resolves.toBe('released')
  })
})
