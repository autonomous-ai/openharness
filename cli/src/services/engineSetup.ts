import { createSetupProbeExecutor } from '../engines/kit/setupProbe.js'
/** Optional installation and probing, with the core's explicit commit before an installer can start. */
import { randomUUID } from 'node:crypto'
import type { ServiceRequests } from '../core/api.js'
import { ENGINES, type AgentEngine } from '../engines/types.js'
import { retainedExecutable } from '../engines/kit/nativeExecutable.js'
import { LAUNCH_LOCATION_VARIABLES } from '../engines/kit/nativeLocations.js'
import type { NativeInstallation } from '../engines/kit/nativeInstall.js'
import type { NativeSetup } from '../engines/kit/nativeSetup.js'
import { engineInstallRecipe } from '../lib/engineInstall.js'
import { createLocalNativeSetup } from './nativeSetup.js'

const MAX_PREPARED = 8
const MAX_REQUESTS = 8
const PREPARATION_MS = 30_000
const held = (): NativeInstallation => ({ complete: false, detail: 'Waiting for engine setup.' })
const busy = () => { console.warn('[engine-setup] SETUP_BUSY'); return { error: 'SETUP_BUSY', installation: held() } }
const string = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
const engineOf = (value: unknown): AgentEngine | null => (ENGINES as readonly unknown[]).includes(value) ? value as AgentEngine : null
function locations(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  return entries.length <= LAUNCH_LOCATION_VARIABLES.length && entries.every(([key, value]) =>
    (LAUNCH_LOCATION_VARIABLES as readonly string[]).includes(key) && typeof value === 'string' && !value.includes('\0'))
    && JSON.stringify(value).length <= 65_536 ? value as Record<string, string> : null
}

export function startEngineSetup(directory: string, given?: NativeSetup) {
  const probes = given ? undefined : createSetupProbeExecutor()
  const setup = given ?? createLocalNativeSetup(directory, probes!.execute)
  interface Preparation {
    engine: AgentEngine; request: string; expiresAt: number; live: boolean; committed: boolean; finished: boolean
    decide(allowed: boolean): void
    result: Promise<NativeInstallation>
    timer: ReturnType<typeof setTimeout>
  }
  const prepared = new Map<string, Preparation>()
  // Revocation never releases admission: even disconnected work owns its slot until ensure settles.
  const stop = () => {
    probes?.close()
    for (const entry of prepared.values()) { entry.live = false; entry.decide(false); clearTimeout(entry.timer) }
  }
  const requests: Record<string, ServiceRequests[string]> = {
    setup_probe: async payload => {
      const environment = locations(payload.environment)
      if (!environment || !string(payload.command) || !string(payload.identity, 32768)
        || !['help', 'version', 'versionHelp', 'runtime'].includes(String(payload.kind))) return { output: null }
      const executable = retainedExecutable(payload.command, payload.identity)
      const output = await setup.probe(executable, payload.kind as 'help' | 'version' | 'versionHelp' | 'runtime', environment)
      return { output: executable.current() ? output : null }
    },
    setup_download: async payload => {
      const engine = engineOf(payload.engine)
      return { downloading: engine ? await setup.downloading(engine) : false }
    },
    setup_version: async payload => {
      if (payload.engine === 'opencode') return { major: await setup.opencodeMajor() }
      if (payload.engine !== 'hermes') return { keepsRecord: null }
      const environment = payload.environment === undefined ? undefined : locations(payload.environment)
      if (environment === null || payload.command !== undefined && !string(payload.command)) return { keepsRecord: null }
      return { keepsRecord: await setup.hermesKeepsRecord(payload.command ? { command: payload.command as string } : undefined, environment) }
    },
    setup_status: async (payload, _asker, closed) => {
      const engine = engineOf(payload.engine)
      return { installation: engine && string(payload.request) ? await setup.installations.status(engine, payload.request, () => !closed?.aborted) : held() }
    },
    setup_prepare: async (payload, _asker, closed) => {
      const engine = engineOf(payload.engine), environment = locations(payload.environment)
      if (!engine || !string(payload.request) || !environment || closed?.aborted) return { installation: held() }
      const recipe = engineInstallRecipe(engine)
      if (!recipe) return { installation: held() }
      for (const [token, entry] of prepared) if (entry.finished) { clearTimeout(entry.timer); prepared.delete(token) }
      if (prepared.size >= MAX_PREPARED) return busy()
      const token = randomUUID(), request = payload.request
      let decide!: (allowed: boolean) => void, ready!: (value: Record<string, unknown>) => void
      const decision = new Promise<boolean>(resolve => { decide = resolve })
      const readiness = new Promise<Record<string, unknown>>(resolve => { ready = resolve })
      const entry: Preparation = { engine, request, expiresAt: Date.now() + PREPARATION_MS, live: true, committed: false, finished: false, decide,
        result: Promise.resolve(held()), timer: setTimeout(() => {
          entry.live = false; entry.decide(false)
        }, PREPARATION_MS) }
      entry.timer.unref?.()
      prepared.set(token, entry)
      const current = () => entry.live && Date.now() < entry.expiresAt && !closed?.aborted
      entry.result = setup.installations.ensure(engine, recipe, Object.freeze({ ...environment }), request, current,
        () => { if (!current()) return Promise.resolve(false); ready({ preparation: token }); return decision })
        .catch(() => { console.warn('[engine-setup] INSTALLATION_PREPARATION_FAILED'); return held() }).then(result => { entry.finished = true; return result })
      return Promise.race([readiness, entry.result.then(installation => ({ installation }))])
    },
    setup_commit: async payload => {
      const entry = typeof payload.preparation === 'string' ? prepared.get(payload.preparation) : undefined
      if (!entry || !entry.live || entry.engine !== payload.engine || entry.request !== payload.request) return { installation: held() }
      if (Date.now() >= entry.expiresAt) {
        entry.live = false; entry.decide(false); clearTimeout(entry.timer)
        return { installation: held() }
      }
      if (!entry.committed) { entry.committed = true; entry.decide(payload.allowed === true) }
      return { installation: await entry.result }
    },
  }
  // Actual settlement releases request admission: timeouts/disconnects cannot free stuck reads or duplicate commits.
  let answering = 0
  // These handlers are private core calls, never client routes. Keep this check even for explicit inline composition.
  for (const [type, handler] of Object.entries(requests)) requests[type] = async (payload, asker, closed) => {
    if (!asker.local || !asker.owner || asker.connection !== undefined) return { error: 'SETUP_OWNER_REQUIRED' }
    if (answering >= MAX_REQUESTS) return busy()
    answering++
    try { return await handler!(payload, asker, closed) }
    finally { answering-- }
  }
  return { requests, stop }
}
