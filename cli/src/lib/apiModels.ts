/**
 * A saved API as a place to run a harness: an OpenAI-compatible API (OpenRouter, or a Custom API) lists
 * its chat models, and a person can move a pane's agent onto one of them.
 *
 * The move is a grid move in everything but where the endpoint comes from. The same per-engine launch
 * contracts run it (`gridLaunch.ts`) — OpenRouter documents exactly those variables for Claude Code
 * (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`), Codex (`wire_api = "responses"`) and OpenCode — and
 * the endpoint and key are read HERE, from this computer's store, so the app never holds the key.
 *
 * Listing a model list is a free read; nothing here makes a paid request.
 */
import { createHash } from 'node:crypto'
import { ApiConnectionError, type ApiConnections } from './apiConnections.js'
import { rememberApiBase } from './gridAssignment.js'
import { API_NETWORK_PREFIX, contextWindowHint, isApiLaunch, type GridLaunchOverride } from './gridLaunch.js'
import { MIN_CODING_CONTEXT } from './codingContext.js'

export interface ApiModel {
  id: string
  /** The API's display name for it, when it gives one (OpenRouter: "Anthropic: Claude Sonnet 4.6"). */
  name?: string
  /** Its context window in tokens, when listed — what the engine is told to compact inside. */
  contextWindow?: number
}

/** A list is re-read after this long, or at once when the connection's URL or key changed. */
const LIST_FRESH_MS = 10 * 60_000
const LIST_TIMEOUT_MS = 15_000
/** More than any API lists; an answer past it is cut. */
const MAX_MODELS = 2000
const MODEL_ID = /^[^\s\x00-\x1f\x7f]{1,256}$/

interface Listed { fingerprint: string; at: number; models: ApiModel[] }
const lists = new Map<string, Listed>()

/** Forget every list read, so the next ask reads each API again. */
export function forgetApiModels(): void {
  lists.clear()
}

export interface ApiModelDeps {
  fetch?: typeof fetch
  now?: () => number
}

/** The models in an OpenAI-shaped `/models` answer that a coding agent can run on.
 *
 * A field an API does not send says nothing: a Custom API's rows are usually just `{id}` and are all
 * kept. Where the API does say (OpenRouter), a model that takes no tools, answers in no text, or has a
 * window under the smallest a coding agent can work in (64K, as for local models) is left out. */
export function chatModels(body: unknown): ApiModel[] {
  const rows = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data
    : []
  const seen = new Set<string>()
  const models: ApiModel[] = []
  for (const raw of rows.slice(0, MAX_MODELS)) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!MODEL_ID.test(id) || seen.has(id)) continue
    const parameters = row.supported_parameters
    if (Array.isArray(parameters) && !parameters.includes('tools')) continue
    const outputs = (row.architecture as { output_modalities?: unknown } | undefined)?.output_modalities
    if (Array.isArray(outputs) && !outputs.includes('text')) continue
    const listed = typeof row.context_length === 'number' ? row.context_length : row.context_window
    if (typeof listed === 'number' && listed < MIN_CODING_CONTEXT) continue
    const contextWindow = contextWindowHint(listed)
    const name = typeof row.name === 'string' && row.name.trim() && row.name.length <= 200 ? row.name.trim() : undefined
    seen.add(id)
    models.push({ id, ...(name && name !== id ? { name } : {}), ...(contextWindow ? { contextWindow } : {}) })
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/** The chat models `connectionId` lists, read with its saved key and kept for [LIST_FRESH_MS]. */
export async function listApiModels(
  store: ApiConnections,
  connectionId: string,
  options: ApiModelDeps & { refresh?: boolean } = {},
): Promise<ApiModel[]> {
  const { connection, apiKey } = store.modelAccess(connectionId)
  const now = options.now ?? Date.now
  const fingerprint = createHash('sha256').update(`${connection.baseUrl}\n${apiKey}`).digest('hex')
  const kept = lists.get(connection.id)
  if (!options.refresh && kept?.fingerprint === fingerprint && now() - kept.at < LIST_FRESH_MS) return kept.models
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(`${connection.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    })
  } catch {
    throw new ApiConnectionError(`${connection.name} did not answer. Check your connection and try again.`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new ApiConnectionError(response.status === 401 || response.status === 403
      ? `${connection.name} did not accept the saved key. Edit the connection and paste a new key.`
      : `${connection.name} could not list its models (HTTP ${response.status}). Try again.`)
  }
  const models = chatModels(await response.json().catch(() => null))
  lists.set(connection.id, { fingerprint, at: now(), models })
  return models
}

/**
 * The launch that puts an agent on `model` of the saved API `connectionId`.
 *
 * ⚠️ The answer carries the live key; it travels only through `gridLaunch.ts`, into the engine's
 * environment. A model the API does not list is refused rather than launched into an engine that
 * would fail on its first message.
 */
export async function resolveApiTarget(
  store: ApiConnections,
  connectionId: string,
  model: string,
  deps: ApiModelDeps = {},
): Promise<GridLaunchOverride> {
  const { connection, apiKey } = store.modelAccess(connectionId)
  if (!MODEL_ID.test(model)) throw new ApiConnectionError('Choose a model.')
  const listed = (await listApiModels(store, connectionId, deps)).find((row) => row.id === model)
  if (!listed) throw new ApiConnectionError(`${connection.name} does not list ${model} for coding agents.`)
  rememberApiBase(connection.baseUrl)
  return {
    networkId: `${API_NETWORK_PREFIX}${connection.id}`,
    networkName: connection.name,
    baseUrl: connection.baseUrl,
    apiKey,
    model,
    ...(listed.contextWindow ? { contextWindow: listed.contextWindow } : {}),
  }
}

/**
 * [launch] with the endpoint and key as saved NOW. A restart, a restore or a resume repeats the row's
 * launch, and the person may have pasted a new key since; a launch that is not onto an API comes back
 * unchanged. Throws when the connection was removed: its key must not keep being used.
 */
export function refreshApiLaunch(store: ApiConnections, launch: GridLaunchOverride): GridLaunchOverride {
  if (!isApiLaunch(launch)) return launch
  const { connection, apiKey } = store.modelAccess(launch.networkId.slice(API_NETWORK_PREFIX.length))
  rememberApiBase(connection.baseUrl)
  return { ...launch, networkName: connection.name, baseUrl: connection.baseUrl, apiKey }
}

/** Every saved API's endpoint, so agents already running on one are recognised (`gridAssignment.ts`). */
export function rememberSavedApis(store: ApiConnections): void {
  try {
    for (const connection of store.list()) rememberApiBase(connection.baseUrl)
  } catch {
    // An unreadable store is reported where it is managed; recognising agents is best effort.
  }
}

/** `api_connections {action: 'models', id}`: one API's chat models. No key in any reply. */
export async function apiModelsRequest(
  store: ApiConnections,
  payload: Record<string, unknown>,
  deps: ApiModelDeps = {},
): Promise<Record<string, unknown>> {
  if (typeof payload.id !== 'string' || !payload.id) return { error: 'API_MODELS_FAILED', detail: 'Choose a saved API.' }
  try {
    return { id: payload.id, models: await listApiModels(store, payload.id, { ...deps, refresh: payload.refresh === true }) }
  } catch (error) {
    return { error: 'API_MODELS_FAILED', detail: error instanceof ApiConnectionError ? error.message : 'Models are unavailable. Try again.' }
  }
}
