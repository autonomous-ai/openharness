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
 * person's act (issue 03): an explicit wake, moving an agent onto a sleeping grid, the first keystroke
 * into a pane whose agent runs on one — each decided here, from the picture, and sent through
 * `gridWake.ts`, the one module that reads a grid with its credential. Beside that, the picture says
 * which rows only a computer of the account's that seems offline serves (`gridPresence.ts`): a label,
 * never a removal.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { env as config } from '../config/env.js'
import { gridCredentialsPath } from './gridCredentials.js'
import { signedInGridEmail } from './gridDerive.js'
import { gridJson } from './gridExec.js'
import {
  emptyPicture, mergeAwake, idKey, parsePicture, provenStopped, sectionView, servedKey, servesAModel, unspelled, withAsleep,
  withSpellings, withUnknown, withWindows, type GridPicture, type LocalRecord, type PictureState, type RowUnavailable,
  type SectionView, type ServedHere,
} from './gridPicture.js'
import { ComputerPresence, computersIn, MACHINE_LIST_FRESH_MS } from './gridPresence.js'
import {
  OWNER_ASLEEP_STATUS, readBase, readDiscoveryIds, readGridInfo, readOverview, readViaCli, type GridInfo, type GridRead,
  type ReadNode,
} from './gridReader.js'
import type { GridLaunchOverride } from './gridLaunch.js'
import { PrewarmDebounce, wakeRead, type RelayAccess, type WakePurpose } from './gridWake.js'
import { readRunRecords } from './localModels.js'

export interface GridModel {
  /** The id an engine is pointed at, in the exact case the grid serves it. */
  id: string
  /** Which machine answers it, or empty when the grid does not say. Display only. */
  node: string
  /** Every computer serving it seems offline — sent only to a client that asked for row state
   *  ([presentGridSections]); an older one reads it in `node` instead. */
  unavailable?: RowUnavailable
}

/** How an explicit wake that did not show models ended: the grid did not come up in time, or came up
 *  with nobody serving anything. */
export type WakeOutcome = 'not_started' | 'nobody_serving'

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
  /** Additive (issue 03): the last explicit wake of this grid did not show models — while it stands. */
  wakeOutcome?: WakeOutcome
}

/** What the Model Manager is told about the grid it runs on (`localModels.ts`'s `GridInventory`). */
export interface GridInventoryAnswer {
  state: PictureState
  nodes: Record<string, unknown>[]
  /** The owner status as last read (memoised, never asked per tick); null when it could not be read. */
  status: string | null
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

/** An explicit wake re-reads the grid, without a credential, this often and for this long after its one
 *  credentialed read — long enough for a master to boot and its providers to report (issue 03). */
const WAKE_REREAD_MS = 3_000
const WAKE_WINDOW_MS = 45_000

/** How long a wake that showed no models keeps saying so. */
const WAKE_OUTCOME_STANDS_MS = 10 * 60_000

/** A grid seen awake this recently needs no prewarm: an agent moved onto it will find it up. */
const RECENTLY_AWAKE_MS = 60_000

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
  /** An explicit wake running for this grid; a second ask joins it. */
  waking: Promise<void> | null
  /** How the last explicit wake ended when it showed no models, and when. */
  wakeOutcome: { outcome: WakeOutcome; at: number } | null
  /** What a picker was last told about this grid — what an agent's note is read from, with no I/O. */
  lastView: GridView | null
}

/** One grid's section as this service builds it: the picture's view, and the wake it may be in. */
type GridView = Omit<SectionView, 'models'> & { models: GridModel[]; wakeOutcome?: WakeOutcome }

/** What a prewarm did: `fired` one credentialed read, or why it did not. */
export type PrewarmOutcome =
  | 'fired' | 'debounced' | 'awake' | 'absent' | 'offline'
  /** Keystroke only: the agent's grid is not one this daemon is tracking, or it is not asleep. */
  | 'untracked' | 'not-asleep'

/** A grid as a launch names it: its network id (what it is tracked and persisted under) and its name. */
export interface GridRef { networkId: string; gridName: string }

/** Where an agent's inference goes (`gridAssignment.ts`) — all a prewarm or a note needs of it. */
export interface AgentGridTarget { baseUrl: string; model: string | null }

/** What is said about an agent already on a grid model (issue 03): that grid's state, and a note when its
 *  model will not answer — every computer serving it seems offline, or the latest list no longer has it. */
export interface GridNote { reason: 'offline' | 'not_served'; model: string; machine?: string }
export interface GridAnnotation { state: PictureState; note?: GridNote }

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
  /** The explicit wake's pause between re-reads — injectable, so a test's clock moves instead. */
  sleep: (ms: number) => Promise<void>
  /** Run `run` in `ms`, with nothing else to trigger it (an expiry); answers how to call it off. */
  after: (ms: number, run: () => void) => () => void
}

const defaultDeps: GridModelsDeps = {
  now: () => Date.now(),
  dataDir: () => config.ADAPTER_DATA_DIR,
  gridHome: () => dirname(gridCredentialsPath()),
  email: () => signedInGridEmail(),
  firstReadWaitMs: FIRST_READ_WAIT_MS,
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.() }),
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  },
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
  private readonly presence = new ComputerPresence()
  private readonly debounce = new PrewarmDebounce()
  private rows: GridRow[] | null = null
  private changeTimer: NodeJS.Timeout | null = null
  /** Called off by the next machine list: fires only when none came in time, and the labels lapse. */
  private cancelStaleList: (() => void) | null = null

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
    await Promise.all([...this.tracked.values()].flatMap((tracked) => [tracked.pending?.catch(() => {}), tracked.waking]))
  }

  /**
   * Every picture this computer saved, taken back into memory with nothing read from any grid — at daemon
   * start, so an agent's frame carries its grid's state and note, and a keystroke can start its grid, from
   * the first moment: before any window has asked for the list, and when none ever does (a phone typing).
   */
  async warm(): Promise<void> {
    const folder = join(this.deps.dataDir(), PICTURES_DIR)
    const names = await readdir(folder).catch(() => [] as string[])
    await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      try {
        const saved = JSON.parse(await readFile(join(folder, name), 'utf8')) as SavedPicture
        if (typeof saved.networkId !== 'string' || !saved.networkId) return
        const gridName = typeof saved.name === 'string' ? saved.name : ''
        const tracked = await this.track({ id: saved.networkId, name: gridName, type: '' }, saved.own === true ? true : undefined)
        await this.view(tracked)
      } catch { /* not a picture this module wrote; the list will read that grid when asked */ }
    }))
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
  async sections(ownGridName: string | null, opts: { refresh?: boolean; wake?: readonly string[] } = {}): Promise<GridSection[]> {
    const rows = await this.gridRows(ownGridName)
    const sections = await Promise.all(rows.map(async (row) => {
      const tracked = await this.track(row, row.name === ownGridName)
      // A person asked for this one to start: its wake is running before the answer is built, so the
      // answer says "waking" — and a wake's own re-reads stand in for the refresh below.
      if (opts.wake?.includes(row.name)) this.startWake(tracked)
      if (opts.refresh !== false && !tracked.waking && this.due(tracked)) {
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
    return {
      state: tracked.picture.state,
      nodes: tracked.picture.state === 'awake' ? tracked.rawNodes : [],
      status: tracked.info?.value?.status ?? null,
    }
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
        pending: null, waking: null, wakeOutcome: null, lastView: null,
      }
      this.tracked.set(row.id, tracked)
    }
    // A warmed grid may know only its id; the list's name is better than none.
    if (row.name) tracked.name = row.name
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
    const pending = tracked.pending ?? this.read(tracked).then(() => {}).finally(() => { tracked.pending = null })
    tracked.pending = pending
    return pending
  }

  /**
   * One credential-less read, applied. `waking`: an explicit wake's re-read, which goes to the grid even
   * where an automatic look would not (the own grid past its one read per asleep episode). Answers the
   * read it made, or null when the episode rule stood in for one.
   */
  private async read(tracked: Tracked, waking = false): Promise<GridRead | null> {
    const before = JSON.stringify(await this.signature(tracked))
    const info = await this.info(tracked)
    const asleepByStatus = tracked.own && info?.status === OWNER_ASLEEP_STATUS
    let made: GridRead | null = null
    // The own grid, while its status says asleep, is read exactly once per asleep episode — to fetch the
    // platform's record of what it served — and then left alone until the status changes.
    if (asleepByStatus && tracked.episodeRead && !waking) {
      await this.apply(tracked, { kind: 'asleep', lastKnown: null }, null)
    } else {
      tracked.episodeRead = asleepByStatus
      const base = readBase(info?.gridUrl ?? null)
      made = base ? await readOverview(base) : { kind: 'unreachable' }
      // Only when nothing answered at all — never to second-guess an answer the grid gave.
      if (made.kind === 'unreachable') made = await readViaCli(tracked.name)
      await this.apply(tracked, made, base)
    }
    await this.save(tracked)
    tracked.known = true
    if (JSON.stringify(await this.signature(tracked)) !== before) this.changed()
    return made
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
    picture = withWindows({ ...picture, caseMap: withSpellings(picture.caseMap, [...read.curatedIds, ...here.records.flatMap((r) => r.ids)]) }, read.windows)
    const unknownIds = unspelled(picture, read.nodes).filter((key) => !tracked.spelled.has(key))
    if (unknownIds.length && base) {
      unknownIds.forEach((key) => tracked.spelled.add(key))
      picture = { ...picture, caseMap: withSpellings(picture.caseMap, await readDiscoveryIds(base)) }
    }
    tracked.picture = picture
    tracked.rawNodes = read.rawNodes
    tracked.readTtl = AWAKE_MEMO_MS
    // A wake that showed nothing stops saying so once the grid is found serving.
    if (servesAModel(read.nodes)) tracked.wakeOutcome = null
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

  private async view(tracked: Tracked): Promise<GridView> {
    const now = this.deps.now()
    const view = sectionView(tracked.picture, await this.servedHere(tracked), now, (name) => this.presence.seemsOffline(name, now))
    const outcome = tracked.wakeOutcome && now - tracked.wakeOutcome.at < WAKE_OUTCOME_STANDS_MS ? tracked.wakeOutcome.outcome : null
    const shown: GridView = {
      ...view,
      // A wake in flight is the state, whatever its re-reads have found so far.
      state: tracked.waking ? 'waking' : view.state,
      ...(outcome && !tracked.waking ? { wakeOutcome: outcome } : {}),
    }
    tracked.lastView = shown
    return shown
  }

  /** What a push is about: the rows (labels included), the state and a wake's outcome — not the ages,
   *  which move every second. */
  private async signature(tracked: Tracked): Promise<unknown> {
    const view = await this.view(tracked)
    return { models: view.models, state: view.state, wakeOutcome: view.wakeOutcome }
  }

  /** Coalesced: the views are rebuilt first, so a listener reading an agent's note sees the change. */
  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      void Promise.all([...this.tracked.values()].map((tracked) => this.view(tracked).catch(() => null))).then(() => {
        for (const listener of this.listeners) {
          try { listener() } catch { /* a listener's failure is its own */ }
        }
      })
    }, CHANGE_COALESCE_MS)
    this.changeTimer.unref?.()
  }

  // ── a person's act (issue 03) ─────────────────────────────────────────────────────────────────────

  /** What was read about `tracked` is stale now: a person has just acted on it. The picture stays. */
  private dropMemo(tracked: Tracked): void {
    tracked.readAt = null
    tracked.info = null
    tracked.episodeRead = false
  }

  /**
   * An explicit wake — "Show models", the viewer's "Wake now". Returns at once (the answer being built
   * says "waking"); behind it, ONE credentialed read marked `(wake)`, then credential-less re-reads every
   * [WAKE_REREAD_MS] for up to [WAKE_WINDOW_MS], merged like any read, until one finds a node serving.
   * A second ask while it runs joins it.
   */
  private startWake(tracked: Tracked): void {
    if (tracked.waking) return
    this.dropMemo(tracked)
    tracked.wakeOutcome = null
    // A prewarm right behind a wake would pay for the same boot twice.
    this.debounce.mark(tracked.id, this.deps.now())
    void this.credentialedRead(tracked, 'wake')
    tracked.waking = this.wake(tracked).catch(() => {}).finally(() => {
      tracked.waking = null
      // The status said asleep when this began; whatever it says now is asked afresh.
      tracked.info = null
      this.changed()
    })
    this.changed()
  }

  private async wake(tracked: Tracked): Promise<void> {
    let cameUp = false
    for (let reread = 0; reread < WAKE_WINDOW_MS / WAKE_REREAD_MS; reread++) {
      await this.deps.sleep(WAKE_REREAD_MS)
      const read = await this.readNow(tracked)
      if (read?.kind !== 'awake') continue
      cameUp = true
      if (servesAModel(read.nodes)) return
    }
    tracked.wakeOutcome = { outcome: cameUp ? 'nobody_serving' : 'not_started', at: this.deps.now() }
    // It stops being said with no read to notice: tell the windows when it does.
    this.deps.after(WAKE_OUTCOME_STANDS_MS, () => this.changed())
  }

  /** A wake's re-read: after any read already out, and never shared with the automatic path's memo. */
  private async readNow(tracked: Tracked): Promise<GridRead | null> {
    while (tracked.pending) await tracked.pending.catch(() => {})
    let answered: GridRead | null = null
    tracked.pending = this.read(tracked, true).then((read) => { answered = read }).finally(() => { tracked.pending = null })
    await tracked.pending
    return answered
  }

  /** One credentialed read marked `purpose`, detached — unless one went out for this grid in the last
   *  ten minutes. */
  private sendPrewarm(tracked: Tracked, purpose: WakePurpose, now: number, access?: RelayAccess): PrewarmOutcome {
    if (!this.debounce.allows(tracked.id, now)) return 'debounced'
    this.debounce.mark(tracked.id, now)
    void this.credentialedRead(tracked, purpose, access)
    return 'fired'
  }

  /** The credentialed read itself ([wakeRead]). Its answer lists each model's context window, which the
   *  picture keeps for the next move onto that grid — the one thing it teaches that no free read did. */
  private async credentialedRead(tracked: Tracked, purpose: WakePurpose, access?: RelayAccess): Promise<void> {
    const name = tracked.name || (await this.gridRows(null)).find((row) => row.id === tracked.id)?.name
    if (!name) return
    const windows = await wakeRead(name, purpose, access)
    if (!windows) return
    tracked.picture = withWindows(tracked.picture, windows)
    await this.save(tracked)
  }

  /**
   * An agent was just moved onto `model` on `gridName`: start that grid while the pane restarts — when
   * its picture says asleep or it was not seen awake in the last minute. Not when the model is not in the
   * picture, and not when every computer serving it seems offline: a boot nobody can answer on is wasted.
   * The move never waits on this, and is never refused by it.
   */
  async retargetPrewarm(grid: GridRef, model: string, access?: RelayAccess): Promise<PrewarmOutcome> {
    // By the id the move already resolved: no `grid ls` of its own behind a click.
    const tracked = await this.track({ id: grid.networkId, name: grid.gridName, type: '' })
    const now = this.deps.now()
    const { state, seenAt } = tracked.picture
    const view = await this.view(tracked)
    this.dropMemo(tracked)
    if (state !== 'asleep' && seenAt !== null && now - seenAt < RECENTLY_AWAKE_MS) return 'awake'
    const row = servedRow(view.models, model)
    if (!row) return 'absent'
    if (row.unavailable) return 'offline'
    return this.sendPrewarm(tracked, 'prewarm', now, access)
  }

  /**
   * Someone typed into a terminal whose agent runs on `target`: when that grid's picture says asleep,
   * start it while they type. Asked on EVERY input, so it answers from memory — the picture and the view
   * a picker was last given — and the ten-minute debounce is checked first.
   */
  async keystrokePrewarm(target: AgentGridTarget | null | undefined): Promise<PrewarmOutcome> {
    const tracked = target ? this.trackedFor(target.baseUrl) : null
    if (!tracked || !target) return 'untracked'
    if (tracked.picture.state !== 'asleep' || tracked.waking) return 'not-asleep'
    const now = this.deps.now()
    if (!this.debounce.allows(tracked.id, now)) return 'debounced'
    const rows = target.model ? tracked.lastView?.models : undefined
    const row = rows && servedRow(rows, target.model!)
    if (rows && !row) return 'absent'
    if (row?.unavailable) return 'offline'
    this.dropMemo(tracked)
    return this.sendPrewarm(tracked, 'prewarm-key', now)
  }

  /** The grid an agent's inference goes to: the tracked grid whose id is a segment of its relay's path. */
  private trackedFor(baseUrl: string): Tracked | null {
    let segments: string[]
    try { segments = new URL(baseUrl).pathname.split('/').filter(Boolean) } catch { return null }
    return [...this.tracked.values()].find((tracked) => !tracked.id.startsWith(NAME_ONLY_PREFIX) && segments.includes(tracked.id)) ?? null
  }

  /**
   * What an agent frame says about the agent's grid, from what a picker was last told — no I/O, so a
   * frame costs nothing. Null for an agent on no grid this daemon is tracking.
   */
  annotation(target: AgentGridTarget | null | undefined): GridAnnotation | null {
    const tracked = target ? this.trackedFor(target.baseUrl) : null
    const view = tracked?.lastView
    if (!tracked || !view || !target) return null
    if (!target.model || view.state === 'waking') return { state: view.state }
    const row = servedRow(view.models, target.model)
    if (row?.unavailable) return { state: view.state, note: { reason: 'offline', model: row.id, machine: row.unavailable.machine } }
    // "No longer lists" needs a list: a grid never read says nothing about any model.
    if (!row && tracked.picture.listAt !== null) return { state: view.state, note: { reason: 'not_served', model: target.model } }
    return { state: view.state }
  }

  /** A machine list this daemon just read (`GET /api/machines`, or null when signed out): which of the
   *  account's other computers seem offline. Re-tells clients only when a verdict changed. */
  observeMachines(body: unknown, localComputerId: string): void {
    const list = computersIn(body, localComputerId) ?? { computers: [], guest: true }
    if (this.presence.observe(list, this.deps.now())) this.changed()
    // A list that stops coming (this computer lost the backend) stops labelling, with no read to notice.
    this.cancelStaleList?.()
    this.cancelStaleList = this.deps.after(MACHINE_LIST_FRESH_MS + 1_000, () => this.changed())
  }

  /** The context window `model` was last reported with on the grid tracked as `networkId`, read without a
   *  credential — what a launch tells the engine to compact inside. */
  async contextWindow(grid: GridRef, model: string): Promise<number | undefined> {
    const tracked = await this.track({ id: grid.networkId, name: grid.gridName, type: '' })
    return tracked.picture.windows[idKey(model)]
  }

  private file(tracked: Tracked): string {
    const name = createHash('sha256').update(tracked.id).digest('hex').slice(0, 24)
    return join(this.deps.dataDir(), PICTURES_DIR, `${name}.json`)
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
      const saved: SavedPicture = { networkId: tracked.id, name: tracked.name, own: tracked.own, picture: tracked.picture }
      await writeFile(temp, JSON.stringify(saved), { mode: 0o600 })
      await rename(temp, file)
      tracked.saved = text
    } catch { /* the picture is still in memory; the next read tries again */ }
  }
}

/** A picture as saved: which grid it is (its name and whether it is the account's own, so a daemon that
 *  just started can use it before `grid ls` is asked — both absent from a file written before issue 03). */
interface SavedPicture { networkId?: unknown; name?: unknown; own?: unknown; picture?: unknown }

/** Where pictures are kept, under the data directory. */
const PICTURES_DIR = 'grid-pictures'

/** The row a view offers for `model`, whatever its case. */
function servedRow(rows: readonly GridModel[], model: string): GridModel | undefined {
  const key = idKey(model)
  return rows.find((row) => idKey(row.id) === key)
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

/** The pictures this computer saved, back in memory ([GridModelsService.warm]) — at daemon start. */
export function warmGridModels(): Promise<void> {
  return service.warm()
}

/** Every grid this computer is signed into, each with its models, own grid first. `wake` names the
 *  sections a person asked to start (issue 03's explicit wake). */
export function listAllGridModels(ownGridName: string | null, opts: { refresh?: boolean; wake?: readonly string[] } = {}): Promise<GridSection[]> {
  return service.sections(ownGridName, opts)
}

/**
 * The sections as a client that did or did not ask for row state reads them. One that did (`rowState`)
 * gets each label as `unavailable` beside a plain `node`; an older one, which would draw neither, reads
 * the label in the node text — "<computer> · seems offline" — and nothing else changes for it.
 */
export function presentGridSections(sections: GridSection[], opts: { rowState: boolean }): GridSection[] {
  if (opts.rowState) return sections
  return sections.map((section) => ({
    ...section,
    models: section.models.map(({ unavailable, ...row }) => unavailable ? { ...row, node: `${unavailable.machine} · seems offline` } : row),
  }))
}

/** An agent was just moved onto the grid model `launch` names — start that grid while the pane restarts,
 *  if it needs it ([GridModelsService.retargetPrewarm]), with the relay and credential the move resolved.
 *  A launch with no model (Auto) names nothing to check, and starts nothing. */
export async function retargetPrewarm(launch: GridLaunchOverride): Promise<PrewarmOutcome | null> {
  if (!launch.model) return null
  return service.retargetPrewarm({ networkId: launch.networkId, gridName: launch.networkName }, launch.model,
    { baseUrl: launch.baseUrl, apiKey: launch.apiKey })
}

/** Input reached a terminal whose agent runs on `target` ([GridModelsService.keystrokePrewarm]). */
export function keystrokePrewarm(target: AgentGridTarget | null | undefined): Promise<PrewarmOutcome> {
  return service.keystrokePrewarm(target)
}

/** What an agent frame says about the grid the agent is on ([GridModelsService.annotation]). */
export function gridAnnotation(target: AgentGridTarget | null | undefined): GridAnnotation | null {
  return service.annotation(target)
}

/** The context window `model` was last reported with on `grid`, read without a credential. */
export function gridContextWindow(grid: GridRef, model: string): Promise<number | undefined> {
  return service.contextWindow(grid, model)
}

/** A machine list this daemon just read, or null when signed out ([GridModelsService.observeMachines]). */
export function observeMachineList(body: unknown, localComputerId: string): void {
  service.observeMachines(body, localComputerId)
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
