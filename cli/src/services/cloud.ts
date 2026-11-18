/**
 * Cloud agents (`cloud`), an experiment: harnesses that run on their maker's servers (Fo, Devin Cloud, Cursor
 * Cloud) and have no pane (cloud/service.ts, docs/design/2026-10-11-cloud-agents.md). The core lists them,
 * puts their questions in front of the person, and hands a New Harness for one, a message, an answer and a
 * Stop to this service through its port (core/agents/cloud.ts).
 * - In the core's process (`HARNESSD_SERVICES=none`) it starts here, on `core.cloud`; in its own process,
 *   services/cloudProcess.ts starts the same service on `core.cloud` asked over its link.
 */
import type { CoreApi, CorePorts, ServiceRequests } from '../core/api.js'
import { startCloudService, type CloudService, type CloudServiceOptions } from '../cloud/service.js'

/** The requests cloud agents answer, declared in core/api.ts for the core to route. */
export { CLOUD_REQUESTS } from '../core/api.js'

/** The service on a core's doors, its port in `ports.cloud`: what its process keeps to tell a reconnected core again. */
export function startCloudOn(core: CoreApi, ports: CorePorts, options: Partial<CloudServiceOptions> = {}): CloudService {
  if (!core.owners) throw new Error('this core offers no session owner door')
  const service = startCloudService({ dataDir: core.dataDir, core: core.owners, ...options })
  ports.cloud = Object.assign(service.port, { stop: () => service.stop() })
  return service
}

/** Cloud agents in the core's process (`HARNESSD_SERVICES=none`): its harnesses told at once. */
export function startCloud(core: CoreApi, ports: CorePorts, options: Partial<CloudServiceOptions> = {}): ServiceRequests {
  const service = startCloudOn(core, ports, options)
  service.republish()
  return service.requests
}
