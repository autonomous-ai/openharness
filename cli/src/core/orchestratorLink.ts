/**
 * The orchestrator in its own process, as the core sees it (an experiment, step 8; the process's side is
 * services/orchestratorProcess.ts).
 *
 * The core asks it one thing in line: what an agent is to its projects, at every turn's end
 * (core/turns/recaps.ts). That cannot wait on another process, so the process reports the role of every
 * live agent that has one whenever a project changes (`roles`), and the core answers from the last report:
 * no role before the first, as while it is off. A report holds while the process is down, since only the
 * orchestrator changes a role, and it cannot while it is down.
 *
 * It reads its Directors' turns from the frames the apps are sent. Only an agent reported as a Director's,
 * and only the four kinds it reads, go to its process, so every other frame (every agent's `text_delta`)
 * stays in the core. Nothing is held for it while it is down: an open service in the core's process read
 * nothing it missed either.
 */
import type { OrchestratorPort, OrchestratorRole } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

/** The frames a project reads its Director's turn from (orchestrator/service.ts `ingest`). */
export const DIRECTOR_FRAMES: ReadonlySet<string> = new Set(['turn_started', 'turn_ended', 'text_delta', 'error'])

const roleIn = (value: unknown): OrchestratorRole | null => {
  const role = value as { role?: unknown; busy?: unknown } | null
  if (role?.role === 'worker') return { role: 'worker' }
  if (role?.role === 'director' && typeof role.busy === 'boolean') return { role: 'director', busy: role.busy }
  return null
}

/** `notify` tells the orchestrator's process something (core/serviceLinks.ts `notify`, for `orchestrator`). */
export function createOrchestratorLink(notify: (frame: ServiceFrame) => boolean) {
  let roles = new Map<string, OrchestratorRole>()
  const port: OrchestratorPort = {
    roleOf: (agentId) => roles.get(agentId) ?? null,
    frame: (frame) => {
      if (typeof frame.agentId !== 'string' || roles.get(frame.agentId)?.role !== 'director' || !DIRECTOR_FRAMES.has(String(frame.type))) return
      notify({ type: 'service_event', payload: { kind: 'frame', frame } })
    },
    // Its process is the master's to stop.
    stop: () => {},
  }
  return {
    port,
    /** The orchestrator's report of every role, replacing the last (`service_query roles`); null for any other query. */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> | null {
      if (query !== 'roles') return null
      const reported = payload.roles && typeof payload.roles === 'object' ? payload.roles as Record<string, unknown> : {}
      roles = new Map(Object.entries(reported).flatMap(([agentId, value]) => {
        const role = roleIn(value)
        return role ? [[agentId, role] as const] : []
      }))
      return {}
    },
  }
}
