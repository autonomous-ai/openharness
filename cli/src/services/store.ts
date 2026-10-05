/**
 * The Harness Store on this machine: the harnesses (DSHs) installed here, and installing, updating and
 * removing one (`dsh_list`, `dsh_install`, `dsh_update`, `dsh_remove`; store/spec/README.md § Wire).
 * The core never calls it, so it has no port: it only answers the apps. What each request reads off its
 * payload and replies is dsh/wire.ts.
 *
 * Install and update take minutes for a toolchain. Their handlers return a promise, so the socket never
 * holds anything else for them, and they say how they are going as `dsh_install_status` pushes, which
 * the apps show in the create dialog. Agents already running from a harness that is removed keep running:
 * their processes hold what they need.
 */
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { refreshDshRegistry } from '../dsh/catalog.js'
import { removeDsh } from '../dsh/install.js'
import { mutateDsh } from '../dsh/service.js'
import { dshInstallReply, dshInstallRequest, dshInstallStatus, dshListRows, dshRemoveId, dshRemoveReply } from '../dsh/wire.js'

/** The requests the store answers for the apps. */
export const STORE_REQUESTS = ['dsh_list', 'dsh_install', 'dsh_update', 'dsh_remove'] as const

export interface StoreDeps {
  refresh: typeof refreshDshRegistry
  remove: typeof removeDsh
  mutate: typeof mutateDsh
  rows: typeof dshListRows
}

const DEFAULTS: StoreDeps = { refresh: refreshDshRegistry, remove: removeDsh, mutate: mutateDsh, rows: dshListRows }

const internal = (error: unknown): Record<string, unknown> =>
  ({ error: 'INTERNAL', detail: error instanceof Error ? error.message : String(error) })

export function startStore(core: CoreApi, deps: StoreDeps = DEFAULTS): ServiceRequests {
  return {
    dsh_list: () => deps.refresh().then((catalog) => ({ dsh: deps.rows(undefined, catalog) }), internal),
    // The clone under ~/.harness/dsh goes (a linked install loses only its link), and the index forgets
    // it, so a `dsh_list` after this no longer says installed. The store asks, and refreshes its list.
    dsh_remove: (payload) => {
      const id = dshRemoveId(payload)
      if (!id) return { error: 'INVALID_DSH', detail: 'dsh_remove needs an id' }
      return dshRemoveReply(id, deps.remove(id))
    },
    dsh_update: (payload) => {
      const id = dshRemoveId(payload)
      if (!id) return { error: 'INVALID_DSH', detail: 'dsh_update needs an id' }
      return deps.mutate({ id, update: true }, (progress) => core.clients.dshInstallStatus(dshInstallStatus(progress, { id })))
        .then(dshInstallReply, internal)
    },
    // Clone, set up and doctor a harness on this machine.
    dsh_install: (payload) => {
      const request = dshInstallRequest(payload)
      if (!request) return { error: 'INVALID_DSH', detail: 'dsh_install needs an id or a url' }
      return deps.mutate(request, (progress) => core.clients.dshInstallStatus(dshInstallStatus(progress, request)))
        .then(dshInstallReply, internal)
    },
  }
}
