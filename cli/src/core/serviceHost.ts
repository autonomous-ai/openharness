/** Shared service fallbacks and failure identity; inline hosting is loaded through services/inline.ts only. */
/** The fallback of a member whose failure belongs to its caller: it throws (or rejects). */
export const FAIL = Symbol('fail')

const LATER = Symbol('later')
/** The fallback of a member that returns a promise: resolve to `value` (or reject, for `FAIL`). */
export interface Later<T> { readonly [LATER]: T }
export function later<T>(value: T): Later<T> {
  return { [LATER]: value }
}

/** A fallback read: whether its member returns a promise (`later`), and what it answers. A service that
 *  guards parts of its own the way this host guards services reads its fallbacks with this
 *  (services/devicesGuard.ts). */
export function readFallback(fallback: unknown): { deferred: boolean; value: unknown } {
  const deferred = typeof fallback === 'object' && fallback !== null && LATER in fallback
  return { deferred, value: deferred ? (fallback as Later<unknown>)[LATER] : fallback }
}

/** For every member of a port, what the core gets when that member fails or its service is off. */
export type PortFallbacks<P> = {
  [K in keyof P]-?: P[K] extends (...args: never[]) => infer R
    ? R extends PromiseLike<infer T> ? Later<T | typeof FAIL> : R | typeof FAIL
    : never
}

/** Why a call into a service was not answered: the service is off, or the call failed. */
export class ServiceUnavailableError extends Error {
  constructor(readonly service: string, readonly cause?: unknown) {
    super(`the ${service} service is unavailable`)
    this.name = 'ServiceUnavailableError'
  }
}

/** `HARNESSD_TEST_FAULTS`: a comma-separated list of `service` and `service.member` names. */
export function testFaults(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))
}
