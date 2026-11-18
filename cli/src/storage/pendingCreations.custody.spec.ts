import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fault = vi.hoisted(() => ({ inode: undefined as number | undefined, directory: '', closes: 0 }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, closeSync: (fd: number) => {
    const fail = actual.fstatSync(fd).ino === fault.inode
    actual.closeSync(fd)
    if (fail) { fault.closes++; throw new Error('fixture close uncertainty') }
  } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, opendir: async (...args: Parameters<typeof actual.opendir>) => {
    const dir = await actual.opendir(...args), close = dir.closeSync.bind(dir)
    dir.closeSync = () => { close(); if (dir.path === fault.directory) { fault.closes++; throw new Error('fixture close uncertainty') } }
    return dir
  } }
})
let root: string
beforeEach(() => { vi.resetModules(); root = mkdtempSync(join(tmpdir(), 'pending-custody-')); fault.inode = undefined; fault.directory = ''; fault.closes = 0 })
afterEach(() => { fault.inode = undefined; fault.directory = ''; rmSync(root, { recursive: true, force: true }) })

it.each(['receipt', 'iterator'] as const)('preserves uncertain %s custody instead of treating it as damaged evidence or retrying close', async kind => {
  const { createPendingCreationIndex } = await import('./pendingCreations.js')
  const { StateFileCleanupUnconfirmed } = await import('../lib/secureState.js')
  const directory = join(root, 'agent-creations'), id = 'pending-custody-fixture'
  mkdirSync(directory, { mode: 0o700 })
  const primary = join(directory, `${id}.json`)
  writeFileSync(primary, JSON.stringify({ version: 2, cancelled: true }), { mode: 0o600 })
  const index = createPendingCreationIndex(directory); index.ensure(id)
  if (kind === 'receipt') fault.inode = statSync(primary).ino
  else fault.directory = directory
  await expect(index.page(null, performance.now() + 5_000)).rejects.toThrow(StateFileCleanupUnconfirmed)
  expect(() => index.ensure(id)).toThrow(StateFileCleanupUnconfirmed)
  expect(fault.closes).toBe(1)
})
