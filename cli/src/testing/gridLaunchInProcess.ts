/**
 * The models service's grid launch, answered in this process, for specs that build a launch with no models process
 * running: what `services/models.ts` answers `ModelsPort.gridLaunch` with. Without saved APIs a saved-API launch is
 * built as the spec wrote it, as `buildLaunchOverrides` built it before the launch port, so those specs pin the
 * same launches they always did.
 */
import type { ApiConnections } from '../lib/apiConnections.js'
import { refreshApiFor } from '../lib/apiModels.js'
import { answerGridLaunch } from '../lib/gridLaunch.js'
import type { GridLaunchAnswer, GridLaunchOverride, GridLaunchRequest } from '../lib/gridLaunchWire.js'

export function gridLaunchInProcess(savedApis?: ApiConnections): (request: GridLaunchRequest) => Promise<GridLaunchAnswer> {
  const refresh = savedApis ? refreshApiFor(savedApis) : (override: GridLaunchOverride) => ({ override })
  return async (request) => answerGridLaunch(request, refresh)
}
