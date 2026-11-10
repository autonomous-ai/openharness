/**
 * A task's claim, made by command in the builder's own pane: `harness super-tab take owner/repo#N`.
 *
 * A builder used to claim an issue by hand: the label `status:taken` and a comment "taken by <name>". Done by hand, issues
 * were worked with no claim, two builders claimed one (lampOS, 30 October: each handed it to the other and both stepped back),
 * and one builder held eleven at once while others had none. So the claim is made here.
 *
 * A builder takes only a task given to it: one that carries its `builder:` label, which the PM or the assigner puts on
 * (githubAssign.ts). The first take of #3907 let a builder claim an issue nobody held and settled two claims at once by the
 * order of their comments; its review found that a clock ahead of GitHub's, a stranger's comment in the claim's form, or a
 * failure half way each broke it. With the task given first there is one builder that may take it, and nothing to settle.
 *
 * The label goes on first and the comment second, and the same command again finishes what an earlier one left: it puts on
 * what is missing, and posts and records only what is not there. The comment is recorded with the backend as the calling
 * agent's (backend superTabs/githubComments.ts).
 */
import { labelOf } from './assign/crew.js'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'
import { hhmm, recordOwn } from './githubVerdict.js'
import { object, SuperTabHostError } from './wire.js'

export interface Claim { repository: string; number: number }

export interface ClaimDeps {
  get: GitHubGet
  send: GitHubSend
  /** Tells the backend that the builder wrote the GitHub comment [commentId] on [repository]. The same record again costs nothing. */
  record: (repository: string, commentId: string) => Promise<void>
  /** This computer's GitHub login, which wrote any comment the command made before. */
  login: () => Promise<string>
  now?: () => number
}

/** The most tasks one builder holds at once, as lampOS set it (four, with sub-agents): past it, work sits on a busy builder
 *  while others have none. One builder runs one command at a time, so what it holds is read, then added to. */
export const CLAIM_LIMIT = 4
const TAKEN = 'status:taken', PAGE = 100
/** How many pages of taken tasks are read for the limit. A builder's own fit in one; three bound the read for a name with
 *  a comma, whose tasks are found among everyone's (below). */
const HELD_PAGES = 3
/** How much of another builder's label a refusal shows: the label is anyone's words. */
const SHOWN = 30

/** The claim a `take` request asks for, or null: a repository as `owner/name` and an issue's number. */
export function claimAsked(payload: Record<string, unknown>): Claim | null {
  const { repository, number } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (!Number.isSafeInteger(number) || Number(number) < 1) return null
  return { repository, number: Number(number) }
}

/** An issue's labels as GitHub compares them: whatever their case. */
const labelsOf = (labels: unknown): string[] => (Array.isArray(labels) ? labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
/** Another builder's label, for a refusal: its letters and digits alone, and not much of it. Anyone who may label an issue
 *  writes it, so its words are never passed to the agent as Harness's own. */
const shown = (label: string): string =>
  `builder:${label.slice('builder:'.length).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, SHOWN)}`

/**
 * Takes [asked] for [builder]: marks it `status:taken`, says so in a comment under the builder's name, and records the
 * comment as the builder's. Refused, with nothing changed: a repository that is no project of the builder's, an issue that is
 * closed, a pull request or cannot be read, one not given to this builder, and a claim past CLAIM_LIMIT. `taken` is whether
 * this command changed anything: a task taken in full already is not taken again.
 */
export async function takeTask(deps: ClaimDeps, builder: { name: string; repositories: ReadonlySet<string> }, asked: Claim): Promise<{ url: string; taken: boolean }> {
  const repository = asked.repository.toLowerCase(), at = `${repository}#${asked.number}`, name = builder.name.trim()
  if (!name) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to take a task under.', 409)
  if (!builder.repositories.has(repository)) {
    throw new SuperTabHostError('REPOSITORY_NOT_PROJECT', `${asked.repository} is not the repository of a project you are in.`, 422)
  }
  // Once the label is on, a failure says so and that the same command finishes the claim: "nothing was changed" would be false.
  let labelled = false
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    // gh missing or signed out, or GitHub out of reach: said in gh's own words.
    try { return await call() } catch (error) {
      const said = error instanceof Error ? error.message : 'GitHub could not be reached.'
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', labelled ? `${said} ${at} is labelled taken: run the same command again to finish the claim.` : said, 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED', labelled
    ? `GitHub answered ${status} for ${at} after it was labelled taken. Run the same command again: it finishes the claim.`
    : `GitHub answered ${status} for ${at}. Nothing was changed.`, 502)
  const issues = `/repos/${repository}/issues`, task = `${issues}/${asked.number}`
  const read = await github(() => deps.get(task, null))
  if (read.status === 404) throw new SuperTabHostError('TASK_NOT_FOUND', `${at} is not an issue this computer's GitHub login can read.`, 404)
  if (read.status !== 200) throw refused(read.status)
  const issue = object(read.body), labels = labelsOf(issue.labels), mine = labelOf(name)
  if (issue.pull_request) throw new SuperTabHostError('NOT_A_TASK', `${at} is a pull request. A task is an issue.`, 409)
  if (issue.state !== 'open') throw new SuperTabHostError('TASK_CLOSED', `${at} is closed.`, 409)
  // The label whole, not its letters alone: "Pip Two" is builder:pip-two, and builder:piptwo is another agent's.
  const another = (held: string[]) => held.find(label => label.startsWith('builder:') && label !== mine)
  const other = another(labels)
  if (other) throw new SuperTabHostError('TASK_NOT_YOURS', `${at} is given to another builder (${shown(other)}).`, 409)
  if (!labels.includes(mine)) throw new SuperTabHostError('TASK_NOT_GIVEN', `${at} is not given to you. A task is yours once it carries ${mine}.`, 409)

  let changed = false
  if (labels.includes(TAKEN)) labelled = true
  else {
    // What this builder holds now, read with its two labels together: an index read on GitHub's side. GitHub reads a comma
    // in that filter as "and", so a name with one is looked for among every taken task, as far as HELD_PAGES.
    const held: number[] = []
    for (let page = 1; page <= HELD_PAGES; page++) {
      const holding = await github(() => deps.get(`${issues}?state=open&labels=${encodeURIComponent(mine.includes(',') ? TAKEN : `${mine},${TAKEN}`)}&per_page=${PAGE}&page=${page}`, null))
      if (holding.status !== 200 || !Array.isArray(holding.body)) throw refused(holding.status)
      // GitHub lists pull requests among issues: a builder's open pull request is not a task it holds.
      for (const one of holding.body.map(object)) if (!one.pull_request && labelsOf(one.labels).includes(mine)) held.push(Number(one.number))
      if (holding.body.length < PAGE) break
    }
    if (held.length >= CLAIM_LIMIT) {
      throw new SuperTabHostError('CLAIM_LIMIT', `You hold ${held.length} tasks already (${held.sort((a, b) => a - b).map(number => `#${number}`).join(', ')}), `
        + `and ${CLAIM_LIMIT} is the most. Finish or release one first.`, 409)
    }
    const put = await github(() => deps.send('POST', `${task}/labels`, { labels: [TAKEN] }))
    if (put.status !== 200) throw refused(put.status)
    // GitHub answers with the labels the issue carries now. The assigner moves a task nobody took to a builder that is free:
    // one moved between the read above and the label would be marked taken for a builder that never took it, with this one
    // at work on it too. The mark comes off again.
    const now = labelsOf(put.body), moved = another(now)
    if (moved || !now.includes(mine)) {
      const to = moved ? `given to another builder (${shown(moved)})` : 'taken back from you'
      const off = await deps.send('DELETE', `${task}/labels/${encodeURIComponent(TAKEN)}`).then(reply => reply.status, () => 0)
      // 404: the label is off already.
      throw new SuperTabHostError('TASK_NOT_YOURS', off === 200 || off === 404 ? `${at} was ${to} as you took it. It is not marked taken.`
        : `${at} was ${to} as you took it, and GitHub ${off ? `answered ${off}` : 'did not answer'} when ${TAKEN} was taken off it. Take that label off.`, 409)
    }
    labelled = changed = true
  }

  // A task marked before this command may have its comment already (the command twice, or a record that failed): its own is
  // the newest in the claim's form, under its name, that this computer's login wrote. The comment follows the label at once,
  // so it is looked for where the issue's newest comments are, two pages back at most; past that the command posts again.
  let comment: Record<string, unknown> | undefined
  if (!changed) {
    const login = String((await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body).toLowerCase()
    const open = `${name}, `, close = `: taken by ${name}`
    const own = (said: Record<string, unknown>): boolean => {
      const line = String(said.body ?? '').split('\n')[0] ?? ''
      return line.startsWith(open) && line.endsWith(close) && /^\d\d:\d\d$/.test(line.slice(open.length, line.length - close.length))
        && String(object(said.user).login ?? '').toLowerCase() === login
    }
    const last = Math.max(1, Math.ceil((Number(issue.comments) || 0) / PAGE))
    for (let page = last; page >= Math.max(1, last - 1) && !comment; page--) {
      const said = await github(() => deps.get(`${task}/comments?per_page=${PAGE}&page=${page}`, null))
      if (said.status !== 200 || !Array.isArray(said.body)) throw refused(said.status)
      comment = said.body.map(object).filter(own).at(-1)
    }
  }
  if (!comment) {
    const made = await github(() => deps.send('POST', `${task}/comments`, { body: `${name}, ${hhmm((deps.now ?? Date.now)())}: taken by ${name}` }))
    if (made.status !== 201) throw refused(made.status)
    comment = object(made.body)
    changed = true
  }
  return { url: await recordOwn(deps.record, repository, comment, 'Taken'), taken: changed }
}
