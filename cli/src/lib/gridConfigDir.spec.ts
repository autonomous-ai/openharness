import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { writeGridConfigDir } from './gridConfigDir.js'

let root = '', before = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'grid-config-')); before = env.ADAPTER_DATA_DIR; env.ADAPTER_DATA_DIR = root })
afterEach(() => { env.ADAPTER_DATA_DIR = before; rmSync(root, { recursive: true, force: true }) })

// An agent moved between grids after its old grid's sessions folder was deleted: on Node 25.3 a link whose target is gone
// stayed where it was, so the new link was never made and its sessions landed where the daemon never reads them.
it('points a link again whose old target is gone', async () => {
  const fresh = join(root, 'new-sessions')
  mkdirSync(fresh)
  const dir = await writeGridConfigDir('agent-1', [], [{ name: 'sessions', target: join(root, 'gone') }])
  const again = await writeGridConfigDir('agent-1', [], [{ name: 'sessions', target: fresh }])
  expect(again).toBe(dir)
  expect(readlinkSync(join(dir, 'sessions'))).toBe(fresh)
})

it('leaves a real folder in a link\'s place alone: it is the engine\'s own', async () => {
  const dir = await writeGridConfigDir('agent-2', [])
  mkdirSync(join(dir, 'sessions'))
  await writeGridConfigDir('agent-2', [], [{ name: 'sessions', target: join(root, 'elsewhere') }])
  expect(() => readlinkSync(join(dir, 'sessions'))).toThrow()
})
