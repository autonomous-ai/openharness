/**
 * Which review steps a pull request needs, from the files it changes (task #3401, anh Dee's Swarm redesign, 2026-11-05): one
 * read by default; two security reviews for sign-in, tokens, encryption, access, the Buddy guard, device links and deletion
 * (project instructions, Rules for every agent: Ken, 2026-10-29); a test step where the change runs (Workflow 2). The table is
 * the project's rules record (policy.ts, #3393): its review rows, test rows and untested paths, read through its own matcher.
 */
import type { Conversation, SuperTabState } from './model.js'
import { unknownHistory, type HistoryReport } from './prHistory.js'
import { requiredReads, SEED_RULES, testsFor, touchedRows, type ProjectRules } from './policy.js'
import { stepName } from './steps.js'

export type StepKind = 'review' | 'security' | 'test'
/** A step a pull request needs: its name in the task, its kind, the sensitive areas it touched, where a test runs, and
 *  `unread` when its files could not be read, so it was planned as strictly as the table goes. */
export interface PlannedStep { name: string; kind: StepKind; areas: string[]; where?: string[]; unread?: true; os?: StepOs }

/** An OS a test step runs on, as the rules record's `where` names it (task #3602): "on a Mac", "on a Linux machine". */
export type StepOs = 'mac' | 'linux' | 'windows'
const OS_PLACE: Record<StepOs, string> = { mac: 'a Mac', linux: 'a Linux machine', windows: 'a Windows machine' }
const OS_WORDS: Record<StepOs, RegExp> = { mac: /\bmac(?:os|book)?\b/i, linux: /\blinux\b/i, windows: /\bwindows\b/i }
/** The OSes [where] names, in a fixed order. */
export const osesIn = (where: readonly string[]): StepOs[] => (['mac', 'linux', 'windows'] as const).filter(os => where.some(line => OS_WORDS[os].test(line)))
/** Whether a machine's reported OS (machines.ts resources.os: "macOS", "Linux", "Windows") is [os]. */
export const reportsOs = (reported: string | null | undefined, os: StepOs): boolean => !!reported && OS_WORDS[os].test(reported)
const OS_NAME: Record<StepOs, string> = { mac: 'Mac', linux: 'Linux', windows: 'Windows' }

/** The OS a step's name names, when it names exactly one (task #3926): "Test on a Linux machine" is Linux's; a plain "Test",
 *  or anything that is not a step, names none and is matched to no OS. */
export function stepOs(group: Pick<Conversation, 'reviewOf' | 'step' | 'title'>): StepOs | undefined {
  const oses = group.reviewOf ? osesIn([stepName(group)]) : []
  return oses.length === 1 ? oses[0] : undefined
}

/** The words for a step of [os] nobody of that OS can take: "No Linux Tester free". */
export const noTesterFree = (os: StepOs): string => `No ${OS_NAME[os]} Tester free`

/**
 * Why [group], a step named for an OS, cannot run on [machineId], or null (task #3926: with the Linux Testers down, two Linux
 * steps went to a Windows and a Mac Tester, and stalled). The machine's own reading says its OS, as reviewerPick.ts reads it;
 * one the Swarm does not list, or with no reading, reports none and takes no OS step. [contributorId] picks an agent's own pool.
 */
export function stepOsRefusal(state: SuperTabState, group: Pick<Conversation, 'reviewOf' | 'step' | 'title'>, machineId: string, contributorId?: string): string | null {
  const os = stepOs(group)
  if (!os) return null
  const pool = state.machines?.find(m => m.machineId === machineId && (!contributorId || m.contributorId === contributorId))
  const reported = pool?.observation?.resources?.os
  if (reportsOs(reported, os)) return null
  return `${stepName(group)} runs only on a ${OS_NAME[os]} machine, and ${pool?.name ?? 'this machine'} reports ${reported ? reported : 'no OS'}.`
}

/** Windows runs shared Desktop/CLI source and its native runner, not the Mac's Team-account implementation. Keep this
 *  alongside the planner so existing saved rules gain the Windows check without a rules migration (task #3778). */
const WINDOWS_TESTS = [
  { where: 'Desktop on Windows', paths: ['desktop/lib/**', 'desktop/windows/**', 'desktop/pubspec.yaml', 'desktop/pubspec.lock'] },
  { where: 'The CLI on Windows', paths: ['cli/src/**'] },
]
const MAC_TEAM_FILES = new Set(['cli/src/team/script.ts', 'cli/src/team/nodeTools.ts', 'cli/src/team/tmux.ts'])
// Match platform names, not names beginning with "mac" such as machineResources. Shared Team setup must still run on Windows.
const OTHER_PLATFORM = /\/(?:macos|darwin|linux)(?:[A-Z_./]|$)|\/mac_/
function windowsTests(files: readonly string[] | null, rules: ProjectRules): string[] {
  return testsFor({ ...rules, reviews: { ...rules.reviews, test: WINDOWS_TESTS,
    untested: [...SEED_RULES.reviews.untested, ...rules.reviews.untested] } },
  files?.filter(file => !MAC_TEAM_FILES.has(file) && !OTHER_PLATFORM.test(file)) ?? null)
}

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
  // A test that must run on more than one OS is one step per OS, each for a Tester on that OS (task #3602: #3576's went to a
  // Mac only when its check needed a Mac and a Linux machine); one OS named is that step's.
  const oses = osesIn(where)
  if (where.length && oses.length > 1) for (const os of oses) steps.push({ name: os === 'windows' ? 'Test on Windows' : `Test on ${OS_PLACE[os]}`, kind: 'test', areas: [], where, os })
  else if (where.length) steps.push({ name: oses[0] === 'windows' ? 'Test on Windows' : 'Test', kind: 'test', areas: [], where, ...oses.length ? { os: oses[0]! } : {} })
  const windows = windowsTests(files, rules)
  if (windows.length && !oses.includes('windows')) steps.push({ name: 'Test on Windows', kind: 'test', areas: [], where: windows, os: 'windows' })
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

/** What a step's agent is asked to do: which pull requests, at which head, for which task, and why this step. */
interface BriefTask { number: number; title: string;
  pulls: ReadonlyArray<{ url: string; head: string | null; base?: string | null; history?: HistoryReport }> }
export function stepBrief(step: PlannedStep, task: BriefTask): string {
  // Each pull request at the whole head its own files were read at, on its base branch: a verdict records both (#3394), and
  // work.check refuses a short head, so the brief shows the id a reviewer can copy.
  const pulls = task.pulls.length ? task.pulls.map(pull => `${pull.url}${pull.head ? ` at head ${pull.head}` : ''}${pull.base ? ` on base ${pull.base}` : ''}`).join(', ')
    : 'its pull request'
  const what = step.kind === 'test'
    ? `Test ${pulls} for task #${task.number} "${task.title}" as a user would, where it changes: ${step.where!.join('; ')}.`
      + (step.os && step.name !== 'Test' ? ` This step runs it on ${OS_PLACE[step.os]}.` : '')
      + (step.os === 'windows' ? ` Read docs/windows-rules.md first: no unwanted window may flash, even for a moment. Prove the flow with a recording in the person's Windows session on the signed build; SSH or session 0 cannot prove it.` : '')
    : `${step.kind === 'security' ? 'Security-review' : 'Review'} ${pulls} for task #${task.number} "${task.title}".`
  const why = step.unread ? ' Its changed files could not be read, so it is reviewed as strictly as the review table goes.'
    : step.kind === 'security' ? ` It changes ${step.areas.join(', ')}: two independent security reviews before merge.` : ''
  // A verdict counts only at the exact head and base it read (#3394): the role sheets' words (cli swarmToolSheets.ts work.check).
  return '<!-- harness-review-brief -->\n' + withHistoryBrief(`${what}${why} Record your verdict as this step's check at the pull request head (whole commit id) and base branch you read, and send `
    + 'it to the task\'s Engineer with "Ready to merge: Yes", "No" or "With fixes".', task.pulls) + '\n<!-- /harness-review-brief -->'
}

/** Regenerate our own brief at Ready; keep custom instructions outside it or in older, unmarked steps. */
export function refreshStepBrief(brief: string, step: PlannedStep, task: BriefTask): string {
  const generated = /<!-- harness-review-brief -->[\s\S]*?<!-- \/harness-review-brief -->/
  return generated.test(brief) ? brief.replace(generated, () => stepBrief(step, task)) : withHistoryBrief(brief, task.pulls)
}

/** The acceptance check a step's agent records. */
export const stepCheck = (step: PlannedStep): string => step.kind === 'test'
  ? `Runs as a user would: ${step.where!.join('; ')}`
  : `${step.kind === 'security' ? 'Security review' : 'Review'}: Ready to merge at the pull request's head`

/** Replace only our generated report, preserving a manually written step's instructions on the next Ready. */
export function withHistoryBrief(brief: string, pulls: ReadonlyArray<{ url: string; head: string | null; history?: HistoryReport }>): string {
  const before = brief.replace(/\n\n<!-- harness-pr-history -->[\s\S]*?<!-- \/harness-pr-history -->/g, '')
  const lines = pulls.map(pull => {
    const h = pull.head && pull.history?.head === pull.head ? pull.history : unknownHistory(pull.head)
    return `- ${pull.url} at ${pull.head ?? 'unread head'}: Plan first: ${h.planFirst}; Test before code: ${h.testBeforeCode}; `
      + `${h.productionLines ?? 'unknown'} production lines, ${h.totalLines ?? 'unknown'} total changed lines; ${h.commits ?? 'unknown'} commits.`
      + (h.missingTests.length ? ` No prior test-only commit: ${h.missingTests.slice(0, 5).map(sha => sha.slice(0, 12)).join(', ')}.` : '')
      + (h.merges ? ' Merge resolutions need a manual read.' : '')
  })
  return `${before}\n\n<!-- harness-pr-history -->\nPR history checks:\n${lines.join('\n') || '- History unavailable.'}\n`
    + 'History order does not prove a test failed or covers the change. Check red/green evidence and any small-fix exception.\n<!-- /harness-pr-history -->'
}
