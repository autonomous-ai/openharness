/**
 * Connected services (lib/connectors): the MCP bridge every local agent's connector entries point at
 * (127.0.0.1:51793), and `connectors`, the desktop app's Connectors screen. Agents' entries are written
 * again as it starts, so an agent installed since a service was connected gets it too.
 *
 * `connectors` takes `{action}`: `list`, `connect` {connector}, `flow` {flow}, `disconnect` {connector},
 * `custom` {name, url, headers}, `callback` {flow, url}. The app opens a returned `authorize_url` in the
 * browser and follows the flow. A phone signing in for this computer opens it in its own browser and,
 * for a service this computer signs in to itself, sends back the redirect to 127.0.0.1 it caught as
 * `callback`: the code alone is useless without the PKCE verifier kept here. Never a token in a reply.
 * Owner only, and end-to-end encrypted like `api_connections`.
 *
 * The connections are the account's: kept the same on every computer through the backend, sealed for the
 * account's machines (lib/connectors/vaultSync.ts).
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { bridgePort, saveBridgePort, sync } from '../lib/connectors/agents.js'
import { createBridge } from '../lib/connectors/bridge.js'
import { services, type GatewayRow } from '../lib/connectors/catalog.js'
import { addApiKey, addCustom, cards, disconnect, Flows, signInFor } from '../lib/connectors/connect.js'
import * as gateway from '../lib/connectors/gateway.js'
import { ConnectorError, Store, validateCode } from '../lib/connectors/store.js'
import { answerVaultOp, VaultSync, vaultPortOf, type VaultPort } from '../lib/connectors/vaultSync.js'

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
  /** The account's sealed connections (lib/connectors/vaultSync.ts), or null to keep them on this
   *  computer alone. In the core's process it is the core's own `connector_vault` answer, signed in. */
  vaultPort: VaultPort | null
}

/** How many tries a held port gets: the bridge of the process this one replaced may still be letting go of it. */
const TRIES_BEFORE_MOVING = 3

/**
 * Listen on [port]. Another process holding it means agents' connections reach that process, not this bridge, so that is
 * said once, and after a few tries [moved] (when given) has the bridge take a free port and tell the agents about it.
 * Another account can hold it with no race, from boot until this user logs in (audit H1).
 */
function listen(bridge: Server, port: number, retryMs: number, moved?: (port: number) => void): void {
  let tries = 0
  let moving = false
  bridge.on('listening', () => {
    if (moving && moved) moved((bridge.address() as AddressInfo).port)
    moving = false
    tries = 0
  })
  bridge.on('error', (error: NodeJS.ErrnoException) => {
    tries++
    if (tries === 1) console.warn(`[connections] bridge port ${port} is not available (${error.message}); trying again every ${retryMs} ms`)
    moving = !!moved && tries >= TRIES_BEFORE_MOVING
    setTimeout(() => bridge.listen(moving ? 0 : port, '127.0.0.1'), retryMs).unref()
  })
  bridge.listen(port, '127.0.0.1')
}

export function startConnectors(core: CoreApi, overrides: Partial<ConnectorsDeps> = {}): ServiceRequests {
  const env = overrides.env ?? process.env
  const store = overrides.vault ?? new Store(undefined, env)
  const deps: ConnectorsDeps = {
    vault: store, port: overrides.port ?? bridgePort(env, store),
    offered: overrides.offered ?? (() => gateway.available()), env, retryMs: overrides.retryMs ?? 5_000,
    vaultPort: overrides.vaultPort !== undefined ? overrides.vaultPort
      : core.account.signedIn() ? vaultPortOf((op, payload = {}) => answerVaultOp(core.account, { ...payload, op })) : null,
  }
  const { vault } = deps
  const flows = new Flows(vault, env)
  const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key ?? ''), harnessKey: () => String(vault.file('harness-key.json').key ?? '') })
  bridge.unref()
  // A port a test or HARNESS_CONNECTIONS_PORT names stays that port.
  const movable = overrides.port === undefined && env.HARNESS_CONNECTIONS_PORT === undefined
  listen(bridge, deps.port, deps.retryMs, movable ? (port) => {
    console.warn(`[connections] the bridge moved to port ${port}; agents started from now on use it`)
    try { saveBridgePort(vault, port); sync(vault, env) } catch (error) { console.warn(`[connections] could not save the bridge's new port: ${(error as Error).message}`) }
  } : undefined)
  try { sync(vault, env) } catch { /* A config that cannot be written now is written at the next connect. */ }

  // Connections the same on every computer of the account: read now, at each `connectors_changed`, and
  // written whenever this computer's change (here, by `harness connections`, by a renewal in the bridge).
  if (deps.vaultPort) {
    const shared = new VaultSync({ vault, port: deps.vaultPort, env, log: console.warn })
    shared.start()
    core.account.onNotice((notice) => {
      if (notice.type === 'connectors_changed') shared.changed(notice.revision)
      else if (notice.type === 'device_keys_changed') shared.changed(null)
    })
  }

  let offered: Record<string, GatewayRow> = {}
  let offeredAt = 0
  const gatewayOffers = async () => {
    if (Date.now() - offeredAt > GATEWAY_CACHE_MS) { offered = await deps.offered(); offeredAt = Date.now() }
    return offered
  }

  const answer = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (payload.action) {
      // `shared`: a connection made here reaches the account's other computers. The phone signs in
      // through one that says so before one that keeps it to itself (an older CLI says nothing).
      case 'list': return { ...cards(vault, await gatewayOffers()), shared: deps.vaultPort !== null }
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
      case 'custom': return payload.kind === 'api' ? addApiKey(vault, payload, env) : addCustom(vault, flows, payload, env)
      case 'callback': return { ...flows.deliver(String(payload.flow ?? ''), String(payload.url ?? '')) }
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
