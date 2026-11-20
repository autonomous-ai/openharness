import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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

it('runs a held deadline timer on expire() and never on the host clock', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS)
  const ran = vi.fn()
  setTimeout(ran, DEADLINE_MS)
  expect(ran).not.toHaveBeenCalled()
  expect(host.waits).not.toContain(DEADLINE_MS)
  held.expire()
  expect(ran).toHaveBeenCalledOnce()
})

it('never runs a cleared deadline timer', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS)
  const ran = vi.fn()
  clearTimeout(setTimeout(ran, DEADLINE_MS))
  held.expire()
  expect(ran).not.toHaveBeenCalled()
})

it('runs a held timer of another bound on fire(ms) only', () => {
  const held = deadline.holdRegistryDeadline(DEADLINE_MS, { hold: [2_000] })
  const ran = vi.fn()
  setTimeout(ran, 2_000)
  held.expire()
  expect(ran).not.toHaveBeenCalled()
  expect(host.waits).not.toContain(2_000)
  held.fire(2_000)
  expect(ran).toHaveBeenCalledOnce()
})

it('runs a real wait from 250 ms once a registry image syncs, before its time', async () => {
  deadline.holdRegistryDeadline(DEADLINE_MS)
  const ran = vi.fn()
  setTimeout(ran, 300)
  await syncRegistryImage()
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
