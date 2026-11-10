/**
 * A read's verdict, made by command in the reader's own pane: `harness super-tab read ok|hold owner/repo#N SHA [TEXT]`.
 *
 * A reader used to type its verdict as a comment ("Juno, 16:21: READ-OK f6edb44"), and the merger knew the reader by the
 * name that comment opens with. lampOS's bot changed how it reads such comments at least 12 times in nine days and still
 * carried the wrong pull request at least 18 times in 368 trains; by 10 November it could not tell who wrote a third of the
 * verdicts. v4 needed 24 repairs to the same reading in its first two days, and an author could type another agent's name
 * (docs/research/2026-11-10-swarm-study). So the verdict is made here: Harness reads the head, writes the comment in the
 * one form the merger reads, and tells the backend which agent wrote it (backend superTabs/githubComments.ts), from the
 * session that ran the command (service.ts: a harness speaks as its own agent alone).
 *
 * The comment keeps lampOS's form, for a person to read on the pull request. The merger as it is reads the reader from that
 * form only for a name of one or two plain words (githubMerge.ts SIGNATURE); it counts the recorded agent, whatever its
 * name, once it reads the record.
 */
import { REPLY_TEXT_MAX } from './agentReplies.js'
import { isWriter, writersOf } from './githubMerge.js'
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'
import { object, SuperTabHostError } from './wire.js'

export interface Verdict { repository: string; number: number; verdict: 'READ-OK' | 'HOLD'; sha: string; text: string }

export interface VerdictDeps {
  get: GitHubGet
  send: GitHubSend
  /** Tells the backend that the reader wrote the GitHub comment [commentId] on [repository]. The same record again costs nothing. */
  record: (repository: string, commentId: string) => Promise<void>
  /** This computer's GitHub login, which wrote any comment the command made before. */
  login: () => Promise<string>
  now?: () => number
}

/** How far back an earlier comment is looked for, so that a command that arrives twice posts once, and how many pages of
 *  that hour are read: past them the reader's own comment is not looked for, and the command posts. */
const TWICE_MS = 60 * 60_000, TWICE_PAGES = 3, PAGE = 100

/** The verdict a `read` request asks for, or null: a repository as `owner/name`, a pull request's number, the head the
 *  reader was asked to read (7 to 40 hex digits, as GitHub shortens it), and the reader's words, which a HOLD must have. */
export function verdictAsked(payload: Record<string, unknown>): Verdict | null {
  const { repository, number, verdict, sha, text } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (!Number.isSafeInteger(number) || Number(number) < 1) return null
  if (verdict !== 'READ-OK' && verdict !== 'HOLD') return null
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) return null
  if (typeof text !== 'string' || text.length > REPLY_TEXT_MAX || (verdict === 'HOLD' && !text.trim())) return null
  return { repository, number: Number(number), verdict, sha, text }
}

const hhmm = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Posts [asked] on its pull request as [reader] and records it as the reader's. Refused, with nothing posted: a repository
 * that is no project of the reader's, a pull request that is closed or cannot be read, a head that moved since the reader
 * was asked (a verdict is on the head that was read), and the pull request's own writer.
 */
export async function postVerdict(deps: VerdictDeps, reader: { name: string; repositories: ReadonlySet<string> }, asked: Verdict):
  Promise<{ url: string; head: string; posted: boolean }> {
  const repository = asked.repository.toLowerCase(), at = `${repository}#${asked.number}`
  // The comment opens with the reader's name, for people and for the merger: an agent with none cannot sign one.
  if (!reader.name.trim()) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to sign a verdict with.', 409)
  if (!reader.repositories.has(repository)) {
    throw new SuperTabHostError('REPOSITORY_NOT_PROJECT', `${asked.repository} is not the repository of a project you are in.`, 422)
  }
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    // gh missing or signed out, or GitHub out of reach: said in gh's own words.
    try { return await call() } catch (error) {
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', error instanceof Error ? error.message : 'GitHub could not be reached.', 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED', `GitHub answered ${status} for ${at}. Nothing was posted.`, 502)
  const read = await github(() => deps.get(`/repos/${repository}/pulls/${asked.number}`, null))
  if (read.status === 404) throw new SuperTabHostError('PULL_NOT_FOUND', `${at} is not a pull request this computer's GitHub login can read.`, 404)
  if (read.status !== 200) throw refused(read.status)
  const pull = object(read.body), head = String(object(pull.head).sha ?? '')
  if (pull.state !== 'open') throw new SuperTabHostError('PULL_CLOSED', `${at} is closed: there is nothing to read.`, 409)
  if (!/^[0-9a-f]{40}$/.test(head) || !head.startsWith(asked.sha)) {
    throw new SuperTabHostError('HEAD_MOVED', `${at} is now at ${head.slice(0, asked.sha.length)}, not ${asked.sha}. Read that head, then run the command with it.`, 409)
  }
  if (isWriter(writersOf(pull), reader.name)) throw new SuperTabHostError('OWN_PULL_REQUEST', `${at} is your own pull request. Another agent reads it.`, 403)

  const now = (deps.now ?? Date.now)()
  const words = asked.text.trim()
  const line = (time: string) => `${reader.name.trim()}, ${time}: ${asked.verdict} ${head}`
  const body = `${line(hhmm(now))}${words ? `\n\n${words}` : ''}`
  // The same verdict in the same words on the same head, as the newest thing this reader said of the head in the last hour,
  // is this command arriving twice: a reader whose first try timed out, or one whose record failed (below). Only the time
  // in the line may differ. Anything it said of the head since makes it a new verdict (a HOLD said again after a READ-OK
  // took the first HOLD for it, and the merger read READ-OK), and so does another login's comment that reads the same.
  const login = (await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body
  const own: Array<Record<string, unknown>> = []
  for (let page = 1; page <= TWICE_PAGES; page++) {
    const said = await github(() => deps.get(`/repos/${repository}/issues/${asked.number}/comments?since=${new Date(now - TWICE_MS).toISOString()}&per_page=${PAGE}&page=${page}`, null))
    if (said.status !== 200 || !Array.isArray(said.body)) throw refused(said.status)
    const mine = (line: string) => /^(.*?), \d\d:\d\d: (?:READ-OK|HOLD) ([0-9a-f]{40})$/.exec(line)
    for (const comment of said.body.map(object)) {
      const first = mine(String(comment.body ?? '').split('\n')[0] ?? '')
      if (first && first[1] === reader.name.trim() && first[2] === head && String(object(comment.user).login ?? '').toLowerCase() === String(login).toLowerCase()) own.push(comment)
    }
    if (said.body.length < PAGE) break
  }
  const timeless = (text: string) => text.replace(/^(.*?), \d\d:\d\d: /, '$1, 00:00: ')
  const newest = own.at(-1)
  let comment = newest && timeless(String(newest.body ?? '')) === timeless(body) ? newest : undefined
  const posted = !comment
  if (!comment) {
    const made = await github(() => deps.send('POST', `/repos/${repository}/issues/${asked.number}/comments`, { body }))
    if (made.status !== 201) throw refused(made.status)
    comment = object(made.body)
  }
  const url = String(comment.html_url ?? '')
  try { await deps.record(repository, String(comment.id)) } catch (error) {
    const said = error instanceof Error ? error.message : 'the server did not answer.'
    // What the server refuses for good (another agent's comment, a repository of no project) the same command would be
    // refused again: said as the server said it. A busy or unreachable server is worth the command again.
    if (error instanceof SuperTabHostError && error.status >= 400 && error.status < 500 && error.status !== 429) {
      throw new SuperTabHostError('NOT_RECORDED', `Posted (${url}), but it is not recorded as yours: ${said} (${error.code})`, error.status)
    }
    throw new SuperTabHostError('NOT_RECORDED', `Posted (${url}), but Harness could not record it as yours: ${said} `
      + 'Run the same command again: it will not post twice.', 503)
  }
  return { url, head, posted }
}
