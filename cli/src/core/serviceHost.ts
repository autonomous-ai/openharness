/**
 * Hosting services in the core's process so that a failing one cannot take the core down with it
 * (docs/design/2026-10-03-harnessd.md, the core boundary). In process, a service shares the core's
 * heap and event loop; this is the isolation a function boundary can give, and a service moved out
 * of process gets the rest.
 *
 * - **Start.** A service whose start throws is left off: its port stays null, it is logged, and the
 *   core starts without it.
 * - **Calls.** Every call into a port is guarded. One that throws, or whose promise rejects, is logged
 *   and answered with that member's fallback, so the core's caller (the event funnel, restore, a
 *   frame being built) carries on. A member whose fallback is `FAIL` answers a request: its failure
 *   goes back to that one request, which the socket answers with an error.
 * - **Switching off.** A service that fails `maxFailures` times within `windowMs` is switched off
 *   for the rest of the daemon's life: it is stopped when its port can stop, its port goes null, the
 *   core's calls answer their fallbacks without reaching it, and the `onOff` handlers unbind what
 *   clients reach it through. A restart of the daemon starts it again.
 */
import type { CoreApi, CorePorts } from './api.js'

/** The fallback of a member whose failure belongs to its caller: it throws (or rejects). */
export const FAIL = Symbol('fail')

const LATER = Symbol('later')
/** The fallback of a member that returns a promise: resolve to `value` (or reject, for `FAIL`). */
export interface Later<T> { readonly [LATER]: T }
export function later<T>(value: T): Later<T> {
  return { [LATER]: value }
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

export interface ServiceHostOptions {
  /** Failures within `windowMs` that switch a service off. */
  maxFailures?: number
  windowMs?: number
  now?: () => number
  log?: (line: string) => void
  /**
   * Faults to inject, for the end-to-end suite only (`HARNESSD_TEST_FAULTS`): `name` makes that
   * service's start throw, `name.member` makes that member throw on every call.
   */
  faults?: ReadonlySet<string>
}

type PortName = keyof CorePorts
type Port<K extends PortName> = NonNullable<CorePorts[K]>
type Member = (...args: unknown[]) => unknown

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `HARNESSD_TEST_FAULTS`: a comma-separated list of `service` and `service.member` names. */
export function testFaults(value: string | undefined): ReadonlySet<string> {
  return new Set((value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean))
}

export function createServiceHost(ports: CorePorts, options: ServiceHostOptions = {}) {
  const maxFailures = options.maxFailures ?? 5
  const windowMs = options.windowMs ?? 60_000
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(line))
  const faults = options.faults ?? new Set<string>()
  const off = new Set<PortName>()
  const failures = new Map<PortName, number[]>()
  const offHandlers = new Map<PortName, Array<() => void>>()
  const stoppers = new Map<PortName, () => void>()

  const inject = (target: string): void => {
    if (faults.has(target)) throw new Error(`injected fault: ${target}`)
  }

  const switchOff = (name: PortName, failed: number): void => {
    if (off.has(name)) return
    off.add(name)
    ports[name] = null
    log(`[services] ${name} switched off after ${failed} failures in ${Math.round(windowMs / 1000)}s · it stays off until the daemon restarts`)
    for (const handler of [stoppers.get(name), ...offHandlers.get(name) ?? []]) {
      try { handler?.() } catch (error) { log(`[services] switching ${name} off: ${describe(error)}`) }
    }
  }

  const failed = (name: PortName, member: string, error: unknown): void => {
    log(`[services] ${name}.${member} failed · ${describe(error)}`)
    const at = now()
    const recent = (failures.get(name) ?? []).filter((t) => at - t < windowMs)
    recent.push(at)
    failures.set(name, recent)
    if (recent.length >= maxFailures) switchOff(name, recent.length)
  }

  const guard = <K extends PortName>(name: K, port: Port<K>, fallbacks: PortFallbacks<Port<K>>): Port<K> => {
    const guarded: Record<string, Member> = {}
    for (const [member, fallback] of Object.entries(fallbacks) as Array<[string, unknown]>) {
      const deferred = typeof fallback === 'object' && fallback !== null && LATER in fallback
      const value = deferred ? (fallback as Later<unknown>)[LATER] : fallback
      const answer = (cause?: unknown): unknown => {
        if (value === FAIL) {
          const error = new ServiceUnavailableError(name, cause)
          if (deferred) return Promise.reject(error)
          throw error
        }
        return deferred ? Promise.resolve(value) : value
      }
      guarded[member] = (...args: unknown[]): unknown => {
        if (off.has(name)) return answer()
        let result: unknown
        try {
          inject(`${name}.${member}`)
          result = ((port as unknown as Record<string, Member>)[member]).apply(port, args)
        } catch (error) {
          failed(name, member, error)
          return answer(error)
        }
        if (!deferred) return result
        return Promise.resolve(result).catch((error: unknown) => {
          failed(name, member, error)
          return answer(error)
        })
      }
    }
    return guarded as unknown as Port<K>
  }

  return {
    /**
     * Start one service. It fills its own port (`ports[name]`) in a staging copy; what it filled is
     * installed guarded, and anything else it wrote is ignored. A service that leaves its port null
     * has said why itself and is simply off.
     */
    start<K extends PortName>(name: K, start: (core: CoreApi, ports: CorePorts) => void, core: CoreApi, fallbacks: PortFallbacks<Port<K>>): void {
      const staging: CorePorts = { ...ports, [name]: null }
      try {
        inject(name)
        start(core, staging)
      } catch (error) {
        off.add(name)
        ports[name] = null
        log(`[services] ${name} did not start · ${describe(error)} · the core runs without it`)
        return
      }
      const port = staging[name] as Port<K> | null
      if (!port) {
        off.add(name)
        ports[name] = null
        return
      }
      const stop = (port as unknown as { stop?: () => unknown }).stop
      if (typeof stop === 'function') stoppers.set(name, () => { void Promise.resolve(stop.call(port)).catch(() => {}) })
      ports[name] = guard(name, port, fallbacks) as CorePorts[K]
    },
    /** Run `handler` once, when `name` is switched off. */
    onOff(name: PortName, handler: () => void): void {
      offHandlers.set(name, [...offHandlers.get(name) ?? [], handler])
    },
    /** Whether `name` is off: it did not start, or it was switched off. */
    isOff(name: PortName): boolean {
      return off.has(name)
    },
  }
}

export type ServiceHost = ReturnType<typeof createServiceHost>
