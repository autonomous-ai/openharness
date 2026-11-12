/**
 * Connected services (lib/connectors): the MCP bridge every local agent's connector entries reach, through a stdio shim to
 * its 0600 socket, or on Windows its pipe (and on 127.0.0.1:51793 for clients still running on that address), and `connectors`, the desktop app's Connectors screen. Agents' entries are written
 * again as it starts, so an agent installed since a service was connected gets it too.
 *
 * `connectors` takes `{action}`: `list`, `connect` {connector}, `flow` {flow}, `disconnect` {connector},
 * `custom` {name, url, headers}, `callback` {flow, url}; and for Gmail, Calendar and Drive through this computer's
 * Claude Code or Codex instead of Harness, `elsewhere`, `connect_via` / `disconnect_via` {connector, via}, which answer
 * the page to open in that engine's account (lib/connectors/elsewhere.ts). The app opens a returned `authorize_url` in the
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
import { bridgePort, bridgeSocketPath, retireBridgeKey, rotateHarnessKey, saveBridgePort, sync } from '../lib/connectors/agents.js'
import { portHolderIsThisAccount } from '../lib/peerAccount.js'
import { createBridge, serveBridgePipe, serveBridgeSocket } from '../lib/connectors/bridge.js'
import { services, type GatewayRow } from '../lib/connectors/catalog.js'
import { addApiKey, addCustom, cards, disconnect, Flows, signInFor } from '../lib/connectors/connect.js'
import * as gateway from '../lib/connectors/gateway.js'
import { connectVia, disconnectVia, elsewhere, type ElsewhereDeps } from '../lib/connectors/elsewhere.js'
import { keepAlive, KEEP_ALIVE_S } from '../lib/connectors/renew.js'
import { ConnectorError, Store, validateCode } from '../lib/connectors/store.js'
import { answerVaultOp, VaultSync, vaultPortOf, type VaultPort } from '../lib/connectors/vaultSync.js'

/** The request connectors answers for the apps, declared in core/api.ts for the core to route. */
export { CONNECTORS_REQUESTS } from '../core/api.js'

const GATEWAY_CACHE_MS = 60_000
/** How long a Refresh waits for the account's connections to be exchanged before it lists what is here. */
const SYNC_WAIT_MS = 15_000
/** How often the bridge looks for connections to keep alive (renew.ts `keepAlive`), and how soon after it starts. */
const KEEP_ALIVE_EVERY_MS = 3_600_000
const KEEP_ALIVE_FIRST_MS = 120_000
/** Up to this much more wait, drawn once per start: the account's computers do not renew one token at the same moment
 *  (a service that rotates refresh tokens honours only the first), and the first one's renewal resets the others' wait. */
const KEEP_ALIVE_SPREAD_S = 12 * 3600

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

/** How many tries a held port gets before asking whose it is. */
const TRIES_BEFORE_ASKING = 3

/**
 * The longest wait between two asks while the holder is this account's, or no one can say. Asking is lsof on macOS, about
 * 40 ms of a core: at every 5 s try it was about 1% of a core for as long as a second Harness home, a dev build or a
 * leftover core held the port (2026-11-11). Another account taking the port over from such a holder is seen within this,
 * and only where agents reach the bridge through its socket or pipe, so the port's holder hears none of their calls.
 */
const MOST_BETWEEN_ASKS_MS = 5 * 60_000

interface Moving {
  /** Whether this account holds the port: a daemon handing over, or a second daemon of this account sharing the vault. */
  holderIsMine(port: number): Promise<boolean | null>
  moved(port: number, from: number): void
  /** Agents reach the bridge through its socket or pipe: the asking may slow down ([MOST_BETWEEN_ASKS_MS]). */
  local: boolean
}

/**
 * Listen on [port]. Another process holding it means agents' connections reach that process, not this bridge, so that is
 * said once. Only another account's hold moves the bridge ([moving]): it can last from boot until this user logs in
 * (audit H1). A hold of this account's own is waited out, however long: the vault and the agents' configurations are the
 * account's, so a second daemon or a slow handover that moved would take the agents with it. The port is tried every
 * [retryMs] all along; only the asking slows down while the answer is this account or none.
 */
function listen(bridge: Server, port: number, retryMs: number, moving?: Moving): void {
  let tries = 0
  let leaving = false
  // macOS reads a listener that has just gone as another account's, so one answer may be a handover ending: it takes two
  // in a row, with a try of the port between them.
  let notMine = 0
  // Tries left before the next ask, and how many the one after waits: doubling, up to MOST_BETWEEN_ASKS_MS. Another
  // account's answer is asked again at the next try, as before.
  let skip = 0
  let gap = 1
  let toldMine = false
  let toldUnknown = false
  // The port is tried again while an ask is out: lsof under load takes up to LSOF_MS, and a try that waited on it held a
  // port this account had let go for that long (task #3640).
  let asking = false
  bridge.on('listening', () => {
    if (leaving) moving!.moved((bridge.address() as AddressInfo).port, port)
    leaving = false
    tries = 0
  })
  const again = (): void => { setTimeout(() => bridge.listen(leaving ? 0 : port, '127.0.0.1'), retryMs).unref() }
  bridge.on('error', (error: Error) => {
    tries++
    if (tries === 1) console.warn(`[connections] bridge port ${port} is not available (${error.message}); trying again every ${retryMs} ms`)
    again()
    if (!moving || tries < TRIES_BEFORE_ASKING || leaving || asking) return
    if (skip > 0) { skip--; return }
    asking = true
    void moving.holderIsMine(port).then((mine) => {
      asking = false
      // The port was taken while the ask was out: its answer is about a hold that has ended.
      if (bridge.listening) return
      notMine = mine === false ? notMine + 1 : 0
      leaving = notMine >= 2
      if (mine !== false && moving.local) {
        skip = gap
        // An ask's own try and the ones it skips: at the default 5 s, 60 tries, 5 minutes.
        gap = Math.min(gap * 2, Math.max(1, Math.floor(MOST_BETWEEN_ASKS_MS / retryMs) - 1))
      }
      if (mine === true && !toldMine) {
        toldMine = true
        console.warn(`[connections] a process of this account holds bridge port ${port} (another Harness home, a dev build?); the bridge takes the port once it lets go`)
      }
      if (mine === null && !toldUnknown) {
        toldUnknown = true
        console.warn(`[connections] cannot tell which account holds bridge port ${port}; the bridge keeps trying the port and asking`)
      }
    })
  })
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

/** The bridge's pipe on Windows (bridge.ts `serveBridgePipe`), a new name at each try. Said once, as the socket is. */
function listenPipe(vault: Store, path: (() => string) | undefined, retryMs: number, said = false): void {
  serveBridgePipe(vault, path?.()).catch((error: unknown) => {
    if (!said) console.warn(`[connectors] the bridge's pipe is not listening, trying again: ${String(error)}`)
    setTimeout(() => listenPipe(vault, path, retryMs, true), retryMs).unref()
  })
}

export interface ConnectorsOverrides extends Partial<ConnectorsDeps> {
  holderIsMine?: (port: number) => Promise<boolean | null>
  /** How Claude Code and Codex are found and asked (a spec's fakes). */
  elsewhere?: ElsewhereDeps
  /** Seconds a connection goes unrenewed before it is kept alive (renew.ts `keepAlive`); by default a day and up to 12 hours more. */
  keepAliveAfter?: number
  /** The platform it runs on, and on Windows where its pipe is (a test's socket named as a pipe). */
  platform?: NodeJS.Platform
  pipePath?: () => string
}

export function startConnectors(core: CoreApi, overrides: ConnectorsOverrides = {}): ServiceRequests {
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
  const platform = overrides.platform ?? process.platform
  const socket = bridgeSocketPath(vault, platform)
  // Windows has no socket, but a pipe (task #2162): until then the Team account, holding the port from boot, heard every tool call.
  const local = socket !== null || platform === 'win32'
  // Where a socket or pipe can be, the port takes neither key for long: Harness's own goes over it, and the agents' retires (agents.ts).
  if (local) { try { rotateHarnessKey(vault) } catch (error) { console.warn(`[connections] could not replace Harness's key: ${(error as Error).message}`) } }
  const bridgeKeys = local
    ? { key: () => { try { return retireBridgeKey(vault) } catch { return '' } } }
    : { key: () => String(vault.file('bridge.json').key ?? ''), harnessKey: () => String(vault.file('harness-key.json').key ?? '') }
  const bridge = createBridge(vault, bridgeKeys)
  bridge.unref()
  // A port a test or HARNESS_CONNECTIONS_PORT names stays that port.
  const movable = overrides.port === undefined && env.HARNESS_CONNECTIONS_PORT === undefined
  listen(bridge, deps.port, deps.retryMs, movable ? {
    local,
    holderIsMine: overrides.holderIsMine ?? portHolderIsThisAccount,
    moved: (port, from) => {
      console.warn(`[connections] another account holds port ${from}; the bridge moved to port ${port}, and agents started from now on use it`)
      try { saveBridgePort(vault, port); sync(vault, env) } catch (error) { console.warn(`[connections] could not save the bridge's new port: ${(error as Error).message}`) }
      // Agents already running keep the old address: they recover here as soon as the other account lets go of it.
      const old = createBridge(vault, bridgeKeys)
      old.unref()
      listen(old, from, deps.retryMs)
    },
  } : undefined)
  if (socket) listenSocket(vault, socket, deps.retryMs)
  else if (local) listenPipe(vault, overrides.pipePath, deps.retryMs)
  // Stamped now, not at a client's first call: the day counts from this start.
  if (local) { try { retireBridgeKey(vault) } catch { /* The next request tries again. */ } }
  /** Every agent installed here given its entries; a config that cannot be written now is written at the next change. */
  const syncAgents = (): void => { try { sync(vault, env) } catch { /* Left as it is. */ } }
  syncAgents()

  // Connections the same on every computer of the account: read now, at each `connectors_changed`, and
  // written whenever this computer's change (here, by `harness connections`, by a renewal in the bridge).
  const shared = deps.vaultPort ? new VaultSync({ vault, port: deps.vaultPort, env, log: console.warn }) : null
  if (shared) {
    shared.start()
    core.account.onNotice((notice) => {
      if (notice.type === 'connectors_changed') shared.changed(notice.revision)
      else if (notice.type === 'device_keys_changed') shared.changed(null)
    })
  }

  const keepAliveAfter = overrides.keepAliveAfter ?? KEEP_ALIVE_S + Math.floor(Math.random() * KEEP_ALIVE_SPREAD_S)
  const keepRound = (): void => {
    void keepAlive(vault, keepAliveAfter).then((failed) => {
      for (const [code, why] of Object.entries(failed)) console.warn(`[connections] could not keep ${code} signed in: ${why}`)
    }, (error: unknown) => console.warn(`[connections] keeping connections signed in failed: ${String(error)}`))
  }
  setTimeout(keepRound, KEEP_ALIVE_FIRST_MS).unref()
  setInterval(keepRound, KEEP_ALIVE_EVERY_MS).unref()

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
      // `sync`: the Refresh button. The account's connections are exchanged first (a computer added since the last
      // write is sealed for), waited on for a while. Then every agent installed here gets its entries again: one
      // installed since the last connection change (Claude Code or Codex set up after signing in) has none.
      // Only when the person asks: nothing watches for an agent being installed.
      case 'list': {
        if (payload.sync === true) {
          if (shared) await Promise.race([shared.run(), new Promise((done) => setTimeout(done, SYNC_WAIT_MS).unref())])
          syncAgents()
        }
        return { ...cards(vault, await gatewayOffers()), shared: shared !== null }
      }
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
      // Gmail, Calendar and Drive through this computer's Claude Code or Codex instead (lib/connectors/elsewhere.ts).
      case 'elsewhere': return { ...(await elsewhere(overrides.elsewhere)) }
      case 'connect_via': return await connectVia(payload.connector, payload.via, overrides.elsewhere)
      case 'disconnect_via': return await disconnectVia(payload.connector, payload.via, overrides.elsewhere)
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
