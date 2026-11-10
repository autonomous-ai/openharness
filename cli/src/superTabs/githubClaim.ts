/**
 * A task's claim, made by command in the builder's own pane: `harness super-tab take owner/repo#N`.
 *
 * A builder used to claim an issue by hand: the label `status:taken` and a comment "taken by <name>". Done by hand, issues
 * were worked with no claim, two builders claimed one (lampOS, 30 October: each handed it to the other and both stepped back),
 * and one builder held eleven at once while others had none. So the claim is made here, by lampOS's own rule
 * (lampOS/docs/joining.md "Claiming an issue"): the comment is the claim, GitHub orders the comments, and the first claim
 * there holds the task. The comment is recorded with the backend as the calling agent's (backend superTabs/githubComments.ts).
 */
import { labelOf, sameKey } from './assign/crew.js'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'
import { object, SuperTabHostError } from './wire.js'

export interface Claim { repository: string; number: number }

export interface ClaimDeps {
  get: GitHubGet
  send: GitHubSend
  /** Tells the backend that the builder wrote the GitHub comment [commentId] on [repository]. */
  record: (repository: string, commentId: string) => Promise<void>
  now?: () => number
}

/** The most tasks one builder holds at once, as lampOS set it (four, with sub-agents): past it, work sits on a busy builder
 *  while others have none. */
export const CLAIM_LIMIT = 4
/** How far back another builder's claim counts as made at the same moment. An older one is from a holder that gave the task
 *  back, or it would still be labelled. */
const SAME_MOMENT_MS = 2 * 60_000
const TAKEN = 'status:taken'

/** The claim a `take` request asks for, or null: a repository as `owner/name` and an issue's number. */
export function claimAsked(payload: Record<string, unknown>): Claim | null {
  const { repository, number } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (!Number.isSafeInteger(number) || Number(number) < 1) return null
  return { repository, number: Number(number) }
}

const hhmm = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
const labelsOf = (issue: Record<string, unknown>): string[] => (Array.isArray(issue.labels) ? issue.labels.map(object) : []).map(label => String(label.name ?? ''))

/**
 * Takes [asked] for [builder]. Refused, with nothing changed: a repository that is no project of the builder's, an issue that
 * is closed, a pull request or cannot be read, one given to another builder or taken by someone who is none, and a claim
 * past CLAIM_LIMIT. A task the builder already holds is taken already: the command twice does its work once.
 */
export async function takeTask(deps: ClaimDeps, builder: { name: string; repositories: ReadonlySet<string> }, asked: Claim): Promise<{ url: string; taken: boolean }> {
  const repository = asked.repository.toLowerCase(), at = `${repository}#${asked.number}`, name = builder.name.trim()
  if (!name) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to take a task under.', 409)
  if (!builder.repositories.has(repository)) {
    throw new SuperTabHostError('REPOSITORY_NOT_PROJECT', `${asked.repository} is not the repository of a project you are in.`, 422)
  }
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    try { return await call() } catch (error) {
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', error instanceof Error ? error.message : 'GitHub could not be reached.', 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED', `GitHub answered ${status} for ${at}. Nothing was changed.`, 502)
  const issues = `/repos/${repository}/issues`
  const read = await github(() => deps.get(`${issues}/${asked.number}`, null))
  if (read.status === 404) throw new SuperTabHostError('TASK_NOT_FOUND', `${at} is not an issue this computer's GitHub login can read.`, 404)
  if (read.status !== 200) throw refused(read.status)
  const issue = object(read.body), labels = labelsOf(issue), mine = labelOf(name)
  if (issue.pull_request) throw new SuperTabHostError('NOT_A_TASK', `${at} is a pull request. A task is an issue.`, 409)
  if (issue.state !== 'open') throw new SuperTabHostError('TASK_CLOSED', `${at} is closed.`, 409)
  const holders = labels.filter(label => /^builder:/i.test(label)), held = holders.some(label => sameKey(label) === sameKey(mine))
  const other = holders.find(label => sameKey(label) !== sameKey(mine))
  if (other) throw new SuperTabHostError('TASK_NOT_YOURS', `${at} is given to ${other.slice('builder:'.length)}. Take a task that is yours, or one nobody holds.`, 409)
  if (labels.includes(TAKEN)) {
    if (held) return { url: String(issue.html_url ?? ''), taken: false }
    throw new SuperTabHostError('TASK_TAKEN', `${at} is taken already, by someone who is no builder here.`, 409)
  }
  // What this builder holds now, read with the two labels together: an index read on GitHub's side, a page at most.
  const holding = await github(() => deps.get(`${issues}?state=open&labels=${encodeURIComponent(`${mine},${TAKEN}`)}&per_page=${CLAIM_LIMIT + 1}`, null))
  if (holding.status !== 200 || !Array.isArray(holding.body)) throw refused(holding.status)
  const tasks = holding.body.map(object).filter(task => !task.pull_request).map(task => `#${String(task.number)}`)
  if (tasks.length >= CLAIM_LIMIT) {
    throw new SuperTabHostError('CLAIM_LIMIT', `You hold ${tasks.length} tasks already (${tasks.join(', ')}), and ${CLAIM_LIMIT} is the most. Finish or release one first.`, 409)
  }

  const now = (deps.now ?? Date.now)()
  // The comment is the claim. GitHub orders the comments, so of two builders that claim at the same moment both read the same
  // first claim, and exactly one holds the task.
  const made = await github(() => deps.send('POST', `${issues}/${asked.number}/comments`, { body: `${name}, ${hhmm(now)}: taken by ${name}` }))
  if (made.status !== 201) throw refused(made.status)
  const comment = object(made.body)
  const said = await github(() => deps.get(`${issues}/${asked.number}/comments?since=${new Date(now - SAME_MOMENT_MS).toISOString()}&per_page=100`, null))
  if (said.status !== 200 || !Array.isArray(said.body)) throw refused(said.status)
  const claim = (body: unknown) => /^(.+?), \d\d:\d\d: taken by \1$/.exec(String(body ?? '').split('\n')[0] ?? '')?.[1]
  const first = said.body.map(object).find(other => claim(other.body))
  if (first && first.id !== comment.id) {
    // Not this builder's task: its own claim comes off, so the issue reads as its holder left it.
    await github(() => deps.send('DELETE', `${issues}/comments/${String(comment.id)}`))
    throw new SuperTabHostError('TASK_TAKEN', `${at} was taken by ${claim(first.body)} at the same moment. It is theirs: take another.`, 409)
  }
  const labelled = await github(() => deps.send('POST', `${issues}/${asked.number}/labels`, { labels: held ? [TAKEN] : [TAKEN, mine] }))
  if (labelled.status !== 200) throw refused(labelled.status)
  const url = String(comment.html_url ?? '')
  try { await deps.record(repository, String(comment.id)) } catch (error) {
    throw new SuperTabHostError('NOT_RECORDED', `Taken (${url}), but it is not recorded as yours: ${error instanceof Error ? error.message : 'the server did not answer.'}`, 503)
  }
  return { url, taken: true }
}
