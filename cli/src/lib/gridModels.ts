/**
 * What the grids this computer is signed into can answer — read WITHOUT waking any of them.
 *
 * Every picker, the Models panel and the macOS Models menu ask here, and until issue 02 of
 * grid-reads-without-waking each ask was a `grid models` spawn plus a SIGNED-IN read of the relay's
 * model list. On the platform a signed-in read of a sleeping grid wakes it, so an open app kept every
 * grid of the account awake all day — and the read that woke one usually came back empty. Now:
 *
 * - each grid is read through `gridReader.ts`, with no credential: an awake grid answers as before, a
 *   sleeping one says so at once (with the platform's record of what it served) and is not started;
 * - what was read is kept as a PICTURE per grid (`gridPicture.ts`, persisted), so an answer is given at
 *   once and a sleeping grid shows its last known models instead of vanishing;
 * - the account's OWN grid, whose status the owner can read, is read at most once per asleep episode.
 *
 * The credentialed model-list read is gone from every automatic path. What still wakes a grid is a
 * person's act, and it does not go through here.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env as config } from '../config/env.js'
import { gridCredentialsPath } from './gridCredentials.js'
import { signedInGridEmail } from './gridDerive.js'
import { gridExec, gridJson } from './gridExec.js'
import { resolveGridMcpUrl } from './gridMcpUrl.js'
import {
  emptyPicture, mergeAwake, idKey, parsePicture, provenStopped, sectionView, servedKey, unspelled, withAsleep,
  withSpellings, withUnknown, type GridPicture, type LocalRecord, type PictureState, type SectionView, type ServedHere,
} from './gridPicture.js'
import {
  OWNER_ASLEEP_STATUS, readBase, readDiscoveryIds, readGridInfo, readOverview, readViaCli, type GridInfo, type GridRead,
  type ReadNode,
} from './gridReader.js'
import { readRunRecords } from './localModels.js'

export interface GridModel {
  /** The id an engine is pointed at, in the exact case the grid serves it. */
  id: string
  /** Which machine answers it, or empty when the grid does not say. Display only. */
  node: string
}

/** One grid this computer is signed into, with what it serves — the picker's section. */
export interface GridSection {
  /** The grid's name as `grid ls` prints it. */
  name: string
  /** `permissioned-public` is the account's own private grid; the others are shared. */
  type: string
  /** True for the account's private grid — the picker labels that one "Local". */
  own: boolean
  /** Its models: live while it is awake, the last known ones while it is not — never blanked. */
  models: GridModel[]
  /** Additive (an older app ignores these three): what the last read said, when the grid was last seen
   *  awake, and how old the list above is. */
  state?: PictureState
  seenAt?: string | null
  lastKnownAge?: number | null
}

/** What the Model Manager is told about the grid it runs on (`localModels.ts`'s `GridInventory`). */
export interface GridInventoryAnswer {
  state: PictureState
  nodes: Record<string, unknown>[]
}

/** How long one read's answer stands before the next is made: the list is live while a grid is awake,
 *  and a sleeping grid changes only when something wakes it. A failure is retried sooner than sleep. */
const AWAKE_MEMO_MS = 15_000
const ASLEEP_MEMO_MS = 120_000
const FAILED_MEMO_MS = 30_000

/** `grid info` is a control-plane call: a member's grid address barely moves; the OWNER's status is the
 *  thing that says a grid fell asleep or woke, so it is asked more often, and less often while asleep. */
const ADDRESS_MEMO_MS = 10 * 60_000
const OWN_STATUS_AWAKE_MEMO_MS = 15_000
const OWN_STATUS_ASLEEP_MEMO_MS = 60_000

/** Several changes landing together (three grids refreshed at once) are one push, not three. */
const CHANGE_COALESCE_MS = 250

/** How long an ask waits for the FIRST read of a grid this daemon has never seen before answering with
 *  what it has. Kept well inside the app's 12s `grid_models_list` timeout, which the grid-name wait
 *  (`GRID_ATTACH_WAIT_MS`, 6s) shares: a read slower than this lands behind the answer and is pushed. */
const FIRST_READ_WAIT_MS = 4_000

interface GridRow { name: string; type: string; id: string }

/** The key a grid is tracked under when `grid ls` gave it no network id — its name, marked as such, so
 *  it can never collide with an id and never names a run-record directory. */
const NAME_ONLY_PREFIX = 'name:'
const nameOnlyRow = (name: string, type = ''): GridRow => ({ name, type, id: `${NAME_ONLY_PREFIX}${name}` })

/** Everything this daemon holds about one grid, keyed by its network id. */
interface Tracked {
  id: string
  /** The name `grid` knows it by — what goes into `grid info <name>` and the fallback's argv. */
  name: string
  /** The account's own grid. A property of the GRID, learnt from whoever last knew (the model list,
   *  the Model Manager), so an asker that does not know — a launch check — never changes how it is read. */
  own: boolean
  picture: GridPicture
  loaded: boolean
  /** Whether a picture existed before this process read anything (on disk, or read since). */
  known: boolean
  /** The picture as last written, so a read that changed nothing writes nothing. */
  saved: string
  readAt: number | null
  readTtl: number
  info: { at: number; value: GridInfo | null } | null
  /** The own grid's one read of its current asleep episode has been made. */
  episodeRead: boolean
  /** What this daemon has watched a live run record serve here since the last awake read. */
  seen: Set<string>
  /** Ids discovery has already been asked to spell, so an id no provider spells is asked about once. */
  spelled: Set<string>
  /** The last awake overview's own node objects, for the Model Manager. Not persisted. */
  rawNodes: Record<string, unknown>[]
  pending: Promise<void> | null
}

export interface GridModelsDeps {
  now: () => number
  /** Where pictures are kept (`<data dir>/grid-pictures`). */
  dataDir: () => string
  /** `~/.grid`, whose `run/engines/<grid id>/` holds this computer's run records. */
  gridHome: () => string
  /** The signed-in account — a node published under it is the account's own. */
  email: () => string | null
  /** [FIRST_READ_WAIT_MS], injectable so a test need not wait it out. */
  firstReadWaitMs: number
}

const defaultDeps: GridModelsDeps = {
  now: () => Date.now(),
  dataDir: () => config.ADAPTER_DATA_DIR,
  gridHome: () => dirname(gridCredentialsPath()),
  email: () => signedInGridEmail(),
  firstReadWaitMs: FIRST_READ_WAIT_MS,
}

/**
 * The pictures, the reads that keep them current, and the answers built from them.
 *
 * Nothing here runs on a timer: a grid is read only when something asks about it and its last answer
 * has aged past its memo. So an app nobody looks at costs nothing, and an app somebody looks at costs a
 * credential-less read every 15s at most per grid — and never a wake.
 */
export class GridModelsService {
  private readonly deps: GridModelsDeps
  private readonly tracked = new Map<string, Tracked>()
  private readonly listeners = new Set<() => void>()
  private rows: GridRow[] | null = null
  private changeTimer: NodeJS.Timeout | null = null

  constructor(deps: Partial<GridModelsDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps }
  }

  /** Called (coalesced) whenever a read changed what a picker would be told. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resolves once every read already started has landed — for a test, and for a caller that must see
   *  the answer a read it triggered produced. */
  async settled(): Promise<void> {
    await Promise.all([...this.tracked.values()].map((tracked) => tracked.pending?.catch(() => {})))
  }

  /** Every read is due again — for a caller that has just changed what a grid serves, or which grid is
   *  whose. The pictures stay: they are what is shown until the next read lands. */
  forget(): void {
    for (const tracked of this.tracked.values()) {
      tracked.readAt = null
      tracked.info = null
    }
    this.rows = null
  }

  /**
   * Every grid this computer is signed into, own grid first, each with its models.
   *
   * Answered from the pictures at once. A grid whose answer has aged is read again in the background —
   * one read per grid at a time — and a change is announced through [onChange]. Only a grid this daemon
   * has never seen is waited for, and only for [FIRST_READ_WAIT_MS]: an answer made of nothing is worse
   * than a short wait, and a timed-out ask is worse than both.
   */
  async sections(ownGridName: string | null, opts: { refresh?: boolean } = {}): Promise<GridSection[]> {
    const rows = await this.gridRows(ownGridName)
    const sections = await Promise.all(rows.map(async (row) => {
      const tracked = await this.track(row, row.name === ownGridName)
      if (opts.refresh !== false && this.due(tracked)) {
        const refreshing = this.refresh(tracked)
        if (!tracked.known) await this.within(refreshing, this.deps.firstReadWaitMs)
        else void refreshing.catch(() => {})
      }
      return { name: row.name, type: row.type, own: tracked.own, ...await this.view(tracked) }
    }))
    sections.sort((a, b) => Number(b.own) - Number(a.own))
    return sections
  }

  /** One grid's models, read now if its answer has aged — for a launch that must not start on a model
   *  nobody serves. Still never a waking read: a sleeping grid answers with what it last served. */
  async models(gridName: string): Promise<GridModel[]> {
    const tracked = await this.track(await this.rowFor(gridName))
    if (this.due(tracked)) await this.refresh(tracked)
    return (await this.view(tracked)).models
  }

  /** What the Model Manager needs to tell a running model from a stopped one, on the account's own grid. */
  async inventory(gridName: string, force: boolean): Promise<GridInventoryAnswer> {
    const tracked = await this.track(await this.rowFor(gridName), true)
    if (force) tracked.readAt = null
    if (this.due(tracked)) await this.refresh(tracked)
    return { state: tracked.picture.state, nodes: tracked.picture.state === 'awake' ? tracked.rawNodes : [] }
  }

  private async rowFor(gridName: string): Promise<GridRow> {
    return (await this.gridRows(null)).find((row) => row.name === gridName) ?? nameOnlyRow(gridName)
  }

  /** `grid ls --json` — a LOCAL registry read, no network. The last good answer stands in for a failed
   *  one; with none, the own grid alone, as before this module knew about shared grids. */
  private async gridRows(ownGridName: string | null): Promise<GridRow[]> {
    const { value } = await gridJson<Array<{ grid?: unknown; type?: unknown; id?: unknown }>>(['--remote', 'ls'])
    if (Array.isArray(value)) {
      this.rows = value
        // A name goes into a `grid` argv (`info <grid>`, the fallback's `models <grid>`): one that reads
        // as a flag, or carries a control character, is not one this daemon will pass along.
        .filter((row) => typeof row?.grid === 'string' && /^[^-\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/.test(row.grid.trim()))
        .map((row) => {
          const name = (row.grid as string).trim()
          const type = typeof row.type === 'string' ? row.type : ''
          return typeof row.id === 'string' && row.id.trim() ? { name, type, id: row.id.trim() } : nameOnlyRow(name, type)
        })
    }
    if (this.rows) return this.rows
    return ownGridName ? [nameOnlyRow(ownGridName, 'permissioned-public')] : []
  }

  /** The grid behind `row`, loaded from disk the first time. `own`, when the caller knows it, is recorded. */
  private async track(row: GridRow, own?: boolean): Promise<Tracked> {
    let tracked = this.tracked.get(row.id)
    if (!tracked) {
      tracked = {
        id: row.id, name: row.name, own: false, picture: emptyPicture(), loaded: false, known: false, saved: '',
        readAt: null, readTtl: 0, info: null, episodeRead: false, seen: new Set(), spelled: new Set(), rawNodes: [],
        pending: null,
      }
      this.tracked.set(row.id, tracked)
    }
    tracked.name = row.name
    if (own !== undefined) tracked.own = own
    if (!tracked.loaded) {
      tracked.loaded = true
      await this.load(tracked)
    }
    return tracked
  }

  /** `work`, or nothing more than `ms` of it — what it produces meanwhile lands on its own. */
  private async within(work: Promise<void>, ms: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([work.catch(() => {}), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
    clearTimeout(timer)
  }

  private due(tracked: Tracked): boolean {
    const now = this.deps.now()
    if (tracked.readAt === null || now - tracked.readAt >= tracked.readTtl) return true
    // The owner's status is what says the own grid fell asleep or woke; it is checked on its own clock.
    return tracked.own && (tracked.info === null || now - tracked.info.at >= this.statusTtl(tracked))
  }

  private statusTtl(tracked: Tracked): number {
    if (!tracked.own) return ADDRESS_MEMO_MS
    return tracked.info?.value?.status === OWNER_ASLEEP_STATUS ? OWN_STATUS_ASLEEP_MEMO_MS : OWN_STATUS_AWAKE_MEMO_MS
  }

  /** One refresh per grid at a time; every asker shares it. */
  private refresh(tracked: Tracked): Promise<void> {
    tracked.pending ??= this.read(tracked).finally(() => { tracked.pending = null })
    return tracked.pending
  }

  private async read(tracked: Tracked): Promise<void> {
    const before = JSON.stringify(await this.signature(tracked))
    const info = await this.info(tracked)
    const asleepByStatus = tracked.own && info?.status === OWNER_ASLEEP_STATUS
    // The own grid, while its status says asleep, is read exactly once per asleep episode — to fetch the
    // platform's record of what it served — and then left alone until the status changes.
    if (asleepByStatus && tracked.episodeRead) {
      await this.apply(tracked, { kind: 'asleep', lastKnown: null }, null)
    } else {
      tracked.episodeRead = asleepByStatus
      const base = readBase(info?.gridUrl ?? null)
      let read: GridRead = base ? await readOverview(base) : { kind: 'unreachable' }
      // Only when nothing answered at all — never to second-guess an answer the grid gave.
      if (read.kind === 'unreachable') read = await readViaCli(tracked.name)
      await this.apply(tracked, read, base)
    }
    await this.save(tracked)
    tracked.known = true
    if (JSON.stringify(await this.signature(tracked)) !== before) this.changed()
  }

  private async info(tracked: Tracked): Promise<GridInfo | null> {
    const now = this.deps.now()
    if (tracked.info && now - tracked.info.at < this.statusTtl(tracked)) return tracked.info.value
    // A failed ask keeps the last answer (the address is still the address), and is not re-asked at once.
    const value = await readGridInfo(tracked.name) ?? tracked.info?.value ?? null
    tracked.info = { at: now, value }
    if (value?.status !== OWNER_ASLEEP_STATUS) tracked.episodeRead = false
    return value
  }

  private async apply(tracked: Tracked, read: GridRead, base: string | null): Promise<void> {
    const now = this.deps.now()
    tracked.readAt = now
    if (read.kind === 'asleep') {
      tracked.picture = withAsleep(tracked.picture, read.lastKnown, now)
      tracked.readTtl = ASLEEP_MEMO_MS
      return
    }
    if (read.kind !== 'awake') {
      tracked.picture = withUnknown(tracked.picture)
      tracked.readTtl = FAILED_MEMO_MS
      return
    }
    const here = await this.servedHere(tracked)
    const email = this.deps.email()?.trim().toLowerCase() ?? ''
    const isMine = (node: ReadNode): boolean => !!email && node.providerEmail?.trim().toLowerCase() === email
    const previous = tracked.picture
    let picture = mergeAwake(previous, read.nodes, now, isMine, (name, key) => provenStopped(previous, here, name, key))
    picture = { ...picture, caseMap: withSpellings(picture.caseMap, [...read.curatedIds, ...here.records.flatMap((r) => r.ids)]) }
    const unknownIds = unspelled(picture, read.nodes).filter((key) => !tracked.spelled.has(key))
    if (unknownIds.length && base) {
      unknownIds.forEach((key) => tracked.spelled.add(key))
      picture = { ...picture, caseMap: withSpellings(picture.caseMap, await readDiscoveryIds(base)) }
    }
    tracked.picture = picture
    tracked.rawNodes = read.rawNodes
    tracked.readTtl = AWAKE_MEMO_MS
    // What this computer serves is re-learnt from what is live now: the grid has just said what it serves.
    tracked.seen = new Set(liveKeys(here.records))
  }

  /**
   * This computer's own records for the grid, and what they have been seen serving. Deliberately updates
   * `seen` on EVERY look, answers included: "seen served since the last awake read" is only true if each
   * look that found a live record counted.
   */
  private async servedHere(tracked: Tracked): Promise<ServedHere> {
    const records: LocalRecord[] = tracked.id.startsWith(NAME_ONLY_PREFIX) ? [] : await readRunRecords(this.deps.gridHome(), tracked.id)
    for (const key of liveKeys(records)) tracked.seen.add(key)
    return { records, seen: tracked.seen, own: tracked.own }
  }

  private async view(tracked: Tracked): Promise<Omit<SectionView, 'models'> & { models: GridModel[] }> {
    return sectionView(tracked.picture, await this.servedHere(tracked), this.deps.now())
  }

  /** What a push is about: the rows and the state — not the ages, which move every second. */
  private async signature(tracked: Tracked): Promise<unknown> {
    const view = await this.view(tracked)
    return { models: view.models, state: view.state }
  }

  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      for (const listener of this.listeners) {
        try { listener() } catch { /* a listener's failure is its own */ }
      }
    }, CHANGE_COALESCE_MS)
    this.changeTimer.unref?.()
  }

  private file(tracked: Tracked): string {
    const name = createHash('sha256').update(tracked.id).digest('hex').slice(0, 24)
    return join(this.deps.dataDir(), 'grid-pictures', `${name}.json`)
  }

  private async load(tracked: Tracked): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file(tracked), 'utf8')) as { networkId?: unknown; picture?: unknown }
      const picture = raw.networkId === tracked.id ? parsePicture(raw.picture) : null
      if (!picture) return
      tracked.picture = picture
      tracked.known = true
      tracked.saved = JSON.stringify(picture)
    } catch { /* never read on this computer, or not a file this module wrote */ }
  }

  /** Owner-only, replaced atomically — a crash mid-write leaves the previous picture, never half of one. */
  private async save(tracked: Tracked): Promise<void> {
    const text = JSON.stringify(tracked.picture)
    if (text === tracked.saved) return
    try {
      const file = this.file(tracked)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ networkId: tracked.id, picture: tracked.picture }), { mode: 0o600 })
      await rename(temp, file)
      tracked.saved = text
    } catch { /* the picture is still in memory; the next read tries again */ }
  }
}

function liveKeys(records: readonly LocalRecord[]): string[] {
  return records
    .filter((record) => record.pid !== null && record.alive)
    .flatMap((record) => record.ids.map((id) => servedKey(record.name, idKey(id))))
}

/** The daemon's one service. Module-level like the memo it replaces, so every caller shares one picture. */
let service = new GridModelsService()

/** Live models on `gridName`, router excluded, as the picture has them after a read if one was due. */
export async function listGridModels(gridName: string | null): Promise<GridModel[]> {
  if (!gridName?.trim()) return []
  return service.models(gridName.trim())
}

/** Every grid this computer is signed into, each with its models, own grid first. */
export function listAllGridModels(ownGridName: string | null, opts: { refresh?: boolean } = {}): Promise<GridSection[]> {
  return service.sections(ownGridName, opts)
}

/** The Model Manager's inventory of the own grid (`LocalModels`' injected `inventory`). */
export function gridInventory(gridName: string, force: boolean): Promise<GridInventoryAnswer> {
  return service.inventory(gridName, force)
}

/** Make every read due again — for a caller that has just changed what a grid serves. */
export function forgetGridModels(): void {
  service.forget()
}

/** Be told (coalesced) when a background read changed what a picker would be told. */
export function onGridModelsChanged(listener: () => void): () => void {
  return service.onChange(listener)
}

/** For tests: a fresh service, optionally with its clock and places injected. */
export function resetGridModels(deps: Partial<GridModelsDeps> = {}): GridModelsService {
  service = new GridModelsService(deps)
  return service
}


/** `grid info --env` prints shell exports; these are the two that matter. */
const ENV_LINE = /^export\s+(OPENAI_BASE_URL|OPENAI_API_KEY)=(.*)$/gm

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
  const info = await gridExec(['--remote', 'info', gridName, '--env'])
  if (info.code !== 'OK') return null
  const { baseUrl, apiKey } = readEnvExports(info.stdout)
  if (!baseUrl || !apiKey) return null
  // The grid's own id, for the record the launch is written into. Falls back to the name, which is
  // unique on this account and is all the launch actually needs to be re-derivable.
  const { value: rows } = await gridJson<Array<{ grid?: unknown; id?: unknown }>>(['--remote', 'ls'])
  const row = Array.isArray(rows) ? rows.find((r) => r.grid === gridName) : undefined
  return {
    networkId: typeof row?.id === 'string' ? row.id : gridName,
    networkName: gridName,
    baseUrl,
    apiKey,
    model,
    ...(mcpUrl ? { mcpUrl } : {}),
  }
}

/** The two exports out of `grid info --env`. ⚠️ Values are SHELL-QUOTED — a base URL read with the
 *  quotes still on produces a request to a host that does not exist. */
function readEnvExports(stdout: string): { baseUrl: string; apiKey: string } {
  let baseUrl = ''
  let apiKey = ''
  for (const match of stdout.matchAll(ENV_LINE)) {
    const value = match[2]!.trim().replace(/^["']|["']$/g, '')
    if (match[1] === 'OPENAI_BASE_URL') baseUrl = value
    else apiKey = value
  }
  return { baseUrl, apiKey }
}
