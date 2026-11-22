// The dial eval's check evaluators: pure functions from what a driver saw to scores (docs/plans/2026-11-21-dial-app-eval-plan.md,
// Task 5). Evidence names session keys, editor window ids and times only, never a title, a folder or spoken text, and
// lists only what was observed: a driver that observes nothing leaves it empty, so its probes fail.
import { posix } from 'node:path'
import { windowClasses } from '../../cable/hosts/frontApp.js'
import { APP_BUNDLES } from '../../cable/hosts/hostDetect.js'
import { observedTitle } from '../../cable/hosts/observedTitle.js'
import { WINDOWS_APPS } from '../../cable/hosts/windowsRaise.js'
import { CAROUSEL_TILES } from '../dialCarousel.js'
import { tabTitle } from './orcaListing.js'
import { agentIdOf, EDITORS, engineOf, orcaPaneHandle, orcaWorktreeId, PAGE, placeOf, SKIPPED_SCROLL, THRESHOLDS, type App, type Check,
  type CheckResult, type LinkedApp, type Platform, type Scenario, type Seen, type SessionDef, type SessionKey, type StepOf, type Tier,
  type Until, type WrongSend } from './types.js'

/** A failing check's evidence stays readable in the report, however long the scenario ran. */
const MAX_EVIDENCE = 20

/** [full, half], inclusive (≤); never seen scores 0. */
export function graded(value: number | null, threshold: readonly [number, number]): 0 | 0.5 | 1 {
  if (value === null) return 0
  return value <= threshold[0] ? 1 : value <= threshold[1] ? 0.5 : 0
}

interface Part { part: string; score: number; timed: boolean; ms?: number | null; evidence: string[] }
/** A check's window: from its `after` step (inclusive, as a step's own reaction lands at its time) to its `at` step. */
interface Window { from: number; to: number }
export interface Ring { at: number; page: string; rows: Array<{ id: string; name: string }> }

type CheckOf<K extends Check['kind']> = Extract<Check, { kind: K }>

const ratio = (part: number, whole: number): number => (whole === 0 ? 1 : part / whole)
const bounded = (lines: string[]): string[] =>
  lines.length <= MAX_EVIDENCE ? lines : [...lines.slice(0, MAX_EVIDENCE), `… ${lines.length - MAX_EVIDENCE} more`]
/** Session keys on one line, as many as lines a check may give: a ring of 2,000 rows stays one readable line. */
const keyList = (keys: string[]): string => bounded(keys).join(' ')

class World {
  private readonly keys = new Map<string, SessionKey>()

  constructor(readonly scenario: Scenario, readonly seen: Seen) {
    for (const s of scenario.sessions) this.keys.set(agentIdOf(s), s.key)
  }

  session(key: SessionKey): SessionDef {
    const found = this.scenario.sessions.find((s) => s.key === key)
    if (!found) throw new Error(`scenario ${this.scenario.id} names no session ${key}`)
    return found
  }

  /** A row's session key; an id the scenario does not know is never printed, as it may be the machine's. */
  keyOf(agentId: string | null): string {
    return agentId === null ? 'none' : this.keys.get(agentId) ?? 'other'
  }

  /** A shell's key as a stream line names it; anything else is never printed, as it may be a pid. */
  known(key: unknown): string {
    return typeof key === 'string' && this.scenario.sessions.some((s) => s.key === key) ? key : 'other'
  }

  stepAt(label: string): number | undefined {
    return this.seen.steps.find((s) => s.label === label)?.at
  }

  /** Undefined while a step it names has not run: nothing it measures was seen. */
  window(check: Check): Window | undefined {
    const from = check.after === undefined ? 0 : this.stepAt(check.after)
    const to = check.at === undefined ? Infinity : this.stepAt(check.at)
    return from === undefined || to === undefined ? undefined : { from, to }
  }

  /**
   * Whether the dial still holds a frame at `to`: one before `to` and after the last unplug before it, as an unplugged
   * dial forgets its tiles and its page (tierA/loopbackDial.ts).
   */
  held(at: number, to: number): boolean {
    const unplugged = this.seen.steps.filter((s) => s.kind === 'unplug' && s.at < to).at(-1)?.at ?? -Infinity
    return at > unplugged && at < to
  }

  /** Each step that ran before `to`, with the scenario's step. */
  stepsBefore(to: number): Scenario['steps'] {
    return this.seen.steps.filter((s) => s.at < to).map((s) => this.scenario.steps[s.index]!)
  }
}

const within = (at: number, w: Window): boolean => at >= w.from && at < w.to

/**
 * The whole lists the dial was sent. Only whole lists count: a list with no `agents.end`, or one a second `agents.begin`
 * replaced, is never read, as the firmware does not read it. Its page is the last `apps` frame's, which each push sends
 * before its ring.
 */
export function rings(seen: Pick<Seen, 'frames'>): Ring[] {
  const all: Ring[] = []
  let page = ''
  let building: Ring['rows'] | undefined
  for (const { at, message } of seen.frames) {
    if (message.t === 'apps') page = typeof message.shown === 'string' ? message.shown : ''
    else if (message.t === 'agents.begin') building = []
    else if (message.t === 'agent' && building && typeof message.id === 'string') {
      building.push({ id: message.id, name: typeof message.name === 'string' ? message.name : '' })
    } else if (message.t === 'agents.end' && building) {
      all.push({ at, page, rows: building })
      building = undefined
    }
  }
  return all
}

/**
 * The untimed parts read the ring the dial holds as the window ends, even one that landed before it opened: a step that
 * leaves the ring as it was needs no push, and a stale ring that differs from the one expected still fails. The dial holds
 * its last whole list alone: one of another page, or with none, after the page's own means the page's ring is gone (PM
 * 2026-11-22). Only the timed `change` needs a list in the window.
 */
function ringParts(check: CheckOf<'ring'>, world: World, w: Window | undefined): Part[] {
  const expected = check.expect.map((key) => agentIdOf(world.session(key)))
  const page = PAGE[check.page]
  const all = rings(world.seen)
  const held = w ? all.filter((r) => world.held(r.at, w.to)).at(-1) : undefined
  const last = held?.page === page ? held : undefined
  const lists = w ? all.filter((r) => r.page === page && within(r.at, w)) : []
  const right = (r: Ring): boolean => {
    const ids = new Set(r.rows.map((row) => row.id))
    return expected.every((id) => ids.has(id)) && r.rows.length === new Set(expected).size && ids.size === r.rows.length
  }
  const changed = w && check.timed ? lists.find(right) : undefined
  const change = changed && w ? changed.at - w.from : null
  const parts: Part[] = []
  const evidence: string[] = []
  if (!last) {
    if (held) {
      evidence.push(`list at ${held.at} on ${held.page || 'none'}, not ${page}: ${held.rows.length} rows ${
        keyList(held.rows.map((r) => world.keyOf(r.id)))}`.trimEnd())
    } else if (all.length > 0) evidence.push(`no whole list held on ${page}; ${all.length} whole lists seen`)
    for (const part of ['recall', 'precision', 'order', 'names', 'cap', 'archived']) parts.push({ part, score: 0, timed: false, evidence })
  } else {
    const ids = last.rows.map((r) => r.id)
    const unique = new Set(ids)
    evidence.push(`list at ${last.at} on ${page}: ${ids.length} rows ${keyList(ids.map((id) => world.keyOf(id)))}`.trimEnd())
    // Over the rows the list has: a missing row is recall's to lose, not names'.
    const present = check.expect.filter((key) => unique.has(agentIdOf(world.session(key))))
    const right = present.filter((key) => {
      const row = last.rows.find((r) => r.id === agentIdOf(world.session(key)))
      return row!.name === observedTitle(titleOf(world, key, w!.to))
    })
    const misnamed = present.filter((key) => !right.includes(key))
    if (misnamed.length > 0) evidence.push(`names wrong: ${keyList(misnamed)}`)
    const archived = [...archivedBefore(world, w!.to)].filter((key) => unique.has(agentIdOf(world.session(key))))
    if (archived.length > 0) evidence.push(`archived rows: ${keyList(archived)}`)
    const scored: Array<[string, number]> = [
      ['recall', ratio(expected.filter((id) => unique.has(id)).length, expected.length)],
      // A duplicate or an unknown id is an extra row: only one row per expected id is right.
      ['precision', ratio(new Set(ids.filter((id) => expected.includes(id))).size, ids.length)],
      ['order', ratio(expected.filter((id, i) => ids[i] === id).length, expected.length)],
      ['names', ratio(right.length, present.length)],
      ['cap', ids.length <= CAROUSEL_TILES ? 1 : 0],
      ['archived', archived.length === 0 ? 1 : 0],
    ]
    for (const [part, score] of scored) parts.push({ part, score, timed: false, evidence })
  }
  if (check.apart) parts.push(apartPart(check.apart, page, world, w))
  if (check.timed) {
    const lines = changed ? [`first right list at ${changed.at}`]
      : all.length > 0 ? [...evidence, 'no right list in the window'] : []
    parts.push({ part: 'change', score: graded(change, THRESHOLDS.ringChange), timed: true, ms: change, evidence: lines })
  }
  return parts
}

/**
 * The last `apps` frame the dial holds as the window ends, which must show the ring's page as the ring's list must: its
 * other pages count exactly the sessions apart, no fewer (one merged into the ring) and no more (one shown twice). An
 * editor's session apart is counted on its own app's page, as U2's VS Code row is while Cursor's page is shown: one filed
 * under Terminal is not where the person looks for it. A base app's may be on any, as X10's Codex CLI is on its
 * terminal's. Counts name no session, so a check apart from no other is exact.
 */
function apartPart(apart: SessionKey[], page: string, world: World, w: Window | undefined): Part {
  const frame = w ? world.seen.frames.filter((f) => f.message.t === 'apps' && world.held(f.at, w.to)).at(-1) : undefined
  // With no apps frame nothing was counted, so it cannot pass. It says so only to a driver that saw frames.
  if (!frame) return { part: 'apart', score: 0, timed: false, evidence: world.seen.frames.length > 0 ? ['no apps frame'] : [] }
  const shown = typeof frame.message.shown === 'string' ? frame.message.shown : ''
  if (shown !== page) return { part: 'apart', score: 0, timed: false, evidence: [`apps at ${frame.at} on ${shown || 'none'}, not ${page}`] }
  const apps = Array.isArray(frame.message.apps) ? frame.message.apps as Array<{ id?: unknown; count?: unknown }> : []
  const counts = apps.map((a) => ({ id: String(a.id), count: typeof a.count === 'number' ? a.count : 0 }))
  // The ring's own page counts its rows: no session apart is counted there.
  const countedOn = (id: string): number => counts.filter((a) => a.id === id && id !== page).reduce((sum, a) => sum + a.count, 0)
  const ownPage = (key: SessionKey): string => PAGE[world.session(key).app]
  const exact = (EDITORS as readonly string[]).includes(page)
    ? [...new Set([...counts.map((a) => a.id), ...apart.map(ownPage)])]
      .every((id) => countedOn(id) === apart.filter((key) => ownPage(key) === id).length)
    : counts.filter((a) => a.id !== page).reduce((sum, a) => sum + a.count, 0) === apart.length
  return { part: 'apart', score: exact ? 1 : 0, timed: false,
    evidence: [`apps at ${frame.at}: ${counts.map((a) => `${a.id} ${a.count}`).join(', ')}`.trimEnd()] }
}

/**
 * The title a row should carry at `to`: the latest `codex.write` that renamed it before then, else the fixture's. The
 * hooks of Codex and Cursor's agents in an editor carry no title, so their rows are named by the folder the hook sends:
 * a Cursor hook's first root, as notify.mjs sends it, else its cwd.
 */
function titleOf(world: World, key: SessionKey, to: number): string {
  const session = world.session(key)
  if (session.app === 'orca') return orcaTitle(world, session, to)
  const folder = session.app === 'cursor' ? session.folders?.[0] ?? session.cwd : session.cwd
  let title = placeOf(session) !== undefined && engineOf(session) !== 'claude' ? posix.basename(folder) : session.title
  for (const step of world.stepsBefore(to)) {
    if (step.kind === 'codex.write' && step.names && Object.hasOwn(step.names, key)) title = step.names[key]!
  }
  return title
}

/**
 * An Orca row's name at `to` (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decision 13): its tab's rename in the latest
 * layout, else Claude Code's own title, else its tab's title, else its folder's, as Orca lists no worktree but the
 * layout's. Its tab is the panes open there, as both tiers lay them out (orcaListing.ts orcaLayout): a pane opens at its
 * session's start and closes at `orca.close`, its end and Orca's quit; Orca's relaunch opens again those its quit closed.
 */
function orcaTitle(world: World, session: SessionDef, to: number): string {
  let layout: StepOf<'orca.layout'> | undefined
  const open = new Set<SessionKey>()
  let quit: SessionKey[] = []
  for (const step of world.stepsBefore(to)) {
    if (step.kind === 'orca.layout') layout = step
    else if (step.kind === 'hook' && step.event === 'start') open.add(step.session)
    else if (step.kind === 'orca.close' || (step.kind === 'hook' && step.event === 'end')) open.delete(step.session)
    else if (step.kind === 'quit' && step.app === 'orca') {
      quit = [...open]
      open.clear()
    } else if (step.kind === 'relaunch' && step.app === 'orca') {
      for (const key of quit) open.add(key)
      quit = []
    }
  }
  const laid = session.worktree !== undefined && layout?.worktrees.includes(session.worktree) === true
  const tab = laid ? world.scenario.sessions.filter((s) => s.app === 'orca' && s.worktree === session.worktree
    && (s.tab ?? 0) === (session.tab ?? 0) && (s === session || open.has(s.key))).map((s) => ({ key: s.key, title: s.title, split: s.split ?? 0 })) : []
  const renamed = layout?.renamed ?? {}
  if (tab.some((p) => Object.hasOwn(renamed, p.key))) return tabTitle(tab, renamed)
  if (engineOf(session) === 'claude') return session.title
  return laid ? tabTitle(tab, {}) : posix.basename(session.cwd)
}

/** Sessions the latest write before `to` left archived: a later write of the session unarchives it. */
function archivedBefore(world: World, to: number): Set<SessionKey> {
  const archived = new Set<SessionKey>()
  for (const step of world.stepsBefore(to)) {
    if (step.kind === 'claude.write') {
      for (const key of step.sessions) {
        if (step.archived) archived.add(key)
        else archived.delete(key)
      }
    } else if (step.kind === 'codex.write') {
      for (const key of step.sessions) archived.delete(key)
      for (const key of step.archived ?? []) archived.add(key)
    }
  }
  return archived
}

function focusParts(check: CheckOf<'focus'>, world: World, w: Window | undefined): Part[] {
  const id = agentIdOf(world.session(check.session))
  const faces = w ? world.seen.faces.filter((f) => f.at < w.to) : []
  const after = w ? faces.filter((f) => f.at >= w.from) : []
  // The face as the window opens, then each one in it.
  const start = w ? faces.filter((f) => f.at < w.from).at(-1) : undefined
  const evidence = bounded([...(start ? [start] : []), ...after].map((f) => `face at ${f.at}: ${world.keyOf(f.active)}`))
  const last = faces.at(-1)
  // A face on the session as the window opens has landed at its start: what it does from then on is judged.
  const already = start?.active === id
  const landing = already ? 0 : after.findIndex((f) => f.active === id)
  const latency = !w || landing < 0 ? null : already ? 0 : after[landing]!.at - w.from
  const parts: Part[] = [
    { part: 'lands', score: last?.active === id ? 1 : 0, timed: false, evidence },
    { part: 'latency', score: graded(latency, THRESHOLDS.follow), timed: true, ms: latency, evidence },
  ]
  if (check.noBounce) {
    const bounced = landing >= 0 && after.slice(landing).some((f) => f.active !== null && f.active !== id)
    parts.push({ part: 'noBounce', score: landing >= 0 && !bounced ? 1 : 0, timed: false, evidence })
  }
  return parts
}

function stillParts(check: CheckOf<'still'>, world: World, w: Window | undefined): Part[] {
  const faces = w ? world.seen.faces.filter((f) => f.at < w.to) : []
  // A dial whose face was never seen is not shown still: a driver that sees nothing passes nothing.
  if (!w || faces.length === 0) return [{ part: 'still', score: 0, timed: false, evidence: [] }]
  // The window opens on the face before it: one that moves at its first ms moved.
  const start = faces.filter((f) => f.at < w.from).at(-1)
  let was = start?.active ?? null
  // Inclusive of its last ms, as every mark here is, but not of the step that closes the window (`at`): that step's own
  // move is the person's, not the dial's. Moving is leaving a tile, for another or for none: the first landing from no
  // tile, when the ring arrives, is not.
  const moved = faces.filter((f) => f.at >= w.from && f.at <= w.from + check.ms).filter((f) => {
    const left = was !== null && f.active !== was
    was = f.active
    return left
  })
  // The face held, the first seen when none came before the window, then each move.
  const held = start ?? faces[0]!
  const evidence = bounded([held, ...moved].map((f) => `face at ${f.at}: ${world.keyOf(f.active)}`))
  return [{ part: 'still', score: moved.length === 0 ? 1 : 0, timed: false, evidence }]
}

/** Each app's link scheme: the ChatGPT app's threads are Codex's. Orca's rows open by its CLI, with no link. */
const SCHEMES: Readonly<Record<LinkedApp, string>> = { claude: 'claude://', chatgpt: 'codex://', vscode: 'vscode://', cursor: 'cursor://' }

/**
 * The session's own link: the Claude app opens its store's `local_` id, the ChatGPT app the Codex thread, an editor's
 * Claude Code panel its session; an editor's other rows and Orca's have none.
 */
function linkOf(session: SessionDef): string | undefined {
  if (session.app === 'orca') return undefined
  const place = placeOf(session)
  if (place === 'panel') return `${SCHEMES[session.app]}anthropic.claude-code/open?session=${session.id}`
  if (place !== undefined) return undefined
  if (session.app === 'chatgpt') return `${SCHEMES.chatgpt}threads/${session.id}`
  return session.localId && `${SCHEMES.claude}code/continue?session=${session.localId}`
}

/** A command's program, without its folder or `.exe`. */
const programOf = (argv: string[]): string => (argv[0] ?? '').split(/[\\/]/).at(-1)!.replace(/\.exe$/, '')

/**
 * Whether a command brings the session's app to the front (the eval sees commands, not windows), in the form the
 * devices run it on each platform, or tier A records it (tierA/world.ts):
 * - macOS: `open -b <the app's bundle> [<link>]`.
 * - Linux: `xdg-open <the session's link>`, or `raise [<pid>] [<app id>]`, tier A's record of linuxRaise's call. A raise
 *   counts only naming the session's app, by its app id or one of its window classes (frontApp.ts windowClasses): a pid
 *   alone does not, as the eval is told no session's process.
 * - Windows: `harness-pty open-link <the session's link>`, or `harness-pty raise` naming the app, by its bundle (tier
 *   A's record of windowsRaise.app) or by `--exe <its program>` (the helper's own form, windowsRaise.ts), any case.
 */
function fronts(argv: string[], platform: Platform, app: App, link: string | undefined): boolean {
  const exe = programOf(argv)
  const id = PAGE[app]
  const bundle = APP_BUNDLES[id]!
  switch (platform) {
    case 'darwin': return argv.some((a, i) => a === '-b' && argv[i + 1] === bundle)
    case 'linux': return (exe === 'xdg-open' && link !== undefined && argv.includes(link))
      || (exe === 'raise' && argv.slice(1).some((a) => a === id || windowClasses(id).includes(a)))
    case 'win32': {
      const program = WINDOWS_APPS[bundle]!.toLowerCase()
      return exe === 'harness-pty' && ((argv[1] === 'open-link' && link !== undefined && argv[2] === link)
        || (argv[1] === 'raise' && (argv[2] === bundle || (argv[2] === '--exe' && argv[3]?.toLowerCase() === program))))
    }
  }
}

/**
 * Whether a command opens Cursor's window on the folder, as cursorFolder.ts runs it: macOS's `open -b <Cursor> <folder>`,
 * Linux's Cursor CLI on it, Windows' `harness-pty cursor-folder <folder>` (tier A's record of windowsRaise.cursorFolder).
 */
function opensFolder(argv: string[], platform: Platform, folder: string): boolean {
  const exe = programOf(argv)
  switch (platform) {
    case 'darwin': return argv.some((a, i) => a === '-b' && argv[i + 1] === APP_BUNDLES.cursor) && argv.at(-1) === folder
    case 'linux': return exe === 'cursor' && argv.length > 1 && argv.at(-1) === folder
    case 'win32': return exe === 'harness-pty' && argv[1] === 'cursor-folder' && argv[2] === folder
  }
}

type StreamLine = NonNullable<Seen['streams']>[number]
/** An editor window's stream as it stands: whether it ended, and its last state (its index in the lines). */
interface Stream { ended: boolean; state?: { index: number; terminals: unknown[]; active: unknown } }

function apply(streams: Map<string, Stream>, { window, line }: StreamLine, index: number): void {
  const stream = streams.get(window) ?? { ended: false }
  streams.set(window, stream)
  if ('ended' in line) stream.ended = true
  else if (line.type === 'vscode-state') {
    stream.state = { index, terminals: Array.isArray(line.terminals) ? line.terminals : [], active: line.active }
  }
}

/**
 * The stream holding a shell: among those not ended, the one whose last state lists it, the latest state winning, as a
 * terminal moved to another window, or a reload's new stream, is listed there last.
 */
function holder(streams: ReadonlyMap<string, Stream>, key: SessionKey): string | undefined {
  let found: { window: string; index: number } | undefined
  for (const [window, s] of streams) {
    if (!s.ended && s.state?.terminals.includes(key) && (!found || s.state.index > found.index)) found = { window, index: s.state.index }
  }
  return found?.window
}

/**
 * An editor row is graded by its kind (docs/plans/2026-11-22-dial-eval-vscode-cursor-plan.md, Decision 6): a terminal
 * whose shell a stream holds as the window opens on its `show` with `raise` there, and its app brought forward; one with
 * none on VS Code's front or Cursor's folder, its last resort; Cursor's agent on its folder; a panel, as the base apps,
 * on its link and front. An Orca row is graded by orcaOpenParts. A row the dial was never sent scores 0 on every part.
 */
function openParts(check: CheckOf<'open'>, world: World, w: Window | undefined, tier: Tier, platform: Platform): Part[] {
  const session = world.session(check.session)
  const place = placeOf(session)
  const link = linkOf(session)
  const folder = session.app === 'cursor' ? session.folders?.[0] ?? session.cwd : undefined
  const streams = world.seen.streams ?? []
  const opening = new Map<string, Stream>()
  if (w) streams.forEach((l, i) => l.at <= w.from && apply(opening, l, i))
  const holding = place === 'terminal' ? holder(opening, session.key) : undefined
  const shows = w ? streams.filter((l) => l.line.show !== undefined && within(l.at, w)) : []
  const shown = shows.find((l) => l.window === holding && l.line.show === session.key && l.line.raise === true)
  const commands = w ? world.seen.commands.filter((c) => within(c.at, w)) : []
  const linked = commands.filter((c) => link !== undefined && c.argv.includes(link))
  // A command that failed, or that hands an app a link it refuses (world.linkFails), brought nothing up, whatever it
  // names: X5's tap must bring its app up another way.
  const refused = world.scenario.world?.linkFails ?? []
  const brings = (c: Seen['commands'][number]): boolean => c.ok
    && !c.argv.some((arg) => refused.some((app) => arg.startsWith(SCHEMES[app])))
    && fronts(c.argv, platform, session.app, link)
  const front = commands.find(brings)
  const folds = (c: Seen['commands'][number]): boolean => folder !== undefined && c.ok && opensFolder(c.argv, platform, folder)
  const folded = commands.find(folds)
  // The dial's inputs first, so an input that opened nothing fails with what the driver saw. Commands carry paths: the
  // evidence says only what each one was. The inputs are the scenario's own steps, which every driver records: only a
  // window in which the driver saw a command, a frame or a stream line names them, so a recorder that sees nothing
  // catches no probe.
  const heard = commands.length > 0 || (w !== undefined
    && (world.seen.frames.some((f) => within(f.at, w)) || streams.some((l) => within(l.at, w))))
  const inputs = w && heard ? world.seen.steps.filter((s) => within(s.at, w)).flatMap((s) => {
    const step = world.scenario.steps[s.index]!
    return step.kind === 'tap' || step.kind === 'swipe' ? [`${step.kind} on ${step.session} at ${s.at}`] : []
  }) : []
  // A row the dial was never sent cannot be opened from it: another tap bringing the app forward must not pass a probe
  // naming a session never written. Only a window in which the driver heard something says so.
  const id = agentIdOf(session)
  const listed = w !== undefined && world.seen.frames.some((f) => f.at < w.to && f.message.t === 'agent' && f.message.id === id)
  const never = (parts: Part[]): Part[] => {
    const lines = bounded([...(heard ? [`${session.key} never listed`] : []), ...parts[0]!.evidence])
    return parts.map((p) => ({ ...p, score: 0, ...(p.timed ? { ms: null } : {}), evidence: lines }))
  }
  if (session.app === 'orca') {
    const parts = orcaOpenParts(session, world, w, tier, platform, commands, inputs)
    return listed ? parts : never(parts)
  }
  const evidence = bounded([...inputs, ...commands.map((c) => `command at ${c.at}: ${
    [linked.includes(c) && 'link', brings(c) && 'front', folds(c) && 'folder', !c.ok && 'failed'].filter(Boolean).join(' ') || 'other'}`),
  ...shows.map((l) => `show at ${l.at} on ${l.window}: ${world.known(l.line.show)}${l.line.raise === true ? ' raise' : ''}`),
  ...(inputs.length > 0 && commands.length === 0 ? ['no command'] : [])])
  const timing = (at: number | undefined): Part => {
    const latency = at !== undefined && w ? at - w.from : null
    return { part: 'latency', score: graded(latency, THRESHOLDS.open), timed: true, ms: latency, evidence }
  }
  return place !== undefined && !listed ? never(editorParts()) : editorParts()

  function editorParts(): Part[] {
    if (place === 'agent' || (place === 'terminal' && holding === undefined && session.app === 'cursor')) {
      return [{ part: 'folder', score: folded ? 1 : 0, timed: false, evidence }, timing(folded?.at)]
    }
    const fronted = { part: 'front', score: front ? 1 : 0, timed: false, evidence }
    if (holding !== undefined) {
      // The show reached the window holding the shell alone: a show on another window brings up the wrong terminal.
      const alone = shown !== undefined && shows.every((l) => l.window === holding)
      return [{ part: 'show', score: alone ? 1 : 0, timed: false, evidence }, fronted,
        timing(shown && front ? Math.max(shown.at, front.at) : undefined)]
    }
    return [
      ...(check.link ? [{ part: 'link', score: linked.length > 0 ? 1 : 0, timed: false, evidence }] : []),
      fronted,
      timing(front?.at),
    ]
  }
}

/** Whether a command is Orca's CLI running `<group> <verb>`, as `orca`, `orca-ide` or `orca.exe` from any folder. */
const orcaRuns = (argv: string[], group: string, verb: string): boolean =>
  ['orca', 'orca-ide'].includes(programOf(argv)) && argv[1] === group && argv[2] === verb
const flagOf = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at < 0 ? undefined : argv[at + 1]
}

/**
 * An Orca row as the person sees it (docs/plans/2026-11-22-dial-eval-orca-plan.md, Decision 11): the last `worktree
 * activate` before the switch names its worktree, as one must whenever Orca's last layout before the input lists that
 * worktree (none ran passes only when none does), a `terminal switch` to its handle at this launch succeeded, then a tap
 * brings Orca forward, timed, and a rest does not; with no switch no part passes. Tier B on Linux records no raise, so a
 * tap there has no raise part. Evidence says what each command was and, for a switch, whose handle it names.
 */
function orcaOpenParts(session: SessionDef, world: World, w: Window | undefined, tier: Tier, platform: Platform,
  commands: Seen['commands'], inputs: string[]): Part[] {
  // A relaunched Orca lays every pane out on a new handle: the one before it is no session's.
  const launch = w ? world.seen.steps.filter((s) => {
    const step = world.scenario.steps[s.index]!
    return s.at <= w.from && step.kind === 'relaunch' && step.app === 'orca'
  }).length : 0
  const owners = new Map(world.scenario.sessions.filter((s) => s.app === 'orca').map((s) => [orcaPaneHandle(s, launch), s.key]))
  const handle = orcaPaneHandle(session, launch)
  const target = (c: Seen['commands'][number]): string | undefined =>
    orcaRuns(c.argv, 'terminal', 'switch') ? flagOf(c.argv, '--terminal') : undefined
  const raises = (c: Seen['commands'][number]): boolean => c.ok && fronts(c.argv, platform, 'orca', undefined)
  const switched = commands.findIndex((c) => c.ok && target(c) === handle)
  // Tier A's commands are in the order they ran. Tier B's fake Orca notes each run at its own time and the raise at its
  // read (Decision 14), so one at the switch's time counts on either side.
  const before = (i: number, j: number): boolean => i !== j && (tier === 'b' ? commands[i]!.at <= commands[j]!.at : i < j)
  const shown = switched < 0 ? undefined : commands.filter((c, i) => orcaRuns(c.argv, 'worktree', 'activate') && before(i, switched)).at(-1)
  const raised = switched < 0 ? undefined : commands.find((c, i) => raises(c) && before(switched, i))
  const made = w ? world.seen.steps.find((s) => {
    const step = world.scenario.steps[s.index]!
    return within(s.at, w) && (step.kind === 'tap' || step.kind === 'swipe') && step.session === session.key
  }) : undefined
  const input = made && world.scenario.steps[made.index]
  // The product activates the worktree whenever its last read of Orca's layout lists it: the layout as the input was made.
  const layout = w ? world.stepsBefore(made?.at ?? w.from)
    .filter((s): s is StepOf<'orca.layout'> => s.kind === 'orca.layout').at(-1) : undefined
  const laid = session.worktree !== undefined && layout?.worktrees.includes(session.worktree) === true
  const evidence = bounded([...inputs, ...commands.map((c) => {
    const to = target(c)
    const what = to !== undefined ? `switch ${owners.get(to) ?? 'other'}` : orcaRuns(c.argv, 'worktree', 'activate') ? 'worktree'
      : orcaRuns(c.argv, 'terminal', 'send') ? 'send' : raises(c) ? 'front' : undefined
    return `command at ${c.at}: ${[what, !c.ok && 'failed'].filter(Boolean).join(' ') || 'other'}`
  }), ...(inputs.length > 0 && commands.length === 0 ? ['no command'] : []),
  ...(inputs.length > 0 && commands.length > 0 && switched < 0 ? ['no switch'] : [])])
  const activated = shown !== undefined && flagOf(shown.argv, '--worktree') === `id:${orcaWorktreeId(session.worktree ?? '')}`
  // With no switch the pane was never shown: a dead input passes neither its worktree nor a rest's no raise.
  const parts: Part[] = [
    { part: 'worktree', score: switched >= 0 && (activated || (shown === undefined && !laid)) ? 1 : 0, timed: false, evidence },
    { part: 'switch', score: switched < 0 ? 0 : 1, timed: false, evidence },
  ]
  if (input?.kind === 'swipe') parts.push({ part: 'noRaise', score: switched >= 0 && !commands.some(raises) ? 1 : 0, timed: false, evidence })
  else if (tier === 'a' || platform !== 'linux') {
    const latency = raised && w ? raised.at - w.from : null
    parts.push({ part: 'raise', score: raised ? 1 : 0, timed: false, evidence },
      { part: 'latency', score: graded(latency, THRESHOLDS.open), timed: true, ms: latency, evidence })
  }
  return parts
}

/**
 * The carousel as the person sees it from the check's `after` on (Decision 12): it refused no tile, and never held tiles
 * with none on the face. The face held as the window opens is shown from then on, so it counts; no face seen fails.
 */
function faceParts(world: World, w: Window | undefined): Part[] {
  const faces = w ? world.seen.faces.filter((f) => f.at < w.to) : []
  const start = w ? faces.filter((f) => f.at < w.from).at(-1) : undefined
  const judged = [...(start ? [start] : []), ...faces.filter((f) => f.at >= w!.from)]
  if (judged.length === 0) return [{ part: 'face', score: 0, timed: false, evidence: [] }]
  const refused = start?.refused ?? 0
  const wrong = judged.filter((f) => f.refused > refused || (f.tiles.length > 0 && f.active === null))
  const evidence = bounded((wrong.length > 0 ? wrong : [judged.at(-1)!])
    .map((f) => `face at ${f.at}: ${world.keyOf(f.active)}, ${f.tiles.length} tiles, refused ${f.refused}`))
  return [{ part: 'face', score: wrong.length === 0 ? 1 : 0, timed: false, evidence }]
}

/**
 * A stroke reached the session's terminal: the stream holding its shell ran a scroll line for it, as the extension runs
 * one only while its state has that shell active (loop.ts), and no line ran for another shell.
 */
function scrollParts(check: CheckOf<'scroll'>, world: World, w: Window | undefined): Part[] {
  const streams = new Map<string, Stream>()
  const lines: Array<{ at: number; window: string; pid: unknown; ran: boolean; held: boolean }> = []
  ;(world.seen.streams ?? []).forEach((l, i) => {
    if (w && within(l.at, w) && l.line.scroll !== undefined) {
      const stream = streams.get(l.window)
      const ran = stream !== undefined && !stream.ended && stream.state?.active === l.line.pid
      lines.push({ at: l.at, window: l.window, pid: l.line.pid, ran, held: holder(streams, check.session) === l.window })
    }
    apply(streams, l, i)
  })
  const mine = lines.some((l) => l.pid === check.session && l.ran && l.held)
  const other = lines.some((l) => l.pid !== check.session && l.ran)
  const scrolls = lines.map((l) => `scroll at ${l.at} on ${l.window} for ${world.known(l.pid)}: ${l.ran ? 'ran' : 'dropped'}`)
  if (mine && !other) return [{ part: 'ran', score: 1, timed: false, evidence: bounded(scrolls) }]
  // A failure says why, as open does, so a probe on a session never written is caught. Only a window in which the driver
  // saw a frame, a command or a stream line names the strokes, so a recorder that sees nothing catches no probe.
  const heard = w !== undefined && (world.seen.frames.some((f) => within(f.at, w)) || world.seen.commands.some((c) => within(c.at, w))
    || (world.seen.streams ?? []).some((l) => within(l.at, w)))
  if (!heard) return [{ part: 'ran', score: 0, timed: false, evidence: bounded(scrolls) }]
  const id = agentIdOf(world.session(check.session))
  const listed = world.seen.frames.some((f) => f.at < w.to && f.message.t === 'agent' && f.message.id === id)
  const strokes = world.seen.steps.filter((s) => s.kind === 'stroke' && within(s.at, w)).map((s) => `stroke at ${s.at}`)
  return [{ part: 'ran', score: 0, timed: false, evidence: bounded([...(listed ? [] : [`${check.session} never listed`]), ...strokes,
    ...scrolls, ...(mine ? [] : [`no scroll line ran for ${check.session}`])]) }]
}

const SCROLL_TAG = '[device] scroll'
/** What leads a line after its tag: its ` · ` fields and whole words of small letters, as the devices' own words are. */
const PLAIN = /^(?:[ ·]|[a-z]+(?=[ ·]|$))*/

/**
 * A log line from its tag on, as far as its words are the devices' own: the rest, which may hold a path, a session's
 * title or folder, or a pid, is `<…>`.
 */
function bareLog(line: string): string {
  const rest = line.slice(line.indexOf(SCROLL_TAG) + SCROLL_TAG.length)
  const plain = PLAIN.exec(rest)![0]
  return `${SCROLL_TAG}${plain}${plain === rest ? '' : '<…>'}`
}

/** The devices said why a stroke scrolled nothing: SKIPPED_SCROLL and a reason after it. */
function loggedParts(world: World, w: Window | undefined): Part[] {
  const lines = w ? (world.seen.logs ?? []).filter((l) => within(l.at, w) && l.line.includes(SCROLL_TAG)) : []
  const skipped = lines.filter((l) => {
    const at = l.line.indexOf(SKIPPED_SCROLL)
    return at >= 0 && l.line.slice(at + SKIPPED_SCROLL.length).trim() !== ''
  })
  const evidence = bounded((skipped.length > 0 ? skipped : lines).map((l) => `log at ${l.at}: ${bareLog(l.line)}`))
  return [{ part: 'logged', score: skipped.length > 0 ? 1 : 0, timed: false, evidence }]
}

/**
 * The row's state as the device cards set it, as HarnessSource.noteCard reads them; a restored recap is no news. Each
 * question stays up on the dial until its own close or the turn's end, as the devices keep them: a turn card sent while
 * one is open is no news either, and the close of one leaves the others asking. `open`: the row's open questions' ids.
 */
function stateAfter(message: Record<string, unknown>, open: Set<string>): string | undefined {
  const question = String(message.id ?? '')
  switch (message.t) {
    case 'turn.started': return open.size > 0 ? undefined : 'working'
    case 'question':
      open.add(question)
      return 'needs-you'
    // A close heard twice, or of a question never open, is no news.
    case 'question.close': return open.delete(question) && open.size === 0 ? 'working' : undefined
    case 'summary':
    case 'turn.done':
      if (message.restore === true) return undefined
      open.clear()
      return 'done'
    case 'turn.error':
      open.clear()
      return 'error'
  }
  return undefined
}

const STATE_MARKS = { working: THRESHOLDS.working, 'needs-you': THRESHOLDS.needsYou, done: THRESHOLDS.done } as const

function stateParts(check: CheckOf<'state'>, world: World, w: Window | undefined): Part[] {
  const session = world.session(check.session)
  const id = agentIdOf(session)
  const page = PAGE[session.app]
  const lists = rings(world.seen)
  // Every session's changes, not only this one's: the evidence lists those in the window, so a probe on a session that
  // never changes still says what the driver saw.
  const all: Array<{ at: number; agentId: string; state: string }> = []
  const questions = new Map<string, Set<string>>()
  for (const { at, message } of world.seen.frames) {
    if (typeof message.agentId !== 'string') continue
    let open = questions.get(message.agentId)
    if (!open) questions.set(message.agentId, open = new Set())
    const next = stateAfter(message, open)
    if (next !== undefined) all.push({ at, agentId: message.agentId, state: next })
  }
  const changes = all.filter((c) => c.agentId === id)
  // Shown: at some moment in the window the row is in that state and in the last whole list, which is its page's: the
  // dial holds no other, as the ring check reads it. A list from before an unplug since is gone, and one that lands at
  // the moment is held from it on.
  const moments = w ? [w.from, ...changes.map((c) => c.at), ...lists.map((r) => r.at)].filter((at) => within(at, w)).sort((x, y) => x - y) : []
  const shownAt = moments.find((at) => {
    const now = changes.filter((c) => c.at <= at).at(-1)?.state ?? 'idle'
    const ring = lists.filter((r) => r.at <= at).at(-1)
    return now === check.state && ring !== undefined && (ring.at === at || world.held(ring.at, at)) && ring.page === page
      && ring.rows.some((r) => r.id === id)
  })
  const seenChanges = w ? all.filter((c) => within(c.at, w)) : []
  const evidence = bounded(seenChanges.map((c) => `${world.keyOf(c.agentId)} ${c.state} at ${c.at}`))
  if (shownAt !== undefined) evidence.push(`${check.session} shown ${check.state} at ${shownAt}`)
  const parts: Part[] = [{ part: 'shown', score: shownAt === undefined ? 0 : 1, timed: false, evidence }]
  if (check.state !== 'idle') {
    const latency = shownAt === undefined || !w ? null : shownAt - w.from
    parts.push({ part: 'latency', score: graded(latency, STATE_MARKS[check.state]), timed: true, ms: latency, evidence })
  }
  return parts
}

function voiceParts(check: CheckOf<'voice'>, world: World, w: Window | undefined): Part[] {
  const deliveries = w ? world.seen.deliveries.filter((d) => within(d.at, w)) : []
  const mine = deliveries.filter((d) => d.target === check.session && (check.path === undefined || d.path === check.path))
  const exact = mine.length > 0 && mine.every((d) => d.text === check.text)
  // What the dial was told of the voice (a refusal is a voice.error), so a voice that reached nobody says why.
  const told = w ? world.seen.frames.filter((f) => typeof f.message.t === 'string' && f.message.t.startsWith('voice.') && within(f.at, w)) : []
  // Spoken text is never printed: only whether it matched.
  const evidence = bounded([...told.map((f) => `${String(f.message.t)} at ${f.at}`), ...deliveries.map((d) =>
    `delivery at ${d.at} via ${d.path} to ${d.target ?? 'none'}${d.target === check.session ? `, text ${d.text === check.text ? 'exact' : 'differs'}` : ''}`),
  ...(told.length > 0 && deliveries.length === 0 ? ['no delivery'] : [])])
  return [
    { part: 'reached', score: mine.length > 0 ? 1 : 0, timed: false, evidence },
    { part: 'once', score: mine.length === 1 ? 1 : 0, timed: false, evidence },
    { part: 'exact', score: exact ? 1 : 0, timed: false, evidence },
  ]
}

function recapParts(check: CheckOf<'recap'>, world: World, w: Window | undefined): Part[] {
  const id = agentIdOf(world.session(check.session))
  // Every session's summaries in the window, so a probe on a session that never has one still says what was seen.
  const summaries = w ? world.seen.frames.filter((f) => f.message.t === 'summary' && within(f.at, w)) : []
  const last = summaries.filter((f) => f.message.agentId === id).at(-1)
  const exact = last?.message.text === check.text
  // The recap is the session's words: only whether it matched is printed.
  const evidence = bounded(summaries.map((f) => `summary at ${f.at} for ${world.keyOf(typeof f.message.agentId === 'string' ? f.message.agentId : null)}${
    f === last ? `, text ${exact ? 'exact' : 'differs'}` : ''}`))
  return [{ part: 'exact', score: exact ? 1 : 0, timed: false, evidence }]
}

function costParts(seen: Seen): Part[] {
  const cost = seen.cost
  const evidence = cost ? [`cpu ${cost.cpuPercent}%, loop p99 ${cost.loopP99Ms} ms, ${cost.leftovers} processes left`] : []
  return [
    { part: 'cpu', score: graded(cost?.cpuPercent ?? null, THRESHOLDS.cpuPercent), timed: true, evidence },
    { part: 'loopP99', score: graded(cost?.loopP99Ms ?? null, THRESHOLDS.loopP99Ms), timed: true, ms: cost?.loopP99Ms ?? null, evidence },
    { part: 'leftovers', score: cost?.leftovers === 0 ? 1 : 0, timed: false, evidence },
  ]
}

function partsOf(check: Check, scenario: Scenario, seen: Seen, tier: Tier, platform: Platform): Part[] {
  const world = new World(scenario, seen)
  const w = world.window(check)
  switch (check.kind) {
    case 'ring': return ringParts(check, world, w)
    case 'focus': return focusParts(check, world, w)
    case 'still': return stillParts(check, world, w)
    case 'open': return openParts(check, world, w, tier, platform)
    case 'state': return stateParts(check, world, w)
    case 'voice': return voiceParts(check, world, w)
    case 'recap': return recapParts(check, world, w)
    case 'cost': return costParts(seen)
    case 'scroll': return scrollParts(check, world, w)
    case 'logged': return loggedParts(world, w)
    case 'face': return faceParts(world, w)
  }
}

export function evaluate(check: Check, scenario: Scenario, seen: Seen, tier: Tier, platform: Platform): CheckResult[] {
  // Tier A runs in the test process: its cost would be the test runner's, so it has no D8.
  if (check.kind === 'cost' && tier === 'a') return []
  const parts = partsOf(check, scenario, seen, tier, platform)
  const base = { tier, platform, scenario: scenario.id, app: scenario.app, dim: check.dim, heldOut: scenario.heldOut }
  // Robustness asks whether the thing still works, not how fast: one pass/fail result over its untimed parts.
  if (check.dim === 'D7') {
    const untimed = parts.filter((p) => !p.timed)
    const evidence = [...new Set(untimed.flatMap((p) => p.evidence))]
    return [{ ...base, check: check.id, score: untimed.every((p) => p.score === 1) ? 1 : 0, timed: false, evidence }]
  }
  return parts.map((p) => ({ ...base, check: `${check.id}.${p.part}`, score: p.score, timed: p.timed,
    ...(p.ms === undefined ? {} : { ms: p.ms }), evidence: p.evidence }))
}

/**
 * A wait's condition holds once every untimed part of the same check, from the scenario's start, is right; the
 * evidence is what the dial had, for a wait that reaches its limit.
 */
export function condition(until: Until, scenario: Scenario, seen: Seen): { holds: boolean; evidence: string[] } {
  // The id and dim name no result: only the parts are read, from the start.
  const world = new World(scenario, seen)
  const untimed = ringParts({ id: 'until', dim: scenario.dims[0]!, ...until }, world, { from: 0, to: Infinity }).filter((p) => !p.timed)
  return { holds: untimed.length > 0 && untimed.every((p) => p.score === 1), evidence: [...new Set(untimed.flatMap((p) => p.evidence))] }
}

/**
 * Each delivery after a voice step to anyone but that step's target; one with no known target is a wrong-session send too. A
 * delivery is the latest voice step's that spoke its words, as one can land after the next step; words no step spoke are
 * the latest step's.
 */
export function wrongSends(scenario: Scenario, seen: Seen): Array<Omit<WrongSend, 'tier' | 'platform'>> {
  const voices = seen.steps.flatMap((s) => {
    const step = scenario.steps[s.index]!
    return step.kind === 'voice' ? [{ at: s.at, step }] : []
  })
  const wrong: Array<Omit<WrongSend, 'tier' | 'platform'>> = []
  for (const d of seen.deliveries) {
    const before = voices.filter((v) => v.at <= d.at)
    const voice = (before.filter((v) => v.step.transcript === d.text).at(-1) ?? before.at(-1))?.step
    if (voice === undefined || d.target === voice.target) continue
    wrong.push({ scenario: scenario.id, target: voice.target, got: d.target, path: d.path, at: d.at })
  }
  return wrong
}
