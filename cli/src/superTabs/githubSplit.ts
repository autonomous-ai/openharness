/**
 * A piece cut off a task, by command in its builder's own pane: `harness super-tab split owner/repo#N s|m|l TITLE [TEXT]`.
 *
 * Only the PM cut tasks, so how fast one agent cut them set the team's pace. In the 1,000-agent run the lead told its captains
 * to cut the work, and by hour 5.6 the helpers cut it themselves: 73 of them had written 756 tasks, and the hardest statement
 * grew a tree of 2,418 tasks, ten levels deep, each piece cut by a helper that found its own too big for one
 * (docs/research/2026-11-10-swarm-study, section 7). lampOS's builders could not: only its PM opened issues, and a task too
 * large for one pull request waited for it.
 *
 * So a builder cuts a piece off a task it holds (anh Dee, 2026-11-11: "Split what you hold"; new work outside its task still
 * goes to the PM, who owns the product). The piece is a GitHub sub-issue of the task with the size its builder gives it and
 * the task's own part, needs and priority labels, so Harness gives it to the builder who can ship it soonest, as it gives
 * every sized task (githubAssign.ts): the one that cut it does not choose who builds it. A piece is a task: its builder can
 * cut it again.
 *
 * The same command again finishes what an earlier one left: it finds the piece by its title under the task, or the issue it
 * made and could not attach, and posts and records only what is not there.
 */
import { REPLY_TEXT_MAX } from './agentReplies.js'
import { labelOf } from './assign/crew.js'
import type { GitHubReply } from './githubRest.js'
import { hhmm, recordOwn, type VerdictDeps } from './githubVerdict.js'
import { object, SuperTabHostError } from './wire.js'

export interface Split { repository: string; number: number; size: 's' | 'm' | 'l'; title: string; text: string }

/** The most open pieces one task has at a time. The run's captain cut its hardest statement into ten areas, and each grew
 *  deeper as it proved too big; past ten, a piece is cut from a piece. GitHub holds a hundred under one issue, eight deep. */
export const PIECES_MAX = 10
const PAGE = 100, TITLE_MAX = 200
/** How far back an issue this login made and could not attach is looked for. */
const LEFT_MS = 60 * 60_000

/** The piece a `split` request asks for, or null: a repository as `owner/name`, the task's number, the piece's size, its
 *  title on one line, and what it is. */
export function splitAsked(payload: Record<string, unknown>): Split | null {
  const { repository, number, size, title, text } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (!Number.isSafeInteger(number) || Number(number) < 1) return null
  if (size !== 's' && size !== 'm' && size !== 'l') return null
  // eslint-disable-next-line no-control-regex
  if (typeof title !== 'string' || !title.trim() || title.trim().length > TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) return null
  if (typeof text !== 'string' || text.length > REPLY_TEXT_MAX) return null
  return { repository, number: Number(number), size, title: title.trim(), text }
}

const labelsOf = (labels: unknown): string[] => (Array.isArray(labels) ? labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())

/**
 * Cuts [asked] off its task for [builder]: opens the piece, makes it a sub-issue of the task, says so on the task under the
 * builder's name, and records that comment as the builder's. Refused, with nothing changed: a repository that is no project
 * of the builder's, a task that is closed, a pull request or cannot be read, one this builder does not hold, and one with
 * PIECES_MAX open pieces already. `cut` is whether this command changed anything; `sized` is whether GitHub kept the
 * piece's size, without which nobody is given it.
 */
export async function splitTask(deps: VerdictDeps, builder: { name: string; repositories: ReadonlySet<string> }, asked: Split):
  Promise<{ url: string; number: number; cut: boolean; sized: boolean }> {
  const repository = asked.repository.toLowerCase(), at = `${repository}#${asked.number}`, name = builder.name.trim()
  if (!name) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to cut a task under.', 409)
  if (!builder.repositories.has(repository)) {
    throw new SuperTabHostError('REPOSITORY_NOT_PROJECT', `${asked.repository} is not the repository of a project you are in.`, 422)
  }
  // Once the piece is open, a failure names it and says the same command finishes the cut: "nothing was changed" would be false.
  let made = 0
  const again = () => `#${made} is open and not yet ${at}'s piece in full. Run the same command again: it finishes the cut and opens nothing twice.`
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    try { return await call() } catch (error) {
      const said = error instanceof Error ? error.message : 'GitHub could not be reached.'
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', made ? `${said.replace(/[.!]?$/, '.')} ${again()}` : said, 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED',
    made ? `GitHub answered ${status} for ${at}. ${again()}` : `GitHub answered ${status} for ${at}. Nothing was changed.`, 502)
  const issues = `/repos/${repository}/issues`, task = `${issues}/${asked.number}`
  const read = await github(() => deps.get(task, null))
  if (read.status === 404) throw new SuperTabHostError('TASK_NOT_FOUND', `${at} is not an issue this computer's GitHub login can read.`, 404)
  if (read.status !== 200) throw refused(read.status)
  const issue = object(read.body), labels = labelsOf(issue.labels), mine = labelOf(name)
  if (typeof issue.repository_url === 'string' && !issue.repository_url.toLowerCase().endsWith(`/repos/${repository}`)) {
    throw new SuperTabHostError('TASK_NOT_FOUND', `${at} was moved to another repository.`, 404)
  }
  if (issue.pull_request) throw new SuperTabHostError('NOT_A_TASK', `${at} is a pull request. A task is an issue.`, 409)
  if (issue.state !== 'open') throw new SuperTabHostError('TASK_CLOSED', `${at} is closed.`, 409)
  // The label whole, as a claim reads it (githubClaim.ts). New work outside a builder's own task goes to its PM.
  if (!labels.includes(mine) || labels.some(label => label.startsWith('builder:') && label !== mine)) {
    throw new SuperTabHostError('TASK_NOT_YOURS', `${at} is not a task you hold: you cut pieces only off one that carries ${mine}. Other work goes to your PM.`, 409)
  }

  const under = await github(() => deps.get(`${task}/sub_issues?per_page=${PAGE}`, null))
  if (under.status !== 200 || !Array.isArray(under.body)) throw refused(under.status)
  const pieces = under.body.map(object).filter(piece => piece.state === 'open')
  // The same title under the same task is this command again: a builder whose first try timed out.
  let piece = pieces.find(one => String(one.title ?? '') === asked.title)
  const marker = `Part of #${asked.number}.`
  let changed = false
  if (piece) made = Number(piece.number)
  else {
    if (pieces.length >= PIECES_MAX) {
      throw new SuperTabHostError('PIECE_LIMIT', `${at} has ${pieces.length} open pieces already, and ${PIECES_MAX} is the most. `
        + 'Cut a piece off one of them, or wait for one to land.', 409)
    }
    // An earlier command may have opened the issue and failed to attach it: this login's own, of the last hour, with this
    // title and the line that names its task. Another login's, or an older one, is somebody's own issue.
    const login = String((await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body)
    const since = new Date((deps.now ?? Date.now)() - LEFT_MS).toISOString()
    const left = await github(() => deps.get(`${issues}?state=open&creator=${encodeURIComponent(login)}&since=${since}&per_page=${PAGE}`, null))
    if (left.status !== 200 || !Array.isArray(left.body)) throw refused(left.status)
    piece = left.body.map(object).find(one => !one.pull_request && String(one.title ?? '') === asked.title
      && String(one.body ?? '').trimEnd().endsWith(marker) && String(object(one.user).login ?? '').toLowerCase() === login.toLowerCase())
    if (!piece) {
      // Its size, and what the task says of every piece of it: its area, what its machine needs, how urgent it is.
      const carried = labels.filter(label => label.startsWith('part:') || label.startsWith('needs:') || /^p[0-2]$/.test(label))
      const opened = await github(() => deps.send('POST', issues, { title: asked.title, body: `${asked.text.trim() ? `${asked.text.trim()}\n\n` : ''}${marker}`,
        labels: [`size:${asked.size}`, ...carried] }))
      if (opened.status !== 201) throw refused(opened.status)
      piece = object(opened.body)
    }
    made = Number(piece.number)
    if (!Number.isSafeInteger(made) || !Number.isSafeInteger(piece.id)) throw refused(502)
    const attached = await github(() => deps.send('POST', `${task}/sub_issues`, { sub_issue_id: piece!.id }))
    if (attached.status !== 201) throw refused(attached.status)
    changed = true
  }

  // Said on the task, where its people and the quiet watch read what its builder does. A piece found already cut may have its
  // line: this login's newest, under the builder's name, among the task's last comments (as a claim's is, githubClaim.ts).
  const line = `: split off #${made}: `
  let comment: Record<string, unknown> | undefined
  if (!changed) {
    const login = String((await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body).toLowerCase()
    const last = Math.max(1, Math.ceil((Number(issue.comments) || 0) / PAGE))
    for (let page = last; page >= Math.max(1, last - 1) && !comment; page--) {
      const said = await github(() => deps.get(`${task}/comments?per_page=${PAGE}&page=${page}`, null))
      if (said.status !== 200 || !Array.isArray(said.body)) throw refused(said.status)
      comment = said.body.map(object).filter(one => {
        const first = String(one.body ?? '').split('\n')[0] ?? ''
        return first.startsWith(`${name}, `) && /^\d\d:\d\d$/.test(first.slice(name.length + 2, name.length + 7)) && first.slice(name.length + 7).startsWith(line)
          && String(object(one.user).login ?? '').toLowerCase() === login
      }).at(-1)
    }
  }
  if (!comment) {
    const said = await github(() => deps.send('POST', `${task}/comments`, { body: `${name}, ${hhmm((deps.now ?? Date.now)())}${line}${asked.title}` }))
    if (said.status !== 201) throw refused(said.status)
    comment = object(said.body)
    changed = true
  }
  await recordOwn(deps.record, repository, comment, 'Split')
  return { url: String(piece.html_url ?? ''), number: made, cut: changed, sized: labelsOf(piece.labels).includes(`size:${asked.size}`) }
}
