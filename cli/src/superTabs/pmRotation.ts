/**
 * A Product Manager that runs low on its Claude account moves to another account its machine's owner ticked, and keeps its
 * conversation (spec 2026-11-06-pm-account-rotation): the same pane relaunches the same session under the new account's folder
 * (`agent_restart` with `claudeHome`, core/agents/restart.ts). This host decides when and where, because it already sees the PM's
 * turn, its screen and every account's quota; the core only carries the move out.
 *
 * Nothing waits only in memory. A PM that is out and waiting for a reset is found again from what the screen and the readings
 * say each tick, so a daemon restarted meanwhile still wakes it when the reset comes.
 */
import type { MessageHold } from '../engines/facets/screen.js'
import { readPmTold, writePmTold, type PmMove } from '../lib/pmAccountPool.js'
import { limitOf, modelFailing, signedOut, WAITING } from './terminal.js'

export interface PmWindow { name: '5-hour' | 'weekly'; leftPercent: number; resetsAt?: string }
/** One of this machine's Claude accounts; `home` is the folder to run under, null for the default account. `reportLabel` is the
 *  folder-based name that is safe to say aloud (claudeProfiles.ts), never an email; `label` may be one. */
export interface PmAccount { id: string; label: string; reportLabel?: string; home: string | null }
export interface PmRow { tabId: string; agent: { id: string; harnessId: string } }
export interface PmNeed { why: 'low' | 'out'; window: '5-hour' | 'weekly'; leftPercent: number }

/** Under this much left in a window, an account is low; at or under it, it is not a place to move to. */
export const LOW_PERCENT = 5
/** A move waits for a turn end, but never starts a second one within this long of the last. */
export const MOVE_COOLDOWN_MS = 2 * 60_000
/** A resume that exits, or shows a limit or error line, within this long went wrong. */
export const RESUME_CHECK_MS = 30_000
/** A new process needs a moment to draw its prompt before `Continue` is typed, and is given up on after the check ends twice over. */
const READY_AFTER_MS = 4_000
const CONTINUE_GIVE_UP_MS = 60_000
const SCREEN_EVERY_MS = 5_000
/** A pick that found nowhere, or an all-out pause, is looked at again after this long (each look reads sign-ins). */
const LOOK_AGAIN_MS = 15_000
const NO_TARGET_RETRY_MS = 30_000
/** An account a resume just failed on is not tried again for this long. */
const AVOID_MS = 30 * 60_000
const MAX_TOLD = 64
/** `Continue` is typed up to this many times, this far apart, until the PM is seen working on it. */
const CONTINUE_TRIES = 3
const CONTINUE_RETRY_MS = 10_000
/** A PM whose turn is unknown this long while low is moved from a waiting prompt, as no turn end will tell. */
const UNKNOWN_MOVE_MS = 10 * 60_000
const SNAPSHOT_LINES = 60
const STALE_GRACE_MS = 2 * RESUME_CHECK_MS
interface Stale { seen: Map<string, number>; at: number }
export const CONTINUE_TEXT = 'Continue'

/** What an account is called aloud and in the log: its folder-based name, never an email. */
const said = (a: PmAccount): string => { const label = a.reportLabel ?? a.label; return label.includes('@') ? 'a Claude account' : label }

/** The non-empty lines at the end of a screen, counted: what was already drawn before a move. */
function snapshot(text: string, now: number): Stale {
  const seen = new Map<string, number>()
  for (const line of text.split('\n').slice(-SNAPSHOT_LINES)) { const t = line.trim(); if (t !== '') seen.set(t, (seen.get(t) ?? 0) + 1) }
  return { seen, at: now }
}

/** The screen without the lines that were there before the move (a resume may draw an old limit line again, a moment after the new
 *  process starts, and keeps it in view); a line that appears more often than it did before still counts once for each extra. The
 *  snapshot is dropped once the screen shows none of its lines, after the resume has had [STALE_GRACE_MS] to draw them. */
function fresh(text: string, stale: Stale | undefined, now: number): { text: string; stale: Stale | undefined } {
  if (!stale) return { text, stale }
  const left = new Map(stale.seen)
  let any = false
  const lines = text.split('\n').map(line => {
    const t = line.trim(), n = left.get(t)
    if (n === undefined || n === 0) return line
    any = true
    left.set(t, n - 1)
    return ''
  })
  return any ? { text: lines.join('\n'), stale } : { text, stale: now - stale.at >= STALE_GRACE_MS ? undefined : stale }
}

/** A window whose reset time has passed is full again, whatever an older reading says. */
const resetPassed = (w: PmWindow, now: number | undefined) => now !== undefined && w.resetsAt !== undefined && Date.parse(w.resetsAt) <= now
const effective = (windows: PmWindow[], now: number | undefined): PmWindow[] => windows.map(w => resetPassed(w, now) ? { ...w, leftPercent: 100 } : w)
const tightest = (windows: PmWindow[]): PmWindow | undefined => windows.reduce<PmWindow | undefined>((a, w) => !a || w.leftPercent < a.leftPercent ? w : a, undefined)

/**
 * Whether the account a PM runs on needs it to move: low when a window has under [LOW_PERCENT] left; out when its screen shows a
 * limit line [limited]. The window named is the tighter one.
 */
export function pmNeedsMove(windows: PmWindow[], now: number, limited = false): PmNeed | null {
  const tight = tightest(effective(windows, now))
  if (limited) return { why: 'out', window: tight?.name ?? '5-hour', leftPercent: tight?.leftPercent ?? 0 }
  return tight && tight.leftPercent < LOW_PERCENT ? { why: 'low', window: tight.name, leftPercent: tight.leftPercent } : null
}

/**
 * The account to move to: among the signed-in ones, not the current, with over [LOW_PERCENT] left in every window read, the one
 * with the most left in its tighter window; on a tie, the one whose weekly window resets soonest. Null when none. An account with
 * no reading says nothing of its quota, so it is not picked.
 */
export function pickPmAccount(candidates: Array<{ id: string; signedIn: boolean; windows: PmWindow[] }>, currentId: string, now?: number): string | null {
  const fit = candidates.flatMap(c => {
    const windows = effective(c.windows, now)
    if (c.id === currentId || !c.signedIn || windows.length === 0 || windows.some(w => w.leftPercent <= LOW_PERCENT)) return []
    const weekly = windows.find(w => w.name === 'weekly')?.resetsAt
    return [{ id: c.id, left: tightest(windows)!.leftPercent, resets: weekly !== undefined && !Number.isNaN(Date.parse(weekly)) ? Date.parse(weekly) : Infinity }]
  })
  fit.sort((a, b) => b.left - a.left || a.resets - b.resets)
  return fit[0]?.id ?? null
}

/** When an account can be used again: once every window at or under the threshold has reset. Infinity when one says no time. */
function freeAt(windows: PmWindow[], now: number): number {
  const blocked = effective(windows, now).filter(w => w.leftPercent <= LOW_PERCENT)
  return blocked.reduce((at, w) => Math.max(at, w.resetsAt === undefined ? Infinity : Date.parse(w.resetsAt)), now)
}

/** The time an owner reads in their Buddy chat, in their own zone. */
export const resetTime = (at: number): string => new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export const movedCopy = (pm: string, to: string, from: string, need: PmNeed, out: boolean): string =>
  `${pm} moved to ${to}: ${out ? `${from} was out of quota.` : `${from} had ${need.leftPercent}% of its ${need.window === 'weekly' ? 'week' : '5-hour window'} left.`} Same conversation.`
export const pausedCopy = (pm: string, at: number, label: string): string =>
  `${pm} is paused: every Claude account it may use is out. The earliest resets at ${resetTime(at)} (${label}).`
export const failedCopy = (pm: string, to: string, from: string): string => `${pm} could not move to ${to} and is back on ${from}.`

export interface PmRotationDeps {
  /** The profile ids the owner ticked (lib/pmAccountPool.ts). */
  pool: () => string[]
  /** This machine's Claude accounts. */
  accounts: () => PmAccount[]
  /** The windows last read for an account here. */
  windows: (id: string) => PmWindow[]
  signedIn: (id: string) => Promise<boolean>
  /** The id of the account a PM runs on now (its registry claudeHome), undefined when it is none of this machine's. */
  current: (harnessId: string) => string | undefined
  name: (harnessId: string) => string
  /** The PM's visible screen, null when it could not be read. */
  screen: (harnessId: string) => Promise<{ text: string; hold: MessageHold | null } | null>
  turn: (harnessId: string) => Promise<'busy' | 'idle' | 'unknown'>
  /** Whether the PM's process is still there. */
  alive: (harnessId: string) => boolean
  restart: (harnessId: string, claudeHome: string | null) => Promise<{ ok: true } | { ok: false; error: string }>
  /** Types one line and Enter into the PM, false when it could not. */
  type: (harnessId: string, text: string) => Promise<boolean>
  /** One line from the PM to the machine's owner, in their Buddy chat (person.tell). */
  tell: (row: PmRow, text: string) => Promise<void>
  record: (move: PmMove) => void
  /** Whether another restart of this PM is in progress (a person's own): a process that goes away meanwhile is not a failed resume. */
  restarting?: (harnessId: string) => boolean
  /** The reset windows already told to the owner for a PM, kept across a daemon restart (lib/pmAccountPool.ts when not given). */
  told?: { read: (harnessId: string) => string[]; write: (harnessId: string, keys: string[]) => void }
  now: () => number
  log: (message: string) => void
}

/** What a move that just happened still owes: a check that it took, and `Continue` when an interrupted turn waits. */
interface After { from: PmAccount | undefined; to: PmAccount; at: number; owesContinue: boolean; tries: number; typedAt: number; confirmed: boolean; fallback: boolean }
interface State {
  running: boolean
  lastMoveAt: number
  retryAt: number
  screenAt: number
  limit: { resetAt?: string } | null
  /** When the limit on screen first said it ends: later readings of "resets 6pm" slide to the next day. */
  limitReset?: number
  /** Lines drawn before the last move, which a redraw must not count as new. */
  stale?: Stale
  waiting: boolean
  unknownSince?: number
  outSince?: number
  paused: boolean
  told: string[]
  avoid: Map<string, number>
  after?: After
}

export class PmRotation {
  private readonly states = new Map<string, State>()
  private readonly told: NonNullable<PmRotationDeps['told']>
  constructor(private readonly deps: PmRotationDeps) { this.told = deps.told ?? { read: readPmTold, write: writePmTold } }

  /** Each roster tick for a Claude PM running here; one pass at a time per PM. */
  async serve(row: PmRow, now: number): Promise<void> {
    const id = row.agent.harnessId
    let state = this.states.get(id)
    if (!state) this.states.set(id, state = { running: false, lastMoveAt: -Infinity, retryAt: 0, screenAt: -Infinity, limit: null, waiting: false, paused: false, told: this.told.read(id), avoid: new Map() })
    if (state.running) return
    state.running = true
    try { await this.step(row, state, now) } catch (error) {
      this.deps.log(`PM account rotation: ${error instanceof Error ? error.message : String(error)}`)
    } finally { state.running = false }
  }

  /** Forgets PMs that are gone. */
  keep(harnessIds: ReadonlySet<string>): void {
    for (const id of this.states.keys()) if (!harnessIds.has(id)) this.states.delete(id)
  }

  private async step(row: PmRow, state: State, now: number): Promise<void> {
    const h = row.agent.harnessId
    const accounts = this.deps.accounts()
    if (state.after) {
      await this.follow(row, state, state.after, now)
      if (state.after) return
    }
    const ticked = this.deps.pool().filter(id => accounts.some(a => a.id === id))
    // Fewer than two accounts: nothing to move between.
    if (ticked.length < 2) { state.outSince = undefined; state.paused = false; state.unknownSince = undefined; return }
    const current = accounts.find(a => a.id === this.deps.current(h))
    const windows = current ? this.deps.windows(current.id) : []
    if (now - state.screenAt >= SCREEN_EVERY_MS) {
      state.screenAt = now
      const read = await this.deps.screen(h)
      if (read) {
        const seen = fresh(read.text, state.stale, now)
        state.stale = seen.stale
        state.limit = limitOf(seen.text, now)
        state.waiting = read.hold !== null && WAITING.has(read.hold)
      }
    }
    if (!state.limit) state.limitReset = undefined
    else if (state.limitReset === undefined) state.limitReset = state.limit.resetAt === undefined ? Infinity : Date.parse(state.limit.resetAt)
    const need = pmNeedsMove(windows, now, state.limit !== null)
    if (!need) { state.outSince = undefined; state.paused = false; state.unknownSince = undefined; return }
    if (state.limit) state.outSince ??= now
    if (now - state.lastMoveAt < MOVE_COOLDOWN_MS || now < state.retryAt) return
    // A low account waits for a turn end, so no turn is cut off; an out one has nothing running to cut.
    if (!state.limit && !await this.turnEnded(h, state, now)) return
    for (const [id, until] of state.avoid) if (until <= now) state.avoid.delete(id)
    const candidates = await Promise.all(ticked.filter(id => !state.avoid.has(id)).map(async id => ({ id, signedIn: await this.deps.signedIn(id), windows: this.deps.windows(id) })))
    const to = pickPmAccount(candidates, current?.id ?? '', now)
    if (to === null) {
      if (!state.limit) { state.retryAt = now + NO_TARGET_RETRY_MS; return }
      return this.allOut(row, state, current, windows, ticked, accounts, now)
    }
    const target = accounts.find(a => a.id === to)!
    const reset = state.paused || this.deps.windows(to).some(w => w.leftPercent <= LOW_PERCENT && resetPassed(w, now))
    await this.move(row, state, current, target, need, state.limit ? (reset ? 'reset' : 'out') : 'low', now)
  }

  /** Whether a low PM may be moved now: its turn is over, or its turn state has said nothing for [UNKNOWN_MOVE_MS] and its screen waits
   *  at a prompt, where no turn end is coming. A busy PM moves at its first turn end, however long it has been busy. */
  private async turnEnded(h: string, state: State, now: number): Promise<boolean> {
    const turn = await this.deps.turn(h)
    if (turn !== 'unknown') { state.unknownSince = undefined; return turn === 'idle' }
    state.unknownSince ??= now
    return now - state.unknownSince >= UNKNOWN_MOVE_MS && state.waiting
  }

  /** Every ticked account is out: the owner is told once per reset window, and the earliest reset wakes the PM, from the readings. */
  private async allOut(row: PmRow, state: State, current: PmAccount | undefined, windows: PmWindow[], ticked: string[], accounts: PmAccount[], now: number): Promise<void> {
    const h = row.agent.harnessId
    state.retryAt = now + LOOK_AGAIN_MS
    // Its own account came back with a reset (a reading older than the reset says so): nothing to move, only to continue.
    // Or the screen's own reset time has passed: a fresh reading of 100% only agrees.
    const ownReset = state.limitReset !== undefined && state.limitReset <= now
    if (current && (ownReset || windows.some(w => w.leftPercent <= LOW_PERCENT && resetPassed(w, now)) && freeAt(windows, now) <= now)) {
      state.limit = null
      state.limitReset = undefined
      state.outSince = undefined
      state.paused = false
      state.lastMoveAt = now
      state.after = { from: current, to: current, at: now, owesContinue: true, tries: 0, typedAt: -Infinity, confirmed: false, fallback: true }
      this.deps.log(`PM ${h.slice(0, 8)} continues on ${said(current)}: its limit reset.`)
      return
    }
    let wake = Infinity, label = ''
    for (const id of ticked) {
      const at = freeAt(this.deps.windows(id), now)
      if (at < wake && this.deps.windows(id).length > 0) { wake = at; label = said(accounts.find(a => a.id === id)!) }
    }
    // The screen's own reset time stands in for its account's when no reading says one.
    const own = state.limit?.resetAt === undefined ? Infinity : Date.parse(state.limit.resetAt)
    if (current && windows.length === 0 && own < wake) { wake = own; label = said(current) }
    state.paused = true
    if (!Number.isFinite(wake)) return
    const key = String(Math.floor(wake / 60_000))
    if (state.told.includes(key)) return
    state.told = [...state.told, key].slice(-MAX_TOLD)
    await this.tellOwner(row, pausedCopy(this.deps.name(h), wake, label))
    this.told.write(h, state.told)
  }

  /** A line to the owner that fails is logged and never held against the move it reports. */
  private async tellOwner(row: PmRow, text: string): Promise<void> {
    await this.deps.tell(row, text).catch(error => this.deps.log(`PM account rotation: could not tell the owner: ${error instanceof Error ? error.message : String(error)}`))
  }

  private async move(row: PmRow, state: State, from: PmAccount | undefined, to: PmAccount, need: PmNeed, why: 'low' | 'out' | 'reset', now: number): Promise<void> {
    const h = row.agent.harnessId
    const before = await this.deps.screen(h)
    const began = this.deps.now()
    const result = await this.deps.restart(h, to.home).catch(() => ({ ok: false as const, error: 'RESTART_FAILED' }))
    if (!result.ok) {
      // A failure may follow the old process stopping. The core attempts recovery, but its refusal alone cannot
      // promise the PM is running; tell the owner without claiming a successful move or rollback.
      this.deps.log(`PM ${h.slice(0, 8)} could not move to ${said(to)}: ${result.error}.`)
      state.retryAt = now + MOVE_COOLDOWN_MS
      state.avoid.set(to.id, now + AVOID_MS)
      this.deps.record({ at: now, pm: this.deps.name(h), from: from?.id ?? '', to: to.id, why, ok: false })
      await this.tellOwner(row, `${this.deps.name(h)} could not move to ${said(to)}. Check its pane before continuing.`)
      return
    }
    const done = this.deps.now()
    const pm = this.deps.name(h)
    state.lastMoveAt = now
    // An out PM was away since its limit showed, a low one only while it relaunched.
    const away = done - (state.outSince ?? began)
    state.limit = null
    state.limitReset = undefined
    state.outSince = undefined
    state.paused = false
    state.screenAt = now
    state.stale = before ? snapshot(before.text, now) : undefined
    state.after = { from, to, at: now, owesContinue: why !== 'low', tries: 0, typedAt: -Infinity, confirmed: false, fallback: false }
    this.deps.record({ at: now, pm, from: from?.id ?? '', to: to.id, why, ...(why === 'low' ? { window: need.window, leftPercent: need.leftPercent } : {}), awayMs: away, ok: true })
    this.deps.log(`PM ${h.slice(0, 8)} moved to ${said(to)} (${why}).`)
    await this.tellOwner(row, movedCopy(pm, said(to), from ? said(from) : 'its account', need, why !== 'low'))
  }

  /** After a move: a resume that went wrong within [RESUME_CHECK_MS] goes back once; `Continue` is typed once the new process is ready
   *  and idle, and counted only when the PM is then seen working. Only lines new since the move can say it went wrong. */
  private async follow(row: PmRow, state: State, after: After, now: number): Promise<void> {
    const h = row.agent.harnessId
    const age = now - after.at
    const raw = await this.deps.screen(h)
    let read = raw
    if (raw) {
      const seen = fresh(raw.text, state.stale, now)
      state.stale = seen.stale
      read = { ...raw, text: seen.text }
    }
    if (!after.fallback && age < RESUME_CHECK_MS && !this.deps.restarting?.(h) && (!this.deps.alive(h) || (read && (limitOf(read.text, now) || signedOut(read.text) || modelFailing(read.text))))) {
      return this.fallBack(row, state, after, now, raw)
    }
    if (after.owesContinue && !after.confirmed && age < CONTINUE_GIVE_UP_MS) await this.continueOn(h, after, read, age, now)
    const gaveUp = after.tries >= CONTINUE_TRIES && now - after.typedAt >= CONTINUE_RETRY_MS
    const settled = !after.owesContinue || after.confirmed || gaveUp || age >= CONTINUE_GIVE_UP_MS
    if (age >= RESUME_CHECK_MS && settled) state.after = undefined
  }

  private async continueOn(h: string, after: After, read: { text: string; hold: MessageHold | null } | null, age: number, now: number): Promise<void> {
    const turn = await this.deps.turn(h)
    // The PM went to work after a `Continue`: it took.
    if (after.tries > 0 && turn === 'busy') { after.confirmed = true; return }
    if (age < READY_AFTER_MS || after.tries >= CONTINUE_TRIES || now - after.typedAt < CONTINUE_RETRY_MS) return
    // Typing Enter on a prompt or a menu would answer it: it waits until the screen has none and the turn is idle (limitResume.ts).
    if (turn !== 'idle' || !read || read.text.trim() === '' || (read.hold !== null && WAITING.has(read.hold))) return
    after.tries++
    after.typedAt = now
    await this.deps.type(h, CONTINUE_TEXT)
  }

  /** Back to the previous account, once: the account that failed is not tried again for a while, so there is no loop. */
  private async fallBack(row: PmRow, state: State, after: After, now: number, screen: { text: string } | null): Promise<void> {
    const h = row.agent.harnessId
    const pm = this.deps.name(h)
    state.after = undefined
    // The failed account's lines are on screen, and a resume back may draw them again.
    state.stale = screen ? snapshot(screen.text, now) : undefined
    state.avoid.set(after.to.id, now + AVOID_MS)
    state.lastMoveAt = now
    const back = after.from
    if (!back) {
      this.deps.log(`PM ${h.slice(0, 8)}: the move to ${said(after.to)} failed and its first account is unknown.`)
      await this.tellOwner(row, `${pm} could not recover after its move to ${said(after.to)} failed. Check its pane before continuing.`)
      return
    }
    const result = await this.deps.restart(h, back.home).catch(() => ({ ok: false as const, error: 'RESTART_FAILED' }))
    this.deps.record({ at: now, pm, from: after.to.id, to: back.id, why: 'fallback', ok: result.ok })
    if (!result.ok) this.deps.log(`PM ${h.slice(0, 8)} could not go back to ${said(back)}: ${result.error}.`)
    await this.tellOwner(row, result.ok ? failedCopy(pm, said(after.to), said(back))
      : `${pm} could not move back to ${said(back)} after its move to ${said(after.to)} failed. Check its pane before continuing.`)
  }
}
