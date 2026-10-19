import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { superTabService, type SuperTabServiceOptions } from '../superTabs/service.js'

/** No feature state lives in the core. Inline mode uses the same host journal and guards. */
export function startSuperTabs(core: CoreApi, ports: CorePorts, options?: SuperTabServiceOptions): ServiceRequests {
  const service = superTabService(core, options)
  ports.superTabs = service.port
  service.port.connected()
  return service.requests
}
