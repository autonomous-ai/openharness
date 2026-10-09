/**
 * Connected services (lib/connectors): the MCP bridge every local agent's connector entries point at
 * (127.0.0.1:51793), and `connectors`, the desktop app's Connectors screen. Agents' entries are written
 * again as it starts, so an agent installed since a service was connected gets it too.
 *
 * `connectors` takes `{action}`: `list`, `connect` {connector}, `flow` {flow}, `disconnect` {connector},
 * `custom` {name, url, headers}. The app opens a returned `authorize_url` in the browser and follows the
 * flow. Never a token in a reply. Owner only, and end-to-end encrypted like `api_connections`.
 */
import type { Server } from 'node:http'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { bridgePort, sync } from '../lib/connectors/agents.js'
import { createBridge } from '../lib/connectors/bridge.js'
import { services, type GatewayRow } from '../lib/connectors/catalog.js'
import { addCustom, cards, disconnect, Flows, signInFor } from '../lib/connectors/connect.js'
import * as gateway from '../lib/connectors/gateway.js'
import { ConnectorError, Store, validateCode } from '../lib/connectors/store.js'

/** The request connectors answers for the apps, declared in core/api.ts for the core to route. */
export { CONNECTORS_REQUESTS } from '../core/api.js'

const GATEWAY_CACHE_MS = 60_000

export interface ConnectorsDeps {
  vault: Store
  port: number
  /** The gateway's list for this account. Injected so a spec reaches no network. */
  offered: () => Promise<Record<string, GatewayRow>>
  env: NodeJS.ProcessEnv
  /** How long to wait before listening again while another process holds the port. */
  retryMs: number
}

/** Listen on the bridge's fixed port; while another process holds it (a core handing over), try again. */
function listen(bridge: Server, port: number, retryMs: number): void {
  bridge.on('error', () => { setTimeout(() => bridge.listen(port, '127.0.0.1'), retryMs).unref() })
  bridge.listen(port, '127.0.0.1')
}

export function startConnectors(_core: CoreApi, overrides: Partial<ConnectorsDeps> = {}): ServiceRequests {
  const env = overrides.env ?? process.env
  const deps: ConnectorsDeps = {
    vault: overrides.vault ?? new Store(undefined, env), port: overrides.port ?? bridgePort(env),
    offered: overrides.offered ?? (() => gateway.available()), env, retryMs: overrides.retryMs ?? 5_000,
  }
  const { vault } = deps
  const flows = new Flows(vault, env)
  const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key ?? '') })
  bridge.unref()
  listen(bridge, deps.port, deps.retryMs)
  try { sync(vault, env) } catch { /* A config that cannot be written now is written at the next connect. */ }

  let offered: Record<string, GatewayRow> = {}
  let offeredAt = 0
  const gatewayOffers = async () => {
    if (Date.now() - offeredAt > GATEWAY_CACHE_MS) { offered = await deps.offered(); offeredAt = Date.now() }
    return offered
  }

  const answer = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (payload.action) {
      case 'list': return { ...cards(vault, await gatewayOffers()) }
      case 'connect': {
        const code = validateCode(payload.connector)
        return { ...(await flows.start(code, signInFor(vault, code, services(await gatewayOffers())))) }
      }
      case 'flow': {
        // Never an `error` key on an answer: the desktop's socket reads one, even empty, as the request
        // failing, and would never see the sign-in finish. Why one failed rides as `reason`.
        const { connector, state, error } = flows.get(String(payload.flow ?? ''))
        return { connector, state, ...(error ? { reason: error } : {}) }
      }
      case 'disconnect': {
        const code = validateCode(payload.connector)
        await disconnect(vault, code, env)
        return { connector: code, state: 'not_connected' }
      }
      case 'custom': return addCustom(vault, flows, payload, env)
      default: return { error: 'CONNECTORS_FAILED', detail: 'Unknown action.' }
    }
  }

  return {
    connectors: async (payload, asker) => {
      if (!asker.owner) return { error: 'OWNER_REQUIRED' }
      try { return await answer(payload) } catch (error) {
        return { error: 'CONNECTORS_FAILED', detail: error instanceof ConnectorError ? error.message : 'Connections are unavailable. Try again.' }
      }
    },
  }
}
