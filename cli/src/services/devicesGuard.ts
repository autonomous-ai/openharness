/**
 * How the devices keep one of their parts failing from costing the others (services/devices.ts): the
 * dial, the window bridges and the fleet's router share a service, and a dial that throws on every
 * frame must cost ⌘K nothing, as a fleet that cannot start must cost the dial nothing.
 *
 * The same two guards the core puts around a service (core/serviceHost.ts), one level down:
 * - `call` runs a notice into a part (a card for the dial, a window's answer for a bridge). One that
 *   throws, or whose promise rejects, is logged, at most once a minute per part with a count of the rest,
 *   and goes no further.
 * - `start` builds a part with members the others call in line (the fleet's routing), each with its
 *   fallback. A part whose start throws is left off; a member that throws answers its fallback, and five
 *   failures in a minute switch the part off for the life of the process. A `FAIL` fallback throws
 *   `ServiceUnavailableError`, which the dial's host reads as "route this computer by yourself".
 *
 * `HARNESSD_TEST_FAULTS` names fail them for the end-to-end suite: `<part>` its start, or every call into
 * a notice part, and `<part>.<member>` one member.
 */
import { FAIL, readFallback, ServiceUnavailableError, type PortFallbacks } from '../core/api.js'

export interface PartGuardOptions {
  log?: (line: string) => void
  faults?: ReadonlySet<string>
  now?: () => number
  /** Failures within `windowMs` that switch a started part off. */
  maxFailures?: number
  windowMs?: number
}

type Member = (...args: unknown[]) => unknown

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createPartGuard(options: PartGuardOptions = {}) {
  const log = options.log ?? ((line: string) => console.error(line))
  const faults = options.faults ?? new Set<string>()
  const now = options.now ?? Date.now
  const maxFailures = options.maxFailures ?? 5
  const windowMs = options.windowMs ?? 60_000
  const said = new Map<string, { at: number; quiet: number }>()
  const failures = new Map<string, number[]>()
  const off = new Set<string>()

  const inject = (target: string): void => {
    if (faults.has(target)) throw new Error(`injected fault: ${target}`)
  }

  /** Logged once a minute per part: a dial unplugged mid-call throws on every frame until it is gone. */
  const quietly = (part: string, error: unknown): void => {
    const at = now()
    const last = said.get(part)
    if (last && at - last.at < 60_000) { last.quiet++; return }
    log(`[devices] ${part} failed · ${describe(error)}${last?.quiet ? ` · ${last.quiet} more since` : ''}`)
    said.set(part, { at, quiet: 0 })
  }

  const failed = (part: string, member: string, error: unknown, stop: (() => unknown) | undefined): void => {
    log(`[devices] ${part}.${member} failed · ${describe(error)}`)
    const at = now()
    const recent = [...(failures.get(part) ?? []).filter((t) => at - t < windowMs), at]
    failures.set(part, recent)
    if (recent.length < maxFailures || off.has(part)) return
    off.add(part)
    log(`[devices] ${part} switched off after ${recent.length} failures in ${Math.round(windowMs / 1000)}s · it stays off until the devices restart`)
    try { void Promise.resolve(stop?.()).catch(() => {}) } catch { /* a part failing to stop is already off */ }
  }

  return {
    /** Run a notice into `part`; a throw or a rejection is logged and goes no further. */
    call(part: string, run: () => unknown): void {
      try {
        inject(part)
        const result = run()
        if (result instanceof Promise) result.catch((error: unknown) => quietly(part, error))
      } catch (error) {
        quietly(part, error)
      }
    },

    /** Build `part` and guard every member `fallbacks` names; null when its start threw. */
    start<T extends object>(part: string, build: () => T, fallbacks: PortFallbacks<T>): T | null {
      let target: T
      try {
        inject(part)
        target = build()
      } catch (error) {
        off.add(part)
        log(`[devices] ${part} did not start · ${describe(error)} · the devices run without it`)
        return null
      }
      const stop = (target as { stop?: () => unknown }).stop?.bind(target)
      const guarded: Record<string, Member> = {}
      for (const [member, fallback] of Object.entries(fallbacks) as Array<[string, unknown]>) {
        const { deferred, value } = readFallback(fallback)
        const answer = (cause?: unknown): unknown => {
          if (value === FAIL) {
            const error = new ServiceUnavailableError(part, cause)
            if (deferred) return Promise.reject(error)
            throw error
          }
          return deferred ? Promise.resolve(value) : value
        }
        guarded[member] = (...args: unknown[]): unknown => {
          if (off.has(part)) return answer()
          let result: unknown
          try {
            inject(`${part}.${member}`)
            result = ((target as Record<string, Member>)[member]).apply(target, args)
          } catch (error) {
            failed(part, member, error, stop)
            return answer(error)
          }
          if (!deferred) return result
          return Promise.resolve(result).catch((error: unknown) => {
            failed(part, member, error, stop)
            return answer(error)
          })
        }
      }
      return guarded as T
    },

    /** Whether a started part is off: it did not start, or it failed too often. */
    isOff(part: string): boolean {
      return off.has(part)
    },
  }
}

export type PartGuard = ReturnType<typeof createPartGuard>
