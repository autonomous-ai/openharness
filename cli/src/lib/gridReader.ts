/**
 * Reading a grid the way a person glances at it — without knocking.
 *
 * A grid sleeps when nobody uses it, and on the platform a SIGNED-IN read of a sleeping grid wakes it
 * (grid-apis `wake_routes`: presence of a credential, never its validity). This daemon used to read
 * every grid an account is in about once a minute, with the account's credential, so none of them ever
 * slept — and the read that woke one usually came back empty, because a just-woken master has not heard
 * from its providers yet. Everything here reads with NO credential:
 *
 * - The master's overview and its provider discovery are public (grid-src serves both unauthenticated),
 *   so an AWAKE grid answers exactly as it would a signed-in read;
 * - a SLEEPING grid answers at once `503 {code: "grid_asleep"}` and is not started, and that answer may
 *   carry `last_known` — what the grid was serving when the platform put it to sleep.
 *
 * ⚠️ **Never add a credential to anything in this file.** Not an Authorization header, not x-api-key,
 * not a token in the query. The whole resource saving rests on it, and its failure is SILENT: every list
 * still looks perfect while every open harness keeps every grid awake again. A person's act that SHOULD
 * wake a grid (a message, Start, an explicit wake, a prewarm) goes out another way — `gridWake.ts` — on
 * purpose.
 *
 * The values below are cross-repo (the lockstep register; `tests/test_grid_reads_lockstep.py` in the
 * public `grid` repository finds the two literals by these exact quoted spellings).
 */
import { VERSION } from '../version.js'
import { gridExec, gridJson } from './gridExec.js'
import { idKey } from './gridPicture.js'

/** The master's two public reads, under a grid's address. ⚠️ Cross-repo literals (grid-src's routes,
 *  grid-apis' route rules and sleep record, the public CLI's `remote_overview`). */
export const GRID_OVERVIEW_PATH = '/relay/v1/grid/overview'
export const GRID_DISCOVER_PATH = '/nodes/discover'

/** The code beside `detail` on a sleeping grid's 503 (grid-apis `grid_proxy.GRID_ASLEEP_CODE`). Compared
 *  for EQUALITY only: any other code, or none, is "not answering" — never asleep, never awake. */
export const GRID_ASLEEP_CODE = 'grid_asleep'

/** The public CLI's flag that reads without a credential (`grid` ≥ 0.3.49). A `grid` too old for it exits
 *  2 at argparse, before anything is sent — so the fallback below can never turn into a waking read. */
export const GRID_NO_WAKE_FLAG = '--no-wake'

/** The owner status of a grid the platform's reaper slept (grid-apis `grid_sleep_state.ASLEEP`), as
 *  `grid info --json` passes it through. Only the grid's owner sees a status at all. */
export const OWNER_ASLEEP_STATUS = 'asleep'

/** A read that has not answered in this long is not going to; the list shown meanwhile is the last one. */
const READ_TIMEOUT_MS = 10_000

/** An overview is a few KB; anything past this is not one, and is not held in memory to find out. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Bounds on what a hostile or broken answer can put into the picture (and so onto disk). */
const MAX_NODES = 256
const MAX_MODELS_PER_NODE = 256
const MAX_IDS = 1024
const MAX_TEXT = 256

/** Why a request is being made — the User-Agent's trailing word, read by people counting the platform's
 *  "wake fired" journal lines (the zero-baseline alarm keys on `(read)`). Attribution only. */
export type ReadPurpose = 'read' | 'wake' | 'prewarm' | 'prewarm-key'

export function harnessUserAgent(purpose: ReadPurpose): string {
  return `autonomous-harness/${VERSION} (${purpose})`
}

/** One engine node as a read reports it. `models` are ids as the grid lists them — lower-cased by the
 *  overview, exact from the CLI fallback; the picture keys them without case either way. */
export interface ReadNode {
  name: string
  engine: string
  models: string[]
  /** The provider's account, when the grid publishes it (it withholds it on an `os-community` grid).
   *  Read only to decide whether a node is the account's own, and never persisted. */
  providerEmail: string | null
}

/** What the platform recorded a grid serving when it slept it (grid-apis `sleep_record.answer_field`). */
export interface LastKnown {
  /** How long ago the record was taken, computed by the SERVER so no clock here matters. */
  ageSeconds: number
  nodes: Array<{ name: string; engine: string; models: string[] }>
  /** Exact-case candidate ids — a spelling source for the case map, never a list of what is served. */
  ids: string[]
}

export type GridRead =
  /** It answered: these are the live nodes. `rawNodes` is the overview's own node objects, for the Model
   *  Manager, which reads telemetry off them; through the CLI fallback, the little `grid models` says.
   *  `windows` is each model's context window, keyed without case (empty through the fallback). */
  | { kind: 'awake'; nodes: ReadNode[]; curatedIds: string[]; rawNodes: Array<Record<string, unknown>>; windows: Record<string, number> }
  /** The platform says it is resting. `lastKnown` is its record, when it has a valid one. */
  | { kind: 'asleep'; lastKnown: LastKnown | null }
  /** Anything else: stopped by its owner, master down, deleted, a codeless 503, garbage, a timeout. */
  | { kind: 'unanswered' }
  /** No HTTP answer at all — the one case the CLI fallback is for. */
  | { kind: 'unreachable' }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT) : ''
const strings = (value: unknown, limit: number): string[] =>
  Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, limit) : []

/**
 * The address a read goes to, or null when it is not one this daemon will send anything to: `https`, or
 * plain `http` to this computer only (a developer's local grid), with no credentials in the URL itself.
 * Null is not a verdict on the grid — the caller falls back to the CLI, which knows its own transport.
 */
export function readBase(gridUrl: string | null): string | null {
  if (!gridUrl) return null
  let url: URL
  try { url = new URL(gridUrl) } catch { return null }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username || url.password) return null
  url.search = ''
  url.hash = ''
  return url.href.replace(/\/+$/, '')
}

/** A GET with no credential, bounded in time, size and redirects. Throws only on a network failure. */
async function get(base: string, path: string, purpose: ReadPurpose): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: { 'user-agent': harnessUserAgent(purpose), accept: 'application/json' },
    // A redirect is answered as what it is — not followed to wherever it points.
    redirect: 'manual',
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })
  return { status: response.status, body: await boundedJson(response) }
}

/** The body as JSON, or undefined when it is not JSON or is larger than any real answer. */
async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {})
    return undefined
  }
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return undefined }
}

function readNodes(value: unknown): ReadNode[] {
  if (!Array.isArray(value)) return []
  return value.filter(isObject).slice(0, MAX_NODES).map((node) => ({
    name: text(node.name),
    engine: text(node.engine),
    models: strings(node.models, MAX_MODELS_PER_NODE),
    providerEmail: typeof node.provider_email === 'string' && node.provider_email ? node.provider_email : null,
  }))
}

/** `last_known`, or null when it is absent or not in the shape grid-apis writes. Parsing it sends nothing. */
export function parseLastKnown(value: unknown): LastKnown | null {
  if (!isObject(value)) return null
  const age = value.age_seconds
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) return null
  if (!Array.isArray(value.nodes)) return null
  const nodes = value.nodes.filter(isObject).slice(0, MAX_NODES).map((node) => ({
    name: text(node.name),
    engine: text(node.engine),
    models: strings(node.models, MAX_MODELS_PER_NODE),
  }))
  return { ageSeconds: age, nodes, ids: strings(value.ids, MAX_IDS) }
}

/**
 * Read a grid's public overview, with no credential, and say which of the four it is.
 *
 * Asleep is a 503 whose JSON `code` EQUALS `grid_asleep` and nothing else: `grid_stopped` (its owner
 * stopped it), `grid_master_down`, a 410 for a deleted grid and a codeless 503 are all "not answering",
 * and so is a 200 that is not an overview.
 */
export async function readOverview(base: string): Promise<GridRead> {
  let answer: { status: number; body: unknown }
  try {
    answer = await get(base, GRID_OVERVIEW_PATH, 'read')
  } catch {
    return { kind: 'unreachable' }
  }
  const { status, body } = answer
  if (status === 503 && isObject(body) && body.code === GRID_ASLEEP_CODE) {
    return { kind: 'asleep', lastKnown: parseLastKnown(body.last_known) }
  }
  // A 200 that is not an overview (a maintenance page, a proxy's own JSON) is not "awake with nothing":
  // read as that, it would count as an empty answer and start taking models off every list.
  if (status !== 200 || !isObject(body) || !Array.isArray(body.nodes)) return { kind: 'unanswered' }
  const curatedIds = Array.isArray(body.models)
    ? body.models.filter(isObject).map((entry) => text(entry.id)).filter(Boolean).slice(0, MAX_IDS)
    : []
  const rawNodes = body.nodes.filter(isObject).slice(0, MAX_NODES)
  return { kind: 'awake', nodes: readNodes(rawNodes), curatedIds, rawNodes, windows: readWindows(body.models, rawNodes) }
}

/** No model's window is this large; a number past it is not one. */
const MAX_WINDOW = 100_000_000

/**
 * Each model's context window as the overview reports it — the largest of its curated entry's
 * `context_length` and every node's `model_capabilities[id].context_length`. The same figure the relay's
 * signed-in `/models` gives as `context_window` (grid-src `advertised_context_window`, MAX across the
 * engines serving it), read here without a credential. Keyed without case.
 */
function readWindows(curated: unknown, nodes: Array<Record<string, unknown>>): Record<string, number> {
  const windows: Record<string, number> = {}
  const take = (id: unknown, value: unknown): void => {
    const key = idKey(text(id))
    if (!key || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_WINDOW) return
    if (Object.keys(windows).length >= MAX_IDS && !(key in windows)) return
    windows[key] = Math.max(windows[key] ?? 0, value)
  }
  if (Array.isArray(curated)) for (const entry of curated.filter(isObject)) take(entry.id, entry.context_length)
  for (const node of nodes) {
    const capabilities = isObject(node.model_capabilities) ? node.model_capabilities : {}
    for (const [id, cell] of Object.entries(capabilities).slice(0, MAX_MODELS_PER_NODE)) {
      if (isObject(cell)) take(id, cell.context_length)
    }
  }
  return windows
}

/** The master's display rule (grid-src `model_ids.display_model_name`): a trailing `.gguf` removed,
 *  compared without regard to case, and the case of what is left KEPT. */
export function displayModelName(raw: string): string {
  return raw.toLowerCase().endsWith('.gguf') ? raw.slice(0, -'.gguf'.length) : raw
}

/**
 * Every served model's exact-case name from the grid's public provider discovery, under the display rule.
 * Asked only when an awake answer names a model no other source can spell. Any failure is an empty list,
 * which leaves the lower-case id the overview gave — a spelling problem, never a reason to fail a read.
 */
export async function readDiscoveryIds(base: string): Promise<string[]> {
  try {
    const { status, body } = await get(base, GRID_DISCOVER_PATH, 'read')
    if (status !== 200 || !isObject(body) || !Array.isArray(body.providers)) return []
    const ids: string[] = []
    for (const provider of body.providers.filter(isObject)) {
      const capabilities = isObject(provider.capabilities) ? provider.capabilities : {}
      const entries = isObject(capabilities.models) ? capabilities.models : {}
      if (!Array.isArray(provider.models)) continue
      for (const route of provider.models) {
        const entry = typeof route === 'string' ? entries[route] : undefined
        const raw = isObject(entry) ? text(entry.raw_model_id) : ''
        if (raw) ids.push(displayModelName(raw))
      }
    }
    return ids.slice(0, MAX_IDS)
  } catch {
    return []
  }
}

/** `grid info <grid> --json`, reduced to what a read needs. Null when `grid` could not answer. */
export interface GridInfo {
  /** The owner status (`running`, `asleep`, `stopped`, …); null for a member, who cannot read it. */
  status: string | null
  /** The grid's address; reads go to `<gridUrl>/relay/v1/grid/overview`. */
  gridUrl: string | null
}

export async function readGridInfo(gridName: string): Promise<GridInfo | null> {
  const { value } = await gridJson<Json>(['--remote', 'info', gridName])
  if (!isObject(value)) return null
  return {
    status: typeof value.status === 'string' && value.status ? value.status : null,
    gridUrl: typeof value.grid_url === 'string' && value.grid_url.trim() ? value.grid_url.trim() : null,
  }
}

/** The `code` of `grid`'s `--json` refusal envelope (one JSON line on stderr), or null. */
function envelopeCode(stderr: string): string | null {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
      if (error && typeof error.code === 'string') return error.code
    } catch { /* not the envelope */ }
  }
  return null
}

/**
 * The fallback for a machine that reaches the internet only through something the daemon's own `fetch`
 * does not use (an HTTP proxy the `grid` CLI honours): `grid models <grid> --json --no-wake`, ONCE.
 *
 * ⚠️ Never retried without the flag. A `grid` too old for it exits 2 before sending anything, and that is
 * "no read" — a stale list, which is the direction every failure here must take.
 */
export async function readViaCli(gridName: string): Promise<GridRead> {
  const result = await gridExec(['--remote', 'models', gridName, GRID_NO_WAKE_FLAG, '--json'])
  if (result.code !== 'OK') {
    return envelopeCode(result.stderr) === GRID_ASLEEP_CODE ? { kind: 'asleep', lastKnown: null } : { kind: 'unanswered' }
  }
  let rows: unknown
  try { rows = JSON.parse(result.stdout) } catch { return { kind: 'unanswered' } }
  if (!Array.isArray(rows)) return { kind: 'unanswered' }
  // `grid models` answers one row per (model, node); the picture wants nodes.
  const byNode = new Map<string, ReadNode>()
  const exact: string[] = []
  for (const row of rows.filter(isObject).slice(0, MAX_NODES * MAX_MODELS_PER_NODE)) {
    const model = text(row.model)
    if (!model) continue
    const name = text(row.node)
    const engine = text(row.engine)
    const key = `${name}\u0000${engine}`
    const node = byNode.get(key) ?? { name, engine, models: [], providerEmail: null }
    node.models.push(model)
    byNode.set(key, node)
    exact.push(model)
  }
  const nodes = [...byNode.values()].slice(0, MAX_NODES)
  // The Model Manager reads node objects; these carry what `grid models` knows, and a node it lists is
  // one the grid is routing to right now.
  const rawNodes = nodes.map((node) => ({ name: node.name, engine: node.engine, models: node.models, online: true }))
  return { kind: 'awake', nodes, curatedIds: exact.slice(0, MAX_IDS), rawNodes, windows: {} }
}
