/**
 * The cloud service's way to its makers: the Connections bridge (lib/connectors/bridge.ts), which adds each
 * connection's credential, so this service holds none (services/AGENTS.md, "Do not hold credentials").
 * A connection is found by where it points (Fo's MCP server, Devin's API), not by what the person named it.
 */
import { bridgePort, bridgeSocketPath, harnessKey } from '../lib/connectors/agents.js'
import { fetchOverSocket } from '../lib/localTransport.js'
import { Store } from '../lib/connectors/store.js'
import { CLOUD_AGENTS, type CloudAgentId } from '../lib/cloudAgents.js'
import { CloudError } from './types.js'

export interface Connection { code: string; name: string; mcp: string | null; api: string | null; state: string }

export interface Bridge {
  connections(): Promise<Connection[]>
  /** The bridge's MCP address for a connection. */
  mcpUrl(code: string): string
  /** How to reach [mcpUrl]: over the bridge's socket where it has one. */
  fetch?: typeof fetch
  /** One call to a key-only connection's API, as JSON. A non-2xx status is the answer, not a throw. */
  api(code: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<{ status: number; json: Record<string, unknown> }>
}

/** Where the bridge is, and how to reach it. */
export interface BridgeRoute { base: string; fetch: typeof fetch }

/**
 * Through Harness's own key (agents.ts `harnessKey`), never the one in the agents' configurations, and over the bridge's 0600 socket
 * where it can have one: whoever holds a port hears what is sent to it (audit H1). With the socket gone Connections is down, and
 * nothing goes to the port. The address's host is then only a name, one that resolves nowhere (RFC 6761), so the key cannot leave if the
 * address ever reached plain `fetch`.
 */
export function bridgeRoute(vault: Store = new Store()): BridgeRoute {
  const socket = bridgeSocketPath(vault)
  return socket
    ? { base: `http://connections.invalid/${harnessKey(vault)}`, fetch: fetchOverSocket(socket) }
    : { base: `http://127.0.0.1:${bridgePort(process.env, vault)}/${harnessKey(vault)}`, fetch: (input, init) => fetch(input, init) }
}

export function connectionsBridge(target: () => string | BridgeRoute = () => bridgeRoute()): Bridge {
  const route = (): BridgeRoute => {
    const got = target()
    return typeof got === 'string' ? { base: got, fetch: (input, init) => fetch(input, init) } : got
  }
  return {
    async connections() {
      const { base, fetch: send } = route()
      const answer = await send(`${base}/connections`, { signal: AbortSignal.timeout(10_000) })
      if (!answer.ok) throw new CloudError('CONNECTIONS_UNAVAILABLE', 'Connections is not running here.')
      const body = await answer.json() as { connections?: unknown }
      return Array.isArray(body.connections) ? body.connections as Connection[] : []
    },
    mcpUrl: (code) => `${route().base}/${code}/mcp`,
    fetch: (input, init) => route().fetch(input, init),
    async api(code, method, path, body, timeoutMs = 30_000) {
      const { base, fetch: send } = route()
      const answer = await send(`${base}/${code}/api${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const raw = await answer.text()
      let json: Record<string, unknown> = {}
      try { json = raw ? JSON.parse(raw) as Record<string, unknown> : {} } catch { json = { raw: raw.slice(0, 500) } }
      return { status: answer.status, json }
    },
  }
}

/**
 * Where a cloud agent's maker is: its own address, or another named in `HARNESS_CLOUD_ENDPOINTS` (JSON, by
 * agent id): a test's fake, or an organization's own host for the maker.
 */
export function endpointFor(agent: CloudAgentId, env: NodeJS.ProcessEnv = process.env): { mcp: string } | { api: string } {
  const want = CLOUD_AGENTS[agent].connection
  let moved: unknown
  try { moved = (JSON.parse(env.HARNESS_CLOUD_ENDPOINTS ?? '{}') as Record<string, unknown>)[agent] } catch { moved = undefined }
  if (typeof moved !== 'string') return want
  try {
    const url = new URL(moved)
    return 'mcp' in want ? { mcp: url.host } : { api: url.origin }
  } catch { return want }
}

/** The connection that signs in a cloud agent, or why there is none. */
export async function connectionFor(bridge: Bridge, agent: CloudAgentId, env: NodeJS.ProcessEnv = process.env): Promise<Connection> {
  const want = endpointFor(agent, env)
  let connections: Connection[]
  try { connections = await bridge.connections() } catch { throw new CloudError('CONNECTIONS_UNAVAILABLE', 'Connections is not running here. Try again in a moment.') }
  const found = connections.find((connection) => 'mcp' in want
    ? !!connection.mcp && new URL(connection.mcp).host === want.mcp
    : connection.api === want.api)
  if (!found) throw new CloudError('NOT_CONNECTED', CLOUD_AGENTS[agent].connect)
  if (found.state === 'reconnect') throw new CloudError('NOT_CONNECTED', `${found.name} needs to be connected again in Connections.`)
  return found
}

/** A maker's refusal, said as the person reads it, with a status the service can act on. */
export function refusal(name: string, status: number, json: Record<string, unknown>): CloudError {
  const said = [json.detail, json.message, json.error, (json.error as Record<string, unknown> | undefined)?.message]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  if (status === 401 || status === 403) return new CloudError('NOT_CONNECTED', `${name} refused the key. Connect it again in Connections.`)
  if (status === 409) return new CloudError('BUSY', `${name} is still working. Send it again once it stops.`)
  if (status === 429) return new CloudError('RATE_LIMITED', `${name} is busy. Try again in a minute.`)
  return new CloudError('CLOUD_FAILED', `${name} answered ${status}${said ? `: ${said.slice(0, 200)}` : '.'}`)
}
