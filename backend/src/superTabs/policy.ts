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
/** A path pattern relative to the repository (globMatch): never absolute, never climbing out of it. */
const glob = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.*?\/@+ -]+$/, 'A path pattern: letters, digits and _ . * ? / @ + - only.')
  .refine(g => !g.startsWith('/') && !g.split('/').includes('..'), 'A path pattern relative to the repository, without "..".')
  // At most MAX_WILDCARDS a pattern, a double star counting as one, and no run of three stars (security review of #3216).
  // globMatch is linear whatever the pattern; this keeps patterns readable and the matcher's work small.
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
  /** Periodic dispatch cadence, handed-work cap and progress clocks. */
  dispatch: dispatchSchema,
  /** Lanes of work and the paths each owns. */
  lanes: distinct(z.object({ name: line(80), owns: z.array(line(400)).max(MAX_LIST) }).strict(), lane => lane.name, 'lane'),
}).strict().refine(rules => Buffer.byteLength(JSON.stringify(rules)) <= MAX_RULES_BYTES,
  `Project rules are at most ${MAX_RULES_BYTES / 1024} KB.`)
  // The backend pause is a part of the release window (review of #3216): outside it, there is no release to pause.
  .refine(rules => {
    const pause = rules.releasePace.backendPause
    return !pause || (pause.start >= rules.releaseWindow.start && pause.end <= rules.releaseWindow.end)
  }, 'The backend pause falls inside the release window.'))

export type ProjectRules = z.infer<typeof projectRulesSchema>

/** [value] frozen all the way down: the seed is shared, so no reader may change it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

/**
 * The review table's security areas (project instructions, Ken 2026-10-29: two independent reviews for sign-in, tokens,
 * access, encryption, the Buddy guard, the device link and anything that deletes data). Each old term matches as a name or as
 * a folder, as the merge train's own matcher did before it read this record (task #3475, review of #3250: it erred wide, and
 * so does this). The seed starts from these rows, and requiredReads never asks fewer than two reads where they match, whatever
 * a saved record says (River, 2026-11-06): a record can raise an area, never lower it.
 */
export const SECURITY_ROWS: ReadonlyArray<{ area: string; reads: number; paths: string[] }> = deepFreeze([
  { area: 'Sign-in', reads: 2, paths: ['**/*auth*', '**/*login*', '**/*logout*', '**/*signin*', '**/*sign_in*', '**/middlewares/**', '**/sessionScope*', 'backend/src/**/session*', '**/community/session*', '**/session-lock*', 'store/agents/**/guard.py'] },
  { area: 'Tokens', reads: 2, paths: ['**/*token*', '**/*token*/**', '**/*credential*', '**/*credential*/**', '**/*secret*', '**/*secret*/**', '**/*keychain*', 'backend/src/github/**', 'cli/src/team/handoff*'] },
  { area: 'Encryption', reads: 2, paths: ['**/*crypt*', '**/*crypt*/**', '**/*cipher*', '**/*cipher*/**', '**/*encrypt*', '**/e2ee/**', '**/*seal*', '**/*pake*', '**/*tlsguard*', 'backend/src/**/*key', 'backend/src/**/*key.*', 'backend/src/**/*key/**', 'backend/src/**/*key-*', 'backend/src/**/*keys', 'backend/src/**/*keys.*', 'backend/src/**/*keys/**', 'backend/src/**/*keys-*', 'cli/src/**/*key', 'cli/src/**/*key.*', 'cli/src/**/*key/**', 'cli/src/**/*key-*', 'cli/src/**/*keys', 'cli/src/**/*keys.*', 'cli/src/**/*keys/**', 'cli/src/**/*keys-*'] },
  { area: 'Access', reads: 2, paths: ['**/*access*', '**/*access*/**', '**/*permission*', '**/*permission*/**', '**/*audience*', '**/*audience*/**', '**/*membership*', '**/*membership*/**', '**/*authority*', '**/*trust*', '**/teamWritten*'] },
  { area: 'Buddy guard', reads: 2, paths: ['**/*buddy*guard*', '**/*ruleguard*', '**/*rule_guard*', '**/*devicesguard*', '**/*devices_guard*', '**/*leadguard*', '**/*lead_guard*', 'backend/src/superTabs/*guard*', 'companions/src/shared/guard.ts', 'cli/src/lib/agentShellGuard*', 'cli/src/superTabs/shellGuard*'] },
  { area: 'Device links', reads: 2, paths: ['**/*device*', 'cli/src/device/**', 'cli/src/devices/**', 'cli/src/lib/*device*/**', '**/add_device/**', '**/*wifi_robot*', 'devices/**/*cable*', 'devices/**/*pair*', 'devices/**/*link*', 'devices/**/*key*', '**/*harnesslinks*', '**/*harnesslinks*/**', '**/*harness_links*', '**/*harness_links*/**', '**/*pairing*', '**/*pairing*/**', '**/*joinlink*', '**/*joinlink*/**', '**/*join_link*', '**/*join_link*/**', '**/*deviceauth*'] },
  { area: 'Deletion', reads: 2, paths: ['**/*delet*', '**/*delet*/**', '**/*purge*', '**/*purge*/**', '**/*cleanup*', '**/*cleanup*/**', '**/*sweep*', '**/*sweep*/**', '**/*prune*', '**/*prune*/**', '**/*tombstone*', '**/*wipe*', '**/account_keys*'] },
])
/** The fewest reads a change to a security area gets, whatever a saved record says. */
export const SECURITY_FLOOR_READS = 2
/** What runs no code: images (not SVG, which can carry script), video, 3D models, Markdown, docs, samples and build output.
 *  The built-in security patterns never catch it (River, SecAlder and ReviewLinnea, review of #3250); a path a person writes
 *  into a security row of their record still does, as written. */
const NOT_CODE = /\.(png|jpe?g|gif|webp|ico|icns|mp4|mov|webm|stl|step|stp|3mf|obj|glb|gltf|f3d|md)$|^(docs|samples|output)\//i
/** Names a security term catches by accident, per area: accessibility is not access control. */
const NOT_AREA: Readonly<Record<string, RegExp>> = { access: /accessib/i }
/** The built-in patterns of each security area, by its name in lower case. */
const BUILT_IN = new Map(SECURITY_ROWS.map(row => [row.area.toLowerCase(), new Set(row.paths)]))
/** Whether [glob] of a security area's row catches [file]: a built-in pattern catches code only, not a known false name; a
 *  pattern a person added to the row in their record catches exactly what it says (SecAlder, re-review of #3250). */
function securityGlob(area: string, glob: string, file: string): boolean {
  if (!globMatch(glob, file)) return false
  if (!BUILT_IN.get(area.toLowerCase())?.has(glob)) return true
  return !NOT_CODE.test(file) && !NOT_AREA[area.toLowerCase()]?.test(file)
}
const inSecurityArea = (row: { area: string; paths: readonly string[] }, file: string) => row.paths.some(glob => securityGlob(row.area, glob, file))

/** Today's numbers (task #3393; project instructions, 2026-11-05): what a project reads until its first save. */
export const SEED_RULES: ProjectRules = deepFreeze({
  releaseWindow: { start: '09:00', end: '18:00', timeZone: 'Asia/Ho_Chi_Minh' },
  releasePace: { backendEveryMinutes: 120, appsAfterVisibleBatch: true, backendPause: { start: '09:00', end: '10:00' } },
  // The review table the review steps plan by (#3401, reviewTable.ts at c935c0665): two security reviews for these areas
  // (project instructions, Ken 2026-10-29), a test where the change runs (Workflow 2).
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

type GlobToken = { kind: 'char'; c: string } | { kind: 'one' } | { kind: 'name' } | { kind: 'any' } | { kind: 'dirs' }
const tokenCache = new Map<string, GlobToken[]>()
/** [glob] as tokens: `**` then a slash, any folders or none (`dirs`); `**` anything (`any`); `*` within one name (`name`); `?` one
 *  character of a name (`one`); anything else itself, lower-cased. */
function globTokens(glob: string): GlobToken[] {
  let tokens = tokenCache.get(glob)
  if (tokens) return tokens
  tokens = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { tokens.push({ kind: 'dirs' }); i += 2 } else { tokens.push({ kind: 'any' }); i += 1 }
    } else if (c === '*') tokens.push({ kind: 'name' })
    else if (c === '?') tokens.push({ kind: 'one' })
    else tokens.push({ kind: 'char', c: c.toLowerCase() })
  }
  // Bounded: a project has at most 50 rows of 50 patterns; the cache only saves tokenizing them again.
  if (tokenCache.size > 10_000) tokenCache.clear()
  tokenCache.set(glob, tokens)
  return tokens
}

/** Whether [path] matches [glob], ignoring case: `**` any folders (or none), `*` and `?` within one name; anything else is
 *  itself. The review steps' rules (#3401 reviewTable.ts globMatch), so both read a row alike. It walks the pattern as a
 *  set of positions, one step per character of the path: time grows with the path times the pattern and never backtracks,
 *  whatever a project saves (security review of #3216: the regex it replaced took 19 s on `*a` ten times). */
export function globMatch(glob: string, path: string): boolean {
  const tokens = globTokens(glob), end = tokens.length
  // A double star and a slash matches no folders, or any characters ending in a slash, as the regex `(?:.*/)?` did. So it
  // has two positions: at its token i (it may still match nothing and move on), and inside it, -(i + 1), having read
  // characters, which it leaves only by reading a slash. Without the inside position `a/**/b` matched `a/xb` (Reviewers).
  const inside = (i: number) => -(i + 1)
  // Every position reachable from [from] without reading a character: a wildcard may match nothing.
  const close = (from: Iterable<number>): Set<number> => {
    const seen = new Set<number>(), stack = [...from]
    while (stack.length) {
      const i = stack.pop()!
      if (seen.has(i)) continue
      seen.add(i)
      const t = i >= 0 ? tokens[i] : undefined
      if (t && (t.kind === 'name' || t.kind === 'any' || t.kind === 'dirs')) stack.push(i + 1)
    }
    return seen
  }
  let states = close([0])
  for (const raw of path) {
    const c = raw.toLowerCase(), next: number[] = []
    for (const i of states) {
      if (i < 0) {
        // Inside a double star and a slash: any characters, leaving only after a slash.
        next.push(i)
        if (c === '/') next.push(-i)
        continue
      }
      const t = tokens[i]
      if (!t) continue
      if (t.kind === 'char') { if (t.c === c) next.push(i + 1) }
      else if (t.kind === 'one') { if (c !== '/') next.push(i + 1) }
      else if (t.kind === 'name') { if (c !== '/') next.push(i) }
      else if (t.kind === 'any') next.push(i)
      else if (c === '/') next.push(i + 1, inside(i))
      else next.push(inside(i))
    }
    if (!next.length) return false
    states = close(next)
  }
  return states.has(end)
}

const matchesAny = (patterns: readonly string[], file: string) => patterns.some(g => globMatch(g, file))

/** The review rows a change to [files] touches; every row when its files could not be read (null): fail closed. */
export function touchedRows(rules: ProjectRules, files: readonly string[] | null): ProjectRules['reviews']['rows'] {
  return files === null ? [...rules.reviews.rows] : rules.reviews.rows.filter(row => files.some(file => matchesAny(row.paths, file)))
}

/** The independent reads a change to [files] needs: the most any touched row asks, at least the default. Files that could
 *  not be read (null) need the most any row asks (the merge train and the review steps fail closed, #3401, #3402). */
export function requiredReads(rules: ProjectRules, files: readonly string[] | null): number {
  // The floor (River, 2026-11-06): a security area's two reads hold whatever the record's own rows say, and unknown files
  // touch every area.
  const security = files === null || files.some(file => SECURITY_ROWS.some(row => inSecurityArea(row, file)))
  // A security area's own row in the record reads files the same way, so a doc or an image named after a device asks no
  // second read; any other row reads every file.
  const areas = new Set(SECURITY_ROWS.map(row => row.area.toLowerCase()))
  const rows = files === null ? touchedRows(rules, null) : rules.reviews.rows.filter(row => areas.has(row.area.toLowerCase())
    ? files.some(file => inSecurityArea(row, file)) : files.some(file => row.paths.some(glob => globMatch(glob, file))))
  return Math.max(rules.reviews.defaultReads, ...rows.map(row => row.reads), security ? SECURITY_FLOOR_READS : 0)
}

/** Where a change to [files] runs, for its test, in the table's order: none for tests, fixtures and docs alone, and none when
 *  its files could not be read (where it runs is unknown). */
export function testsFor(rules: ProjectRules, files: readonly string[] | null): string[] {
  const running = (files ?? []).filter(file => !matchesAny(rules.reviews.untested, file))
  return rules.reviews.test.filter(row => running.some(file => matchesAny(row.paths, file))).map(row => row.where)
}
