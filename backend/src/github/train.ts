/**
 * The merge train's calls to GitHub (task #3402, superTabs/mergeTrain/): read main and pull requests, build a batch branch
 * from main with the git data API (no checkout, so no code of any branch runs on the server), open its pull request,
 * squash-merge it at the exact head CI passed, and close the originals. Every write is the Harness GitHub App's installation
 * token, never a person's.
 *
 * Fail closed: any answer that is not exactly what the call expects throws [TrainReadError], and the pass then writes
 * nothing more for that batch. The branch the train writes never points at a member's own commit: GitHub's activity log
 * would then show the app's bot pushing it, which marks the member's task Team-written (pushOrigin.ts).
 */
import { GitHubAppError, type GitHubApp } from './app.js'
import type { GitHubRepository } from './repository.js'
import { TRAIN_BRANCH_PREFIX, TRAIN_CI_CHECK } from '../superTabs/mergeTrain/config.js'

/** What the train's token may do: build and delete its branches and merge (contents), open, merge, comment on and close pull
 *  requests, and read checks. Among the app's own permissions ([TOKEN_PERMISSIONS]); no workflows, issues or actions. */
export const TRAIN_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' } as const

export class TrainReadError extends Error {
  constructor(readonly call: string, readonly status: number) { super(`GitHub answered ${call} with HTTP ${status}, not what the train expects`) }
}

/** A pull request as the train reads it. */
export interface TrainPull {
  number: number
  url: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  title: string
  body: string
  mergeable: boolean | null
  head: string
  headRef: string
  base: string
  labels: string[]
}

export type TrainCall = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>

export interface TrainGitHub {
  mainHead(): Promise<string>
  openPulls(): Promise<TrainPull[]>
  pull(number: number): Promise<TrainPull>
  files(number: number): Promise<string[]>
  ciRequired(sha: string): Promise<'success' | 'failure' | 'pending' | null>
  createBranch(name: string, sha: string): Promise<void>
  /** Merges [sha] into the train's [branch]: the new merge commit, or `conflict`. */
  mergeInto(branch: string, sha: string, message: string): Promise<{ sha: string } | 'conflict'>
  openPull(branch: string, title: string, body: string): Promise<TrainPull>
  /** Squash-merges pull request [number] only if its head is still [sha]: the commit on main. */
  squash(number: number, sha: string, title: string, message: string): Promise<{ sha: string }>
  comment(number: number, text: string): Promise<void>
  close(number: number): Promise<void>
  deleteBranch(name: string): Promise<void>
}

const SHA = /^[0-9a-f]{40}$/
/** Pages of a pull request's files read at most: GitHub lists 3,000 files at most, and the train reads no partial list. */
const FILE_PAGES = 30
const PULL_PAGES = 5
const PASSED = new Set(['success', 'neutral'])

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const text = (value: unknown): string | null => typeof value === 'string' ? value : null

/** The train's calls on `owner/name` [repository] through [call]. */
export function trainGitHub(call: TrainCall, repository: string): TrainGitHub {
  const base = `/repos/${repository}`
  const expect = async (method: string, path: string, statuses: number[], body?: unknown) => {
    const answer = await call(method, `${base}${path}`, body).catch(error => {
      if (error instanceof GitHubAppError) throw new TrainReadError(`${method} ${path}`, 0)
      throw error
    })
    if (!statuses.includes(answer.status)) throw new TrainReadError(`${method} ${path}`, answer.status)
    return answer
  }
  const sha = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || !SHA.test(value)) throw new TrainReadError(what, 200)
    return value
  }
  const own = (name: string, what: string) => {
    if (!name.startsWith(TRAIN_BRANCH_PREFIX) || name.length === TRAIN_BRANCH_PREFIX.length || /\.\.|[\s~^:?*[\\]/.test(name)) throw new TrainReadError(what, 0)
  }
  const pullOf = (value: unknown, what: string, number?: number): TrainPull => {
    const body = object(value), head = object(body.head), into = object(body.base)
    const state = body.state
    if (typeof body.number !== 'number' || (number !== undefined && body.number !== number) || (state !== 'open' && state !== 'closed')
      || typeof body.draft !== 'boolean' || !text(body.html_url) || !text(head.ref) || !text(into.ref)) throw new TrainReadError(what, 200)
    const mergeable = body.mergeable === true || body.mergeable === false ? body.mergeable : null
    return { number: body.number, url: text(body.html_url)!, state, merged: body.merged === true, draft: body.draft, title: text(body.title) ?? '',
      body: text(body.body) ?? '', mergeable, head: sha(head.sha, what), headRef: text(head.ref)!, base: text(into.ref)!,
      labels: Array.isArray(body.labels) ? body.labels.map(label => text(object(label).name)).filter((n): n is string => !!n) : [] }
  }
  return {
    async mainHead() {
      const answer = object((await expect('GET', '/git/ref/heads/main', [200])).body), target = object(answer.object)
      if (answer.ref !== 'refs/heads/main' || target.type !== 'commit') throw new TrainReadError('main', 200)
      return sha(target.sha, 'main')
    },
    async openPulls() {
      const all: TrainPull[] = []
      for (let page = 1; page <= PULL_PAGES; page++) {
        const answer = (await expect('GET', `/pulls?state=open&base=main&per_page=100&page=${page}`, [200])).body
        if (!Array.isArray(answer)) throw new TrainReadError('open pulls', 200)
        all.push(...answer.map(entry => pullOf(entry, 'open pulls')))
        if (answer.length < 100) return all
      }
      throw new TrainReadError('open pulls: too many', 200)
    },
    async pull(number) {
      return pullOf((await expect('GET', `/pulls/${number}`, [200])).body, `pull ${number}`, number)
    },
    async files(number) {
      const all: string[] = []
      for (let page = 1; page <= FILE_PAGES; page++) {
        const answer = (await expect('GET', `/pulls/${number}/files?per_page=100&page=${page}`, [200])).body
        if (!Array.isArray(answer)) throw new TrainReadError(`files ${number}`, 200)
        for (const entry of answer) {
          const name = text(object(entry).filename)
          if (!name) throw new TrainReadError(`files ${number}`, 200)
          all.push(name)
          // A rename changes its old path too.
          const before = text(object(entry).previous_filename)
          if (before) all.push(before)
        }
        if (answer.length < 100) return all
      }
      throw new TrainReadError(`files ${number}: too many`, 200)
    },
    async ciRequired(head) {
      sha(head, 'ci head')
      const answer = object((await expect('GET', `/commits/${head}/check-runs?check_name=${encodeURIComponent(TRAIN_CI_CHECK)}&filter=latest`, [200])).body)
      if (!Array.isArray(answer.check_runs)) throw new TrainReadError('ci', 200)
      const runs = answer.check_runs.map(object).filter(run => run.name === TRAIN_CI_CHECK)
      if (!runs.length) return null
      if (runs.some(run => run.status !== 'completed')) return 'pending'
      return runs.every(run => PASSED.has(String(run.conclusion))) ? 'success' : 'failure'
    },
    async createBranch(name, from) {
      own(name, 'create branch')
      await expect('POST', '/git/refs', [201], { ref: `refs/heads/${name}`, sha: sha(from, 'branch base') })
    },
    async mergeInto(branch, head, message) {
      own(branch, 'merge')
      const answer = await expect('POST', '/merges', [201, 409], { base: branch, head: sha(head, 'merge head'), commit_message: message })
      if (answer.status === 409) return 'conflict'
      const body = object(answer.body), merged = sha(body.sha, 'merge')
      // Always a merge commit of its own, with the member as its second parent: never the member's commit itself.
      if (merged === head || !Array.isArray(body.parents) || body.parents.length !== 2) throw new TrainReadError('merge: not a merge commit', 201)
      return { sha: merged }
    },
    async openPull(branch, title, body) {
      own(branch, 'open pull')
      return pullOf((await expect('POST', '/pulls', [201], { head: branch, base: 'main', title, body, draft: false })).body, 'open pull')
    },
    async squash(number, head, title, message) {
      const answer = object((await expect('PUT', `/pulls/${number}/merge`, [200],
        { sha: sha(head, 'squash head'), merge_method: 'squash', commit_title: title, commit_message: message })).body)
      if (answer.merged !== true) throw new TrainReadError(`squash ${number}`, 200)
      return { sha: sha(answer.sha, `squash ${number}`) }
    },
    async comment(number, body) {
      await expect('POST', `/issues/${number}/comments`, [201], { body })
    },
    async close(number) {
      await expect('PATCH', `/pulls/${number}`, [200], { state: 'closed' })
    },
    async deleteBranch(name) {
      own(name, 'delete branch')
      // Gone already reads as done.
      await expect('DELETE', `/git/refs/heads/${name}`, [204, 422])
    },
  }
}

/** The train's calls on [repository] with one [TRAIN_PERMISSIONS] token for the pass, revoked by `done`; null where the app
 *  is not installed. */
export async function repositoryTrain(app: Pick<GitHubApp, 'installation' | 'createToken' | 'installationCall' | 'revoke'>, repository: GitHubRepository):
  Promise<(TrainGitHub & { done(): Promise<void> }) | null> {
  const installation = await app.installation(repository)
  if (installation === null) return null
  const { token } = await app.createToken(installation, repository, TRAIN_PERMISSIONS)
  const train = trainGitHub((method, path, body) => app.installationCall(token, method, path, body), `${repository.owner}/${repository.name}`)
  return { ...train, done: () => app.revoke(token).catch(() => {}) }
}
