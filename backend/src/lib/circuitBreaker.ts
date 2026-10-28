/**
 * A circuit breaker for a dependency on the request path (SSO, the Autonomous BFF, Redis).
 *
 * A slow dependency costs every request its full timeout; a breaker lets the first few pay it, then answers at once
 * until the dependency has had time to recover. Closed: calls run, and `failureThreshold` failures in a row open it.
 * Open: calls are refused with CircuitOpenError without running. After `openMs` one trial call runs (half open) while
 * the others are still refused; its success closes the breaker and its failure opens it for another period.
 *
 * Process-local on purpose: each pod learns for itself, in a few calls, whether it can reach the dependency.
 */
export type CircuitState = 'closed' | 'open' | 'half_open'

export class CircuitOpenError extends Error {
  constructor(readonly breaker: string) {
    super(`${breaker} is unavailable (circuit open)`)
    this.name = 'CircuitOpenError'
  }
}

export class CircuitTimeoutError extends Error {
  constructor(readonly breaker: string, readonly timeoutMs: number) {
    super(`${breaker} timed out after ${timeoutMs} ms`)
    this.name = 'CircuitTimeoutError'
  }
}

export interface CircuitBreakerOptions {
  name: string
  failureThreshold?: number
  openMs?: number
  /** Per call: the call's signal aborts, and the call fails with CircuitTimeoutError even if it ignores the signal. */
  timeoutMs?: number
  /** Whether an error means the dependency failed. False for an answer it gave (a 401 is the SSO working). */
  isFailure?: (err: unknown) => boolean
  now?: () => number
  onStateChange?: (state: CircuitState) => void
}

export interface CircuitBreaker {
  run<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T>
  state(): CircuitState
}

export function createCircuitBreaker({
  name,
  failureThreshold = 5,
  openMs = 10_000,
  timeoutMs,
  isFailure = () => true,
  now = Date.now,
  onStateChange,
}: CircuitBreakerOptions): CircuitBreaker {
  let state: CircuitState = 'closed'
  let failures = 0
  let openedAt = 0
  let trialRunning = false

  const move = (next: CircuitState): void => {
    if (state === next) return
    state = next
    onStateChange?.(next)
  }

  const withTimeout = <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (timeoutMs === undefined) return fn(new AbortController().signal)
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new CircuitTimeoutError(name, timeoutMs)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
    })
    return Promise.race([fn(controller.signal), expired]).finally(() => clearTimeout(timer))
  }

  return {
    state: () => state,
    async run(fn) {
      let trial = false
      if (state !== 'closed') {
        if (trialRunning || now() - openedAt < openMs) throw new CircuitOpenError(name)
        trial = true
        trialRunning = true
        move('half_open')
      }
      try {
        const result = await withTimeout(fn)
        failures = 0
        move('closed')
        return result
      } catch (err) {
        if (!isFailure(err)) {
          failures = 0
          move('closed')
        } else if (trial || ++failures >= failureThreshold) {
          failures = 0
          openedAt = now()
          move('open')
        }
        throw err
      } finally {
        if (trial) trialRunning = false
      }
    },
  }
}
