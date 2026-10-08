/**
 * The Harness Store in its own process, as the core hears it (beside the viewers; the process's side is
 * services/storeProcess.ts). The apps' requests are routed to it. The
 * Store tells the core how an install is going, which the core pushes to the apps
 * (`CoreApi.clients.dshInstallStatus`), and that what is installed changed, so that the core reads the
 * installed index again rather than from its two-second cache (dsh/installed.ts): the create that follows
 * an install must find the harness just installed.
 *
 * The core asks it a harness package's part of a launch (`port`, core/api.ts `StorePort`): asked when needed
 * (core/serviceLinks.ts `call`), each answer checked as far as the core hands it on. An answer that does not come
 * (the process is down, or slower than its wait) is the Store being unavailable, and the launch is refused.
 */
import type { DshLaunchAnswer, DshMaterializeAnswer } from '../dsh/launchWire.js'
import type { CoreApi, StorePort } from './api.js'
import { ServiceUnavailableError } from './serviceHost.js'

/** A port call to the Store's process, answered by it or by its link (core/serviceLinks.ts `call`). */
export type CallStore = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText)

/** A refusal, checked: why, in the Store's words. */
function refusalIn(value: Record<string, unknown>): { ok: false; error: string; detail: string; thrown?: string } | null {
  if (!isText(value.error) || !isText(value.detail)) return null
  if (value.thrown !== undefined && !isText(value.thrown)) return null
  return { ok: false, error: value.error, detail: value.detail, ...(isText(value.thrown) ? { thrown: value.thrown } : {}) }
}

/** The Store's answer to a create's workspace, checked; null when it is not one. */
export function dshMaterializeAnswerIn(value: Record<string, unknown>): DshMaterializeAnswer | null {
  if (value.ok === false) {
    const refused = refusalIn(value)
    return refused && { ok: false, error: refused.error, detail: refused.detail }
  }
  if (value.ok !== true || !isTexts(value.created) || !isTexts(value.kept) || !isTexts(value.warnings)) return null
  return { ok: true, created: value.created, kept: value.kept, warnings: value.warnings }
}

/** The Store's answer to a session's runtime, checked as far as the core hands it to a pane; null when it is not one. */
export function dshLaunchAnswerIn(value: Record<string, unknown>): DshLaunchAnswer | null {
  if (value.ok === false) return refusalIn(value)
  const launch = value.launch
  if (value.ok !== true || !isRecord(launch) || !isTexts(launch.args) || !isRecord(launch.env)) return null
  if (!Object.values(launch.env).every(isText)) return null
  return { ok: true, launch: { env: launch.env as Record<string, string>, args: launch.args } }
}

export function createStoreLink(core: Pick<CoreApi, 'clients'>, installedChanged: () => void, call: CallStore = async () => ({ error: 'SERVICE_UNAVAILABLE' })) {
  let prepared = false
  const waiters = new Set<() => void>()
  const readyListeners = new Set<() => void>()
  /** Asked of the Store: unavailable when it is down, slower than its wait, or failed the call. */
  const ask = async (type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const answer = await call(type, payload)
    if (answer.error === 'SERVICE_UNAVAILABLE' || answer.error === 'SERVICE_FAILED') throw new ServiceUnavailableError('store')
    return answer
  }
  const port: StorePort = {
    dshMaterialize: async (request) => {
      const answer = dshMaterializeAnswerIn(await ask('dshMaterialize', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
    dshLaunch: async (request) => {
      const answer = dshLaunchAnswerIn(await ask('dshLaunch', { ...request }))
      if (!answer) throw new ServiceUnavailableError('store')
      return answer
    },
  }
  return {
    port,
    /** Wait only at boot, before restoring bundled harness agents. A missing Store cannot stop boot. */
    ready(waitMs = 5_000): Promise<boolean> {
      if (prepared) return Promise.resolve(true)
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(true) }
        const timer = setTimeout(() => { waiters.delete(done); resolve(false) }, waitMs)
        waiters.add(done)
      })
    },
    /** `listener` each time the Store says it is ready: at its first connection, and again after a restart of
     *  either side. Returns the way to stop listening. */
    onReady(listener: () => void): () => void {
      readyListeners.add(listener)
      return () => { readyListeners.delete(listener) }
    },
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
          prepared = true
          for (const done of waiters) done()
          for (const listener of readyListeners) listener()
        }
        return { read: true }
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}
