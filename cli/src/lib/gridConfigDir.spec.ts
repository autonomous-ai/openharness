import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { writeGridConfigDir } from './gridConfigDir.js'

// Pass-through, recording what reaches each file: opened, written, or renamed onto. Once a test fills the disk, a
// write by either API stops part way, as ENOSPC leaves it.
const disk = vi.hoisted(() => ({ events: [] as string[], full: false }))
const enospc = (): Error => Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.events.push(`open ${String(args[0])}`); return actual.openSync(...args) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      disk.events.push(`write ${String(args[0])}`)
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw enospc()
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.events.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      disk.events.push(`write ${String(args[0])}`)
      if (!disk.full) return actual.writeFile(...args)
      await actual.writeFile(args[0], String(args[1]).slice(0, 8))
      throw enospc()
    },
  }
})

let root = '', before = ''
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'grid-config-')); before = env.ADAPTER_DATA_DIR; env.ADAPTER_DATA_DIR = root })
afterEach(() => { disk.full = false; env.ADAPTER_DATA_DIR = before; rmSync(root, { recursive: true, force: true }) })

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

it('the save goes through a temporary file renamed onto the target', async () => {
  const dir = await writeGridConfigDir('agent-3', [{ name: 'opencode.json', content: '{"provider":{}}' }])
  const file = join(dir, 'opencode.json')
  disk.events = []
  await writeGridConfigDir('agent-3', [{ name: 'opencode.json', content: '{"provider":{"grid":{}}}' }])
  expect(disk.events.filter((event) => event.endsWith(` ${file}`))).toEqual([`rename ${file}`])
  expect(readFileSync(file, 'utf8')).toBe('{"provider":{"grid":{}}}')
})

it('a write that fails part way leaves the old file', async () => {
  const dir = await writeGridConfigDir('agent-4', [{ name: 'opencode.json', content: '{"provider":{"old":{}}}' }])
  disk.full = true
  await expect(writeGridConfigDir('agent-4', [{ name: 'opencode.json', content: '{"provider":{"new":{}}}' }])).rejects.toThrow('ENOSPC')
  disk.full = false
  expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe('{"provider":{"old":{}}}')
  expect(readdirSync(dir)).toEqual(['opencode.json'])
})
