/** Read metadata only from the project's GitHub repository. Never run PR code or follow caller-supplied pagination URLs. */
import { z } from 'zod'
import type { GitHubApp } from '../github/app.js'
import type { GitHubRepository } from '../github/repository.js'
import { checkPrHistory, HISTORY_COMMITS, HISTORY_FILES, unknownHistory, type HistoryReport } from './prHistory.js'

export const HISTORY_READ_MS = 10_000
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const meta = z.object({ head: z.object({ sha }), commits: z.number().int().min(1).max(HISTORY_COMMITS),
  changed_files: z.number().int().min(0).max(HISTORY_FILES) })
const commit = z.object({ sha, parents: z.array(z.object({ sha })).max(2) })

/** The API has a ten-second timeout per call; stop starting reads after a shared ten-second Ready budget.
 * Four concurrent commit reads, three file pages each at most. A partial read is always unknown. */
export async function readPrHistory(get: GitHubApp['get'], repository: GitHubRepository, number: number, token: string,
  head: string, until = Date.now() + HISTORY_READ_MS): Promise<HistoryReport> {
  const unknown = () => unknownHistory(head)
  const base = `/repos/${repository.owner}/${repository.name}`
  const read = async (path: string) => Date.now() >= until ? null : await get(path, token)
  try {
    const pull = await read(`${base}/pulls/${number}`)
    const parsed = meta.safeParse(pull?.status === 200 ? pull.body : null)
    if (!parsed.success || parsed.data.head.sha !== head) return unknown()
    const listed = await read(`${base}/pulls/${number}/commits?per_page=100&page=1`)
    if (listed?.status !== 200 || listed.next || !Array.isArray(listed.body) || listed.body.length !== parsed.data.commits) return unknown()
    const commits = z.array(commit).max(HISTORY_COMMITS).safeParse(listed.body)
    if (!commits.success || commits.data.at(-1)?.sha !== head) return unknown()
    const files = async (path: string, at?: string): Promise<unknown[] | null> => {
      const kept: unknown[] = []
      for (let page = 1; page <= HISTORY_FILES / 100; page++) {
        const answer = await read(`${path}?per_page=100&page=${page}`)
        if (answer?.status !== 200) return null
        const body = answer.body as { sha?: unknown; files?: unknown } | null
        const rows = at ? body?.sha === at ? body.files : null : answer.body
        if (!Array.isArray(rows) || rows.length > 100) return null
        kept.push(...rows)
        if (!answer.next) return kept
      }
      return null
    }
    const net = await files(`${base}/pulls/${number}/files`)
    if (!net || net.length !== parsed.data.changed_files) return unknown()
    const facts: Array<{ sha: string; parents: string[]; files: unknown[] }> = []
    for (let i = 0; i < commits.data.length; i += 4) {
      const batch = await Promise.all(commits.data.slice(i, i + 4).map(async c => ({ sha: c.sha, parents: c.parents.map(p => p.sha),
        files: await files(`${base}/commits/${c.sha}`, c.sha) })))
      if (batch.some(c => c.files === null)) return unknown()
      facts.push(...batch as typeof facts)
    }
    // Normalize the API's snake-case rename field without copying patches, messages or author data.
    const clean = (rows: unknown[]) => rows.map(value => {
      const f = value as Record<string, unknown> | null
      return { filename: f?.filename, previousFilename: f?.previous_filename, status: f?.status, additions: f?.additions, deletions: f?.deletions }
    })
    return checkPrHistory({ head, commits: facts.map(c => ({ ...c, files: clean(c.files) })), files: clean(net) })
  } catch {
    return unknown()
  }
}
