/**
 * A shard's result, said by command on the exact commit it ran on: `harness super-tab suite passed|failed owner/repo SHA SHARD`.
 *
 * The suites CI does not run were run by hand on one computer, and what they found was a sentence in a pull request
 * (docs/validation-and-release.md: "Record what you ran"). Nothing a program reads said which commit a suite passed on, or on
 * whose computer. So the computer that ran a shard says so here, as a reader says its verdict (githubVerdict.ts): Harness
 * finds the commit, reads the project's suites file as that commit has it (suites.ts), and sets a commit status named
 * `suite: <shard>` there with this computer's own gh login, which GitHub then shows as that person's. The train counts it as
 * any check of the commit (githubMerge.ts checksOf): a failure holds what it is on, and a pass lands nothing by itself.
 *
 * Only in a private repository. There every collaborator can set any status already, and the team accepts each other's word.
 * In an open project a result counts when computers of different people agree, which is not built
 * (docs/design/2026-11-11-swarm-allocator/suites-across-machines.md).
 *
 * It runs nothing: the shard was run by a person or an agent, by hand. Its row must be in the file at that commit, so a
 * result is said only for what the project lists, under no other check's name.
 */
import type { GitHubGet, GitHubReply, GitHubSend } from './githubRest.js'
import { projectRepository, type ProjectRepositories } from './githubVerdict.js'
import { shardName, shardsOf, SUITE_CHECK, SUITES_FILE } from './suites.js'
import { object, SuperTabHostError } from './wire.js'

export interface SuiteResult { repository: string; sha: string; shard: string; result: 'passed' | 'failed' }

export interface SuiteDeps {
  get: GitHubGet
  send: GitHubSend
  /** This computer's GitHub login, which set any status the command set before. */
  login: () => Promise<string>
}

/** The most times one login says one shard's result on one commit: a rerun after its computer was mended says it again, and a
 *  command sent in a loop with one result and then the other must not write in its person's name without end. GitHub keeps a
 *  thousand statuses of one name on a commit. */
export const SAID_MAX = 5
/** A commit's statuses are read a page of this many, the newest first: its own among them are looked for there. */
const PAGE = 100
/** The most of an agent's name a status says: GitHub takes a short description. */
const NAME_SAID_MAX = 60

/** The result a `suite` request asks to say, or null: a repository as `owner/name`, the commit it ran on (7 to 40 hex
 *  digits, as GitHub shortens it), a shard's name, and how it ended. */
export function suiteAsked(payload: Record<string, unknown>): SuiteResult | null {
  const { repository, sha, shard, result } = payload
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || repository.includes('..')) return null
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) return null
  if (!shardName(shard) || (result !== 'passed' && result !== 'failed')) return null
  return { repository, sha, shard, result }
}

/**
 * Says [asked] on its commit as [agent]'s person: a status `suite: <shard>`, success or failure. Refused, with nothing said:
 * a repository that is no project of the agent's, or that GitHub does not call private; a commit GitHub does not know there;
 * a shard the suites file does not list at that commit; and a sixth time for one shard on one commit. `said` is whether this
 * command set a status: the result this login said last for the shard there is not said twice.
 */
export async function saySuite(deps: SuiteDeps, agent: { name: string; repositories: ProjectRepositories }, asked: SuiteResult):
  Promise<{ commit: string; check: string; said: boolean }> {
  // One line, as the status says it: a name is the Swarm's text.
  const name = [...agent.name.replace(/[\s\p{Cc}]+/gu, ' ').trim()].slice(0, NAME_SAID_MAX).join('')
  if (!name) throw new SuperTabHostError('AGENT_UNNAMED', 'This agent has no name to say a result under.', 409)
  const repository = projectRepository(agent.repositories, asked.repository).github, at = `${repository} at ${asked.sha}`
  const github = async (call: () => Promise<GitHubReply>): Promise<GitHubReply> => {
    // gh missing or signed out, or GitHub out of reach: said in gh's own words.
    try { return await call() } catch (error) {
      throw new SuperTabHostError('GITHUB_UNAVAILABLE', error instanceof Error ? error.message : 'GitHub could not be reached.', 503)
    }
  }
  const refused = (status: number) => new SuperTabHostError('GITHUB_REFUSED', `GitHub answered ${status} for ${at}. Nothing was said.`, 502)

  const about = await github(() => deps.get(`/repos/${repository}`, null))
  if (about.status !== 200) throw refused(about.status)
  if (object(about.body).private !== true) {
    throw new SuperTabHostError('NOT_PRIVATE', `${repository} is not a private repository: a suite's result is said only in one.`, 403)
  }
  const found = await github(() => deps.get(`/repos/${repository}/commits/${asked.sha}`, null))
  const unknown = () => new SuperTabHostError('COMMIT_NOT_FOUND', `${at} is not a commit this computer's GitHub login can read.`, 404)
  // 422: digits that name no commit. 404: none of this repository's.
  if (found.status === 404 || found.status === 422) throw unknown()
  if (found.status !== 200) throw refused(found.status)
  // GitHub answers a branch's or a tag's name with its tip: the commit asked for is the one whose id begins with the digits.
  const commit = String(object(found.body).sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(commit) || !commit.startsWith(asked.sha)) throw unknown()

  // The file as that commit has it: a row changed in the same change as the code it is for.
  const file = await github(() => deps.get(`/repos/${repository}/contents/${SUITES_FILE}?ref=${commit}`, null))
  if (file.status !== 200 && file.status !== 404) throw refused(file.status)
  const body = object(file.body)
  // None for a file that is not there, a folder of its name, and one too large for GitHub to send whole.
  const shards = shardsOf(typeof body.content === 'string' && body.encoding === 'base64' ? Buffer.from(body.content, 'base64').toString('utf8') : null)
  if (!shards.some(shard => shard.name === asked.shard)) {
    throw new SuperTabHostError('SHARD_NOT_FOUND', `${repository} has no shard named ${asked.shard} in ${SUITES_FILE} at ${commit.slice(0, 7)}. `
      + (shards.length ? `Its shards there: ${shards.map(shard => shard.name).join(', ')}.` : 'That file has no shard there.'), 404)
  }

  const check = `${SUITE_CHECK}${asked.shard}`, state = asked.result === 'passed' ? 'success' : 'failure'
  const login = String((await github(async () => ({ status: 200, etag: null, resetAt: null, body: await deps.login() }))).body).toLowerCase()
  const listed = await github(() => deps.get(`/repos/${repository}/commits/${commit}/statuses?per_page=${PAGE}`, null))
  // Any answer but a list: a refusal carries none.
  if (!Array.isArray(listed.body)) throw refused(listed.status)
  // What this login said of the shard on the commit, the newest first. Another person's is theirs to say.
  const mine = listed.body.map(object).filter(status => status.context === check && String(object(status.creator).login ?? '').toLowerCase() === login)
  // The same result as it said last is this command arriving twice.
  if (mine[0]?.state === state) return { commit, check, said: false }
  if (mine.length >= SAID_MAX) {
    throw new SuperTabHostError('RESULT_LIMIT', `You said ${check} on ${commit.slice(0, 7)} ${mine.length} times, and ${SAID_MAX} is the most: it stands as GitHub shows it.`, 429)
  }
  const made = await github(() => deps.send('POST', `/repos/${repository}/statuses/${commit}`, { state, context: check, description: `${asked.result}, said by ${name}` }))
  if (made.status !== 201) throw refused(made.status)
  return { commit, check, said: true }
}
