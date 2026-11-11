/**
 * What a person's agents shipped, read from GitHub with this computer's own `gh`, as that person (the Swarm leaderboard,
 * docs/plans/2026-11-09-swarm-v4-leaderboard.md). An agent ships an issue when the issue carries its label `builder:<name>`, is closed
 * as completed, a pull request that closes it merged under this person's own login, and no revert of that pull request merged
 * within 7 days of its merge. Only counts leave this module: per agent and week, the issues shipped by priority label. Titles,
 * branches and repositories are read to decide and never kept.
 *
 * A revert is found by "revert" in its title, which is how GitHub's own Revert button writes it (`Revert "<title>"`); one that says so
 * only in its body, under another title, is not seen. A body search would match every pull request whose template has a revert plan.
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
/** What was read for an agent: the weeks it shipped something in, or why it could not be read. */
export type Reading = { agent: ReadAgent; weeks: WeekShipped[] } | { agent: ReadAgent; failed: ReadFailure }

const DAY_MS = 86_400_000
export const WEEK_MS = 7 * DAY_MS
/** How long after its merge a revert still counts against a pull request. */
export const REVERT_WINDOW_MS = 7 * DAY_MS
/** Results one search returns a page of, and how many pages one search may take: a window with more than this is read a week at a time,
 *  and a week with more than this is read as too many, never as fewer. */
const PAGE = 100
export const MAX_PAGES = 5
/** What a GitHub label may be. */
const MAX_LABEL = 50

/** The Monday 00:00 UTC of the week holding `ms`, as the backend's board counts weeks. */
export const weekStart = (ms: number): number => Math.floor((ms - 4 * DAY_MS) / WEEK_MS) * WEEK_MS + 4 * DAY_MS
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

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
 *  resolve (one this person has no access to answers as one that is not there) is `null`, not a failure. Nothing else is: a missing
 *  gh, a sign-in, a limit or a wrong host all say what they are. */
async function graphql(run: Run, query: string, variables: Record<string, string>): Promise<Json | null> {
  let answer: Json
  try {
    answer = object(JSON.parse((await run(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(variables).flatMap(([name, value]) => ['-f', `${name}=${value}`])])).stdout))
  } catch (error) {
    if (error instanceof SyntaxError) throw new ShippingReadError('GH_FAILED', 'GitHub answered something that is not JSON.')
    if (/could not resolve to a repository/i.test(String((error as { stderr?: unknown } | null)?.stderr ?? ''))) return null
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

/** A search over everything since `from`: one search, or, when that is more than a search holds, a week's search at a time up to `now`
 *  (`range` makes the query's date range of a start and an end). A window is at most the weeks the backend names, which bounds the slices. */
async function since(run: Run, query: string, range: (dates: string) => string, from: number, now: number): Promise<{ viewer: string; nodes: Json[] }> {
  try {
    return await search(run, query, range(`>=${day(from)}`))
  } catch (error) {
    if (!(error instanceof ShippingReadError) || error.code !== 'TOO_MANY') throw error
  }
  const nodes: Json[] = []
  let viewer = ''
  for (let start = from; start <= now; start += WEEK_MS) {
    const slice = await search(run, query, range(`${day(start)}..${day(start + WEEK_MS - DAY_MS)}`))
    viewer ||= slice.viewer
    nodes.push(...slice.nodes)
  }
  return { viewer, nodes }
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
async function closedBy(run: Run, repository: string, agent: ReadAgent, now: number): Promise<Shipment[]> {
  const { viewer, nodes } = await since(run, ISSUES, closed => `repo:${repository} is:issue is:closed closed:${closed} label:"${agent.label}"`, agent.from, now)
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

/** The pull requests of `repository` merged since `from` that have "revert" in their title. */
async function revertsSince(run: Run, repository: string, from: number, now: number): Promise<Merged[]> {
  const { nodes } = await since(run, REVERTS, merged => `repo:${repository} is:pr is:merged merged:${merged} revert in:title`, from, now)
  return nodes.map(pr => ({ number: Number(pr.number), title: text(pr.title), body: text(pr.body), at: Date.parse(text(pr.mergedAt)) })).filter(pr => pr.at > 0)
}

/** What a revert says it reverts: `Reverts #12` (this repository's), `Reverts owner/name#12` or its address. */
const REVERTS_NAMED = /\brevert(?:s|ed)?\s+(?:([\w.-]+\/[\w.-]+)#|#|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/)(\d+)/gi

/** Whether `revert`, merged within REVERT_WINDOW_MS of `merged`, undoes it: GitHub's own `Revert "<title>"`, or it says it reverts
 *  the pull request by number in its body (`Reverts #12`, `Reverts owner/name#12`, its address) or its title (`Revert ... (#12)`).
 *  A pull request of another repository with the same number is not it: `repositories` are the names this one goes by. */
function undoes(revert: Merged, merged: Shipment['merged'][number], repositories: string[]): boolean {
  if (revert.number === merged.number || revert.at < merged.at || revert.at - merged.at > REVERT_WINDOW_MS) return false
  if (revert.title.trim().toLowerCase() === `Revert "${merged.title}"`.toLowerCase()) return true
  const ofHere = ([, named, address, number]: RegExpMatchArray): boolean => Number(number) === merged.number
    && (!(named ?? address) || repositories.includes((named ?? address)!.toLowerCase()))
  return [...revert.body.matchAll(REVERTS_NAMED)].some(ofHere)
    || /^revert\b/i.test(revert.title.trim()) && [...revert.title.matchAll(/#(\d+)/g)].some(([, number]) => Number(number) === merged.number)
}

/**
 * What each agent shipped in each week since its own `from`, by priority: the weeks with something shipped only. A reading that cannot
 * be had in full is a failure, never a smaller reading: every agent fails with the same reason when GitHub, the sign-in or a
 * repository's reverts could not be read, and an agent alone when its own search is more than a week's worth can hold (TOO_MANY),
 * so one busy agent does not stop the others. The reverts are looked for once a repository, since the earliest merge there. A
 * repository this person cannot see has nothing of theirs and is left out. It never rejects.
 */
export async function readShipped(run: Run, repositories: readonly string[], agents: readonly ReadAgent[],
  names: Map<string, string> = new Map(), now: number = Date.now()): Promise<Reading[]> {
  const weeks = new Map<string, Map<number, WeekShipped>>(agents.map(agent => [agent.id, new Map()]))
  const tooMany = new Set<string>()
  try {
    for (const given of repositories) {
      const repository = await nameOf(run, given, names)
      if (!repository) continue
      const read: Array<{ agent: ReadAgent; shipments: Shipment[] }> = []
      for (const agent of agents.filter(({ id }) => !tooMany.has(id))) {
        try {
          read.push({ agent, shipments: await closedBy(run, repository, agent, now) })
        } catch (error) {
          if (!(error instanceof ShippingReadError) || error.code !== 'TOO_MANY') throw error
          tooMany.add(agent.id)
        }
      }
      const merges = read.flatMap(({ shipments }) => shipments.flatMap(shipment => shipment.merged.map(merged => merged.at)))
      const reverted = merges.length ? await revertsSince(run, repository, Math.min(...merges), now) : []
      // A revert may call the repository by the name the project holds or the one GitHub gives it now.
      const called = [...new Set([given, repository].map(name => name.toLowerCase()))]
      for (const { agent, shipments } of read) {
        for (const shipment of shipments) {
          // Shipped while any pull request that closed it stands: only when every one of them was reverted is it not.
          if (shipment.merged.every(merged => reverted.some(revert => undoes(revert, merged, called)))) continue
          const mine = weeks.get(agent.id)!
          const week = mine.get(shipment.week) ?? { week: shipment.week, P0: 0, P1: 0, P2: 0, P3: 0, none: 0 }
          week[shipment.priority]++
          mine.set(shipment.week, week)
        }
      }
    }
  } catch (error) {
    const failed: ReadFailure = error instanceof ShippingReadError ? error.code : 'GH_FAILED'
    return agents.map(agent => ({ agent, failed }))
  }
  return agents.map(agent => tooMany.has(agent.id) ? { agent, failed: 'TOO_MANY' }
    : { agent, weeks: [...weeks.get(agent.id)!.values()].sort((a, b) => a.week - b.week) })
}
