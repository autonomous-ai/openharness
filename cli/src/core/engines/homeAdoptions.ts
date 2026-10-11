import type { HomeCatalog } from '../../engines/kit/homeCatalog.js'
import type { SessionStoreEngine } from '../../engines/sessionStoreContracts.js'

export interface HomeAdoptionDeps {
  read(): HomeCatalog
  confirm(environment: NodeJS.ProcessEnv): Record<SessionStoreEngine, string | null>
  install(engine: SessionStoreEngine, home: string): void | Promise<void>
  held(reason: string | null): void
}

/** Core-owned retries. A confirmed durable home and its hook installation are separate acknowledgements. */
export function createHomeAdoptions(deps: HomeAdoptionDeps) {
  let closed = false, restoring = true, reported: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const requests = new Map<string, NodeJS.ProcessEnv>()
  const installs = new Map<string, [SessionStoreEngine, string]>()
  const installed = new Set<string>()
  const inFlight = new Set<string>()
  const failures = new Map<string, string>()
  let catalogHold: string | null = null
  const progress = (): void => {
    if (closed) return
    const held = catalogHold ?? failures.values().next().value ?? (inFlight.size ? 'Waiting for hook installation in an adopted home.' : null)
    if (held !== reported) { reported = held; deps.held(held) }
    if ((restoring || requests.size || [...installs.keys()].some(key => !inFlight.has(key))) && !timer) {
      timer = setTimeout(() => { timer = undefined; retry() }, 1_000)
      timer.unref()
    }
  }
  const queue = (engine: SessionStoreEngine, home: string): void => {
    const key = JSON.stringify([engine, home])
    if (!installed.has(key)) installs.set(key, [engine, home])
  }
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const retry = (): void => {
    if (closed) return
    let held: string | null = null
    for (const [key, environment] of requests) {
      try {
        const confirmed = deps.confirm(environment)
        for (const engine of ['claude', 'codex'] as const) if (confirmed[engine]) queue(engine, confirmed[engine])
        requests.delete(key)
        restoring = true // Confirmation may also have recovered another writer's home.
      } catch (error) { held ??= reason(error) }
    }
    if (restoring) {
      try {
        const homes = deps.read()
        for (const engine of ['claude', 'codex'] as const) for (const home of homes[engine]) queue(engine, home)
        restoring = false
      } catch (error) { held ??= reason(error) }
    }
    catalogHold = held
    for (const [key, [engine, home]] of installs) {
      if (inFlight.has(key)) continue
      const confirm = () => { installed.add(key); installs.delete(key); failures.delete(key) }
      try {
        const result = deps.install(engine, home)
        if (!result) { confirm(); continue }
        inFlight.add(key)
        void result.then(() => {
          if (!closed) confirm()
        }, error => { if (!closed) failures.set(key, reason(error)) }).finally(() => {
          inFlight.delete(key); progress()
        })
      } catch (error) { failures.set(key, reason(error)) }
    }
    progress()
  }

  return {
    retry,
    current: () => !closed,
    submit(environment: NodeJS.ProcessEnv): void {
      if (closed) return
      // Only two declared home variables survive this callback; never retain login-shell credentials.
      const selected: NodeJS.ProcessEnv = {}
      for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) if (environment[key] !== undefined) selected[key] = environment[key]
      const key = JSON.stringify(selected)
      requests.set(key, selected)
      retry()
    },
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined; requests.clear(); installs.clear(); installed.clear(); failures.clear()
    },
  }
}
