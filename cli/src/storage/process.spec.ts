import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import { sessionStorageDeadline } from './process.js'
import { SESSION_STORAGE_REQUEST_MS } from '../lib/sessionStorageWire.js'

it.each([undefined, null, '1', NaN, Infinity, -Infinity, 0, -1, SESSION_STORAGE_REQUEST_MS + 1])(
  'refuses a missing, expired or excessive remaining duration (%s)', value => {
    expect(() => sessionStorageDeadline(value)).toThrow('Session storage unavailable: expired')
  })

it.each([1, SESSION_STORAGE_REQUEST_MS])('starts a bounded child deadline on its own monotonic clock (%s)', duration => {
  const before = performance.now(), deadline = sessionStorageDeadline(duration), after = performance.now()
  expect(deadline).toBeGreaterThanOrEqual(before + duration)
  expect(deadline).toBeLessThanOrEqual(after + duration)
})
