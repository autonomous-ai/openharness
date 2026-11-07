/** Ready's history evidence (#3597). Paths and ancestry prove order, never a test's failure or semantic coverage. */
import { z } from 'zod'

export const HISTORY_COMMITS = 50
export const HISTORY_FILES = 300
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const path = z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !value.split('/').includes('..'))
const file = z.object({ filename: path, previousFilename: path.optional(), status: z.string().min(1).max(20),
  additions: z.number().int().min(0).max(1_000_000_000), deletions: z.number().int().min(0).max(1_000_000_000) })
const history = z.object({ head: sha, commits: z.array(z.object({ sha, parents: z.array(sha).max(2),
  files: z.array(file).max(HISTORY_FILES) })).min(1).max(HISTORY_COMMITS), files: z.array(file).max(HISTORY_FILES) })
type File = z.infer<typeof file>
export type HistoryState = 'pass' | 'fail' | 'unknown' | 'not-needed'
export interface HistoryReport {
  head: string | null
  planFirst: HistoryState
  testBeforeCode: HistoryState
  productionLines: number | null
  totalLines: number | null
  commits: number | null
  merges: number | null
  missingTests: string[]
}
export const unknownHistory = (head: string | null = null): HistoryReport => ({ head, planFirst: 'unknown', testBeforeCode: 'unknown',
  productionLines: null, totalLines: null, commits: null, merges: null, missingTests: [] })

function pathKind(name: string): 'docs' | 'test' | 'code' {
  if (/(^|\/)(?:__tests__|tests?|integration|e2e|fixtures)(\/|$)|(?:^|\/)test_[^/]+\.[^/]+$|\.(?:test|spec|test-support)\.[^/]+$|_test\.dart$/i.test(name)) return 'test'
  return /^docs\//.test(name) || /\.(?:md|rst|txt)$/i.test(name) ? 'docs' : 'code'
}
function kind(file: File): ReturnType<typeof pathKind> {
  const kinds = [file.filename, ...file.previousFilename ? [file.previousFilename] : []].map(pathKind)
  return kinds.includes('code') ? 'code' : kinds.includes('test') ? 'test' : 'docs'
}

/** Commit order is oldest first and checked against local parents. Size is the net PR diff, never commit churn. */
export function checkPrHistory(input: unknown): HistoryReport {
  // Reject excessive lists before schema validation walks their contents.
  const value = input as z.infer<typeof history> | null
  if (!value || !Array.isArray(value.commits) || value.commits.length > HISTORY_COMMITS || !Array.isArray(value.files)
    || value.files.length > HISTORY_FILES || value.commits.some(c => !c || !Array.isArray(c.files) || c.files.length > HISTORY_FILES)) return unknownHistory()
  const parsed = history.safeParse(input)
  if (!parsed.success) return unknownHistory()
  const { head, commits, files } = parsed.data
  const bySha = new Map(commits.map((commit, index) => [commit.sha, { ...commit, index }]))
  if (bySha.size !== commits.length || commits.at(-1)!.sha !== head || commits.some((commit, index) =>
    commit.parents.some(parent => bySha.has(parent) && bySha.get(parent)!.index >= index))) return unknownHistory(head)
  const hasCode = (commit: typeof commits[number]) => commit.files.some(f => kind(f) === 'code')
  const production = commits.filter(c => c.parents.length < 2 && hasCode(c))
  const merges = commits.filter(c => c.parents.length === 2).length
  const needsOrder = production.length > 0 || files.some(f => kind(f) === 'code')
  const first = commits.find(c => c.parents.length < 2)
  const planFirst = !needsOrder ? 'not-needed' : first && first.files.every(f => kind(f) === 'docs')
    && first.files.some(f => /^docs\/plans\/[^/]+-plan\.md$/.test(f.filename) && f.status === 'added') ? 'pass' : 'fail'
  const missingTests: string[] = []
  for (const commit of production) {
    let parent = bySha.get(commit.parents[0] ?? '')
    let priorTest = false
    while (parent && parent.parents.length < 2 && !hasCode(parent)) {
      if (parent.files.some(f => kind(f) === 'test')) { priorTest = true; break }
      parent = bySha.get(parent.parents[0] ?? '')
    }
    if (!priorTest) missingTests.push(commit.sha)
  }
  return { head, planFirst, testBeforeCode: !needsOrder ? 'not-needed' : missingTests.length ? 'fail' : merges ? 'unknown' : 'pass',
    productionLines: files.filter(f => kind(f) === 'code').reduce((sum, f) => sum + f.additions + f.deletions, 0),
    totalLines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0), commits: commits.length, merges, missingTests }
}
