import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from '../../lib/agentCreationReceipt.js'
import { createPendingLaunches } from './pendingLaunches.js'

const roots: string[] = []
const stops: Array<() => void> = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)
  }
})

it.each([0, 3_000])('keeps the normal dependency retry after marker admission takes %i ms', async markerDelay => {
  vi.useFakeTimers()
  const root = mkdtempSync(join(tmpdir(), 'pending-admission-review-')); roots.push(root)
  let admit!: () => void
  const marker = new Promise<void>(resolve => { admit = resolve })
  const discovery = { ensure: vi.fn(() => marker), scan: vi.fn(async function* () {}) }
  const receipts = new AgentCreationReceipts(join(root, 'agent-creations'), discovery.ensure)
  const prepare = vi.fn(async () => null)
  const pending = createPendingLaunches({ receipts, discovery, prepare }); stops.push(pending.stop)
  pending.open()
  await pending.recover()
  expect(discovery.scan).toHaveBeenCalledOnce()
  const request = { kind: 'fixture' }, id = 'pending-admission-review'
  const answer = pending.start(id, creationFingerprint(request), request, { service: 'models', detail: 'Waiting.' })
  await vi.advanceTimersByTimeAsync(markerDelay)
  expect(receipts.status(id)).toEqual({ state: 'missing' })
  expect(prepare).not.toHaveBeenCalled()
  admit()
  expect(await answer).toMatchObject({ state: 'pending' })
  expect(prepare).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(discovery.scan).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledTimes(2)
})
