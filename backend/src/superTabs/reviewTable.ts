/**
 * Which review steps a pull request needs, from the files it changes (task #3401, anh Dee's Swarm redesign, 2026-11-05): one
 * read by default; two security reviews for sign-in, tokens, encryption, access, the Buddy guard, device links and deletion
 * (project instructions, Rules for every agent: Ken, 2026-10-29); a test step where the change runs (Workflow 2). The table is
 * the project's rules record (policy.ts, #3393): its review rows, test rows and untested paths, read through its own matcher.
 */
import { requiredReads, SEED_RULES, testsFor, touchedRows, type ProjectRules } from './policy.js'

export type StepKind = 'review' | 'security' | 'test'
/** A step a pull request needs: its name in the task, its kind, the sensitive areas it touched, where a test runs, and
 *  `unread` when its files could not be read, so it was planned as strictly as the table goes. */
export interface PlannedStep { name: string; kind: StepKind; areas: string[]; where?: string[]; unread?: true }

/**
 * The steps a change to [files] needs by the project's [rules], reads first: as many reads as requiredReads asks, each a
 * security review when a sensitive row is touched; then a test step naming where testsFor says it runs. Files that could not
 * be read (null) plan as strictly as the rules go, and no test: where it runs is unknown, and its brief says why.
 */
export function reviewPlan(files: readonly string[] | null, rules: ProjectRules = SEED_RULES): PlannedStep[] {
  const touched = touchedRows(rules, files)
  const reads = requiredReads(rules, files)
  const security = touched.length > 0
  const areas = touched.map(row => row.area)
  const steps: PlannedStep[] = Array.from({ length: reads }, (_, i) => ({
    name: `${security ? 'Security review' : 'Review'}${reads > 1 ? ` ${i + 1}` : ''}`,
    kind: security ? 'security' as const : 'review' as const, areas,
    ...(files === null ? { unread: true as const } : {}),
  }))
  const where = testsFor(rules, files)
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

const short = (head: string | null) => head ? head.slice(0, 7) : null

/** What a step's agent is asked to do: which pull requests, at which head, for which task, and why this step. */
export function stepBrief(step: PlannedStep, task: { number: number; title: string; pulls: ReadonlyArray<{ url: string; head: string | null }> }): string {
  // Each pull request at the head its own files were read at.
  const pulls = task.pulls.length ? task.pulls.map(pull => short(pull.head) ? `${pull.url} at head ${short(pull.head)}` : pull.url).join(', ') : 'its pull request'
  const what = step.kind === 'test'
    ? `Test ${pulls} for task #${task.number} "${task.title}" as a user would, where it changes: ${step.where!.join('; ')}.`
    : `${step.kind === 'security' ? 'Security-review' : 'Review'} ${pulls} for task #${task.number} "${task.title}".`
  const why = step.unread ? ' Its changed files could not be read, so it is reviewed as strictly as the review table goes.'
    : step.kind === 'security' ? ` It changes ${step.areas.join(', ')}: two independent security reviews before merge.` : ''
  return `${what}${why} Record your verdict at the head you read, and send it to the task's Engineer with "Ready to merge: Yes", "No" or "With fixes".`
}

/** The acceptance check a step's agent records. */
export const stepCheck = (step: PlannedStep): string => step.kind === 'test'
  ? `Runs as a user would: ${step.where!.join('; ')}`
  : `${step.kind === 'security' ? 'Security review' : 'Review'}: Ready to merge at the pull request's head`
