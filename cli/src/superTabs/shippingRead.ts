/**
 * What a person's agents shipped, read from GitHub with this computer's own `gh`, as that person (the Swarm leaderboard,
 * docs/plans/2026-11-09-swarm-v4-leaderboard.md). An agent ships an issue when the issue carries its label `builder:<name>`, is closed
 * as completed, a pull request that closes it merged under this person's own login, and no revert of that pull request merged
 * within 7 days of its merge. Only counts leave this module: per agent and week, the issues shipped by priority label. Titles,
 * branches and repositories are read to decide and never kept.
 */
import { ghError, type Run } from '../lib/github.js'
import { builderLabel } from './githubMentions.js'

/** Why a reading failed: the codes of `gh`'s own errors (lib/github.ts ghError) and this module's bound on what it reads. */
export type ReadFailure = 'GH_MISSING' | 'GH_SIGNED_OUT' | 'RATE_LIMITED' | 'TIMEOUT' | 'GH_FAILED' | 'TOO_MANY'
export class ShippingReadError extends Error {
  constructor(readonly code: ReadFailure, message: string) { super(message) }
}

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'none'] as const
export type Priority = typeof PRIORITIES[number]
export interface WeekShipped extends Record<Priority, number> { week: number }
/** An agent to read for: its id, the name it goes by, the label its issues carry and the first week still open to a revert. */
export interface ReadAgent { id: string; name: string; label: string; from: number }

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
/** How long after its merge a revert still counts against a pull request. */
export const REVERT_WINDOW_MS = 7 * DAY_MS
/** Results one search returns a page of, and how many pages one search may take: an agent with more closed in its window than this
 *  is read as too many, never as fewer. */
const PAGE = 100
export const MAX_PAGES = 5
/** What a GitHub label may be. */
const MAX_LABEL = 50

/** The Monday 00:00 UTC of the week holding `ms`, as the backend's board counts weeks. */
export const weekStart = (ms: number): number => Math.floor((ms - 4 * DAY_MS) / WEEK_MS) * WEEK_MS + 4 * DAY_MS

/** The label an agent's issues carry (githubMentions.ts builderLabel), or null when it cannot be searched for as one label: it
 *  does not fit a label, or has what the search syntax would read as more (a quote, a comma, a backslash). */
export function labelFor(name: string): string | null {
  const label = builderLabel(name)
  return name.trim() && [...label].length <= MAX_LABEL && !/[\p{C}",\\]/u.test(label) ? label : null
}

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''

const REPOSITORY = 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner } }'
const ISSUES = `query($q: String!, $after: String) { viewer { login }
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { closedAt stateReason labels(first: 30) { nodes { name } }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title merged mergedAt author { login } } } } } } }`
const REVERTS = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${PAGE}, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number title body mergedAt } } } }`

/** `gh api graphql` with this person's login: its answer's `data`, or why it could not be had. A repository GitHub says it cannot
 *  find (one this person has no access to answers as one that is not there) is `null`, not a failure. */
async function graphql(run: Run, query: string, variables: Record<string, string>): Promise<Json | null> {
  let answer: Json
  try {
    answer = object(JSON.parse((await run(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([name, value]) => ['-f', `${name}=${value}`])])).stdout))
  } catch (error) {
    if (error instanceof SyntaxError) throw new ShippingReadError('GH_FAILED', 'GitHub answered something that is not JSON.')
    if (/could not resolve to a repository|not found|HTTP 404/i.test(String((error as { stderr?: unknown } | null)?.stderr ?? ''))) return null
    const failed = ghError(error)
    throw new ShippingReadError(failed.code as ReadFailure, failed.message)
  }
  if (list(answer.errors).length || !Object.keys(object(answer.data)).length) throw new ShippingReadError('GH_FAILED', 'GitHub could not answer the question.')
  return object(answer.data)
}

/** One search, every page of it (at most MAX_PAGES). */
async function search(run: Run, query: string, q: string): Promise<{ viewer: string; nodes: Json[] }> {
  const nodes: Json[] = []
  let viewer = '', after: string | null = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await graphql(run, query, { q, ...after ? { after } : {} })
    const found = object(object(data).search)
    if (!Object.keys(found).length) throw new ShippingReadError('GH_FAILED', 'GitHub could not answer the search.')
    viewer ||= text(object(object(data).viewer).login)
    nodes.push(...list(found.nodes))
    const next = object(found.pageInfo)
    if (next.hasNextPage !== true) return { viewer, nodes }
    after = text(next.endCursor)
  }
  throw new ShippingReadError('TOO_MANY', `More than ${MAX_PAGES * PAGE} results for one search.`)
}

/** The name GitHub gives `owner/name` now: a search by `repo:` does not follow a rename, a project may still hold the old name.
 *  Null for a repository this person cannot see, which has nothing of theirs to read. `known` keeps the names found, for the next
 *  reading. */
async function nameOf(run: Run, repository: string, known: Map<string, string>): Promise<string | null> {
  if (known.has(repository)) return known.get(repository)!
  const [owner, name] = repository.split('/')
  const found = text(object(object(await graphql(run, REPOSITORY, { owner: owner!, name: name! })).repository).nameWithOwner) || null
  // Only a name that was found is kept: one that was not may be a sign-in or a network away from being found.
  if (found) known.set(repository, found)
  return found
}

/** The issue's priority: its highest P0 to P3 label, else none. */
function priorityOf(labels: Json[]): Priority {
  const found = labels.map(label => /^P([0-3])$/i.exec(text(label.name))?.[1]).filter((digit): digit is string => digit !== undefined)
  return found.length ? `P${Math.min(...found.map(Number))}` as Priority : 'none'
}

/** An issue closed as completed, and the pull requests of this person's own that merged for it. */
interface Shipment { week: number; priority: Priority; merged: Array<{ number: number; title: string; at: number }> }

/**
 * Every issue `agent` closed as completed since `from` (a Monday) in `repository` that a pull request of this person's own merged
 * for. The pull request must be this person's, which is what keeps two people's agents of one name from sharing what the other
 * shipped: the label names an agent, the login says whose.
 */
async function closedBy(run: Run, repository: string, agent: ReadAgent): Promise<Shipment[]> {
  const since = new Date(agent.from).toISOString().slice(0, 10)
  const { viewer, nodes } = await search(run, ISSUES, `repo:${repository} is:issue is:closed closed:>=${since} label:"${agent.label}"`)
  return nodes.flatMap(issue => {
    const closed = Date.parse(text(issue.closedAt))
    if (!(closed >= agent.from) || ['NOT_PLANNED', 'DUPLICATE'].includes(text(issue.stateReason))) return []
    const labels = list(object(issue.labels).nodes)
    // The search finds a label by its words: the issue must carry this agent's own.
    if (!labels.some(label => text(label.name).toLowerCase() === agent.label)) return []
    const merged = list(object(issue.closedByPullRequestsReferences).nodes)
      .filter(pr => pr.merged === true && Date.parse(text(pr.mergedAt)) > 0 && text(object(pr.author).login).toLowerCase() === viewer.toLowerCase())
      .map(pr => ({ number: Number(pr.number), title: text(pr.title), at: Date.parse(text(pr.mergedAt)) }))
    return merged.length ? [{ week: weekStart(closed), priority: priorityOf(labels), merged }] : []
  })
}

interface Merged { number: number; title: string; body: string; at: number }

/** The pull requests of `repository` merged since `since` that have "revert" in their title. */
async function revertsSince(run: Run, repository: string, since: number): Promise<Merged[]> {
  const day = new Date(since).toISOString().slice(0, 10)
  const { nodes } = await search(run, REVERTS, `repo:${repository} is:pr is:merged merged:>=${day} revert in:title`)
  return nodes.map(pr => ({ number: Number(pr.number), title: text(pr.title), body: text(pr.body), at: Date.parse(text(pr.mergedAt)) })).filter(pr => pr.at > 0)
}

/** Whether `revert`, merged within REVERT_WINDOW_MS of `merged`, undoes it: GitHub's own `Revert "<title>"`, or it says it reverts
 *  the pull request by number (`Reverts #12`, `Reverts owner/name#12`, its address), in its body or its title. */
function undoes(revert: Merged, merged: Shipment['merged'][number]): boolean {
  if (revert.number === merged.number || revert.at < merged.at || revert.at - merged.at > REVERT_WINDOW_MS) return false
  if (revert.title.trim().toLowerCase() === `Revert "${merged.title}"`.toLowerCase()) return true
  const number = `${merged.number}(?!\\d)`
  return new RegExp(`\\brevert(?:s|ed)?\\s+(?:[\\w.-]+/[\\w.-]+#|#|https://github\\.com/[\\w.-]+/[\\w.-]+/pull/)${number}`, 'i').test(revert.body)
    || new RegExp(`^revert\\b.*#${number}`, 'i').test(revert.title.trim())
}

/**
 * What each agent shipped in each week since its own `from`, by priority: the weeks with something shipped only. Every repository is
 * read for every agent, and a failure in any of them fails the whole reading, never a smaller one. The reverts are looked for once
 * a repository, since the earliest merge there. A repository this person cannot see has nothing of theirs and is left out.
 */
export async function readShipped(run: Run, repositories: readonly string[], agents: readonly ReadAgent[],
  names: Map<string, string> = new Map()): Promise<Map<string, WeekShipped[]>> {
  const weeks = new Map<string, Map<number, WeekShipped>>(agents.map(agent => [agent.id, new Map()]))
  for (const given of repositories) {
    const repository = await nameOf(run, given, names)
    if (!repository) continue
    const read: Array<{ agent: ReadAgent; shipments: Shipment[] }> = []
    for (const agent of agents) read.push({ agent, shipments: await closedBy(run, repository, agent) })
    const merges = read.flatMap(({ shipments }) => shipments.flatMap(shipment => shipment.merged.map(merged => merged.at)))
    const reverted = merges.length ? await revertsSince(run, repository, Math.min(...merges)) : []
    for (const { agent, shipments } of read) {
      for (const shipment of shipments) {
        // Shipped while any pull request that closed it stands: only when every one of them was reverted is it not.
        if (shipment.merged.every(merged => reverted.some(revert => undoes(revert, merged)))) continue
        const mine = weeks.get(agent.id)!
        const week = mine.get(shipment.week) ?? { week: shipment.week, P0: 0, P1: 0, P2: 0, P3: 0, none: 0 }
        week[shipment.priority]++
        mine.set(shipment.week, week)
      }
    }
  }
  return new Map([...weeks].map(([id, byWeek]) => [id, [...byWeek.values()].sort((a, b) => a.week - b.week)]))
}
