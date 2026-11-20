import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RegistryWriteQueue } from '../lib/registryPersistence.js'

// Stands in for the host's clock before the helper binds it, so a test sees every wait that reaches the host.
const host = vi.hoisted(() => {
  const real = globalThis.setTimeout, waits: Array<number | undefined> = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    waits.push(ms)
    return real(callback, ms, ...args)
  }) as typeof setTimeout
  return { waits }
})
const deadline = await vi.hoisted(() => import('./registryDeadline.js'))

const DEADLINE_MS = 5_000
let root = ''
beforeEach(() => { host.waits.length = 0; root = mkdtempSync(join(tmpdir(), 'registry-deadline-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

async function syncRegistryImage(): Promise<void> {
  const fs = await deadline.slowSyncFsPromises(() => import('node:fs/promises'))
  const handle = await fs.open(join(root, 'registry.json.x.tmp'), 'w')
  try { await handle.writeFile('{}'); await handle.sync() }
  finally { await handle.close() }
}

// By who arms it, not by its bound: the time a write has left (confirmLaunch's second attempt, a new pane's budget).
it('holds a write deadline the queue arms with 4 s left off the host clock, and a sync, until expire()', async () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS)
  const write = new RegistryWriteQueue().run(() => new Promise(() => {}), performance.now() + 4_000)
  let failed: unknown
  write.catch((error: unknown) => { failed = error })
  await syncRegistryImage()
  expect(failed).toBeUndefined()
  expect(host.waits).not.toContainEqual(expect.closeTo(4_000, 0))
  held.expire()
  await expect(write).rejects.toThrow('write deadline exceeded')
})

// So a test can wait for its write to be queued, then expire it once.
it('says how many write deadlines it holds', async () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS)
  const queue = new RegistryWriteQueue()
  expect(held.deadlines()).toBe(0)
  const writes = [queue.run(() => new Promise(() => {})), queue.run(async () => 'queued behind the first')]
  expect(held.deadlines()).toBe(2)
  held.expire()
  expect(held.deadlines()).toBe(0)
  for (const write of writes) await expect(write).rejects.toThrow('write deadline exceeded')
})

it('leaves a 5 s timer from outside the registry on the host clock, which a sync does not run', async () => {
  deadline.holdRegistryDeadline(DEADLINE_MS)
  const ran = vi.fn()
  const timer = setTimeout(ran, DEADLINE_MS)
  await syncRegistryImage()
  clearTimeout(timer)
  expect(host.waits).toContain(DEADLINE_MS)
  expect(ran).not.toHaveBeenCalled()
})

it('never runs a cleared held timer', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS, { hold: [2_000] })
  const ran = vi.fn()
  clearTimeout(setTimeout(ran, 2_000))
  expect(() => held.fire(2_000)).toThrow('no held 2000 ms timer')
  expect(ran).not.toHaveBeenCalled()
})

// A test that fires a timer before its code has set it fails there, by name, not at its own time limit.
it('says by name that it holds no timer to fire, nor any deadline to expire', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS, { hold: [2_000] })
  expect(() => held.fire(2_000)).toThrow('no held 2000 ms timer')
  expect(() => held.expire()).toThrow('no held write deadline')
})

it('runs a held timer of another bound on fire(ms) only', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS, { hold: [2_000] })
  const ran = vi.fn()
  setTimeout(ran, 2_000)
  expect(() => held.expire()).toThrow('no held write deadline')
  expect(ran).not.toHaveBeenCalled()
  expect(host.waits).not.toContain(2_000)
  held.fire(2_000)
  expect(ran).toHaveBeenCalledOnce()
})

it('runs a real wait from 250 ms once a registry image syncs, before its time', async () => {
  deadline.holdRegistryDeadline(DEADLINE_MS)
  const ran = vi.fn()
  // Near the deadline: a slow sync outlasts a short wait, which the host's clock then runs whether the sync does or not.
  const timer = setTimeout(ran, 4_900)
  await syncRegistryImage()
  clearTimeout(timer)
  expect(ran).toHaveBeenCalledOnce()
})

it('leaves a wait under 250 ms on the host clock alone', async () => {
  deadline.holdRegistryDeadline(DEADLINE_MS)
  const started = performance.now()
  let ranAfter: number | undefined
  const timer = setTimeout(() => { ranAfter = performance.now() - started }, 100)
  await syncRegistryImage()
  clearTimeout(timer)
  expect(host.waits).toContain(100)
  // A slow sync may outlast the wait; then only the host's clock ran it, never the sync.
  expect(ranAfter === undefined || ranAfter >= 99).toBe(true)
})

// As the host's clock: a wait one sets as it runs is due later, never in the same pass, or one that sets itself again
// would run without end.
it('runs a wait once a sync, and the wait it sets again at a later sync', async () => {
  deadline.holdRegistryDeadline(DEADLINE_MS)
  let runs = 0, timer: ReturnType<typeof setTimeout> | undefined
  // Sets itself again twice at most, so a pass that ran every wait set while it runs still ends.
  const again = () => { runs++; if (runs < 3) timer = setTimeout(again, 4_900) }
  timer = setTimeout(again, 4_900)
  await syncRegistryImage()
  expect(runs).toBe(1)
  await syncRegistryImage()
  expect(runs).toBe(2)
  clearTimeout(timer)
})

// As the host's clock: one timer that throws neither keeps the others from running nor fails the caller that ran them
// (a sync, a test's fire or expire); it is thrown on its own.
it('runs every timer it fires, and throws a failing one on its own afterwards', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS, { hold: [2_000] })
  const after = vi.fn()
  setTimeout(() => { throw new Error('fixture timer failed') }, 2_000)
  setTimeout(after, 2_000)
  const thrown: Array<() => void> = []
  const later = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => { thrown.push(task) })
  try { held.fire(2_000) } finally { later.mockRestore() }
  expect(after).toHaveBeenCalledOnce()
  expect(thrown).toHaveLength(1)
  expect(thrown[0]).toThrow('fixture timer failed')
})
