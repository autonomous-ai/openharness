/**
 * Connected services (lib/connectors): the MCP bridge every local agent's connector entries reach, through a stdio shim to
 * its 0600 socket (and on 127.0.0.1:51793 for clients still running on that address), and `connectors`, the desktop app's Connectors screen. Agents' entries are written
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
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { bridgePort, bridgeSocketPath, sync } from '../lib/connectors/agents.js'
import { createBridge, serveBridgeSocket } from '../lib/connectors/bridge.js'
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

/** Listen on the bridge's fixed port; while another process holds it (a core handing over), try again. */
function listen(bridge: Server, port: number, retryMs: number): void {
  bridge.on('error', () => { setTimeout(() => bridge.listen(port, '127.0.0.1'), retryMs).unref() })
  bridge.listen(port, '127.0.0.1')
}

/** The MCP clients' way in (lib/connectors/mcpShimSource.ts). While a live socket is there (a core handing over), try again.
 *  Said once: its clients are told Harness is not running, though it is. */
function listenSocket(vault: Store, path: string, retryMs: number, said = false): void {
  serveBridgeSocket(vault, path).catch((error: unknown) => {
    if (!said) console.warn(`[connectors] the bridge's socket is not listening (${path}), trying again: ${error instanceof Error ? error.message : String(error)}`)
    setTimeout(() => listenSocket(vault, path, retryMs, true), retryMs).unref()
  })
}

export function startConnectors(core: CoreApi, overrides: Partial<ConnectorsDeps> = {}): ServiceRequests {
  const env = overrides.env ?? process.env
  const deps: ConnectorsDeps = {
    vault: overrides.vault ?? new Store(undefined, env), port: overrides.port ?? bridgePort(env),
    offered: overrides.offered ?? (() => gateway.available()), env, retryMs: overrides.retryMs ?? 5_000,
    vaultPort: overrides.vaultPort !== undefined ? overrides.vaultPort
      : core.account.signedIn() ? vaultPortOf((op, payload = {}) => answerVaultOp(core.account, { ...payload, op })) : null,
  }
  const { vault } = deps
  const flows = new Flows(vault, env)
  const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key ?? ''), harnessKey: () => String(vault.file('harness-key.json').key ?? '') })
  bridge.unref()
  listen(bridge, deps.port, deps.retryMs)
  const socket = bridgeSocketPath(vault)
  if (socket) listenSocket(vault, socket, deps.retryMs)
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
