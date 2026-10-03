/**
 * The zoo document and the operations that change it — pure, so the rules and the draw can be tested
 * without a database (daemons/README.md, "The zoo (server contract)", "First egg: habits" and "Earning
 * eggs and growing").
 *
 * The same ONE RULE as the desk (lib/desk.ts): every op is idempotent and an op on something that is
 * not there is dropped, never an error. A client that was offline replays its queue against a zoo that
 * moved and every op still means what it meant: a hatch of an egg already hatched lands on nothing, a
 * habit already counted counts once, a batch of turns already counted (its `batchId`) counts once.
 *
 * The draw happens here and only here. Clients never send a result; `rng` is injected so tests are
 * deterministic, and is `crypto.randomInt` in production. Eggs earned from work are granted here too:
 * a client reports turns, never eggs.
 *
 * A zoo holds INDIVIDUALS (daemons/README.md, "Individuals"): every hatch is its own, with a server-made
 * `uid`, a `seed` its traits follow from (never stored as truth: lib/zooTraits.ts), and a serial. A
 * species hatched again is one more individual, never a merge. Ops name an individual by its uid.
 */
import { createHash, randomInt } from 'node:crypto'
import { z } from 'zod'
import { DAEMON_ROSTER } from './daemonRoster.g.js'

export const ZOO_MAX_EGGS = 12
/** Individuals one zoo holds. Full, a hatch is dropped and its egg waits in the nest (earned eggs are
 *  then held, and past 64 held become xp, as for a full nest). */
export const ZOO_MAX_DAEMONS = 256
export const ZOO_NAME_MAX = 24
/** The highest seed; a hatch draws one from 1 to this. 0 is the species' default traits (an individual
 *  from before individuals, or a guest's). */
export const ZOO_SEED_MAX = 4_294_967_295
/** An account's first hatches are always a species it does not own (when the egg can give one). */
export const ZOO_FIRST_NEW = 4
/** After this many hatches in a row with no new species, the next is a new one (while an unowned released
 *  regular exists). */
export const ZOO_NEW_AFTER = 8
/** Far past anything a real account reaches (it resets on every secret); a bound keeps the draw's
 *  integer weights inside `randomInt`'s range whatever a stored document says. */
export const ZOO_MAX_PITY = 1_000_000
/** Eggs earned while the nest is full wait here, oldest first. 64 turn eggs is months at the daily cap;
 *  past that each further egg is `rules.overflowXp` for the paired daemon instead. */
export const ZOO_MAX_HELD = 64
/** How many `zoo.turn` batch ids are remembered to drop a replay. A reporter retries within minutes. */
export const ZOO_BATCH_MEMORY = 64
/** How many `zoo.lesson` ids are remembered, so a lesson credits its daemon once. A harnessd retries
 *  within minutes; 256 is months of lessons at one proposal an hour. */
export const ZOO_LESSON_MEMORY = 256
/** The most turns one `zoo.turn` may report (a reporter batches a minute; the daily cap is far lower). */
export const ZOO_TURN_MAX_N = 50
/** The most agent-minutes one `zoo.turn` may report: a day for each of its turns (harnessd counts at most
 *  a day for one turn). The daily cap bounds what they earn long before this. */
export const ZOO_TURN_MAX_MINUTES = ZOO_TURN_MAX_N * 24 * 60
/** How many duplicates an old record remembered (read, then dropped: see `parseZoo`). */
const LEGACY_MAX_DUPES = 1_000_000
/** The highest serial a daemon may carry. */
const ZOO_MAX_SERIAL = 1_000_000_000
/** A report may be this many days later than the latest local day on Earth still allows (a retry after
 *  an offline stretch); anything older, or a day that has not started anywhere yet, is dropped. */
export const ZOO_TURN_LATE_DAYS = 1
const ZOO_MAX_TURNS = 1_000_000_000
const ZOO_MAX_XP = 1_000_000_000
/** Days of per-day counts kept: two ISO weeks, so a week is always whole. */
const DAY_MEMORY = 14
const WEEK_MEMORY = 8
const HISTORY_MEMORY = 16
const DAY_MS = 86_400_000

/** A uniform integer in [0, n). */
export type Rng = (n: number) => number
export const cryptoRng: Rng = (n) => randomInt(n)

// ── What the roster says ─────────────────────────────────────────────────────────────────────────
interface EggRule { weights: Readonly<Record<string, number>>; boost?: Readonly<Record<string, number>> }
interface RosterDaemon { id: string; n: number; drop: string; rarity: string }
/** A drop is announced (shown as silhouettes on shelves) before it is released (drawn from). A drop on
 *  hold is kept in the roster without dates: never announced, never drawn. */
interface RosterDrop { id: string; announce?: string; release?: string; hold?: boolean }

const RULES = DAEMON_ROSTER.rules
const EGG_RULES: Readonly<Record<string, EggRule>> = RULES.eggs
/** The rule for an egg kind — own keys only, so a kind spelled `constructor` is simply unknown. */
const eggRule = (kind: string): EggRule | undefined => Object.hasOwn(EGG_RULES, kind) ? EGG_RULES[kind] : undefined
/** Only an egg with a secret weight can hold a secret, and only its hatches count toward the pity. */
const holdsSecret = (kind: string): boolean => (eggRule(kind)?.weights.secret ?? 0) > 0
const ROSTER_DAEMONS: readonly RosterDaemon[] = DAEMON_ROSTER.daemons
const DROPS: readonly RosterDrop[] = DAEMON_ROSTER.drops
const ROSTER_IDS: ReadonlySet<string> = new Set(ROSTER_DAEMONS.map((d) => d.id))
const HABIT_KEYS: ReadonlySet<string> = new Set<string>(RULES.firstEgg.habits)
/** Habits the first egg cannot come without (a finished turn). */
const FIRST_REQUIRES: readonly string[] = RULES.firstEgg.require
const EASTER_HASHES: ReadonlySet<string> = new Set<string>(RULES.easterHashes)
const VERSIONS: readonly string[] = RULES.versions
const FIRST_VERSION = VERSIONS[0]
const EARN = RULES.earn
const BOND_LEVELS: readonly number[] = RULES.bond.levels
const BOND_FOR_VERSION: Readonly<Record<string, number>> = RULES.bondForVersion
/** MM-DD → the daemon that date's history egg gives once a drop holds it, or null. */
const HISTORY_DATES: Readonly<Record<string, string | null>> = RULES.historyDates
/** Why a marathon egg was earned; each earns one, once. */
const MARATHON_REASONS = ['turns', 'machines'] as const

/**
 * Whether a drop is out at `now`: its `release` day (UTC) has begun. Only released drops hatch; a drop
 * that is announced but not yet released is the shelves' silhouettes, never a draw.
 */
export function dropReleased(drop: RosterDrop, now: Date): boolean {
  if (drop.hold || !drop.release) return false
  return Date.parse(`${drop.release}T00:00:00.000Z`) <= now.getTime()
}

/** Every daemon a draw may give at `now`: the released drops, in roster order. */
export function releasedDaemons(now: Date): RosterDaemon[] {
  const out = new Set(DROPS.filter((d) => dropReleased(d, now)).map((d) => d.id))
  return ROSTER_DAEMONS.filter((d) => out.has(d.drop))
}

/** The sha256 (hex) of an easter word as `zoo.easter` sends it, trimmed and lowercased. The roster lists
 *  only these, so the words themselves never ship to a client. */
export function easterHash(word: string): string {
  return createHash('sha256').update(word.trim().toLowerCase()).digest('hex')
}
const HASH_RE = /^[0-9a-f]{64}$/

// ── Days, weeks and levels ───────────────────────────────────────────────────────────────────────
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A local calendar day, `YYYY-MM-DD`, that exists (no 02-30), in years 2000–2999. */
export function isLocalDay(s: string): boolean {
  const m = DAY_RE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2999) return false
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** Days since 1970-01-01 of a calendar day — arithmetic on dates, no time zone involved. */
const dayNumber = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY_MS
}
const dayOf = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10)

/**
 * The night a turn finishing at local `hour` of `day` belongs to, named by the day it began, or null
 * outside the night hours. Night hours may run past midnight (22:00 to 06:59): a turn at 02:00 on the
 * 22nd belongs to the night of the 21st, like one at 23:00 on the 21st.
 */
export function nightOf(day: string, hour: number): string | null {
  const { fromHour, toHour } = EARN.night
  if (fromHour <= toHour) return hour >= fromHour && hour <= toHour ? day : null
  if (hour >= fromHour) return day
  return hour <= toHour ? dayOf(dayNumber(day) - 1) : null
}

/**
 * The history dates whose egg is open on `day`: each `MM-DD` of `rules.historyDates`, in the year its
 * week began, when `day` falls within `earn.history.days` of it (so 12-30 is open until 01-05). A date is
 * named with its year: one egg per date per year.
 */
export function historyDatesOpen(day: string): string[] {
  const at = dayNumber(day)
  const year = Number(day.slice(0, 4))
  const open: string[] = []
  for (const mmdd of Object.keys(HISTORY_DATES)) {
    for (const y of [year - 1, year]) {
      const date = `${y}-${mmdd}`
      if (!isLocalDay(date)) continue                                    // 02-29 in a year without one
      const since = at - dayNumber(date)
      if (since >= 0 && since < EARN.history.days) open.push(date)
    }
  }
  return open.sort()
}

/** The ISO 8601 week a calendar day belongs to, `YYYY-Www` (weeks start on Monday; week 1 holds the
 *  year's first Thursday, so 2027-01-01 is in 2026-W53 and 2024-12-30 is in 2025-W01). */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))          // the Thursday of that week
  const year = t.getUTCFullYear()
  const week = Math.floor((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Bond level for `xp`: the highest threshold of `rules.bond.levels` reached. */
export function levelFor(xp: number): number {
  let level = 0
  for (const [i, at] of BOND_LEVELS.entries()) if (xp >= at) level = i
  return level
}

/** The version a bond level has grown into (`rules.bondForVersion`). */
export function versionFor(level: number): string {
  let version = FIRST_VERSION
  for (const v of VERSIONS) if (level >= BOND_FOR_VERSION[v]) version = v
  return version
}

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────
/** A roster id's shape (the same rule daemons/tools/generate.mjs holds the roster to). */
const daemonId = z.string().regex(/^[a-z][a-z0-9-]{0,15}$/)
/** An egg id, a habit key, an egg kind, an easter word, a batch or machine id: short and id-safe. */
const key = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const isoTime = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'not a time')
const localDay = z.string().max(10).refine(isLocalDay, 'not a YYYY-MM-DD day')
/** 1–24 printable ASCII once trimmed: what a status line and a card can draw on every terminal. */
export const zooNameSchema = z.string().trim().regex(/^[\x20-\x7e]{1,24}$/, 'a name must be 1-24 printable ASCII characters')
/** An individual's id: 24 lowercase hex, made by the server (random at a hatch, derived for an old record). */
export const zooUidSchema = z.string().regex(/^[0-9a-f]{24}$/, 'a uid is 24 lowercase hex characters')
const bond = z.number().int().min(0).max(1_000_000)
const version = z.string().refine((v) => VERSIONS.includes(v), 'unknown version')
/** Its mint number: the nth of its species the server hatched (`DaemonMint`). */
const serial = z.number().int().min(1).max(ZOO_MAX_SERIAL)
/** `local`: hatched in a guest's zoo on a client, brought in by `zoo.seed`; it has no serial. */
const origin = z.literal('local')

/** One individual as stored and served. */
export const zooDaemonSchema = z.object({
  uid: zooUidSchema,
  /** Its species: a roster id. */
  id: daemonId,
  /** What its traits follow from (lib/zooTraits.ts `rollTraits`). 0: the species' default traits. */
  seed: z.number().int().min(0).max(ZOO_SEED_MAX),
  /** Absent on a guest's individual and on one hatched before serials. */
  serial: serial.optional(),
  /** The name the person gave it (at the hatch, or later). */
  name: zooNameSchema.optional(),
  shiny: z.boolean(),
  xp: z.number().int().min(0).max(ZOO_MAX_XP),
  bond,
  version,
  /** When it hatched. */
  hatched: isoTime,
  /** The kind of egg it came from. */
  egg: key,
  origin: origin.optional(),
}).strict()

/**
 * A daemon as stored before individuals: one record per species, a duplicate merged into it (`dupes`).
 * Read as one individual per record (see `parseZoo`); never written again.
 */
const legacyDaemonSchema = z.object({
  id: daemonId,
  hatchedAt: isoTime,
  egg: key,
  shiny: z.boolean(),
  nickname: zooNameSchema.optional(),
  bond,
  /** Absent on a daemon stored before xp existed; read as the least xp its bond needs. */
  xp: z.number().int().min(0).max(ZOO_MAX_XP).optional(),
  version,
  dupes: z.number().int().min(1).max(LEGACY_MAX_DUPES).optional(),
  serial: serial.optional(),
  origin: origin.optional(),
}).strict()
/** `date` is the history date a history egg remembers (`YYYY-MM-DD`, the year its week began); its MM-DD
 *  picks the daemon it leans toward. */
export const zooEggSchema = z.object({
  id: key, kind: key, grantedAt: isoTime, date: localDay.optional(),
  /** `local`: an egg a guest's zoo earned on a client, brought in by `zoo.seed` (self-reported). */
  origin: z.literal('local').optional(),
}).strict()

export type ZooDaemon = z.infer<typeof zooDaemonSchema>
export type ZooEgg = z.infer<typeof zooEggSchema>
/** An egg earned while the nest was full, waiting for room. */
export interface ZooHeld { kind: string; date?: string }
/**
 * What counts toward the eggs earned from work (README, "Earning eggs and growing"). Server-written:
 * clients read it to show how close the next egg is and never send it (except a guest's, once, in
 * `zoo.seed`).
 */
export interface ZooProgress {
  /** Counted turns, all time (after the daily cap): each turn once, plus one per `earn.turn.minutesPerTurn`
   *  agent-minutes. A turn egg every `earn.turn.every`. */
  turns: number
  /** Counted turns per local day, the last two weeks. The daily cap and the week egg read this. */
  days: Record<string, number>
  /** ISO weeks whose week egg was earned, the last few. */
  weeks: string[]
  /** Nights (named by the local day they began) with a counted turn that finished while the person was
   *  away, since the last night egg. */
  nights: string[]
  /** The first machines turns were reported from (up to `earn.marathon.machines`). */
  machines: string[]
  /** Marathon eggs earned, by reason: `turns`, `machines`. */
  marathon: string[]
  /** History dates (`YYYY-MM-DD`, the year each week began) whose egg was earned, the last few. */
  history: string[]
  /** Eggs earned while the nest was full, oldest first. */
  held: ZooHeld[]
  /** The last `zoo.turn` batch ids applied. */
  batches: string[]
  /** The last `zoo.lesson` ids credited: a lesson grows its daemon once, however often it is reported. */
  lessons: string[]
}
/**
 * How much the paired daemon may do on its own (daemons/BRAIN.md, "Autonomy dial"), read by every
 * harnessd's pair brain: `watch` (the default) only reads and tells; `suggest` proposes, and every action
 * waits for a key; `act-on-key` drives harnesses it started, each other action behind its own key;
 * `act-within-rules` also runs the person's `pair.jsonc` rules on the machine that owns a harness. The
 * zoo's level is a request: each harnessd acts above `suggest` only after the person confirms it there.
 */
export const ZOO_AUTONOMY_LEVELS = ['watch', 'suggest', 'act-on-key', 'act-within-rules'] as const
export type ZooAutonomy = typeof ZOO_AUTONOMY_LEVELS[number]
export const ZOO_DEFAULT_AUTONOMY: ZooAutonomy = 'watch'

/**
 * The person's first-day consent to their daemon watching (daemons/README.md, "What your daemon sees"):
 * until `watching` is true no harnessd senses anything. Set only by `zoo.consent`, from a window's consent
 * screen; never seeded.
 */
export interface ZooConsent { watching: boolean; at: string }
const isAutonomy = (value: unknown): value is ZooAutonomy =>
  typeof value === 'string' && (ZOO_AUTONOMY_LEVELS as readonly string[]).includes(value)

export interface Zoo {
  /** Every individual, in the order they hatched. */
  daemons: ZooDaemon[]
  eggs: ZooEgg[]
  /** The uid of the paired individual, or null. */
  paired: string | null
  /** The autonomy dial. Account state like the pair, so every machine's brain reads the same level. */
  autonomy: ZooAutonomy
  /** Whether the person agreed to their daemon watching, and when (null: never asked yet). */
  consent: ZooConsent | null
  habits: string[]
  firstEgg: boolean
  /** The setup egg (the second habit egg, at `rules.setupEgg.need` habits) has been granted. */
  setupEgg: boolean
  /** Hatches of eggs that can hold a secret since the last secret. */
  pity: number
  /** Hatches in a row that gave a species already owned: at `ZOO_NEW_AFTER` the next is a new one. */
  sinceNew: number
  /** sha256 of each easter word already used. */
  easter: string[]
  progress: ZooProgress
}
export interface ZooDoc { revision: number; zoo: Zoo }
/**
 * What one hatch gave: the new individual as it hatched, with the egg it came from and its species again
 * as `daemonId`. `serial` is its mint number, set by the route (routes/zoo.ts).
 */
export type Hatched = ZooDaemon & { eggId: string; daemonId: string }
/** An egg that arrived in the nest during this request (earned now, or held until there was room): its
 *  `eggId`. Or one earned with 64 already held, which became `xp` for the paired daemon instead. */
export interface Grant { kind: string; eggId?: string; xp?: number }
/** An individual whose bond reached a new level during this request (`id` its species), and the version
 *  it is now. */
export interface LevelUp { uid: string; id: string; level: number; version: string }

/**
 * What a client DRAWS from the zoo, as one comparable string: every individual (its level and version,
 * never its xp alone), the eggs, the pair, the dial, consent, the habits and the first and setup eggs. The
 * route publishes `zoo_changed` only when this moved (routes/zoo.ts): a `zoo.turn` or `zoo.lesson` that
 * only tallied — progress, batch ids, xp short of a level — reaches clients on their next natural read,
 * instead of pulling every daemon, window and phone back to `GET /api/zoo` every active minute.
 */
export function shownZoo(zoo: Zoo): string {
  return JSON.stringify({
    daemons: zoo.daemons.map(({ xp: _xp, ...shown }) => shown),
    eggs: zoo.eggs, paired: zoo.paired, autonomy: zoo.autonomy, consent: zoo.consent,
    habits: zoo.habits, firstEgg: zoo.firstEgg, setupEgg: zoo.setupEgg,
  })
}

/** Whether a client would draw `after` differently from `before` (see `shownZoo`). */
export const zooShownChanged = (before: Zoo, after: Zoo): boolean => shownZoo(before) !== shownZoo(after)

export const emptyProgress = (): ZooProgress =>
  ({ turns: 0, days: {}, weeks: [], nights: [], machines: [], marathon: [], history: [], held: [], batches: [], lessons: [] })
export const emptyZoo = (): Zoo => ({
  daemons: [], eggs: [], paired: null, autonomy: ZOO_DEFAULT_AUTONOMY, consent: null, habits: [], firstEgg: false, setupEgg: false,
  pity: 0, sinceNew: 0, easter: [], progress: emptyProgress(),
})

// Names in ops are plain strings rather than roster enums on purpose: a newer client naming a habit or
// a word this server does not know yet gets that op dropped, not the whole batch refused. An individual is
// named by its uid; a well-formed uid the zoo does not hold drops the op like any other missing name.
export const zooOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('zoo.habit'), key }).strict(),
  z.object({ op: z.literal('zoo.hatch'), eggId: key }).strict(),
  z.object({ op: z.literal('zoo.pair'), uid: zooUidSchema }).strict(),
  // The name given at the hatch, or later; null clears it.
  z.object({ op: z.literal('zoo.nickname'), uid: zooUidSchema, name: zooNameSchema.nullable() }).strict(),
  // A level this server does not know (a newer client's) is dropped, not refused, like any unknown name.
  z.object({ op: z.literal('zoo.autonomy'), level: z.string().min(1).max(32) }).strict(),
  // The first-day consent screen's answer: whether the daemon may watch at all.
  z.object({ op: z.literal('zoo.consent'), watching: z.boolean() }).strict(),
  z.object({ op: z.literal('zoo.easter'), word: z.string().min(1).max(64) }).strict(),
  // A guest's local zoo, read entry by entry like a stored one (a bad entry is dropped, not the seed).
  z.object({ op: z.literal('zoo.seed'), zoo: z.record(z.string(), z.unknown()) }).strict(),
  // Turns that finished on one machine, all in one local hour of one local day. harnessd sends it.
  // `minutes`: the agent-minutes those turns ran; `away`: how many of them finished while the person was
  // away from this computer. Absent means 0 (a harnessd from before either existed).
  // SELF-REPORTED, like presence (`away`): anything holding the account's token can send it, so a person can
  // only ever cheat their own zoo — the daily cap bounds even that. Nothing here is proof to anyone else:
  // a card's serial and rarity are not verified until a later verify endpoint exists.
  z.object({
    op: z.literal('zoo.turn'),
    batchId: key,
    n: z.number().int().min(1).max(ZOO_TURN_MAX_N),
    minutes: z.number().int().min(0).max(ZOO_TURN_MAX_MINUTES).optional(),
    away: z.number().int().min(0).max(ZOO_TURN_MAX_N).optional(),
    day: localDay,
    hour: z.number().int().min(0).max(23),
    machineId: key,
  }).strict().refine((op) => (op.away ?? 0) <= op.n, 'away counts turns, so it is at most n'),
  // A lesson the person approved (daemons/LEARNING.md): bond for the daemon that found it, named by its
  // species (see applyLesson for which individual). harnessd sends it.
  // SELF-REPORTED like `zoo.turn`: the approval happened on a machine the server cannot see, so a person can
  // only ever grow their own daemons with it (a retry of one lesson id grows nothing).
  z.object({ op: z.literal('zoo.lesson'), lessonId: key, daemonId }).strict(),
])
export type ZooOp = z.infer<typeof zooOpSchema>

export const zooOpsBodySchema = z.object({
  ops: z.array(zooOpSchema).min(1).max(64),
}).strict()

// ── Reading a stored (or seeded) zoo ─────────────────────────────────────────────────────────────
const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}

function uniqueStrings(raw: unknown, keep: (s: string) => boolean, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !key.safeParse(item).success || !keep(item) || out.includes(item)) continue
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

/** Like uniqueStrings, but a memory: when there are too many, the newest (last) are the ones kept. */
function lastStrings(raw: unknown, keep: (s: string) => boolean, max: number): string[] {
  return uniqueStrings(Array.isArray(raw) ? raw : [], keep, Number.MAX_SAFE_INTEGER).slice(-max)
}

const wholeIn = (raw: unknown, max: number): number =>
  typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? Math.min(raw, max) : 0

/** Forget per-day counts older than two weeks before the newest day counted. */
function pruneDays(days: Record<string, number>): void {
  const keys = Object.keys(days)
  if (!keys.length) return
  const newest = Math.max(...keys.map(dayNumber))
  for (const day of keys) if (dayNumber(day) <= newest - DAY_MEMORY) delete days[day]
}

/** The zoo's progress as stored (or seeded), piece by piece; a malformed piece reads as nothing yet. */
function parseProgress(raw: unknown, strict: boolean): ZooProgress {
  const src = record(raw)
  const days: Record<string, number> = {}
  for (const [day, n] of Object.entries(record(src.days))) {
    if (isLocalDay(day) && typeof n === 'number' && Number.isInteger(n) && n > 0) days[day] = Math.min(n, EARN.turn.dailyCap)
  }
  pruneDays(days)
  const held: ZooHeld[] = []
  if (Array.isArray(src.held)) {
    for (const item of src.held) {
      const h = record(item)
      if (typeof h.kind !== 'string' || !key.safeParse(h.kind).success) continue
      if (strict && !eggRule(h.kind)) continue
      held.push(typeof h.date === 'string' && isLocalDay(h.date) ? { kind: h.kind, date: h.date } : { kind: h.kind })
      if (held.length >= ZOO_MAX_HELD) break
    }
  }
  return {
    turns: wholeIn(src.turns, ZOO_MAX_TURNS),
    days,
    weeks: lastStrings(src.weeks, (w) => /^\d{4}-W\d{2}$/.test(w), WEEK_MEMORY),
    nights: lastStrings(src.nights, isLocalDay, EARN.night.nights - 1),
    machines: uniqueStrings(src.machines, () => true, EARN.marathon.machines),
    marathon: uniqueStrings(src.marathon, (r) => (MARATHON_REASONS as readonly string[]).includes(r), MARATHON_REASONS.length),
    history: lastStrings(src.history, isLocalDay, HISTORY_MEMORY),
    held,
    batches: lastStrings(src.batches, () => true, ZOO_BATCH_MEMORY),
    lessons: lastStrings(src.lessons, () => true, ZOO_LESSON_MEMORY),
  }
}

/** An individual's bond and version follow its xp. A daemon stored before xp existed gets the least xp its
 *  stored bond needs, so reading never lowers a level. */
function grown(d: Omit<ZooDaemon, 'xp'> & { xp?: number }): ZooDaemon {
  const xp = d.xp ?? BOND_LEVELS[Math.min(d.bond, BOND_LEVELS.length - 1)]
  const bond = levelFor(xp)
  return { ...d, xp, bond, version: versionFor(bond) }
}

/**
 * The uid an old record reads with: the first 24 hex of sha256 over the account and the species (and,
 * for a second record of one species, which one it is), so every read of the same old zoo, before and
 * after it is next written, names each individual the same.
 */
export function legacyUid(userId: string, id: string, nth = 0): string {
  return createHash('sha256').update(`harness-zoo\0${userId}\0${id}${nth ? `\0${nth}` : ''}`).digest('hex').slice(0, 24)
}

/**
 * One stored individual, or an old record read as one (`seed` 0, the species' default traits; its
 * `nickname` its name, its `hatchedAt` its hatch, its `dupes` dropped: the xp they gave is in its xp).
 * `nth` counts the old records of each species read so far. Null: malformed.
 */
function readDaemon(item: unknown, userId: string, nth: Map<string, number>): ZooDaemon | null {
  if (Object.hasOwn(record(item), 'uid')) {
    const parsed = zooDaemonSchema.safeParse(item)
    return parsed.success ? grown(parsed.data) : null
  }
  const old = legacyDaemonSchema.safeParse(item)
  if (!old.success) return null
  const { id, hatchedAt, egg, shiny, nickname, bond, xp, version, serial, origin } = old.data
  const k = nth.get(id) ?? 0
  nth.set(id, k + 1)
  return grown({
    uid: legacyUid(userId, id, k), id, seed: 0, ...(serial ? { serial } : {}), ...(nickname ? { name: nickname } : {}),
    shiny, xp, bond, version, hatched: hatchedAt, egg, ...(origin ? { origin } : {}),
  })
}

/** Easter words used, as hashes. A word stored before words were hashed reads as its hash; a seed keeps
 *  only the hashes this roster knows. */
function parseEaster(raw: unknown, strict: boolean): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length < 1 || item.length > 64) continue
    const hash = HASH_RE.test(item) ? item : easterHash(item)
    if ((strict && !EASTER_HASHES.has(hash)) || out.includes(hash)) continue
    out.push(hash)
    if (out.length >= 64) break
  }
  return out
}

/**
 * The zoo as stored (Json), validated entry by entry; anything malformed is dropped rather than served.
 *
 * `roster: true` (a guest's seed) also drops what the roster does not know: daemons, egg kinds,
 * habits and words. A STORED zoo keeps a well-formed daemon id the roster lacks — a roster rolled back
 * must not delete someone's daemon on their next write.
 *
 * A zoo stored before individuals (one record per species, duplicates merged into its `dupes`, `pair` a
 * species id) reads as individuals: each record one, with `legacyUid(userId, id)` (a second record of one
 * species, from before duplicates merged, its own), and `paired` the first individual of the old pair's
 * species. The next write stores it in the new shape, with the same uids: reading it again changes nothing.
 */
export function parseZoo(raw: unknown, opts: { roster?: boolean; userId?: string } = {}): Zoo {
  const src = record(raw)
  const strict = !!opts.roster
  const daemons: ZooDaemon[] = []
  if (Array.isArray(src.daemons)) {
    const nth = new Map<string, number>()
    for (const item of src.daemons) {
      if (daemons.length >= ZOO_MAX_DAEMONS) break
      const d = readDaemon(item, opts.userId ?? '', nth)
      if (!d || daemons.some((x) => x.uid === d.uid)) continue
      if (strict && (!ROSTER_IDS.has(d.id) || !eggRule(d.egg))) continue
      daemons.push(d)
    }
  }
  const eggs: ZooEgg[] = []
  if (Array.isArray(src.eggs)) {
    for (const item of src.eggs) {
      const parsed = zooEggSchema.safeParse(item)
      if (!parsed.success || eggs.some((e) => e.id === parsed.data.id)) continue
      if (strict && !eggRule(parsed.data.kind)) continue
      eggs.push(parsed.data)
      if (eggs.length >= ZOO_MAX_EGGS) break
    }
  }
  // `paired` names a uid; a zoo from before individuals said `pair`, a species id.
  const paired = Object.hasOwn(src, 'paired')
    ? (typeof src.paired === 'string' && daemons.some((d) => d.uid === src.paired) ? src.paired : null)
    : (typeof src.pair === 'string' ? daemons.find((d) => d.id === src.pair)?.uid ?? null : null)
  const consent = record(src.consent)
  return {
    daemons,
    eggs,
    paired,
    autonomy: isAutonomy(src.autonomy) ? src.autonomy : ZOO_DEFAULT_AUTONOMY,
    consent: typeof consent.watching === 'boolean' && typeof consent.at === 'string' && isoTime.safeParse(consent.at).success
      ? { watching: consent.watching, at: consent.at } : null,
    habits: uniqueStrings(src.habits, (h) => !strict || HABIT_KEYS.has(h), 64),
    firstEgg: src.firstEgg === true,
    setupEgg: src.setupEgg === true,
    pity: wholeIn(src.pity, ZOO_MAX_PITY),
    sinceNew: wholeIn(src.sinceNew, ZOO_MAX_PITY),
    easter: parseEaster(src.easter, strict),
    progress: parseProgress(src.progress, strict),
  }
}

// ── The draw ─────────────────────────────────────────────────────────────────────────────────────
/** Weights are whole units so `randomInt` can draw them exactly; a millionth is far below any odds. */
const WEIGHT_UNITS = 1_000_000

/**
 * Whether this zoo's next hatch owes a species it does not own: one of its first `ZOO_FIRST_NEW` hatches
 * (while the egg could give any new species), or the next after `ZOO_NEW_AFTER` in a row with none (while
 * an unowned released regular exists). A zoo's individuals are its hatches: none is ever taken away.
 */
function owesNew(zoo: Zoo, fresh: number, secrets: number): boolean {
  return (zoo.daemons.length < ZOO_FIRST_NEW && fresh + secrets > 0) || (zoo.sinceNew >= ZOO_NEW_AFTER && fresh > 0)
}

/**
 * Who can come out of an egg of `kind` for this zoo at `now`, and how likely, in whole units (README,
 * "The draw"):
 *
 *  1. Eligible: every released regular (not a secret), owned or not: a species you own hatches again as
 *     one more individual. Secrets sit outside the set: an unowned released secret is eligible, but only
 *     from an egg whose `weights.secret` is above 0; one you own never comes again.
 *  2. Weight: `weights[rarity] / (eligible of that rarity)`, plus `pity * pityPerMiss` for a secret,
 *     times `boost[id]`. A rarity with no eligible daemon gives its weight to nothing.
 *  3. The pity guarantee: from an egg that can hold a secret, when `pity` is one short of
 *     `secretGuaranteeAt` and a released secret is unowned, only the unowned secrets are eligible.
 *  4. A new species owed (`owesNew`): only the species you do not own are eligible — the unowned
 *     regulars and, from an egg that can hold one, the unowned secrets — weighed as in 2.
 *
 * When what 4 leaves weighs nothing (an easter egg, which gives only legendaries and secrets, once those
 * are owned) the egg draws as usual, and a new species is still owed to the next hatch. An egg whose
 * eligible daemons all weigh nothing draws from every released daemon rather than giving nobody.
 */
export function drawWeights(zoo: Zoo, kind: string, now: Date = new Date()): Array<{ id: string; rarity: string; weight: number }> {
  const egg = eggRule(kind)
  if (!egg) return []
  const secretsToo = holdsSecret(kind)
  const released = releasedDaemons(now)
  const owned = new Set(zoo.daemons.map((d) => d.id))
  const regulars = released.filter((d) => d.rarity !== 'secret')
  const fresh = regulars.filter((d) => !owned.has(d.id))
  const secrets = secretsToo ? released.filter((d) => d.rarity === 'secret' && !owned.has(d.id)) : []
  const weigh = (pool: readonly RosterDaemon[]) => {
    const perRarity = new Map<string, number>()
    for (const d of pool) perRarity.set(d.rarity, (perRarity.get(d.rarity) ?? 0) + 1)
    return pool.map((d) => {
      const base = (egg.weights[d.rarity] ?? 0) / perRarity.get(d.rarity)!
      const pity = d.rarity === 'secret' && secretsToo ? zoo.pity * RULES.pityPerMiss : 0
      const boost = egg.boost && Object.hasOwn(egg.boost, d.id) ? egg.boost[d.id] : 1
      return { id: d.id, rarity: d.rarity, weight: Math.round((base + pity) * boost * WEIGHT_UNITS) }
    })
  }
  const weighs = (weights: ReturnType<typeof weigh>) => weights.some((w) => w.weight > 0)
  if (secrets.length && zoo.pity + 1 >= RULES.secretGuaranteeAt) return weigh(secrets)
  if (owesNew(zoo, fresh.length, secrets.length)) {
    const unowned = new Set([...fresh, ...secrets])
    const weights = weigh(released.filter((d) => unowned.has(d)))
    if (weighs(weights)) return weights
  }
  const eligible = new Set([...regulars, ...secrets])
  const weights = weigh(released.filter((d) => eligible.has(d)))
  return weighs(weights) ? weights : weigh(released)
}

/** One draw: which species hatches, then (independently) whether it is shiny. `rng` is called in that
 *  order. (The hatch then draws the individual's seed and uid: see `hatchOne`.) */
export function draw(zoo: Zoo, kind: string, rng: Rng, now: Date = new Date()): { id: string; rarity: string; shiny: boolean } | null {
  const weights = drawWeights(zoo, kind, now)
  const total = weights.reduce((sum, w) => sum + w.weight, 0)
  if (total <= 0) return null
  let at = rng(total)
  let picked = weights[weights.length - 1]
  for (const w of weights) {
    if (at < w.weight) { picked = w; break }
    at -= w.weight
  }
  return { id: picked.id, rarity: picked.rarity, shiny: rng(RULES.shinyOneIn) === 0 }
}

/**
 * The daemon a history egg from `date` gives: that date's daemon from `rules.historyDates`, when a
 * released drop holds it and you do not own it yet. Otherwise null, and the egg draws like any other.
 */
export function historyDaemon(zoo: Zoo, date: string | undefined, now: Date = new Date()): RosterDaemon | null {
  if (!date) return null
  const mmdd = date.slice(5)
  const id = Object.hasOwn(HISTORY_DATES, mmdd) ? HISTORY_DATES[mmdd] : null
  if (!id || zoo.daemons.some((d) => d.id === id)) return null
  return releasedDaemons(now).find((d) => d.id === id) ?? null
}

/** The draw for one egg: a history egg's own daemon when it has one to give, else the usual draw. */
function drawEgg(zoo: Zoo, egg: ZooEgg, rng: Rng, now: Date): { id: string; rarity: string; shiny: boolean } | null {
  const own = egg.kind === 'history' ? historyDaemon(zoo, egg.date, now) : null
  if (own) return { id: own.id, rarity: own.rarity, shiny: rng(RULES.shinyOneIn) === 0 }
  return draw(zoo, egg.kind, rng, now)
}

// ── Ops ──────────────────────────────────────────────────────────────────────────────────────────
const EGG_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'   // 32 symbols: no 0/o, 1/l
const EGG_ID_LENGTH = 10                                     // 50 bits: an id is never reused in practice

/** What one request produced besides the zoo itself. */
interface Outcome { hatched: Hatched[]; grants: Grant[]; levelUps: LevelUp[] }

/** What the route knows that the document does not. */
export interface ZooContext {
  /** Whether a machine id is one of the account's machines. Only those count as a machine seen (the
   *  second-machine marathon egg); every reported turn counts either way. Absent: every id counts. */
  ownsMachine?: (machineId: string) => boolean
}

/** A fresh egg id, unlike any egg in the zoo. Random, so a replayed hatch of an egg long gone can never
 *  land on a new egg that happens to share its name. */
function newEggId(zoo: Pick<Zoo, 'eggs'>, rng: Rng): string {
  for (;;) {
    let id = ''
    for (let i = 0; i < EGG_ID_LENGTH; i++) id += EGG_ID_ALPHABET[rng(EGG_ID_ALPHABET.length)]
    if (!zoo.eggs.some((e) => e.id === id)) return id
  }
}

function grantEgg(zoo: Zoo, kind: string, rng: Rng, now: Date, out: Outcome, date?: string): boolean {
  if (zoo.eggs.length >= ZOO_MAX_EGGS) return false
  const egg: ZooEgg = { id: newEggId(zoo, rng), kind, grantedAt: now.toISOString(), ...(date ? { date } : {}) }
  zoo.eggs.push(egg)
  out.grants.push({ kind, eggId: egg.id })
  return true
}

const UID_WORDS = 3                                          // three 32-bit draws: 24 hex, 96 bits
const UID_WORD = 0x1_0000_0000

/** A fresh uid, unlike any individual's in the zoo. */
function newUid(zoo: Pick<Zoo, 'daemons'>, rng: Rng): string {
  for (;;) {
    let uid = ''
    for (let i = 0; i < UID_WORDS; i++) uid += rng(UID_WORD).toString(16).padStart(8, '0')
    if (!zoo.daemons.some((d) => d.uid === uid)) return uid
  }
}

/** A hatch's seed: a whole number from 1 to `ZOO_SEED_MAX` (0 is kept for the default traits). */
const newSeed = (rng: Rng): number => 1 + rng(ZOO_SEED_MAX)

/** xp for one individual; a new level bumps bond and version and is answered in `levelUps`. */
function grow(d: ZooDaemon, xp: number, out: Outcome): void {
  if (xp <= 0) return
  d.xp = Math.min(d.xp + xp, ZOO_MAX_XP)
  const level = levelFor(d.xp)
  if (level <= d.bond) return
  d.bond = level
  d.version = versionFor(level)
  out.levelUps.push({ uid: d.uid, id: d.id, level, version: d.version })
}

/** The paired individual. */
const pairedDaemon = (zoo: Zoo): ZooDaemon | undefined => zoo.paired === null ? undefined : zoo.daemons.find((x) => x.uid === zoo.paired)

/** xp for the paired daemon. Nothing without a pair. */
function addXp(zoo: Zoo, xp: number, out: Outcome): void {
  const d = pairedDaemon(zoo)
  if (d) grow(d, xp, out)
}

/** An egg earned from work. It joins the queue of held eggs, which `releaseHeld` empties into the nest
 *  while there is room — so an egg earned with a full nest waits its turn instead of being lost. Past
 *  64 held it becomes `rules.overflowXp` for the paired daemon, answered as a grant with its `xp` (with
 *  nothing paired, nothing has hatched to grow, and it is lost). */
function earnEgg(zoo: Zoo, kind: string, out: Outcome, date?: string): void {
  if (zoo.progress.held.length < ZOO_MAX_HELD) {
    zoo.progress.held.push(date ? { kind, date } : { kind })
    return
  }
  const d = pairedDaemon(zoo)
  if (!d) return
  grow(d, RULES.overflowXp, out)
  out.grants.push({ kind, xp: RULES.overflowXp })
}

/** Held eggs into the nest, oldest first, while there is room. Runs after every op, so a hatch that
 *  frees a place lets the next waiting egg in. */
function releaseHeld(zoo: Zoo, rng: Rng, now: Date, out: Outcome): boolean {
  let changed = false
  while (zoo.progress.held.length && zoo.eggs.length < ZOO_MAX_EGGS) {
    const next = zoo.progress.held.shift()!
    grantEgg(zoo, next.kind, rng, now, out, next.date)
    changed = true
  }
  return changed
}

/**
 * The eggs habits earn, each once: the first egg at `firstEgg.need` habits, one of them every habit in
 * `firstEgg.require` (a finished turn); then the setup egg at `setupEgg.need`. Checked on every habit op,
 * so a grant that found the nest full happens on the next one.
 */
function maybeGrantHabitEggs(zoo: Zoo, rng: Rng, now: Date, out: Outcome): boolean {
  const done = zoo.habits.filter((h) => HABIT_KEYS.has(h))
  let changed = false
  if (!zoo.firstEgg && done.length >= RULES.firstEgg.need && FIRST_REQUIRES.every((k) => done.includes(k))) {
    if (grantEgg(zoo, 'first', rng, now, out)) { zoo.firstEgg = true; changed = true }
  }
  if (zoo.firstEgg && !zoo.setupEgg && done.length >= RULES.setupEgg.need) {
    if (grantEgg(zoo, 'setup', rng, now, out)) { zoo.setupEgg = true; changed = true }
  }
  return changed
}

/** Whether a reported local day can be today somewhere on Earth (UTC-12 to UTC+14), or is at most
 *  `ZOO_TURN_LATE_DAYS` later than that. */
function dayInWindow(day: string, now: Date): boolean {
  const today = Math.floor(now.getTime() / DAY_MS)
  const at = dayNumber(day)
  return at >= today - 1 - ZOO_TURN_LATE_DAYS && at <= today + 1
}

type TurnOp = Extract<ZooOp, { op: 'zoo.turn' }>

/**
 * Turns finished on one machine (README, "Earning eggs and growing"). A turn counts once, and once more
 * for every `earn.turn.minutesPerTurn` agent-minutes the batch ran. In order: the daily cap decides how
 * many count; counted turns earn turn eggs, the 500-turn marathon egg, a worked day toward the week egg,
 * a night toward the night egg (a turn that finished while you were away, in the night hours), and the
 * egg of a history date whose week is open; the paired daemon gets xp for each and for the first counted
 * turn of the day. A machine seen may earn the second-machine marathon egg.
 */
function applyTurn(zoo: Zoo, op: TurnOp, now: Date, out: Outcome, ctx: ZooContext): boolean {
  const p = zoo.progress
  if (p.batches.includes(op.batchId) || !dayInWindow(op.day, now)) return false
  let changed = false

  const machines = EARN.marathon.machines
  if (!p.machines.includes(op.machineId) && p.machines.length < machines && (ctx.ownsMachine?.(op.machineId) ?? true)) {
    p.machines.push(op.machineId)
    changed = true
    if (p.machines.length >= machines && !p.marathon.includes('machines')) {
      p.marathon.push('machines')
      earnEgg(zoo, 'marathon', out)
    }
  }

  const before = p.days[op.day] ?? 0
  const units = op.n + Math.floor((op.minutes ?? 0) / EARN.turn.minutesPerTurn)
  const counted = Math.max(0, Math.min(units, EARN.turn.dailyCap - before))
  if (counted > 0) {
    changed = true
    p.days[op.day] = before + counted
    pruneDays(p.days)

    const turnsBefore = p.turns
    p.turns = Math.min(p.turns + counted, ZOO_MAX_TURNS)
    const every = EARN.turn.every
    for (let k = Math.floor(turnsBefore / every); k < Math.floor(p.turns / every); k++) earnEgg(zoo, 'turn', out)
    if (p.turns >= EARN.marathon.turns && !p.marathon.includes('turns')) {
      p.marathon.push('turns')
      earnEgg(zoo, 'marathon', out)
    }

    const week = isoWeek(op.day)
    if (!p.weeks.includes(week) && Object.keys(p.days).filter((d) => isoWeek(d) === week).length >= EARN.week.days) {
      p.weeks = [...p.weeks, week].slice(-WEEK_MEMORY)
      earnEgg(zoo, 'week', out)
    }

    const night = (op.away ?? 0) > 0 ? nightOf(op.day, op.hour) : null
    if (night && !p.nights.includes(night)) {
      p.nights.push(night)
      if (p.nights.length >= EARN.night.nights) {
        p.nights = []
        earnEgg(zoo, 'night', out)
      }
    }

    for (const date of historyDatesOpen(op.day)) {
      if (p.history.includes(date)) continue
      p.history = [...p.history, date].slice(-HISTORY_MEMORY)
      earnEgg(zoo, 'history', out, date)
    }

    addXp(zoo, counted * RULES.bond.xpPerTurn + (before === 0 ? RULES.bond.xpPerDay : 0), out)
  }

  // A batch that changed nothing (the day's cap was already reached) is not remembered: replayed, it
  // still changes nothing, and not writing it spares every client a re-fetch each minute past the cap.
  if (changed) p.batches = [...p.batches, op.batchId].slice(-ZOO_BATCH_MEMORY)
  return changed
}

type LessonOp = Extract<ZooOp, { op: 'zoo.lesson' }>

/**
 * A lesson the person approved (daemons/LEARNING.md, "The zoo"): `rules.lessonXp` for the daemon that
 * found it when you own it, else for the paired one (the finder may be a guest's daemon that never came
 * along to this account). The report names a species: the paired individual when it is of that species
 * (the pair brain found it), else the first of that species hatched. Once per lesson id: a retry of a
 * report that landed grows nothing. With neither, nothing grows and the id is not remembered.
 */
function applyLesson(zoo: Zoo, op: LessonOp, out: Outcome): boolean {
  const p = zoo.progress
  if (p.lessons.includes(op.lessonId)) return false
  const paired = pairedDaemon(zoo)
  const d = (paired?.id === op.daemonId ? paired : zoo.daemons.find((x) => x.id === op.daemonId)) ?? paired
  if (!d) return false
  grow(d, RULES.lessonXp, out)
  p.lessons = [...p.lessons, op.lessonId].slice(-ZOO_LESSON_MEMORY)
  return true
}

const isEmpty = (zoo: Zoo): boolean => zoo.daemons.length === 0 && zoo.eggs.length === 0 && zoo.habits.length === 0

/** The only eggs a guest's seed brings: the first egg and turn eggs, neither of which can hold a secret. */
const SEEDED_EGGS: ReadonlySet<string> = new Set(['first', 'turn'])

const cloneProgress = (p: ZooProgress): ZooProgress => ({
  turns: p.turns,
  days: { ...p.days },
  weeks: [...p.weeks],
  nights: [...p.nights],
  machines: [...p.machines],
  marathon: [...p.marathon],
  history: [...p.history],
  held: p.held.map((h) => ({ ...h })),
  batches: [...p.batches],
  lessons: [...p.lessons],
})

const clone = (zoo: Zoo): Zoo => ({
  daemons: zoo.daemons.map((d) => ({ ...d })),
  eggs: zoo.eggs.map((e) => ({ ...e })),
  paired: zoo.paired,
  autonomy: zoo.autonomy,
  consent: zoo.consent ? { ...zoo.consent } : null,
  habits: [...zoo.habits],
  firstEgg: zoo.firstEgg,
  setupEgg: zoo.setupEgg,
  pity: zoo.pity,
  sinceNew: zoo.sinceNew,
  easter: [...zoo.easter],
  progress: cloneProgress(zoo.progress),
})

type HatchOp = Extract<ZooOp, { op: 'zoo.hatch' }>

/**
 * Hatch one egg: draw the species (and shiny), then the individual's seed and uid, in that order of
 * `rng` calls. Every hatch is a new individual — a species you own too — at 0.1, paired when nothing is.
 * A full zoo (`ZOO_MAX_DAEMONS`) hatches nothing and the egg stays where it is.
 */
function hatchOne(zoo: Zoo, op: HatchOp, rng: Rng, now: Date, out: Outcome): boolean {
  const i = zoo.eggs.findIndex((e) => e.id === op.eggId)
  if (i < 0 || zoo.daemons.length >= ZOO_MAX_DAEMONS) return false
  const egg = zoo.eggs[i]
  const drawn = drawEgg(zoo, egg, rng, now)
  if (!drawn) return false                                     // a kind this roster cannot draw
  const isNew = !zoo.daemons.some((d) => d.id === drawn.id)
  zoo.eggs.splice(i, 1)
  // The pity counts only hatches that could have been a secret.
  if (drawn.rarity === 'secret') zoo.pity = 0
  else if (holdsSecret(egg.kind)) zoo.pity = Math.min(zoo.pity + 1, ZOO_MAX_PITY)
  zoo.sinceNew = isNew ? 0 : Math.min(zoo.sinceNew + 1, ZOO_MAX_PITY)
  const seed = newSeed(rng)
  const d: ZooDaemon = {
    uid: newUid(zoo, rng), id: drawn.id, seed, shiny: drawn.shiny, xp: 0, bond: 0, version: FIRST_VERSION,
    hatched: now.toISOString(), egg: egg.kind,
  }
  zoo.daemons.push(d)
  if (zoo.paired === null) zoo.paired = d.uid
  out.hatched.push({ eggId: egg.id, daemonId: d.id, ...d })
  return true
}

/**
 * Apply one op to `zoo` IN PLACE (applyZooOps hands it a copy). Returns whether anything changed; what
 * it hatched, granted or levelled goes into `out`.
 *
 * Every hatch is its own individual; `zoo.pair` and `zoo.nickname` name one by its uid.
 */
function applyZooOp(zoo: Zoo, op: ZooOp, rng: Rng, now: Date, out: Outcome, ctx: ZooContext): boolean {
  switch (op.op) {
    case 'zoo.habit': {
      if (!HABIT_KEYS.has(op.key)) return false
      let changed = false
      if (!zoo.habits.includes(op.key)) { zoo.habits.push(op.key); changed = true }
      if (maybeGrantHabitEggs(zoo, rng, now, out)) changed = true
      return changed
    }
    case 'zoo.hatch':
      return hatchOne(zoo, op, rng, now, out)
    case 'zoo.pair': {
      if (zoo.paired === op.uid || !zoo.daemons.some((d) => d.uid === op.uid)) return false
      zoo.paired = op.uid
      return true
    }
    // The dial and consent are plain assignments, in the order the person made them; what they changed is
    // settled once the whole request has run (settleConsent), never per op. See applyZooOps.
    case 'zoo.autonomy': {
      if (isAutonomy(op.level)) zoo.autonomy = op.level
      return false
    }
    case 'zoo.consent': {
      // Agreeing to be watched starts at `watch`, every time — agreeing again too: the person opts into
      // `suggest` and above afterwards, with a dial move made after the yes. Saying no leaves the dial where
      // it is (nothing is sensed), and a later yes starts at `watch` again, so a level held before a no is
      // never raised again by the yes that follows it.
      if (op.watching) zoo.autonomy = 'watch'
      zoo.consent = { watching: op.watching, at: zoo.consent?.at ?? '' }
      return false
    }
    case 'zoo.nickname': {
      const d = zoo.daemons.find((x) => x.uid === op.uid)
      if (!d || (d.name ?? null) === op.name) return false
      if (op.name === null) delete d.name
      else d.name = op.name
      return true
    }
    case 'zoo.easter': {
      const hash = easterHash(op.word)
      if (!EASTER_HASHES.has(hash) || zoo.easter.includes(hash)) return false
      // A full nest leaves the word unspent, so saying it again later still works.
      if (!grantEgg(zoo, 'easter', rng, now, out)) return false
      zoo.easter.push(hash)
      return true
    }
    case 'zoo.seed': {
      if (!isEmpty(zoo)) return false
      const seed = parseZoo(op.zoo, { roster: true })
      // A guest's zoo lived on a client: everything in it is self-reported. What comes in is only what a
      // client could not have made valuable — its individuals of regular species, each fresh at 0.1 with
      // the species' default traits (seed 0: no rolled look, no shiny, no xp, no bond, no serial), the
      // first and turn eggs, and the habits — all marked `local`. Pity, secrets, the eggs that can hold one
      // (night, easter), easter words, progress, the dial and consent stay the account's own. A daemon of a
      // drop not yet released could not have hatched anywhere, so it stays out too. Uids and egg ids are
      // the server's to give: each is made new on the way in.
      const regular = new Set(releasedDaemons(now).filter((d) => d.rarity !== 'secret').map((d) => d.id))
      const came = seed.daemons.filter((d) => regular.has(d.id))
      const daemons: ZooDaemon[] = []
      for (const d of came) {
        daemons.push({
          uid: newUid({ daemons }, rng), id: d.id, seed: 0, ...(d.name ? { name: d.name } : {}),
          shiny: false, xp: 0, bond: 0, version: FIRST_VERSION, hatched: d.hatched, egg: d.egg, origin: 'local',
        })
      }
      const kept = seed.eggs.filter((e) => SEEDED_EGGS.has(e.kind))
      if (!daemons.length && !kept.length && !seed.habits.length) return false
      const eggs: ZooEgg[] = []
      for (const egg of kept) eggs.push({ id: newEggId({ eggs }, rng), kind: egg.kind, grantedAt: egg.grantedAt, origin: 'local' })
      const pairedAt = came.findIndex((d) => d.uid === seed.paired)
      const paired = (pairedAt >= 0 ? daemons[pairedAt] : daemons[0])?.uid ?? null
      Object.assign(zoo, { daemons, eggs, paired, habits: seed.habits, firstEgg: seed.firstEgg, setupEgg: seed.setupEgg, pity: 0, sinceNew: 0, easter: [] })
      return true
    }
    case 'zoo.turn':
      return applyTurn(zoo, op, now, out, ctx)
    case 'zoo.lesson':
      return applyLesson(zoo, op, out)
  }
}

/**
 * The dial and consent after a request, from what they were before it: consent's time moves only when the
 * request as a whole changed the answer, and what changed is counted once, net. Whether the request moved
 * them is what they are now against what they were — never whether some op along the way touched them.
 *
 * That is what makes a request that answers consent and moves the dial land in the same place however
 * often it is delivered (a retry after a lost answer, a writer that lost the compare-and-set): each op is
 * an assignment, so the dial ends at the last move the person made — a level, or `watch` for a yes — and
 * consent at their last answer, whatever the zoo held when the request arrived.
 */
function settleConsent(before: Zoo, next: Zoo, now: Date): boolean {
  const was = before.consent
  const is = next.consent
  if (is && is.watching !== was?.watching) next.consent = { watching: is.watching, at: now.toISOString() }
  else next.consent = was ? { ...was } : null
  return next.autonomy !== before.autonomy || next.consent?.watching !== was?.watching
}

/** Apply `ops` in order to a copy of `zoo`. `changed` is false when every op was a no-op — the same
 *  request twice, or ops on things already gone — and then nothing needs writing. After every op any
 *  held egg that now fits is let into the nest. */
export function applyZooOps(
  zoo: Zoo, ops: ZooOp[], rng: Rng = cryptoRng, now: Date = new Date(), ctx: ZooContext = {},
): { changed: boolean; zoo: Zoo } & Outcome {
  const next = clone(zoo)
  const out: Outcome = { hatched: [], grants: [], levelUps: [] }
  let changed = false
  for (const op of ops) {
    if (applyZooOp(next, op, rng, now, out, ctx)) changed = true
    if (releaseHeld(next, rng, now, out)) changed = true
  }
  if (settleConsent(zoo, next, now)) changed = true
  return { changed, zoo: next, ...out }
}
