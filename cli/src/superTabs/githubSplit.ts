/**
 * A piece cut off a task, by command in its builder's own pane: `harness super-tab split owner/repo#N s|m|l TITLE [TEXT]`.
 *
 * Only the PM cut tasks, so how fast one agent cut them set the team's pace. In the 1,000-agent run the lead told its captains
 * to cut the work, and by hour 5.6 the helpers cut it themselves: 73 of them had written 756 tasks, and the hardest statement
 * grew a tree of 2,418 tasks, ten levels deep, each piece cut by a helper that found its own too big for one
 * (docs/research/2026-11-10-swarm-study, section 7). lampOS's builders could not: only its PM opened issues, and a task too
 * large for one pull request waited for it.
 *
 * So a builder cuts a piece off a task it took (anh Dee, 2026-11-11: "Split what you hold"; new work outside its task still
 * goes to the PM, who owns the product). The piece is a GitHub sub-issue of the task with the size its builder gives it and
 * the task's own part, needs and priority labels, so Harness gives it to the builder who can ship it soonest, as it gives
 * every sized task (githubAssign.ts): the one that cut it does not choose who builds it. A piece is a task: its builder can
 * cut it again, as deep as GitHub holds (eight levels).
 *
 * A piece is opened without its size, attached, and sized last: the size is what makes an issue a task Harness gives out
 * (assign/crew.ts readProblem), so an issue that could not be attached is never given to anyone. One GitHub refuses to attach
 * for good is closed again. The same command again finishes what an earlier one left: it finds its own piece by its title
 * under the task, or the issue it opened and could not attach, and does only what is not done. Its first review found each of
 * these: an issue left open, sized and given out when the attach was refused; another's sub-issue of the same title taken for
 * the piece; and a piece cut twice by the same command with other words.
 */
import { REPLY_TEXT_MAX } from './agentReplies.js'
import { labelOf } from './assign/crew.js'
import { labelsOf } from './githubClaim.js'
import type { GitHubReply } from './githubRest.js'
import { hhmm, projectRepository, recordOwn, type ProjectRepositories, type VerdictDeps } from './githubVerdict.js'
import { object, SuperTabHostError } from './wire.js'

export interface Split { repository: string; number: number; size: 's' | 'm' | 'l'; title: string; text: string }

/** The most open pieces one task has at a time, the ones not yet attached among them. The run's captain cut its hardest
 *  statement into ten areas, and each grew deeper as it proved too big; past ten, a piece is cut from a piece. */
export const PIECES_MAX = 10
/** The most cuts one agent starts in an hour, on this computer: the run's helpers wrote about two tasks an hour each. A flood
 *  of pieces would push a project's older tasks out of the plan, which reads its newest thousand (githubAssign.ts). */
export const CUTS_PER_HOUR = 30
const HOUR_MS = 60 * 60_000

/**
 * One computer's cuts. Each agent's run one after another, so what a cut reads of its task (its pieces, for PIECES_MAX) is what
 * the cut before it left; and each is counted as it starts, one that fails too, so thirty sent at once are thirty counted. The
 * second review of the split sent ninety in three rounds of thirty, and every one was let through: each had read the count
 * before any had written it. Only the command again, which changes nothing, is not one more. In memory: a restart starts the
 * hour again.
 */
export class Cuts {
  private readonly started = new Map<string, number[]>()
  private readonly last = new Map<string, Promise<void>>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Runs [cut] for [agentId] after its cuts before it, or refuses it when the hour is full. */
  run<T extends { cut: boolean }>(agentId: string, cut: () => Promise<T>): Promise<T> {
    const at = this.now(), recent = (this.started.get(agentId) ?? []).filter(began => at - began < HOUR_MS)
    if (recent.length >= CUTS_PER_HOUR) {
      return Promise.reject(new SuperTabHostError('CUT_LIMIT', `You started ${recent.length} cuts in the last hour, and ${CUTS_PER_HOUR} is the most. `
        + 'Build what is cut, or ask your PM to cut the rest.', 429))
    }
    this.started.set(agentId, [...recent, at])
    const made = (this.last.get(agentId) ?? Promise.resolve()).then(cut).then(done => {
      // Not there any more when it ran for over an hour and a later cut counted the hour afresh.
      const kept = this.started.get(agentId)!, index = done.cut ? -1 : kept.indexOf(at)
      if (index >= 0) kept.splice(index, 1)
      return done
    })
    const tail = made.then(() => {}, () => {})
    this.last.set(agentId, tail)
    void tail.then(() => { if (this.last.get(agentId) === tail) this.last.delete(agentId) })
    return made
  }
}
const PAGE = 100, TITLE_MAX = 200, TAKEN = 'status:taken'
/** How far back an issue this login opened and could not attach is looked for. */
const LEFT_MS = 60 * 60_000

/** What GitHub gave as text, or nothing where it gave none. */
const words = (value: unknown): string => typeof value === 'string' ? value : ''

/** The piece a `split` request asks for, or null: a repository as `owner/name`, the task's number, the piece's size, its
 *  title on one line, and what it is. Harness types a task's title to the builder it is given to (nextThing.ts), so a title
 *  holds no control character and no line or paragraph separator. */
export function splitAsked(payload: Record<string, unknown>): Split | null {
  const { repository, number, size, title, text } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (!Number.isSafeInteger(number) || Number(number) < 1) return null
  if (size !== 's' && size !== 'm' && size !== 'l') return null
  // eslint-disable-next-line no-control-regex
  if (typeof title !== 'string' || !title.trim() || title.trim().length > TITLE_MAX || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(title)) return null
  if (typeof text !== 'string' || text.length > REPLY_TEXT_MAX) return null
  return { repository, number: Number(number), size, title: title.trim(), text }
}

/** What a run of the same cut is known by, whatever its words, its size or the repository's case: a command sent again with
 *  other words while the first still runs joins it, and cuts nothing of its own (service.ts). */
export const sameCut = (asked: Split): string => `split ${asked.repository.toLowerCase()}#${asked.number} ${asked.title}`

/**
 * Cuts [asked] off its task for [builder]: opens the piece, makes it a sub-issue of the task, sizes it, says so on the task
 * under the builder's name, and records that comment as the builder's. Refused, with nothing changed: a repository that is no
 * project of the builder's, a task that is closed, a pull request or cannot be read, one this builder has not taken, a title
 * another's piece of the task has, and one with PIECES_MAX open pieces already. `cut` is whether this command changed
 * anything; `sized` is whether the piece carries a size, without which nobody is given it, and `note` says so.
 */
export async function splitTask(deps: VerdictDeps, builder: { name: string; repositories: ProjectRepositories }, asked: Split):
  Promise<{ url: string; number: number; cut: boolean; sized: boolean; note?: string }> {
  const name = builder.name.trim()
  if (!name) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to cut a task under.', 409)
  const project = projectRepository(builder.repositories, asked.repository), repository = project.github, at = `${repository}#${asked.number}`
  // Once the piece is open, a failure names it and says the same command finishes the cut: "nothing was changed" would be false.
  // And while it is being opened, a failure may have left an issue: the same command finds it.
  let made = 0, opening = false
  const again = () => `#${made} is open and not yet ${at}'s piece in full. Run the same command again: it finishes the cut and opens nothing twice.`
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    try { return await call() } catch (error) {
      const said = error instanceof Error ? error.message : 'GitHub could not be reached.'
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', made ? `${said.replace(/[.!]?$/, '.')} ${again()}`
        : opening ? `${said.replace(/[.!]?$/, '.')} An issue may have been opened for ${at}. Run the same command again: it finds it, and opens nothing twice.` : said, 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED',
    made ? `GitHub answered ${status} for ${at}. ${again()}` : `GitHub answered ${status} for ${at}. Nothing was changed.`, 502)
  const issues = `/repos/${repository}/issues`, task = `${issues}/${asked.number}`
  const read = await github(() => deps.get(task, null))
  if (read.status === 404) throw new SuperTabHostError('TASK_NOT_FOUND', `${at} is not an issue this computer's GitHub login can read.`, 404)
  if (read.status !== 200) throw refused(read.status)
  const issue = object(read.body), labels = labelsOf(issue.labels), mine = labelOf(name)
  const here = (one: Record<string, unknown>) => typeof one.repository_url !== 'string' || one.repository_url.toLowerCase().endsWith(`/repos/${repository}`)
  if (!here(issue)) throw new SuperTabHostError('TASK_NOT_FOUND', `${at} was moved to another repository.`, 404)
  if (issue.pull_request) throw new SuperTabHostError('NOT_A_TASK', `${at} is a pull request. A task is an issue.`, 409)
  if (issue.state !== 'open') throw new SuperTabHostError('TASK_CLOSED', `${at} is closed.`, 409)
  // The label whole, as a claim reads it (githubClaim.ts). New work outside a builder's own task goes to its PM.
  if (!labels.includes(mine) || labels.some(label => label.startsWith('builder:') && label !== mine)) {
    throw new SuperTabHostError('TASK_NOT_YOURS', `${at} is not a task of yours: you cut pieces only off one that carries ${mine}. Other work goes to your PM.`, 409)
  }
  // Taken, not only given: a task that waits for its builder goes to another after ten minutes (githubAssign.ts openWaiting),
  // and its pieces would be cut by one that never worked on it.
  if (!labels.includes(TAKEN)) {
    throw new SuperTabHostError('TASK_NOT_TAKEN', `${at} is given to you and not taken. Take it first: harness super-tab take ${at}.`, 409)
  }

  const login = String((await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body).toLowerCase()
  const marker = `Part of #${asked.number}.`
  // This login's own piece of this task: in this repository, with the line that names its task. A sub-issue anyone else
  // attached, or one of another repository, is not a piece this command cut, whatever its title.
  const own = (one: Record<string, unknown>) => !one.pull_request && here(one) && words(one.body).trimEnd().endsWith(marker)
    && words(object(one.user).login).toLowerCase() === login
  const under = await github(() => deps.get(`${task}/sub_issues?per_page=${PAGE}`, null))
  if (under.status !== 200 || !Array.isArray(under.body)) throw refused(under.status)
  const pieces = under.body.map(object), titled = pieces.filter(one => words(one.title) === asked.title)
  // The same title under the same task is this command again: a builder whose first try timed out, or one that asks again
  // after its context was compacted, when the piece may be built and closed.
  let piece = titled.find(own)
  if (!piece && titled.length) {
    throw new SuperTabHostError('TITLE_TAKEN', `#${titled[0]!.number} under ${at} has this title and is not a piece you cut. Give yours another title.`, 409)
  }
  // Whether this command changed anything, and whether it attached the piece: one attached before may have its line already.
  let changed = false, attachedNow = false
  if (piece) made = Number(piece.number)
  else {
    // An earlier command may have opened the issue and failed to attach it: this login's own, of the last hour.
    const since = new Date((deps.now ?? Date.now)() - LEFT_MS).toISOString()
    const listed = await github(() => deps.get(`${issues}?state=open&creator=${encodeURIComponent(login)}&since=${since}&per_page=${PAGE}`, null))
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw refused(listed.status)
    const attached = new Set(pieces.map(one => Number(one.number)))
    const left = listed.body.map(object).filter(one => own(one) && !attached.has(Number(one.number)))
    const open = pieces.filter(one => one.state === 'open').length + left.length
    piece = left.find(one => words(one.title) === asked.title)
    if (!piece) {
      if (open >= PIECES_MAX) {
        throw new SuperTabHostError('PIECE_LIMIT', `${at} has ${open} open pieces already, and ${PIECES_MAX} is the most. `
          + 'Cut a piece off one of them, or wait for one to land.', 409)
      }
      // What the task says of every piece of it: its area, what its machine needs, how urgent it is. Not yet its size.
      const carried = labels.filter(label => label.startsWith('part:') || label.startsWith('needs:') || /^p[0-2]$/.test(label))
      opening = true
      const opened = await github(() => deps.send('POST', issues, { title: asked.title, body: `${asked.text.trim() ? `${asked.text.trim()}\n\n` : ''}${marker}`, labels: carried }))
      opening = false
      // GitHub failing on its side may have opened it all the same.
      if (opened.status >= 500) {
        throw new SuperTabHostError('GITHUB_REFUSED', `GitHub answered ${opened.status} for ${at}. An issue may have been opened for it. Run the same command again: it finds it, and opens nothing twice.`, 502)
      }
      if (opened.status !== 201) throw refused(opened.status)
      piece = object(opened.body)
      if (!Number.isSafeInteger(piece.number) || !Number.isSafeInteger(piece.id)) {
        throw new SuperTabHostError('GITHUB_REFUSED', `GitHub opened an issue for ${at} and its answer could not be read. Run the same command again: it finds that issue and finishes the cut.`, 502)
      }
    }
    made = Number(piece.number)
    const reply = await github(() => deps.send('POST', `${task}/sub_issues`, { sub_issue_id: piece!.id }))
    // GitHub failing or limiting on its side is worth the command again: its limit on writes answers 403 or 429, with no word of
    // when it lifts. A 403 or a 404 may also be a login that may not attach, which the same command will not get past.
    // A 401 is this computer's login refused, which gh signs in again for the next call.
    if (reply.status >= 500 || reply.status === 429 || reply.status === 401 || reply.resetAt !== null) throw refused(reply.status)
    if (reply.status === 403 || reply.status === 404) {
      throw new SuperTabHostError('GITHUB_REFUSED', `GitHub answered ${reply.status} for ${at}. ${again()} If it answers ${reply.status} again, this login may not attach it: close #${made}.`, 502)
    }
    if (reply.status !== 201) {
      // Refused as it would be again (a task holds a hundred pieces, eight levels deep), unless the piece is under the task
      // after all: an attach whose answer was lost, or a list read before GitHub showed it. Read again before anything is
      // closed: a piece rightly attached was closed as not planned otherwise (second review).
      const now = await github(() => deps.get(`${task}/sub_issues?per_page=${PAGE}`, null))
      if (now.status !== 200 || !Array.isArray(now.body)) throw refused(now.status)
      if (!now.body.map(object).some(one => Number(one.number) === made)) {
        const closed = await deps.send('PATCH', `${issues}/${made}`, { state: 'closed', state_reason: 'not_planned' }).then(answer => answer.status, () => 0)
        throw new SuperTabHostError('PIECE_REFUSED', `GitHub will not make #${made} a piece of ${at}: it answered ${reply.status}. A task holds at most a hundred pieces, eight levels deep. `
          + (closed === 200 ? `#${made} was closed again.` : `#${made} is still open: close it.`), 409)
      }
    }
    // Attached by this answer: its line cannot be on the task yet. Found attached after a refusal, an earlier command may have said it.
    changed = true
    attachedNow = reply.status === 201
  }
  // Found built and closed: there is nothing to finish.
  let sized = labelsOf(piece.labels).some(label => label.startsWith('size:'))
  if (piece.state === 'closed') return { url: words(piece.html_url), number: made, cut: false, sized }
  // Its size last: from here Harness gives it out.
  if (!sized) {
    const put = await github(() => deps.send('POST', `${issues}/${made}/labels`, { labels: [`size:${asked.size}`] }))
    if (put.status !== 200) throw refused(put.status)
    sized = labelsOf(put.body).includes(`size:${asked.size}`)
    changed = true
  }

  // Said on the task, where its people and the quiet watch read what its builder does. A piece found already cut may have its
  // line: this login's newest, under the builder's name, among the task's last comments (as a claim's is, githubClaim.ts).
  const line = `: split off #${made}: `
  let comment: Record<string, unknown> | undefined
  if (!attachedNow) {
    const last = Math.max(1, Math.ceil((Number(issue.comments) || 0) / PAGE))
    for (let page = last; page >= Math.max(1, last - 1) && !comment; page--) {
      const said = await github(() => deps.get(`${task}/comments?per_page=${PAGE}&page=${page}`, null))
      if (said.status !== 200 || !Array.isArray(said.body)) throw refused(said.status)
      comment = said.body.map(object).filter(one => {
        const first = words(one.body).split('\n')[0]!
        return first.startsWith(`${name}, `) && /^\d\d:\d\d$/.test(first.slice(name.length + 2, name.length + 7)) && first.slice(name.length + 7).startsWith(line)
          && words(object(one.user).login).toLowerCase() === login
      }).at(-1)
    }
  }
  if (!comment) {
    const said = await github(() => deps.send('POST', `${task}/comments`, { body: `${name}, ${hhmm((deps.now ?? Date.now)())}${line}${asked.title}` }))
    if (said.status !== 201) throw refused(said.status)
    comment = object(said.body)
    changed = true
  }
  await recordOwn(deps.record, project.project, comment, 'Split')
  return { url: words(piece.html_url), number: made, cut: changed, sized,
    ...sized ? {} : { note: `GitHub did not keep #${made}'s size, and nobody is given a task with none. Ask your PM to size it.` } }
}
