/**
 * The core's first registry write must not wait on a child process: the e2e stall fault (core/stall.ts, `/spawn`) holds
 * the loop as soon as one starts, and a hold inside the write's deadline failed the write and sent a Mac core into safe
 * mode (e2e/stall.e2e.ts). On macOS the write still runs `ps` for its own start marker, synchronously, which the
 * `child_process` channel (and so the fault) never sees. Each case loads the module afresh, so its own start marker is
 * read again, as at a core's start. On Linux the marker comes from /proc and no case starts a `ps`; they are meant for
 * macOS and hold there too.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { processStallDeps, startStalls, type Stalls } from '../core/stall.js'
import { processStartMarker } from './processLiveness.js'

let directory: string
let stalls: Stalls | null = null
const deadline = (ms: number) => {
  const expires = performance.now() + ms
  return { expires, check: () => { if (performance.now() >= expires) throw new Error('fixture deadline') } }
}
const fresh = async () => { vi.resetModules(); return import('./registryPersistence.js') }

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'registry-held-loop-')) })
afterEach(() => {
  stalls?.stop()
  stalls = null
  rmSync(directory, { recursive: true, force: true })
})

it('a registry write waits on no child process', async () => {
  const { registryFileLock } = await fresh()
  let spawned = 0
  const count = () => { spawned++ }
  subscribe('child_process', count)
  try { expect(await registryFileLock(directory, deadline(5_000), async () => 'written')).toBe('written') }
  finally { unsubscribe('child_process', count) }
  expect(spawned).toBe(0)
})

it('a loop held at the next child process does not fail the first write', async () => {
  const { registryFileLock } = await fresh()
  stalls = startStalls(new Set(['core.stall:2500/spawn']), { ...processStallDeps, log: () => {} })
  process.emit('SIGUSR2')
  expect(await registryFileLock(directory, deadline(2_000), async () => 'written')).toBe('written')
})

it('another owner checked with under 1 s left answers as the deadline, not as a bad ps timeout', async () => {
  const { registryFileLock } = await fresh()
  await registryFileLock(directory, deadline(5_000), async () => 'warm')
  // A live owner whose marker matches: the writer asks `ps` for its start on every busy turn until its deadline.
  const lock = join(directory, 'registry.json.lock')
  mkdirSync(lock, { mode: 0o700 })
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'another-writer', startMarker: '',
    generationMarker: processStartMarker(process.pid) ?? '' }), { mode: 0o600 })
  const result = await registryFileLock(directory, deadline(500), async () => 'taken').catch(error => error)
  expect(result).toMatchObject({ message: 'fixture deadline' })
})
