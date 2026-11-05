/**
 * Which review steps a pull request needs, from the files it changes (task #3401, anh Dee's Swarm redesign, 2026-11-05): one
 * read by default; two security reviews for sign-in, tokens, encryption, access, the Buddy guard, device links and deletion
 * (project instructions, Rules for every agent: Ken, 2026-10-29); a test step where the change runs (Workflow 2). The table is
 * data: until the project rules record (#3393) carries it, REVIEW_TABLE is the one place its numbers and paths live.
 */

/** A row of the table: a sensitive area, the reads a change to it needs, and the paths that are it. */
export interface ReviewRow { area: string; reads: number; paths: readonly string[] }
/** Where a change runs, for its Tester, and the paths that run there. */
export interface TestRow { where: string; paths: readonly string[] }
export interface ReviewTable { defaultReads: number; rows: readonly ReviewRow[]; test: readonly TestRow[] }

export type StepKind = 'review' | 'security' | 'test'
/** A step a pull request needs: its name in the task, its kind, the sensitive areas it touched, where a test runs, and
 *  `unread` when its files could not be read, so it was planned as strictly as the table goes. */
export interface PlannedStep { name: string; kind: StepKind; areas: string[]; where?: string[]; unread?: true }

/** What a Tester need not run: tests, fixtures and docs alone (Workflow 2: docs and test-only changes get a review only). */
const NOT_RUN = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test/**', '**/tests/**', '**/integration/**', '**/__fixtures__/**',
  '**/*.md', 'docs/**']

export const REVIEW_TABLE: ReviewTable = {
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
}

const compiled = new Map<string, RegExp>()
/** Whether [path] matches [glob], ignoring case: `**` any folders (or none), `*` and `?` within one name; anything else is
 *  itself. */
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
    compiled.set(glob, pattern)
  }
  return pattern.test(path)
}

const matches = (paths: readonly string[], file: string) => paths.some(glob => globMatch(glob, file))

/**
 * The steps a change to [files] needs by [table], reads first. Its reads are the most any touched row asks, at least the
 * default; with a sensitive row touched each read is a security review. A test step names each place where a changed file
 * runs, tests and docs aside. Files that could not be read (null) plan the most reads any row asks, as security reviews,
 * and no test: where it runs is unknown, and its brief says why.
 */
export function reviewPlan(files: readonly string[] | null, table: ReviewTable = REVIEW_TABLE): PlannedStep[] {
  const touched = files === null ? [...table.rows] : table.rows.filter(row => files.some(file => matches(row.paths, file)))
  const reads = Math.max(table.defaultReads, ...touched.map(row => row.reads))
  const security = touched.length > 0
  const areas = touched.map(row => row.area)
  const steps: PlannedStep[] = Array.from({ length: reads }, (_, i) => ({
    name: `${security ? 'Security review' : 'Review'}${reads > 1 ? ` ${i + 1}` : ''}`,
    kind: security ? 'security' as const : 'review' as const, areas,
    ...(files === null ? { unread: true as const } : {}),
  }))
  const running = (files ?? []).filter(file => !matches(NOT_RUN, file))
  const where = table.test.filter(row => running.some(file => matches(row.paths, file))).map(row => row.where)
  if (where.length) steps.push({ name: 'Test', kind: 'test', areas: [], where })
  return steps
}

/**
 * The files two or more of a batch's pull requests change, with the pull requests changing each: a batch needs a
 * combination read only when this is not empty (task #3401). A pull request whose files could not be read (null) is taken
 * to touch everything, shown as the file `*`.
 */
export function sharedFiles(pulls: ReadonlyArray<{ url: string; files: readonly string[] | null }>): Array<{ file: string; urls: string[] }> {
  const unread = pulls.filter(pull => pull.files === null).map(pull => pull.url)
  if (unread.length && pulls.length > 1) return [{ file: '*', urls: pulls.map(pull => pull.url) }]
  const by = new Map<string, string[]>()
  for (const pull of pulls) for (const file of new Set(pull.files)) by.set(file, [...by.get(file) ?? [], pull.url])
  return [...by].filter(([, urls]) => urls.length > 1).map(([file, urls]) => ({ file, urls }))
}
