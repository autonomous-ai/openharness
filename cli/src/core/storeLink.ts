/**
 * The Harness Store in its own process, as the core hears it (beside the viewers; the process's side is
 * services/storeProcess.ts). The apps' requests are routed to it. The
 * Store tells the core how an install is going, which the core pushes to the apps
 * (`CoreApi.clients.dshInstallStatus`), and that what is installed changed, so that the core reads the
 * installed index again rather than from its two-second cache (dsh/installed.ts): the create that follows
 * an install must find the harness just installed.
 */
import type { DshLaunchAnswer, DshMaterializeAnswer, DshRefusal } from '../dsh/launchWire.js'
import type { CoreApi, StorePort } from './api.js'
import { ServiceUnavailableError } from './serviceHost.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)

function refusal(value: Record<string, unknown>): DshRefusal | null {
  if (value.ok !== false || !text(value.error) || !text(value.detail)) return null
  if (value.unavailable !== undefined && value.unavailable !== 'store') return null
  if (value.thrown !== undefined && !text(value.thrown)) return null
  if (value.holdScope !== undefined && value.holdScope !== 'workspace') return null
  return { ok: false, error: value.error, detail: value.detail,
    ...(value.unavailable ? { unavailable: value.unavailable } : {}),
    ...(value.holdScope ? { holdScope: value.holdScope } : {}),
    ...(value.thrown !== undefined ? { thrown: value.thrown } : {}) }
}

/** Only a checked contribution can reach the pane; malformed answers hold the launch. */
export function dshMaterializeAnswerIn(value: unknown): DshMaterializeAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  return texts(value.created) && texts(value.kept) && texts(value.warnings)
    ? { ok: true, created: value.created, kept: value.kept, warnings: value.warnings } : null
}

export function dshLaunchAnswerIn(value: unknown): DshLaunchAnswer | null {
  if (!record(value)) return null
  if (value.ok !== true) return refusal(value)
  const launch = value.launch
  if (!record(launch) || !record(launch.env) || !Object.values(launch.env).every(text) || !texts(launch.args)) return null
  return { ok: true, launch: { env: launch.env as Record<string, string>, args: launch.args } }
}

type CallStore = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

export function createStoreLink(core: Pick<CoreApi, 'clients'>, installedChanged: () => void,
  call: CallStore = async () => ({ error: 'SERVICE_UNAVAILABLE' })) {
  const listeners = new Set<() => void>()
  const port: StorePort = {
    dshMaterialize: async request => {
      const answer = dshMaterializeAnswerIn(await call('dshMaterialize', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
    dshLaunch: async request => {
      const answer = dshLaunchAnswerIn(await call('dshLaunch', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
  }
  return {
    port,
    /** Restore is already held in core; a Store notice only schedules another pass after core ready. */
    onReady(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** The core's answers to the Store's questions (core/serviceLinks.ts `answer`, for `store`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'installStatus') {
        const status = payload.status
        if (!status || typeof status !== 'object' || Array.isArray(status)) return { error: 'BAD_STATUS' }
        core.clients.dshInstallStatus(status as Record<string, unknown>)
        return { said: true }
      }
      if (query === 'prepared' || query === 'installed') {
        installedChanged()
        if (query === 'prepared') {
          for (const ready of listeners) ready()
        }
        return { read: true }
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}
