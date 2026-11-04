import type { CliReportFailure } from '../lib/productHealthContract.js'

/** Fixed delivery categories only: neither error messages nor unknown codes become telemetry. */
export function reportFailure(answer: { status: number; body: Record<string, unknown> }): CliReportFailure {
  const code = (answer.body?.error as { code?: unknown } | null)?.code
  if (answer.status === 504 && code === 'BACKEND_TIMEOUT') return 'timeout'
  if (answer.status === 502 && code === 'BACKEND_UNREACHABLE') return 'unreachable'
  if (answer.status === 401 || answer.status === 403 || code === 'AUTH_UNAVAILABLE' || code === 'AUTH_SERVICE_UNAVAILABLE'
    || code === 'ACCOUNT_CHANGED') return 'auth'
  if (answer.status === 400) return 'invalid'
  if (answer.status === 413) return 'too_large'
  // A busy backend answers these 429 since 2026-10-28 (503 before): the cause is kept either way.
  if ((answer.status === 429 || answer.status === 503) && code === 'USAGE_WRITE_CONFLICT') return 'write_conflict'
  if ((answer.status === 429 || answer.status === 503) && code === 'USAGE_TRANSACTION_FAILED') return 'transaction'
  if (answer.status === 429) return 'rate_limited'
  // Without the backend's own answer, a 5xx came from the proxy or Cloudflare in front of it.
  if (answer.status >= 500 && answer.status < 600) return typeof code === 'string' ? 'server' : 'unreachable'
  return 'other'
}
