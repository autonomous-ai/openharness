import { expect, it } from 'vitest'
import { CLI_REPORT_FAILURES } from '../lib/productHealthContract.js'
import { reportFailure } from './reportFailure.js'

it.each([
  [400, 'INVALID_USAGE_REPORT', 'invalid'], [413, 'USAGE_UNAVAILABLE', 'too_large'],
  [401, 'UNAUTHORIZED', 'auth'], [403, 'PRIVATE_CANARY', 'auth'], [502, 'AUTH_UNAVAILABLE', 'auth'],
  [409, 'ACCOUNT_CHANGED', 'auth'], [429, 'PRIVATE_CANARY', 'rate_limited'],
  [504, 'BACKEND_TIMEOUT', 'timeout'], [502, 'BACKEND_UNREACHABLE', 'unreachable'],
  [503, 'USAGE_WRITE_CONFLICT', 'write_conflict'], [503, 'USAGE_TRANSACTION_FAILED', 'transaction'],
  // A busy backend answers 429 and keeps the cause; its auth service down is auth, not storage.
  [429, 'USAGE_WRITE_CONFLICT', 'write_conflict'], [429, 'USAGE_TRANSACTION_FAILED', 'transaction'],
  [429, 'USAGE_BUSY', 'rate_limited'], [503, 'AUTH_SERVICE_UNAVAILABLE', 'auth'],
  [503, 'USAGE_UNAVAILABLE', 'server'], [504, 'PRIVATE_CANARY', 'server'],
  [200, 'PRIVATE_CANARY', 'other'], [409, 'PRIVATE_CANARY', 'other'], [404, 'PRIVATE_CANARY', 'other'],
])('reduces status %i and known code %s to %s', (status, code, expected) => {
  const result = reportFailure({ status: status as number, body: { error: { code, message: 'PRIVATE_CANARY', stack: 'PRIVATE_CANARY' } } })
  expect(result).toBe(expected)
  expect(CLI_REPORT_FAILURES).toContain(result)
})

// A 5xx without the backend's own answer came from the proxy or Cloudflare in front of it: the backend was not
// reached. `server` stays the backend's own failure, so it still shows when storage is down.
it('tolerates missing or malformed error bodies without exporting them, as a backend not reached', () => {
  for (const status of [502, 503, 520]) for (const body of [{}, { error: null }, { error: 'PRIVATE_CANARY' }, { error: ['PRIVATE_CANARY'] }]) {
    expect(reportFailure({ status, body })).toBe('unreachable')
  }
})
