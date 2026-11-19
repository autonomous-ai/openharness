// The registry lock on each platform's real file system, nothing mocked: Windows runs it through windows.yml,
// where a folder cannot be renamed onto another.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { registryFileLock } from './registryPersistence.js'

let directory: string, lock: string
// This deadline never throws, so the lock's own budget decides when a wait ends.
const deadline = (ms = 5_000) => ({ expires: performance.now() + ms, check: () => {} })

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'registry-lock-publish-'))
  lock = join(directory, 'registry.json.lock')
  // Windows reads the lock's owner only inside the private state roots.
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('an acquire and its release leave the folder as it was', async () => {
  expect(await registryFileLock(directory, deadline(), async () => 'held')).toBe('held')
  expect(readdirSync(directory)).toEqual([])
})

it('a lock with a live owner is waited for, not replaced', async () => {
  const owner = join(lock, 'owner.json'), held = JSON.stringify({ pid: process.pid, startMarker: '', token: 'held' })
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(owner, held, { mode: 0o600 })
  const apply = vi.fn(async () => {})
  await expect(registryFileLock(directory, deadline(300), apply)).rejects.toThrow('registry lock is busy')
  expect(apply).not.toHaveBeenCalled()
  expect(readFileSync(owner, 'utf8')).toBe(held)
  expect(readdirSync(directory)).toEqual(['registry.json.lock'])
})

it('a lock let go during the wait is taken, and its release leaves the folder as it was', async () => {
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startMarker: '', token: 'held' }), { mode: 0o600 })
  // The lock checks its deadline a few times a turn, so its holder lets go some turns in.
  let checks = 0
  const waited = { expires: performance.now() + 5_000, check: () => { if (++checks === 40) rmSync(lock, { recursive: true }) } }
  expect(await registryFileLock(directory, waited, async () => readdirSync(directory))).toEqual(['registry.json.lock'])
  expect(checks).toBeGreaterThan(40)
  expect(readdirSync(directory)).toEqual([])
})

it('an empty lock folder is not replaced', async () => {
  mkdirSync(lock, { mode: 0o700 })
  const before = lstatSync(lock, { bigint: true }).ino
  const apply = vi.fn(async () => {})
  await expect(registryFileLock(directory, deadline(300), apply)).rejects.toThrow('registry lock is busy')
  expect(apply).not.toHaveBeenCalled()
  expect(readdirSync(lock)).toEqual([])
  expect(lstatSync(lock, { bigint: true }).ino).toBe(before)
  expect(readdirSync(directory)).toEqual(['registry.json.lock'])
})
