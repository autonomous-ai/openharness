/**
 * A project's rules record (task #3393, anh Dee's Swarm redesign, 2026-11-05: code over prompts). The numbers a project runs
 * on — its release window and pace, its review table, the merge train's switch, its caps, paths, crew and lanes — kept as one
 * schema-checked record with every revision, changed by people (or the project's PM passing on a person's chat message)
 * without a release. Nothing here enters the Swarm state, the instructions read or any prompt: it is project data, read by
 * the server and shown to people. Revision 0 is the seed below, never stored until the first save (policyStore.ts).
 */
import { z } from 'zod'
import { personKey } from './instructionsDiff.js'

/** The record as stored, as JSON: small enough that a reader reads every revision kept. */
export const MAX_RULES_BYTES = 16_384
/** Revisions kept per project, the current one included; the save that writes the 51st deletes the oldest. */
export const MAX_RULES_REVISIONS = 50
const MAX_LIST = 50
/** Wildcards a path pattern may hold, a double star counting as one. */
export const MAX_WILDCARDS = 4

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'A time of day as HH:MM, 00:00 to 23:59.')
const timeZone = z.string().min(1).max(64).refine(zone => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}, 'An IANA time zone, such as Asia/Ho_Chi_Minh.')
/** One line of text a person reads: no line breaks or control characters. */
const line = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]*$/, 'One line, without control characters.')
const minutes = z.number().int().min(1).max(10_080)
const reads = z.number().int().min(1).max(5)
/** A path pattern relative to the repository: never absolute, never climbing out of it. */
const glob = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.*?\/@+ -]+$/, 'A path pattern: letters, digits and _ . * ? / @ + - only.')
  .refine(g => !g.startsWith('/') && !g.split('/').includes('..'), 'A path pattern relative to the repository, without "..".')
  // At most MAX_WILDCARDS a pattern, a double star counting as one, and no run of three stars (security review of #3216).
  .refine(g => !g.includes('***') && (g.match(/\*\*|\*|\?/g)?.length ?? 0) <= MAX_WILDCARDS,
    'A path pattern has at most 4 wildcards (* ? or **).')
const globs = z.array(glob).max(MAX_LIST)
/** A list whose entries' [key] differ, ignoring case: two rows for one area would leave the table saying two things. */
const distinct = <T extends z.ZodTypeAny>(item: T, key: (entry: z.infer<T>) => string, what: string) =>
  z.array(item).max(MAX_LIST).refine(list => new Set(list.map(e => key(e).toLowerCase())).size === list.length, `Each ${what} once.`)

const accountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/)
const instructionApprovals = z.object({
  topDeciderId: accountId.nullable(),
  people: distinct(z.object({ name: line(80).refine(name => !!personKey(name), 'Name a person.'),
    accountIds: z.array(accountId).min(1).max(10) }).strict(), person => personKey(person.name), 'person')
    .refine(people => {
      const ids = people.flatMap(person => person.accountIds)
      return new Set(ids).size === ids.length
    }, 'An account belongs to only one named person, once.'),
}).strict()

/** Defaults for projects predating configurable dispatch (#3601); kept here with the rest of the project policy. */
export const SEED_DISPATCH = deepFreeze({ everyMs: 30_000, maxHanded: 3, nudgeAfterMs: 7_200_000, returnAfterMs: 10_800_000 })
export const SEED_LANES = deepFreeze([
  { name: 'backend', owns: ['backend/'] }, { name: 'CLI', owns: ['cli/'] },
  { name: 'Desktop', owns: ['desktop/'] }, { name: 'mobile', owns: ['mobile/'] }, { name: 'docs', owns: ['docs/'] },
])
const dispatchSchema = z.object({
  everyMs: z.number().int().min(30_000).max(3_600_000),
  maxHanded: z.number().int().min(1).max(1000),
  nudgeAfterMs: z.number().int().min(60_000).max(604_800_000),
  returnAfterMs: z.number().int().max(1_209_600_000),
}).strict().refine(d => d.returnAfterMs > d.nudgeAfterMs, 'Return time is later than the nudge.')

/** Old clients and stored revisions have no dispatch section; their unused empty lane table meant the fixed five lanes.
 * An explicit dispatch section makes an empty list deliberate. No backfill or mutation of a saved revision. */
const legacyDispatch = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || 'dispatch' in value) return value
  const old = value as Record<string, unknown>
  return { ...old, dispatch: SEED_DISPATCH, ...Array.isArray(old.lanes) && old.lanes.length === 0 ? { lanes: SEED_LANES } : {} }
}

/** A machine by its id, as the Swarm's Machines list names it: a Mac and its Harness Team account are two ids. */
const machineId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/, 'A machine id.')
/** A machine rule its owners gave (project instructions, Routing › Machines; task #3964): kept here by machine id, never in
 *  source, since people's machines and hours stay out of this public repository (River, 11-05). Each says why, in the words
 *  people read, and at least one of: when the machine is away, the engines no agent runs there with, that no Reviewer runs
 *  there, or the lanes whose work goes there first. machineRules.ts applies them. */
const machineRuleSchema = z.object({
  machineIds: z.array(machineId).min(1).max(20),
  why: line(200),
  /** On these weekdays (0 Sunday … 6 Saturday), between these local times, in its owner's time zone: nothing starts there. */
  away: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    windows: z.array(z.tuple([clock, clock]).refine(([from, to]) => from < to, 'An away window ends after it starts, the same day.')).min(1).max(6),
    timeZone,
  }).strict().optional(),
  noEngines: z.array(z.enum(['claude', 'codex'])).min(1).max(2).optional(),
  noReviews: z.literal(true).optional(),
  /** Work of these lanes goes to this machine first, while an agent there takes it. */
  first: z.object({ lanes: z.array(line(80)).min(1).max(MAX_LIST) }).strict().optional(),
}).strict().refine(rule => !!(rule.away || rule.noEngines || rule.noReviews || rule.first),
  'A machine rule says when the machine is away, which engines or Reviewers it refuses, or which lanes go there first.')

export const projectRulesSchema = z.preprocess(legacyDispatch, z.object({
  /** Explicit authority for instruction-rule changes; absent on older records, null deliberately disables it. */
  instructionApprovals: instructionApprovals.nullable().optional(),
  /** When releases go out, in a local time of day; the end comes after the start, the same day. */
  releaseWindow: z.object({ start: clock, end: clock, timeZone }).strict()
    .refine(w => w.start < w.end, 'The release window ends after it starts, the same day.'),
  /** The backend at most every N minutes (each release reconnects everyone); Desktop, CLI and web after each visible batch. */
  /** `backendPause`: a part of the window, in its time zone, when no backend release goes out (the morning peak); null for none. */
  releasePace: z.object({ backendEveryMinutes: minutes, appsAfterVisibleBatch: z.boolean(),
    backendPause: z.object({ start: clock, end: clock }).strict().refine(p => p.start < p.end, 'The pause ends after it starts.').nullable() }).strict(),
  /** How many independent reads a change gets: the default, more for a change to the paths of an area listed; where a change
   *  runs, for its test; and the paths whose change alone needs no test (tests, fixtures, docs). The review steps read it before
   *  Swarm v4, which opens none (2026-11-10); a saved record keeps it. */
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
  /** Periodic dispatch cadence, handed-work cap and progress clocks. */
  dispatch: dispatchSchema,
  /** Lanes of work and the paths each owns. */
  lanes: distinct(z.object({ name: line(80), owns: z.array(line(400)).max(MAX_LIST) }).strict(), lane => lane.name, 'lane'),
  /** The project's machine rules. Absent on a record from before them: none apply. */
  machines: z.array(machineRuleSchema).max(MAX_LIST).optional(),
}).strict().refine(rules => Buffer.byteLength(JSON.stringify(rules)) <= MAX_RULES_BYTES,
  `Project rules are at most ${MAX_RULES_BYTES / 1024} KB.`)
  // A lane a machine rule names is one the record has, or the rule would never apply.
  .refine(rules => (rules.machines ?? []).every(rule => (rule.first?.lanes ?? []).every(name =>
    rules.lanes.some(lane => lane.name.toLowerCase() === name.toLowerCase()))), 'A machine rule names a lane this record has.')
  // The backend pause is a part of the release window (review of #3216): outside it, there is no release to pause.
  .refine(rules => {
    const pause = rules.releasePace.backendPause
    return !pause || (pause.start >= rules.releaseWindow.start && pause.end <= rules.releaseWindow.end)
  }, 'The backend pause falls inside the release window.'))

export type ProjectRules = z.infer<typeof projectRulesSchema>
export type MachineRule = z.infer<typeof machineRuleSchema>
/** The machine rules of a stored [record] that pass, whether or not the rest of it does (security review 1 of #3964): a record
 *  broken elsewhere still keeps a machine its owner's rule refuses work, rather than failing open while it is repaired. */
export function validMachineRules(record: unknown): MachineRule[] {
  const machines = record && typeof record === 'object' ? (record as { machines?: unknown }).machines : undefined
  return Array.isArray(machines) ? machines.flatMap(rule => { const parsed = machineRuleSchema.safeParse(rule); return parsed.success ? [parsed.data] : [] }) : []
}

/** [value] frozen all the way down: the seed is shared, so no reader may change it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

/**
 * The review table's security areas (project instructions, Ken 2026-10-29: two independent reviews for sign-in, tokens,
 * access, encryption, the Buddy guard, the device link and anything that deletes data). Each old term matches as a name or as
 * a folder, as the merge train's own matcher did before it read this record (task #3475, review of #3250: it erred wide, and
 * so does this). The seed starts from these rows.
 */
export const SECURITY_ROWS: ReadonlyArray<{ area: string; reads: number; paths: string[] }> = deepFreeze([
  { area: 'Sign-in', reads: 2, paths: ['**/*auth*', '**/*login*', '**/*logout*', '**/*signin*', '**/*sign_in*', '**/middlewares/**', '**/sessionScope*', 'backend/src/**/session*', '**/community/session*', '**/session-lock*', 'store/agents/**/guard.py'] },
  { area: 'Tokens', reads: 2, paths: ['**/*token*', '**/*token*/**', '**/*credential*', '**/*credential*/**', '**/*secret*', '**/*secret*/**', '**/*keychain*', 'backend/src/github/**', 'cli/src/team/handoff*'] },
  { area: 'Encryption', reads: 2, paths: ['**/*crypt*', '**/*crypt*/**', '**/*cipher*', '**/*cipher*/**', '**/*encrypt*', '**/e2ee/**', '**/*seal*', '**/*pake*', '**/*tlsguard*', 'backend/src/**/*key', 'backend/src/**/*key.*', 'backend/src/**/*key/**', 'backend/src/**/*key-*', 'backend/src/**/*keys', 'backend/src/**/*keys.*', 'backend/src/**/*keys/**', 'backend/src/**/*keys-*', 'cli/src/**/*key', 'cli/src/**/*key.*', 'cli/src/**/*key/**', 'cli/src/**/*key-*', 'cli/src/**/*keys', 'cli/src/**/*keys.*', 'cli/src/**/*keys/**', 'cli/src/**/*keys-*'] },
  { area: 'Access', reads: 2, paths: ['**/*access*', '**/*access*/**', '**/*permission*', '**/*permission*/**', '**/*audience*', '**/*audience*/**', '**/*membership*', '**/*membership*/**', '**/*authority*', '**/*trust*', '**/teamWritten*'] },
  { area: 'Buddy guard', reads: 2, paths: ['**/*buddy*guard*', '**/*ruleguard*', '**/*rule_guard*', '**/*devicesguard*', '**/*devices_guard*', '**/*leadguard*', '**/*lead_guard*', 'backend/src/superTabs/*guard*', 'companions/src/shared/guard.ts'] },
  { area: 'Device links', reads: 2, paths: ['**/*device*', 'cli/src/device/**', 'cli/src/devices/**', 'cli/src/lib/*device*/**', '**/add_device/**', '**/*wifi_robot*', 'devices/**/*cable*', 'devices/**/*pair*', 'devices/**/*link*', 'devices/**/*key*', '**/*harnesslinks*', '**/*harnesslinks*/**', '**/*harness_links*', '**/*harness_links*/**', '**/*pairing*', '**/*pairing*/**', '**/*joinlink*', '**/*joinlink*/**', '**/*join_link*', '**/*join_link*/**', '**/*deviceauth*'] },
  { area: 'Deletion', reads: 2, paths: ['**/*delet*', '**/*delet*/**', '**/*purge*', '**/*purge*/**', '**/*cleanup*', '**/*cleanup*/**', '**/*sweep*', '**/*sweep*/**', '**/*prune*', '**/*prune*/**', '**/*tombstone*', '**/*wipe*', '**/account_keys*'] },
])
/** Today's numbers (task #3393; project instructions, 2026-11-05): what a project reads until its first save. */
export const SEED_RULES: ProjectRules = deepFreeze({
  releaseWindow: { start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' },
  releasePace: { backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: { start: '09:00', end: '10:00' } },
  // The review table the review steps planned by before Swarm v4 (#3401): two security reviews for these areas (project
  // instructions, Ken 2026-10-29), a test where the change runs (Workflow 2).
  reviews: {
    defaultReads: 1,
    rows: SECURITY_ROWS.map(row => ({ ...row, paths: [...row.paths] })),
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
  lanes: SEED_LANES,
  dispatch: SEED_DISPATCH,
})

/** Task #3710: only this Harness project asked for Dee's authority and Ken's linked accounts.
 * Stable account IDs, never a project/display name or an email-prefix guess; no other project inherits them. */
const HARNESS_APPROVALS = deepFreeze({
  topDeciderId: '6a8fe4fcf1a6b5972eed0103',
  people: [{ name: 'Ken', accountIds: ['6a86d24c2ea251076eb4eebe', '6ae980b6215612e2be51c35b'] }],
})
export function seedRules(tabId: string, projectId: string, rules: ProjectRules = SEED_RULES): ProjectRules {
  return rules.instructionApprovals === undefined && tabId === 'c51479bd73b59e58176ad9e4' && projectId === '5701099db2a04f605ac0d4d4'
    ? { ...rules, instructionApprovals: HARNESS_APPROVALS } : rules
}

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

