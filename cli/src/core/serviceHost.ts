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
 * - **Requests.** A service answers the apps through the requests it declares when it is started;
 *   its start returns their handlers, and the socket asks `route` before its own switch, so a feature
 *   adds a request without touching the socket. While the service is off they are answered
 *   `SERVICE_UNAVAILABLE`, never `UNSUPPORTED`, which the apps read as "update the CLI": that is why
 *   the types are declared before the start that could fail. A handler that throws or rejects is
 *   answered `SERVICE_FAILED`, and counts as a failure of the service like a call into its port.
 * - **Switching off.** A service that fails `maxFailures` times within `windowMs` is switched off
 *   for the rest of the daemon's life: it is stopped when its port can stop, its port goes null, the
 *   core's calls answer their fallbacks without reaching it, its requests are answered unavailable,
 *   and the `onOff` handlers unbind what clients reach it through. A restart of the daemon starts it
 *   again.
 */
import type { Asker, CoreApi, CorePorts, ServiceRequest, ServiceRequests } from './api.js'

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
  const off = new Set<string>()
  const failures = new Map<string, number[]>()
  const offHandlers = new Map<string, Array<() => void>>()
  const stoppers = new Map<string, () => void>()
  /** The service that answers each request type, and its handler once it has started. */
  const owners = new Map<string, { service: string; answer: ServiceRequest | null }>()

  const inject = (target: string): void => {
    if (faults.has(target)) throw new Error(`injected fault: ${target}`)
  }

  const switchOff = (name: string, failed: number): void => {
    if (off.has(name)) return
    off.add(name)
    if (Object.hasOwn(ports, name)) ports[name as PortName] = null
    log(`[services] ${name} switched off after ${failed} failures in ${Math.round(windowMs / 1000)}s · it stays off until the daemon restarts`)
    for (const handler of [stoppers.get(name), ...offHandlers.get(name) ?? []]) {
      try { handler?.() } catch (error) { log(`[services] switching ${name} off: ${describe(error)}`) }
    }
  }

  const failed = (name: string, member: string, error: unknown): void => {
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

  /** Take the request types a service declares, before its start: a type another service answers is a
   *  mistake in the code, and leaves this one off rather than taking the other's requests. */
  const claim = (name: string, requests: readonly string[]): void => {
    for (const type of requests) {
      const owner = owners.get(type)
      if (owner) throw new Error(`${type} is answered by ${owner.service}`)
    }
    for (const type of requests) owners.set(type, { service: name, answer: null })
  }

  /** Install a started service's handlers: exactly the types it declared, no more and no fewer. */
  const install = (name: string, requests: readonly string[], answers: ServiceRequests | void): void => {
    const given = Object.keys(answers ?? {})
    const undeclared = given.filter((type) => !requests.includes(type))
    const unanswered = requests.filter((type) => !given.includes(type))
    if (undeclared.length) throw new Error(`it answers ${undeclared.join(', ')} without declaring ${undeclared.length > 1 ? 'them' : 'it'}`)
    if (unanswered.length) throw new Error(`it declares ${unanswered.join(', ')} without answering ${unanswered.length > 1 ? 'them' : 'it'}`)
    for (const type of requests) owners.set(type, { service: name, answer: (answers as ServiceRequests)[type] })
  }

  const didNotStart = (name: string, error: unknown): void => {
    off.add(name)
    if (Object.hasOwn(ports, name)) ports[name as PortName] = null
    log(`[services] ${name} did not start · ${describe(error)} · the core runs without it`)
  }

  return {
    /**
     * Start one service. It fills its own port (`ports[name]`) in a staging copy; what it filled is
     * installed guarded, and anything else it wrote is ignored. A service that leaves its port null
     * has said why itself and is simply off. `requests` are the types it answers for the apps; its
     * start returns their handlers.
     */
    start<K extends PortName>(
      name: K,
      start: (core: CoreApi, ports: CorePorts) => ServiceRequests | void,
      core: CoreApi,
      fallbacks: PortFallbacks<Port<K>>,
      requests: readonly string[] = [],
    ): void {
      const staging: CorePorts = { ...ports, [name]: null }
      let answers: ServiceRequests | void
      try {
        claim(name, requests)
        inject(name)
        answers = start(core, staging)
      } catch (error) {
        didNotStart(name, error)
        return
      }
      const port = staging[name] as Port<K> | null
      if (!port) {
        off.add(name)
        ports[name] = null
        return
      }
      try {
        install(name, requests, answers)
      } catch (error) {
        didNotStart(name, error)
        return
      }
      const stop = (port as unknown as { stop?: () => unknown }).stop
      if (typeof stop === 'function') stoppers.set(name, () => { void Promise.resolve(stop.call(port)).catch(() => {}) })
      ports[name] = guard(name, port, fallbacks) as CorePorts[K]
    },
    /**
     * Start a service the core never calls: it has no port, and only answers the apps' `requests`.
     * Most features are this.
     */
    serve(name: string, start: (core: CoreApi) => ServiceRequests, core: CoreApi, requests: readonly string[]): void {
      try {
        if (Object.hasOwn(ports, name)) throw new Error('it has a port: start it with start()')
        claim(name, requests)
        inject(name)
        install(name, requests, start(core))
      } catch (error) {
        didNotStart(name, error)
      }
    },
    /**
     * Answer a request a service in this process declared: false when none did, and the socket answers
     * it. Never waits in line: the reply goes when the handler's promise settles.
     */
    route(type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void): boolean {
      const owner = owners.get(type)
      if (!owner) return false
      const { service, answer } = owner
      if (off.has(service) || !answer) {
        reply({ error: 'SERVICE_UNAVAILABLE', service, retryable: false })
        return true
      }
      const failedWith = (error: unknown): void => {
        failed(service, type, error)
        reply({ error: 'SERVICE_FAILED', service })
      }
      let result: ReturnType<ServiceRequest>
      try {
        inject(`${service}.${type}`)
        result = answer(payload, asker)
      } catch (error) {
        failedWith(error)
        return true
      }
      void Promise.resolve(result).then((value) => {
        if (typeof value === 'object' && value !== null) reply(value)
        else failedWith(new Error(`${type} was answered with no reply`))
      }, failedWith)
      return true
    },
    /** Run `handler` once, when `name` is switched off. */
    onOff(name: string, handler: () => void): void {
      offHandlers.set(name, [...offHandlers.get(name) ?? [], handler])
    },
    /** Whether `name` is off: it did not start, or it was switched off. */
    isOff(name: string): boolean {
      return off.has(name)
    },
  }
}

export type ServiceHost = ReturnType<typeof createServiceHost>
