/**
 * The Wi-Fi device's service in the devices' process (services/wifiProcess.ts), as the core sees it: the
 * port the core calls (`WifiPort`) and what the core answers when the service asks (step 9, D3).
 *
 * Input facts and window notifications use this ordered link. Transcript evidence and normalized
 * event observation belong to the component and do not traverse this port.
 * On reconnection the core publishes only the current window focus; authenticated relay sessions and
 * application hello state come from the gateway peer. What a person asks of it
 * (`harness device receipt`, its add-ons) are its routes of the door (core/serviceRoutes.ts).
 *
 * Its remaining reads name this machine and recent turns. Create uses the shared ID-only primitive
 * under its existing empty-launch grant; desk gestures and Stop use ordinary component client doors.
 */
import type { CoreApi, WifiPort } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'
import { parseAgentCreate } from './experimentQueries.js'

export interface WifiLinkDeps {
  core: CoreApi
  /** A notice for the service's process; false when it is not connected to hear it. */
  notify(frame: ServiceFrame): boolean
  log?: (line: string) => void
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createWifiLink(deps: WifiLinkDeps) {
  const { core } = deps
  const log = deps.log ?? ((line: string) => console.warn(line))
  const event = (kind: string, payload: Record<string, unknown> = {}): void => { deps.notify({ type: 'service_event', payload: { ...payload, kind } }) }

  const port: WifiPort = {
    resume: async (state) => event('resume', { ...state }),
    input: progress => event('input', { event: progress }),
    disconnected: () => event('disconnected'),
    delivery: (delivery) => event('delivery', { event: delivery }),
    appFocus: async (machineId, agentId, connId) => event('appFocus', { machineId, agentId, connId }),
    revealed: (operationId, agentId) => event('revealed', { operationId, agentId }),
    // Its own process: the master stops it.
    stop: async () => {},
  }

  /** What the service may ask of the core (`service_query`), by name. */
  const queries: Record<string, (payload: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>> = {
    // Which machine this is (the account's id, which every frame to a device carries), asked as it connects.
    machine: () => ({ id: core.machine.id() }),
    // Asked, not told: the pane's lock says what became of the prompt as it takes it, and the device's reply
    // carries that, as it did when the service ran in the core's process.
    recent: async ({ agentId, n }) => ({ turns: await core.turns.recent(text(agentId), typeof n === 'number' ? n : 3) }),

  }

  return {
    port,
    answer(query: string, payload: Record<string, unknown>, current?: () => boolean): Record<string, unknown> | Promise<Record<string, unknown>> {
      if (query === 'create') {
        if (!current?.()) return { ok: false, error: 'SERVICE_UNAVAILABLE' }
        const request = parseAgentCreate(payload)
        // This existing service capability never grants a first task, permission bypass or another identity.
        if (!request || payload.prompt !== null || payload.name !== null || payload.bypassPermission !== false
          || request.requireUnusedWorkspace !== true) return { ok: false, error: 'INVALID_REQUEST' }
        return core.agents.create(request)
      }
      const ask = Object.hasOwn(queries, query) ? queries[query] : undefined
      return ask ? ask(payload) : { error: 'UNKNOWN_QUERY' }
    },
    notice(payload: Record<string, unknown>): void {
      const kind = text(payload.kind)
      log(`[services] wifi said ${kind.slice(0, 40) || 'nothing'}, which the core does not hear`)
    },
  }
}

export type WifiLink = ReturnType<typeof createWifiLink>
