/**
 * The Claude app's Code sessions on the dial, with or without a process
 * (docs/plans/2026-11-19-dial-claude-app-sessions-design.md): each session of the app's store that is not archived,
 * newest first, at most 16, read by claudeAppStore.ts while a dial is attached. Each is an idle row on the Claude app's
 * page under the id the observed source gives the same session, so the hooked copy and this one are one row
 * (registry.ts) and the row keeps its id as the session's process comes and goes. No process runs it, so it rests: no
 * weight in the dial's default app. It takes voice where its link opens, and its words wake the session: they open it
 * by that link, then go to its mod once its process runs (appWake.ts,
 * docs/plans/2026-11-21-dial-claude-app-wake-send-design.md).
 *
 * Pushed by non-recursive watches of the store's folders, never polled. A working turn writes its session's file several
 * times a second, so one pass runs at a time, and the changes during it give one more after it, at least 250 ms after
 * its start: one read after another, never a pile.
 *
 * A log line says only fixed words and counts: the store names people's folders and sessions.
 */
import { basename, join, sep } from 'node:path'
import { errorKind } from '../../lib/log.js'
import type { ClaudeStoreRoot } from './appPlaces.js'
import type { AppWake } from './appWake.js'
import { claudePaneKey } from './claudeApp.js'
import { localIdOf } from './claudeAppStore.js'
import type { ClaudeAppSession, ClaudeAppStore, StoreFolders, StoreRead } from './claudeAppStore.js'
import { observedAgentId } from './observed.js'
import { observedTitle } from './observedTitle.js'
import type { Caps, HostAgent, HostSource, PaneSwitch, SendResult } from './types.js'

/** The least time between the starts of two passes (cmuxSource.ts's rule). */
const GAP_MS = 250
/** The names waiting for a pass: past it, one listing of the folders reads them all (the app rewrites hundreds of
 *  files at its start or an update). */
const MAX_WAITING = 256
const NO_FOLDERS: StoreFolders = { roots: [], accounts: [], orgs: [] }

export interface ClaudeAppSourceDeps {
  /** The store's reader (claudeAppStore.ts), on the roots' `root`s in the same order. */
  store: Pick<ClaudeAppStore, 'folders' | 'files' | 'touch' | 'read' | 'forget'>
  /** The store's roots and their watch chains (appPlaces.ts), computed once by devices.ts. A root not there is waited
   *  for from the nearest folder of its chain. */
  roots: readonly ClaudeStoreRoot[]
  /** One watch on the nearest existing folder of the list (folderWatch.ts watchNearest), telling the changed entry's
   *  name when the OS gave one. Its stop. */
  watch(folders: readonly string[], changed: (file?: string) => void): () => void
  /** A timer; its cancel is returned. */
  after(ms: number, run: () => void): () => void
  /** A tap on that agent's session, as the devices route it. */
  focus(localId: string, agentId: string): Promise<boolean>
  canShow(localId: string): boolean
  show(localId: string, agentId: string): Promise<PaneSwitch>
  /** Whether the session's link opens on this computer (appLink.ts canLink): only then does its row take voice. */
  canLink(localId: string): boolean
  /** The devices' one wake, which every dial's words for a resting session go through. */
  wake: Pick<AppWake, 'send' | 'stop'>
  monotonic(): number
  log(line: string): void
}

/** A listed session: the app's id of it, which its tap and rest open, and its row. */
interface Row {
  localId: string
  agent: HostAgent
}

/** The pass under way or last run: whether it is under way, and whether it is too soon for the next one, 250 ms not
 *  having passed since it started (and that timer's cancel). */
interface Pass {
  under: boolean
  tooSoon: boolean
  cancel: () => void
}

/** What the dial is told a change of: never a new `lastActivityAt` alone, or each write of a working turn would run the
 *  dial's merge. */
const shape = (rows: readonly Row[]): string => JSON.stringify(rows.map(({ agent }) => [agent.id, agent.name, agent.cwd]))

function rowOf(session: ClaudeAppSession): Row {
  return {
    localId: session.localId,
    agent: {
      id: observedAgentId('claude', session.sessionId),
      engine: 'claude',
      sessionId: session.sessionId,
      paneKeys: [claudePaneKey(session.localId)],
      // The live session's name comes from the same title, so the row keeps its name as its process comes and goes.
      name: observedTitle(session.title) ?? (basename(session.cwd) || 'claude'),
      cwd: session.cwd,
      host: 'claude',
      app: 'claude',
      state: 'idle',
      unseenDone: false,
      resting: true,
      lastActivityAt: session.lastActivityAt,
    },
  }
}

export class ClaudeAppSource implements HostSource {
  readonly id = 'claude-app'
  private readonly listeners = new Set<() => void>()
  private rows: Row[] = []
  private running = false
  /** The count of stops: a pass started before the last stop takes nothing. */
  private stops = 0
  /** The roots' watches' stops. */
  private unwatch: Array<() => void> = []
  /** The account and org folders' watches, by folder. */
  private readonly watches = new Map<string, () => void>()
  /** What waits for the next pass: a listing of the folders, the names touched (by org folder), or one more read. */
  private listing = false
  private readonly names = new Map<string, Set<string>>()
  private named = 0
  private again = false
  private pass: Pass | undefined
  /** The roots there at the last listing, none before the first: kept across a detach, so a dial plugged in again
   *  says nothing. */
  private there: ReadonlySet<string> | undefined
  /** The slowest read said this start, the count of rows last said, and of what the bounds left out. */
  private slowest: number | undefined
  private said: number | undefined
  private over = 0
  /** Whether the last pass of this start failed, so a run of failures says one line. */
  private failed = false

  constructor(private readonly deps: ClaudeAppSourceDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.slowest = undefined
    this.failed = false
    // Held before the folders are listed, so a store made between the two is still heard.
    this.unwatch = this.deps.roots.map((root) => this.deps.watch(root.watch, (file) => this.rootChanged(root, file)))
    this.relist()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.stops++
    // The dial detached: a wake still opening or waiting answers that its session did not answer.
    this.deps.wake.stop()
    for (const stop of this.unwatch) stop()
    this.unwatch = []
    this.watchFolders(NO_FOLDERS)
    this.listing = false
    this.names.clear()
    this.named = 0
    this.again = false
    // A pass under way runs to its end and takes nothing, so a start meanwhile waits for it: one pass at a time.
    if (this.pass) {
      this.pass.cancel()
      this.pass.tooSoon = false
      this.next()
    }
    this.deps.store.forget()
    this.drop()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): HostAgent[] {
    return this.rows.map(({ agent }) => ({ ...agent }))
  }

  /** Status, a tap, a rest while the app is in front, and voice where the session's link opens: no process runs the
   *  session to answer. */
  capabilities(agent: HostAgent): Caps {
    const row = this.find(agent.id)
    return { status: true, voice: !!row && this.deps.canLink(row.localId), focus: true, answer: false }
  }

  /** The words wake the row's session, named by the row as they arrive. A row no longer listed opens nothing. */
  async send(agent: HostAgent, text: string): Promise<SendResult> {
    const row = this.find(agent.id)
    if (!row) return { ok: false, reason: `${agent.name} did not answer.` }
    const { localId, agent: { id, sessionId, name } } = row
    return this.deps.wake.send({ localId, sessionId: sessionId!, agentId: id, name }, text)
  }

  async focus(agent: HostAgent): Promise<boolean> {
    const row = this.find(agent.id)
    return row ? this.deps.focus(row.localId, row.agent.id) : false
  }

  hasPane(agent: HostAgent): boolean {
    const row = this.find(agent.id)
    return row ? this.deps.canShow(row.localId) : false
  }

  async showPane(agent: HostAgent): Promise<PaneSwitch> {
    const row = this.find(agent.id)
    return row ? this.deps.show(row.localId, row.agent.id) : 'failed'
  }

  private find(agentId: string): Row | undefined {
    return this.rows.find(({ agent }) => agent.id === agentId)
  }

  /** Each listener on its own: one that throws neither keeps the next from hearing nor fails a good read. devices.ts
   *  runs each of its listeners through its part guard, which says what failed. */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* said by the listener's own guard */ }
    }
  }

  /** Drops the rows, told once if there were any. The next count is said again, even with as many rows. */
  private drop(): void {
    this.said = undefined
    this.over = 0
    if (this.rows.length === 0) return
    this.rows = []
    this.emit()
  }

  /** An event of a root's watch. While the root is not there it holds a folder of the root's chain, whose other entries
   *  other apps and packages, and the Claude app as it runs, write: only the name of a folder of that chain, or no
   *  name, looks again. */
  private rootChanged(root: ClaudeStoreRoot, file?: string): void {
    const waiting = this.there?.has(root.root) === false
    if (waiting && file !== undefined && !root.watch.some((folder) => basename(folder) === file)) return
    if (file !== undefined) this.unwatchBelow(join(root.root, file))
    this.relist()
  }

  /** An event of an account's watch, which may name one of its orgs. */
  private accountChanged(account: string, file?: string): void {
    if (file !== undefined) this.unwatchBelow(join(account, file))
    this.relist()
  }

  /** Stops the watches of a folder an event named, and of those below it: a folder removed ends its watch for good
   *  (folderWatch.ts), so one made again before the next listing would keep a watch that hears nothing. The listing
   *  sets them again. */
  private unwatchBelow(folder: string): void {
    for (const [watched, stop] of this.watches) {
      if (watched !== folder && !watched.startsWith(folder + sep)) continue
      stop()
      this.watches.delete(watched)
    }
  }

  /** An event of an org's watch. One naming anything but a session's own file changes no session: an archive or a delete
   *  also writes or removes the session's own file, and a write by temp file and rename names the final file too. */
  private orgChanged(org: string, file?: string): void {
    if (file === undefined) this.relist()
    else if (localIdOf(file) !== undefined) this.touched(org, file)
  }

  /** A listing of the folders waits: it lists every file again, so no name needs to wait beside it. */
  private relist(): void {
    if (!this.running) return
    this.listing = true
    this.names.clear()
    this.named = 0
    this.wake()
  }

  private touched(org: string, name: string): void {
    if (!this.running || this.listing) return
    const names = this.names.get(org) ?? new Set<string>()
    if (names.has(name)) return
    if (this.named === MAX_WAITING) {
      this.relist()
      return
    }
    names.add(name)
    this.names.set(org, names)
    this.named++
    this.wake()
  }

  private wake(): void {
    if (!this.pass) void this.run()
  }

  /** A pass that ended, 250 ms after it started, frees the way: what waited since runs. */
  private next(): void {
    const pass = this.pass
    if (!pass || pass.under || pass.tooSoon) return
    this.pass = undefined
    if (this.listing || this.named > 0 || this.again) void this.run()
  }

  /** One pass: what waited, then a read. A store call that fails ends it with the rows kept; the next change runs
   *  one. */
  private async run(): Promise<void> {
    const pass: Pass = { under: true, tooSoon: true, cancel: () => {} }
    this.pass = pass
    pass.cancel = this.deps.after(GAP_MS, () => {
      pass.tooSoon = false
      this.next()
    })
    const { listing } = this
    const names = [...this.names].flatMap(([org, held]) => [...held].map((name) => [org, name] as const))
    this.listing = false
    this.names.clear()
    this.named = 0
    this.again = false
    const stops = this.stops
    const began = this.deps.monotonic()
    try {
      if (listing) {
        const folders = await this.deps.store.folders()
        if (this.stops !== stops) return
        this.look(folders?.roots ?? [])
        // Set before the files are listed, so a file written meanwhile is still heard. A root not there, its own watch
        // waits for it.
        this.watchFolders(folders ?? NO_FOLDERS)
        if (!folders) {
          this.drop()
          return
        }
        await this.deps.store.files()
        if (this.stops !== stops) return
      }
      for (const [org, name] of names) {
        await this.deps.store.touch(org, name)
        if (this.stops !== stops) return
      }
      const read = await this.deps.store.read()
      if (this.stops !== stops) return
      this.take(read, this.deps.monotonic() - began)
      this.failed = false
    } catch (error) {
      // A failed call tells nothing of the store: the rows stay as they were, and nothing throws into the devices process.
      // The kind is said, never the error's words: they can name the store's folders and files.
      if (!this.failed) this.deps.log(`[claude-app] read · failed · ${errorKind(error)}`)
      this.failed = true
    } finally {
      pass.under = false
      this.next()
    }
  }

  /** Which roots are there; whether any is, said when that changed. */
  private look(roots: readonly string[]): void {
    const before = this.there
    this.there = new Set(roots)
    if (before !== undefined && (before.size > 0) === (roots.length > 0)) return
    this.deps.log(`[claude-app] watch · ${roots.length > 0 ? 'on' : 'none'}`)
  }

  /** One watch a folder read, kept while it is read: an account's event lists the folders again, an org's names a
   *  file. */
  private watchFolders({ accounts, orgs }: StoreFolders): void {
    const wanted = new Map<string, (file?: string) => void>([
      ...accounts.map((folder) => [folder, (file?: string) => this.accountChanged(folder, file)] as const),
      ...orgs.map((folder) => [folder, (file?: string) => this.orgChanged(folder, file)] as const),
    ])
    for (const [folder, stop] of this.watches) {
      if (wanted.has(folder)) continue
      stop()
      this.watches.delete(folder)
    }
    for (const [folder, changed] of wanted) {
      if (!this.watches.has(folder)) this.watches.set(folder, this.deps.watch([folder], changed))
    }
  }

  private take(read: StoreRead, ms: number): void {
    // A walk cut at its 256 parses reads on with no event. Its list is partial, so the rows stay until a whole one; the
    // over line still counts the cut.
    if (read.more) {
      this.again = true
      this.counted(read.over)
      return
    }
    const before = shape(this.rows)
    this.rows = read.sessions.map(rowOf)
    this.timed(ms, read)
    this.counted(read.over)
    if (shape(this.rows) !== before) this.emit()
  }

  /** The first read of a start, then only one slower than every one said: the number the read's target needs, not a
   *  line per write of a working turn. */
  private timed(ms: number, { parsed, skipped }: StoreRead): void {
    if (this.slowest !== undefined && ms <= this.slowest) return
    this.slowest = ms
    this.deps.log(`[claude-app] read · ${Math.round(ms)} ms · ${parsed} parsed · ${skipped} skipped`)
  }

  /** The rows, said when their count changes, and what the store's bounds left out, when that changes. */
  private counted(over: number): void {
    if (this.rows.length !== this.said) {
      this.said = this.rows.length
      this.deps.log(`[claude-app] listed · ${this.said} sessions`)
    }
    if (over === this.over) return
    this.over = over
    if (over > 0) this.deps.log(`[claude-app] over · ${over}`)
  }
}
