/** Master-only process selection and updater budget; core reads service membership and capability reports alone. */
import type { ServiceHostSpec, ServiceSpec } from './services.js'

/**
 * The updater's process (services/updaterProcess.ts): checks for a newer build of the CLI and of hn, and
 * downloads, verifies, canaries and stages it, then tells the master, which has the core hand over. Its own
 * process and never the core's: the core never downloads a build, and a core that cannot start (safe mode)
 * or a host whose services keep crashing must not stop the fix from arriving. Not one of `SERVICE_HOSTS`:
 * the core neither routes to it nor runs it, and `HARNESSD_SERVICES` does not turn it off; the master runs
 * it when it runs the installed copy with updates on (masterProcess.ts). It holds one download at a time.
 */
export const UPDATER_HOST: ServiceHostSpec = { services: ['updater'], heapLimitMiB: 256, rssLimitMiB: 512 }
export const UPDATER_PROCESS = 'updater' // the name the master runs it under: the one whose staged build counts

/**
 * The processes to run the services in: every service this build knows, unless `HARNESSD_SERVICES`
 * names a subset, by service (`search,workspaces`) or by process (`edge`, every service it hosts); `none`
 * (or empty) runs them all inside the core's process, for debugging or a quick way back. Isolation is
 * the point of the split (one service failing costs only its process), so it is the default, not an
 * opt-in. Each process hosts the services named of its own, and is not started for none. A process
 * named as one of its services is named whole: `viewers` runs the viewers' process, the Store beside
 * them, as it ran the viewers' before the Store joined it. `HARNESSD_SERVICE_HEAP_LIMIT_MIB` gives every
 * one the same heap limit instead (tests, support). A process on demand (`onDemand`: an experiment's, the
 * devices', the viewers') waits for the core to ask for it; named in `HARNESSD_SERVICES`, it starts with the others.
 */
export function serviceSpecs(env: NodeJS.ProcessEnv, hosts: Readonly<Record<string, ServiceHostSpec>>): ServiceSpec[] {
  const named = env.HARNESSD_SERVICES === undefined ? null
    : new Set(env.HARNESSD_SERVICES.split(',').map((name) => name.trim()).filter((name) => name && name !== 'none'))
  const heap = Number(env.HARNESSD_SERVICE_HEAP_LIMIT_MIB)
  return Object.entries(hosts).flatMap(([name, host]) => {
    const services = host.services.filter((service) => !named || named.has(service) || named.has(name))
    // A process on demand named outright runs from the start, as every service named does (a test, support).
    const onDemand = host.onDemand && !named ? { onDemand: true } : {}
    const { onDemand: _given, ...rest } = host
    return services.length ? [{ name, ...rest, services, ...onDemand, ...(Number.isInteger(heap) && heap > 0 ? { heapLimitMiB: heap } : {}) }] : []
  })
}

