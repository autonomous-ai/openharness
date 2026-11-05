/**
 * The release watch (task #3405): every 5 minutes the singleton worker reads GitHub for each project with a release list to
 * settle, and hands what it read to the store's one write (store.ts settleReleases, releases.ts). A component's verified
 * release is its own release workflow's newest successful run on a pushed release tag (`v1.3.78_desktop`): that workflow
 * builds and checks the release's artifacts, so its success is the tag plus its artifacts. Only a tag on the default branch
 * counts, with the time its commit landed there. Every read fails closed: a read GitHub does not answer marks nothing and
 * opens nothing, and the pass says which projects it could not read.
 */
import type { PrismaClient } from '@prisma/client'
import { RELEASE_READ_PERMISSIONS, type GitHubApp } from '../github/app.js'
import { githubRepository, type GitHubRepository } from '../github/repository.js'
import { reflectionCandidates } from '../lib/routingReflection.js'
import type { SuperTabState } from './model.js'
import { projectsOf } from './projects.js'
import { componentsOf, isReleaseTag, PENDING_MAX, RELEASE_COMPONENTS, type ReleaseComponent, type ReleaseComponentId, type ReleaseFacts,
  type VerifiedRelease } from './releases.js'
import type { SuperTabStore } from './store.js'
import { logger } from '../utils/logger.js'

/** One GET in [repository]: its status (0 when it could not be asked), body, and the next page's path. */
export type GitHubGet = (repository: GitHubRepository, path: string) => Promise<{ status: number; body: unknown; next?: string }>

/** What the watch asks GitHub. `files`: a pull request's changed files, null when GitHub cannot say. `latest`: a component's
 *  newest verified release on the default branch, undefined when there is none, null when GitHub cannot say. */
export interface ReleaseReader {
  files(repository: GitHubRepository, number: number): Promise<string[] | null>
  latest(repository: GitHubRepository, component: ReleaseComponent): Promise<VerifiedRelease | null | undefined>
  done(): Promise<void>
}

/** A pull request's files are read 100 a page, at most this many pages (GitHub lists 3000 files at most). */
const FILE_PAGES = 30
type Run = { head_branch?: unknown; head_sha?: unknown; event?: unknown; conclusion?: unknown; run_started_at?: unknown; created_at?: unknown }

/** The reads, over [get]. Each repository's default branch is read once per reader. */
export function readReleases(get: GitHubGet): Omit<ReleaseReader, 'done'> {
  const branches = new Map<string, Promise<string | null>>()
  const branch = (repository: GitHubRepository) => {
    const key = repository.fullName.toLowerCase()
    if (!branches.has(key)) branches.set(key, get(repository, `/repos/${repository.fullName}`).then(answer => {
      const name = (answer.body as { default_branch?: unknown } | null)?.default_branch
      return answer.status === 200 && typeof name === 'string' && name ? name : null
    }))
    return branches.get(key)!
  }
  return {
    async files(repository, number) {
      const files: string[] = []
      let path: string | undefined = `/repos/${repository.fullName}/pulls/${number}/files?per_page=100`
      for (let page = 0; path && page < FILE_PAGES; page++) {
        const answer = await get(repository, path)
        if (answer.status !== 200 || !Array.isArray(answer.body)) return null
        for (const file of answer.body as Array<{ filename?: unknown; previous_filename?: unknown }>) {
          for (const name of [file.filename, file.previous_filename]) if (typeof name === 'string') files.push(name)
        }
        path = answer.next
      }
      return files
    },
    async latest(repository, component) {
      const runs = await get(repository, `/repos/${repository.fullName}/actions/workflows/${component.workflow}/runs?event=push&status=success&per_page=30`)
      if (runs.status === 404) return undefined
      const list = (runs.body as { workflow_runs?: unknown } | null)?.workflow_runs
      if (runs.status !== 200 || !Array.isArray(list)) return null
      // Newest first, as GitHub lists them.
      const found = (list as Run[]).find(run => run.event === 'push' && run.conclusion === 'success' && typeof run.head_sha === 'string'
        && typeof run.head_branch === 'string' && isReleaseTag(component, run.head_branch))
      if (!found) return undefined
      const main = await branch(repository)
      if (!main) return null
      const compare = await get(repository, `/repos/${repository.fullName}/compare/${found.head_sha as string}...${encodeURIComponent(main)}`)
      if (compare.status !== 200) return null
      const body = compare.body as { status?: unknown; base_commit?: { commit?: { committer?: { date?: unknown } } } }
      // Main at or ahead of the tag: the tag's commit is on main. A tag cut elsewhere carries what main's time says nothing of.
      if (body.status !== 'ahead' && body.status !== 'identical') return undefined
      const committedAt = Date.parse(String(body.base_commit?.commit?.committer?.date ?? ''))
      const at = Date.parse(String(found.run_started_at ?? found.created_at ?? ''))
      if (Number.isNaN(committedAt) || Number.isNaN(at)) return null
      return { tag: found.head_branch as string, sha: found.head_sha as string, at, committedAt }
    },
  }
}

/** Reads with the Harness GitHub App: one read-only token per repository for the whole pass, revoked when it is done. A
 *  repository the app is not installed on, or any GitHub failure, reads as unknown. */
export function appReleaseReader(app: GitHubApp): ReleaseReader {
  const tokens = new Map<string, Promise<string | null>>()
  const token = (repository: GitHubRepository) => {
    const key = repository.fullName.toLowerCase()
    if (!tokens.has(key)) tokens.set(key, (async () => {
      const installation = await app.installation(repository)
      return installation === null ? null : (await app.createToken(installation, repository, RELEASE_READ_PERMISSIONS)).token
    })().catch(() => null))
    return tokens.get(key)!
  }
  const get: GitHubGet = async (repository, path) => {
    const granted = await token(repository)
    return granted ? app.get(path, granted).catch(() => ({ status: 0, body: null })) : { status: 0, body: null }
  }
  return {
    ...readReleases(get),
    async done() {
      for (const granted of tokens.values()) {
        const value = await granted
        if (value) await app.revoke(value).catch(() => {})
      }
      tokens.clear()
    },
  }
}

/** Without the Harness GitHub App nothing can say a release is verified: every read is unknown, and each pass says so. */
export const unknownReleases: ReleaseReader = { files: async () => null, latest: async () => null, done: async () => {} }

const PULL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/
type Log = Pick<typeof logger, 'warn' | 'info'>

/**
 * One pass at [now]: each Swarm with work this week (the routing reflection's candidates), each of its projects whose release
 * list has a task waiting or a step open and whose repository is on GitHub. It reads the files of each task not read yet,
 * and the newest verified release of each component something waits for, then settles the project in one write. A project
 * it could not read is logged and skipped; the others go on. The projects settled.
 */
export async function watchReleases(db: PrismaClient, store: Pick<SuperTabStore, 'settleReleases'>, reader: ReleaseReader, now: number,
  log: Log = logger): Promise<number> {
  let settled = 0
  try {
    for (const [tabId, projectIds] of await reflectionCandidates(db, now, log)) {
      const head = await db.swarmHead.findUnique({ where: { id: `${tabId}:head` }, select: { deleted: true, data: true } })
      if (!head || head.deleted) continue
      for (const project of projectsOf(head.data as unknown as SuperTabState).filter(p => projectIds.includes(p.id))) {
        const ledger = project.releases
        const repository = githubRepository(project.repository?.repositoryUrl)
        if (!ledger || !repository || (!ledger.pending.length && !Object.keys(ledger.steps ?? {}).length)) continue
        try {
          const facts: ReleaseFacts = { components: [], releases: {} }
          let unread = 0
          for (const entry of ledger.pending.filter(e => !e.components)) {
            const match = PULL.exec(entry.url)
            const files = match && `${match[1]}/${match[2]}`.toLowerCase() === repository.fullName.toLowerCase() ? await reader.files(repository, Number(match[3])) : null
            if (files) facts.components.push({ groupId: entry.groupId, url: entry.url, components: componentsOf(files) })
            else unread++
          }
          const needed = new Set<ReleaseComponentId>([...ledger.pending.flatMap(e => e.components ?? []), ...facts.components.flatMap(c => c.components),
            ...Object.keys(ledger.steps ?? {}) as ReleaseComponentId[]])
          const unknown: string[] = []
          for (const component of RELEASE_COMPONENTS.filter(c => needed.has(c.id))) {
            const release = await reader.latest(repository, component)
            if (release) facts.releases[component.id] = release
            else if (release === null) unknown.push(component.id)
          }
          if (unread || unknown.length) {
            log.warn('[swarm-releases] GitHub could not say; those tasks stay waiting and no step opens on a guess', { tabId, projectId: project.id,
              repository: repository.fullName, unreadPullRequests: unread, unreadReleases: unknown })
          }
          if (ledger.pending.length >= PENDING_MAX) log.warn('[swarm-releases] release list full: the oldest merges leave it unshipped', { tabId, projectId: project.id, max: PENDING_MAX })
          const outcome = await store.settleReleases(tabId, project.id, facts)
          settled++
          if (outcome?.dropped.length) {
            log.warn('[swarm-releases] merges no release carried in 14 days left the list unshipped', { tabId, projectId: project.id, groups: outcome.dropped.map(e => e.groupId) })
          }
          if (outcome && (outcome.shipped.length || outcome.opened)) {
            log.info('[swarm-releases] settled', { tabId, projectId: project.id, shipped: outcome.shipped.length, opened: outcome.opened })
          }
        } catch (error) {
          log.warn('[swarm-releases] project skipped', { tabId, projectId: project.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
  } finally { await reader.done() }
  return settled
}

/** Runs the release watch every 5 minutes in the singleton worker. */
export function startReleaseWatch(db: PrismaClient, store: Pick<SuperTabStore, 'settleReleases'>, reader: () => ReleaseReader, everyMs = 5 * 60_000): () => void {
  let running = false
  const run = () => {
    if (running) return
    running = true
    void watchReleases(db, store, reader(), Date.now())
      .catch(error => logger.warn('[swarm-releases] pass failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = false })
  }
  run()
  const timer = setInterval(run, everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
