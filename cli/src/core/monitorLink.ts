/**
 * The machine monitor in its own process, as the core reaches it (in the edge host; the process's side is
 * services/monitorProcess.ts).
 *
 * The core asks the monitor two things, both answered when they are read and never in a connection's
 * line: the readings `agents_list` adds to its rows for the Monitor (`resources`, `storage`), and, after a
 * purge, to forget what it measured (`storage` with `invalidate`). Out of process each is a request to
 * the monitor's process (core/serviceLinks.ts `call`), and an answer that does not come (the process is
 * down, or slower than the link waits) is what the in-process fallbacks give (core/api.ts
 * `MONITOR_FALLBACKS`): rows without readings, and nothing measured to forget. Nothing is held for the
 * process while it is down: a reading asked for later is read later.
 */
import type { MonitorPort } from './api.js'
import { ServiceUnavailableError } from './serviceHost.js'

/** Ask the monitor's process (core/serviceLinks.ts `call`, for `monitor`): never rejects. */
export type CallMonitor = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>

type Snapshot = Awaited<ReturnType<MonitorPort['resources']>>
type Readings = Awaited<ReturnType<MonitorPort['storage']>>

export function createMonitorLink(call: CallMonitor): MonitorPort {
  return {
    resources: async () => {
      const answer = await call('resources', {})
      // SERVICE_UNAVAILABLE or SERVICE_FAILED: no sample, which the list reads as rows without readings.
      if (!answer.snapshot || typeof answer.snapshot !== 'object') throw new ServiceUnavailableError('monitor')
      return answer.snapshot as Snapshot
    },
    storage: async (agents, invalidate = false) => {
      const answer = await call('storage', { agents, invalidate })
      return new Map(Array.isArray(answer.entries) ? answer.entries : []) as Readings
    },
  }
}
