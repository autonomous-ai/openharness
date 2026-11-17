import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namesTheDisk } from '../harnessd/supervisor.js'
import type { registry as Registry } from './registry.js'

const refuse = vi.hoisted(() => ({ code: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (refuse.code && /\/(registry|agent-names)\.json\..*\.tmp$/.test(String(args[0]))) {
      throw Object.assign(new Error(`${refuse.code}: fixture, open '${String(args[0])}'`), { code: refuse.code })
    }
    return actual.open(...args)
  } }
})

let directory: string
let registry: typeof Registry
const input = { agentId: 'persisted-agent', engine: 'claude' as const, tmuxPane: '%1',
  processIdentity: { pid: 101, executable: '/fixture/claude', startMarker: 'fixture-101' } }
beforeEach(async () => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'registry-disk-'))
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  registry.load()
  await registry.openProcessAgent(input)
  await registry.flush()
})
afterEach(async () => {
  refuse.code = undefined
  await registry.flush().catch(() => {})
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it.each([
  ['ENOSPC', 'registry storage has no available space (ENOSPC)'],
  ['EDQUOT', 'registry storage has no available space (EDQUOT)'],
  ['EROFS', 'registry storage is read-only (EROFS)'],
])('a strict save refused with %s says so in words the master reads as the disk', async (code, words) => {
  refuse.code = code
  // The core's own startup save (core/main.ts): every row marked dormant, in one transaction.
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
  expect(namesTheDisk((failure as Error).message)).toBe(true)
  expect((failure as Error).message).not.toContain(directory)
})

it.each([['EIO', 'registry storage write failed'], ['EACCES', 'registry storage access was refused']])(
  'a save refused with %s still does not name the disk', async (code, words) => {
    refuse.code = code
    const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
    expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
    expect(namesTheDisk((failure as Error).message)).toBe(false)
  })
