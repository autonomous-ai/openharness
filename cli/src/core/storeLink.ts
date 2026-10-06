/**
 * The Harness Store in its own process, as the core hears it (beside the viewers; the process's side is
 * services/storeProcess.ts). The core asks the Store nothing: the apps' requests are routed to it. The
 * Store tells the core how an install is going, which the core pushes to the apps
 * (`CoreApi.clients.dshInstallStatus`), and that what is installed changed, so that the core reads the
 * installed index again rather than from its two-second cache (dsh/installed.ts): the create that follows
 * an install must find the harness just installed.
 */
import type { CoreApi } from './api.js'

export function createStoreLink(core: Pick<CoreApi, 'clients'>, installedChanged: () => void) {
  return {
    /** The core's answers to the Store's questions (core/serviceLinks.ts `answer`, for `store`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'installStatus') {
        const status = payload.status
        if (!status || typeof status !== 'object' || Array.isArray(status)) return { error: 'BAD_STATUS' }
        core.clients.dshInstallStatus(status as Record<string, unknown>)
        return { said: true }
      }
      if (query === 'installed') {
        installedChanged()
        return { read: true }
      }
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}
