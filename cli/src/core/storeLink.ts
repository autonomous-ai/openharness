/**
 * The Harness Store in its own process, as the core hears it (beside the viewers; the process's side is
 * services/storeProcess.ts). The apps' requests are routed to it. The
 * Store tells the core how an install is going, which the core pushes to the apps
 * (`CoreApi.clients.dshInstallStatus`), and that what is installed changed, so that the core reads the
 * installed index again rather than from its two-second cache (dsh/installed.ts): the create that follows
 * an install must find the harness just installed.
 */
import type { CoreApi } from './api.js'

export function createStoreLink(core: Pick<CoreApi, 'clients'>, installedChanged: () => void) {
  let prepared = false
  const waiters = new Set<() => void>()
  return {
    /** Wait only at boot, before restoring bundled harness agents. A missing Store cannot stop boot. */
    ready(waitMs = 5_000): Promise<boolean> {
      if (prepared) return Promise.resolve(true)
      return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); waiters.delete(done); resolve(true) }
        const timer = setTimeout(() => { waiters.delete(done); resolve(false) }, waitMs)
        waiters.add(done)
      })
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
        }
        return { read: true }
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}
