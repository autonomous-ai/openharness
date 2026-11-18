import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namesTheDisk } from '../harnessd/supervisor.js'
import { errorKind } from './log.js'
import type { registry as Registry } from './registry.js'

const refuse = vi.hoisted(() => ({ code: undefined as string | undefined, directorySync: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (refuse.code && /\/(registry|agent-names)\.json\..*\.tmp$/.test(String(args[0]))) {
      throw Object.assign(new Error(`${refuse.code}: fixture, open '${String(args[0])}'`), { code: refuse.code })
    }
    return actual.open(...args)
  } }
})

// After the rename: the folder's fsync, where the write is on disk but unconfirmed.
vi.mock('./secureState.js', async original => {
  const actual = await original<typeof import('./secureState.js')>()
  return { ...actual, syncStateDirectory: (...args: Parameters<typeof actual.syncStateDirectory>) => {
    if (refuse.directorySync) throw Object.assign(new Error(`${refuse.directorySync}: fixture, fsync '${args[0]}'`), { code: refuse.directorySync })
    return actual.syncStateDirectory(...args)
  } }
})

let directory: string
let registry: typeof Registry
let AtomicWriteUnconfirmed: typeof import('./registryPersistence.js').AtomicWriteUnconfirmed
const input = { agentId: 'persisted-agent', engine: 'claude' as const, tmuxPane: '%1',
  processIdentity: { pid: 101, executable: '/fixture/claude', startMarker: 'fixture-101' } }
beforeEach(async () => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'registry-disk-'))
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  AtomicWriteUnconfirmed = (await import('./registryPersistence.js')).AtomicWriteUnconfirmed
  registry.load()
  await registry.openProcessAgent(input)
  await registry.flush()
})
afterEach(async () => {
  refuse.code = undefined
  refuse.directorySync = undefined
  await registry.flush().catch(() => {})
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it.each(['EACCES', 'ENOSPC'])('a save refused with %s logs that code, and no path', async (code) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  refuse.code = code
  registry.setActive(input.agentId, false) // save(): logged, never thrown
  await registry.flush().catch(() => {})
  const lines = error.mock.calls.map((call) => call.map(String).join(' '))
  expect(lines).toContain(`[registry] save failed · ${code}`)
  expect(lines.join('\n')).not.toContain(directory)
})

it.each(['ENOSPC', 'EROFS'])('a strict save refused with %s keeps the disk code for the log, off the message', async (code) => {
  refuse.code = code
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(errorKind(failure)).toBe(`RegistryPersistenceUnavailable ${code}`)
  expect((failure as { code?: unknown }).code).toBeUndefined()
})

it('a names save refused with ENOSPC logs the type and the disk code', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await registry.rename(input.agentId, 'Chosen name')
  refuse.code = 'ENOSPC'
  // An inherited name has no request to answer: saveNames() logs its failure, never throws it.
  registry.inheritName(input.agentId, 'next-session')
  await registry.flush().catch(() => {})
  expect(error.mock.calls.map((call) => call.map(String).join(' ')))
    .toContain('[registry] save names failed · RegistryPersistenceUnavailable ENOSPC')
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

it.each([
  ['ENOSPC', 'has no available space (ENOSPC)'],
  ['EDQUOT', 'has no available space (EDQUOT)'],
  ['EROFS', 'is read-only (EROFS)'],
])('a save left unconfirmed by %s after its rename still names the disk', async (code, words) => {
  refuse.directorySync = code
  const rows = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  const names = await registry.rename(input.agentId, 'Renamed').catch((error: Error) => error)
  for (const [failure, subject] of [[rows, 'registry storage'], [names, 'name storage']] as const) {
    expect(failure).toBeInstanceOf(AtomicWriteUnconfirmed)
    expect((failure as Error).message).toBe(`Registry persistence unavailable: ${subject} ${words}`)
    expect(namesTheDisk((failure as Error).message)).toBe(true)
    expect((failure as Error).message).not.toContain(directory)
  }
})
