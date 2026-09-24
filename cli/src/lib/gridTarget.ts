/**
 * Where an engine is pointed when a person moves an agent onto a grid model, or starts one there — the
 * relay, the credential, the web tools and the model's context window, all resolved on THIS machine.
 *
 * Its own module since grid-reads-without-waking issue 03: the model list (`gridModels.ts`) answers what
 * grids serve; this answers how one agent reaches one of them. The window comes from the model list's
 * credential-less picture, so resolving a target never reads a grid with its credential — waking one is
 * the prewarm's job, after the move (`gridModels.ts`, `gridWake.ts`).
 */
import { gridJson } from './gridExec.js'
import { contextWindowHint } from './gridLaunch.js'
import { resolveGridMcpUrl } from './gridMcpUrl.js'
import { gridContextWindow } from './gridModels.js'
import { relayAccess } from './gridWake.js'

/** What `resolveGridTarget` answers: the launch override an engine is built from. */
export interface GridTarget {
  networkId: string
  networkName: string
  baseUrl: string
  /** A live credential — see the function comment. */
  apiKey: string
  model: string
  /** The control plane's web-tools MCP endpoint. Absent when it could not be obtained; the agent
   *  then runs on the grid with no web tools, and the daemon log says why. */
  mcpUrl?: string
  /** The model's context window as the grid last reported it, so the engine can be told to compact
   *  inside it (`GridLaunchOverride.contextWindow`). Absent when it has not been seen. */
  contextWindow?: number
}

/**
 * Everything an engine needs to be pointed at `gridName`, resolved on THIS machine.
 *
 * Deliberately not something a client sends. The app names a model; the endpoint and the credential
 * are read here, from the `grid` CLI that is already signed in, so no grid credential ever crosses
 * the relay and there is one source of truth for an address the app could not know anyway.
 *
 * ⚠️ The returned `apiKey` is a live credential. It goes into the engine's ENVIRONMENT and never into
 * argv or a log line — `gridLaunch.ts` is what enforces that, and this value must keep travelling
 * through it rather than around it.
 *
 * Web tools ride on the same credential: the control plane's MCP server accepts the inference token,
 * so `mcpUrl` is the only thing added here, and it is added FIRST. `grid mcp config` renews the token
 * when it is within a month of expiry and persists the renewal; `info --env` never renews, so asked
 * in the other order it could hand inference an older token than the one the web tools hold — both
 * valid, and a mismatch nobody would think to look for. A missing `mcpUrl` degrades rather than
 * refuses: inference is the feature, web search is an accessory (`gridMcpUrl.ts`).
 */
export async function resolveGridTarget(gridName: string | null, model: string): Promise<GridTarget | null> {
  if (!gridName?.trim() || !model.trim()) return null
  const mcpUrl = await resolveGridMcpUrl(gridName)
  const access = await relayAccess(gridName)
  if (!access) return null
  const { baseUrl, apiKey } = access
  // The grid's own id, for the record the launch is written into. Falls back to the name, which is
  // unique on this account and is all the launch actually needs to be re-derivable.
  const { value: rows } = await gridJson<Array<{ grid?: unknown; id?: unknown }>>(['--remote', 'ls'])
  const row = Array.isArray(rows) ? rows.find((r) => r.grid === gridName) : undefined
  const networkId = typeof row?.id === 'string' && row.id.trim() ? row.id.trim() : null
  // The window from the picture — read WITHOUT a credential. It was a signed-in read of the relay's
  // `/models` on every move, which woke a sleeping grid, held the click for as long as the proxy held
  // the request, and could not be skipped when nobody could answer; waking is the prewarm's job now,
  // and it goes out after the move, detached (issue 03).
  const contextWindow = networkId ? contextWindowHint(await gridContextWindow({ networkId, gridName }, model)) : undefined
  return {
    networkId: networkId ?? gridName,
    networkName: gridName,
    baseUrl,
    apiKey,
    model,
    ...(mcpUrl ? { mcpUrl } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  }
}
