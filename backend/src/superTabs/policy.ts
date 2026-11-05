/**
 * A project's rules record (task #3393, anh Dee's Swarm redesign, 2026-11-05: code over prompts). The numbers a project runs
 * on — its release window and pace, its review table, the merge train's switch, its caps, paths, crew and lanes — kept as one
 * schema-checked record with every revision, changed by people (or the project's PM passing on a person's chat message)
 * without a release. Nothing here enters the Swarm state, the instructions read or any prompt: it is project data, read by
 * the server and shown to people. Revision 0 is the seed below, never stored until the first save (policyStore.ts).
 */
import { z } from 'zod'

/** The record as stored, as JSON: small enough that a reader reads every revision kept. */
export const MAX_RULES_BYTES = 16_384
/** Revisions kept per project, the current one included; the save that writes the 51st deletes the oldest. */
export const MAX_RULES_REVISIONS = 50
const MAX_LIST = 50

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'A time of day as HH:MM, 00:00 to 23:59.')
const timeZone = z.string().min(1).max(64).refine(zone => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}, 'An IANA time zone, such as Asia/Ho_Chi_Minh.')
/** One line of text a person reads: no line breaks or control characters. */
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/, 'One line, without control characters.')
const minutes = z.number().int().min(1).max(10_080)
const reads = z.number().int().min(1).max(5)
/** A path pattern relative to the repository (globMatch): never absolute, never climbing out of it. */
const glob = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.*?\/@+ -]+$/, 'A path pattern: letters, digits and _ . * ? / @ + - only.')
  .refine(g => !g.startsWith('/') && !g.split('/').includes('..'), 'A path pattern relative to the repository, without "..".')
const globs = z.array(glob).max(MAX_LIST)
/** A list whose entries' [key] differ, ignoring case: two rows for one area would leave the table saying two things. */
const distinct = <T extends z.ZodTypeAny>(item: T, key: (entry: z.infer<T>) => string, what: string) =>
  z.array(item).max(MAX_LIST).refine(list => new Set(list.map(e => key(e).toLowerCase())).size === list.length, `Each ${what} once.`)

export const projectRulesSchema = z.object({
  /** When releases go out, in a local time of day; the end comes after the start, the same day. */
  releaseWindow: z.object({ start: clock, end: clock, timeZone }).strict()
    .refine(w => w.start < w.end, 'The release window ends after it starts, the same day.'),
  /** The backend at most every N minutes (each release reconnects everyone); Desktop, CLI and web after each visible batch. */
  /** `backendPause`: a part of the window, in its time zone, when no backend release goes out (the morning peak); null for none. */
  releasePace: z.object({ backendEveryMinutes: minutes, appsAfterVisibleBatch: z.boolean(),
    backendPause: z.object({ start: clock, end: clock }).strict().refine(p => p.start < p.end, 'The pause ends after it starts.').nullable() }).strict(),
  /** How many independent reads a change gets: the default, more for a change to the paths of an area listed; where a change
   *  runs, for its test; and the paths whose change alone needs no test (tests, fixtures, docs). requiredReads and testsFor
   *  read it. */
  reviews: z.object({
    defaultReads: reads,
    rows: distinct(z.object({ area: line(80), reads, paths: globs }).strict(), row => row.area, 'area'),
    test: distinct(z.object({ where: line(200), paths: globs }).strict(), row => row.where, 'place'),
    untested: globs,
  }).strict(),
  /** The batch merge: on or off, and how often it runs. */
  mergeTrain: z.object({ enabled: z.boolean(), everyMinutes: minutes }).strict(),
  /** Named limits, such as the agents one machine takes. */
  caps: distinct(z.object({ name: line(80), value: z.number().int().min(0).max(1_000_000) }).strict(), cap => cap.name, 'cap'),
  /** Named places in the repository, such as where plans go. */
  paths: distinct(z.object({ name: line(80), path: line(400) }).strict(), entry => entry.name, 'path name'),
  /** The crew roster: each role and who fills it. */
  crew: distinct(z.object({ role: line(40), names: z.array(line(80)).max(20) }).strict(), entry => entry.role, 'role'),
  /** Lanes of work and the paths each owns. */
  lanes: distinct(z.object({ name: line(80), owns: z.array(line(400)).max(MAX_LIST) }).strict(), lane => lane.name, 'lane'),
}).strict().refine(rules => Buffer.byteLength(JSON.stringify(rules)) <= MAX_RULES_BYTES,
  `Project rules are at most ${MAX_RULES_BYTES / 1024} KB.`)

export type ProjectRules = z.infer<typeof projectRulesSchema>

/** [value] frozen all the way down: the seed is shared, so no reader may change it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

/** Today's numbers (task #3393; project instructions, 2026-11-05): what a project reads until its first save. */
export const SEED_RULES: ProjectRules = deepFreeze({
  releaseWindow: { start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' },
  releasePace: { backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: { start: '09:00', end: '10:00' } },
  // The review table the review steps plan by (#3401, reviewTable.ts at c935c0665): two security reviews for these areas
  // (project instructions, Ken 2026-10-29), a test where the change runs (Workflow 2).
  reviews: {
    defaultReads: 1,
    rows: [
      { area: 'Sign-in', reads: 2, paths: ['**/*auth*', '**/*login*', '**/*logout*', '**/*signin*', '**/*sign_in*', '**/middlewares/**'] },
      { area: 'Tokens', reads: 2, paths: ['**/*token*', '**/*credential*', '**/*secret*', '**/*keychain*', 'backend/src/github/**'] },
      { area: 'Encryption', reads: 2, paths: ['**/*crypto*', '**/*encrypt*', '**/e2ee/**', '**/*seal*', '**/*pake*'] },
      { area: 'Access', reads: 2, paths: ['**/*access*', '**/*permission*', '**/*authority*', '**/*trust*', '**/teamWritten*'] },
      { area: 'Buddy guard', reads: 2, paths: ['**/*buddyguard*', '**/*buddy_guard*'] },
      { area: 'Device links', reads: 2, paths: ['**/*devicelink*', '**/*device_link*', '**/*deviceauth*', '**/*pairing*'] },
      { area: 'Deletion', reads: 2, paths: ['**/*delet*', '**/*purge*', '**/*cleanup*', '**/*tombstone*', '**/*wipe*'] },
    ],
    test: [
      { where: 'Desktop on a Mac', paths: ['desktop/**'] },
      { where: 'The CLI on a Mac and on a Linux machine', paths: ['cli/**', 'pty/**', 'term/**', 'tui/**', 'daemons/**'] },
      { where: 'The phone app in a simulator', paths: ['mobile/**'] },
      { where: 'The web in a browser', paths: ['website/**'] },
      { where: 'Install and update on a Mac', paths: ['installer/**'] },
      { where: 'Firmware on the device plugged into a machine', paths: ['devices/**', 'serial/**'] },
    ],
    untested: ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test/**', '**/tests/**', '**/integration/**', '**/__fixtures__/**',
      '**/*.md', 'docs/**'],
  },
  // Opt-in per project (River, #3402): a project turns it on with a rules save.
  mergeTrain: { enabled: false, everyMinutes: 10 },
  caps: [],
  paths: [],
  crew: [],
  lanes: [],
})

/** One change a save made: a leaf of an object section, or a whole list. */
export interface RulesChange { path: string; before: unknown; after: unknown }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** JSON with keys in order, so two equal records compare equal whatever order their keys came in. */
const canonical = (value: unknown): string => isObject(value)
  ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : JSON.stringify(value)

export const rulesEqual = (a: ProjectRules, b: ProjectRules): boolean => canonical(a) === canonical(b)

/** What changed from [before] to [after], in the schema's key order: each changed leaf of an object by its dotted path, and
 *  a changed list whole (its rows have no identity to diff by). Empty for equal records. */
export function rulesDiff(before: ProjectRules, after: ProjectRules): RulesChange[] {
  const changes: RulesChange[] = []
  const walk = (path: string, a: unknown, b: unknown) => {
    if (isObject(a) && isObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) walk(path ? `${path}.${key}` : key, a[key], b[key])
    } else if (canonical(a) !== canonical(b)) changes.push({ path, before: a, after: b })
  }
  walk('', before, after)
  return changes
}

/** What a save hands the store: the new revision, its diff from the one before, and who wrote it for whom. `writtenBy` is a
 *  person or the project's PM; `askedBy` the person whose words it carries; `askedIn` the chat message the PM passed on (null
 *  when a person wrote it). Never the machine owner's login. */
export interface RulesWrite {
  projectId: string
  revision: number
  rules: ProjectRules
  diff: RulesChange[]
  summary: string
  writtenBy: { kind: 'person' | 'agent'; id: string }
  askedBy: string
  askedIn: { conversationId: string; messageId: string } | null
  at: number
}

const compiled = new Map<string, RegExp>()
/** Whether [path] matches [glob], ignoring case: `**` any folders (or none), `*` and `?` within one name; anything else is
 *  itself. The review steps' matcher (#3401 reviewTable.ts globMatch), the same rules, so both read a row alike. */
export function globMatch(glob: string, path: string): boolean {
  let pattern = compiled.get(glob)
  if (!pattern) {
    let source = ''
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i]!
      if (c === '*' && glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { source += '(?:.*/)?'; i += 2 } else { source += '.*'; i += 1 }
      } else if (c === '*') source += '[^/]*'
      else if (c === '?') source += '[^/]'
      else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    pattern = new RegExp(`^${source}$`, 'i')
    // Bounded: a project has at most 50 rows of 50 patterns; the cache only saves recompiling them.
    if (compiled.size > 10_000) compiled.clear()
    compiled.set(glob, pattern)
  }
  return pattern.test(path)
}

const matchesAny = (patterns: readonly string[], file: string) => patterns.some(g => globMatch(g, file))

/** The review rows a change to [files] touches; every row when its files could not be read (null): fail closed. */
export function touchedRows(rules: ProjectRules, files: readonly string[] | null): ProjectRules['reviews']['rows'] {
  return files === null ? [...rules.reviews.rows] : rules.reviews.rows.filter(row => files.some(file => matchesAny(row.paths, file)))
}

/** The independent reads a change to [files] needs: the most any touched row asks, at least the default. Files that could
 *  not be read (null) need the most any row asks (the merge train and the review steps fail closed, #3401, #3402). */
export function requiredReads(rules: ProjectRules, files: readonly string[] | null): number {
  return Math.max(rules.reviews.defaultReads, ...touchedRows(rules, files).map(row => row.reads))
}

/** Where a change to [files] runs, for its test, in the table's order: none for tests, fixtures and docs alone, and none when
 *  its files could not be read (where it runs is unknown). */
export function testsFor(rules: ProjectRules, files: readonly string[] | null): string[] {
  const running = (files ?? []).filter(file => !matchesAny(rules.reviews.untested, file))
  return rules.reviews.test.filter(row => running.some(file => matchesAny(row.paths, file))).map(row => row.where)
}
