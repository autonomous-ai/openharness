/** Test-only: the recorded replies of the Swarm read API (design 2026-10-26-swarm-state-parts section 4), kept as JSON so
 *  the integration group can replay them. Each call returns a fresh copy, so a test may change what it gets. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type ReadFixture = 'parts-lead' | 'parts-builder' | 'changes-lead' | 'changes-reload' | 'legacy-tab-lead' | 'legacy-tab-builder'
  | 'host-full' | 'host-changes' | 'host-quiet' | 'list' | 'messages' | 'update-required' | 'status-lead' | 'status-builder'

const DIR = join(import.meta.dirname, '.')
export function readFixture<T = Record<string, unknown>>(name: ReadFixture): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as T
}
/** The fixture's tab, people, agents and machine, by role. */
export const FIXTURE = {
  tabId: 'f1a5c0de0000000000000001', removedTabId: 'f1a5c0de0000000000000009', machineId: 'd00000000000000000000001',
  ownerId: '6a0000000000000000000001', collaboratorId: '6a0000000000000000000002',
  leadId: 'a00000000000000000000001', builderId: 'a00000000000000000000002',
  leadHarness: 'b00000000000000000000001', builderHarness: 'b00000000000000000000002',
  leadsGroup: 'c00000000000000000000000', leadGroup: 'c00000000000000000000001', workGroup: 'c00000000000000000000002', doneGroup: 'c00000000000000000000003',
  startId: 'e00000000000000000000002', projectId: '5000000000000000000000aa',
} as const

/** A backend reply in the envelope `core.account.backend` returns. */
export interface BackendReply { status: number; body: Record<string, unknown> }
export const ok = (data: unknown): BackendReply => ({ status: 200, body: { success: true, data } })
export const refused = (status: number, code: string, message?: string): BackendReply =>
  ({ status, body: { success: false, error: { code, ...(message ? { message } : {}) } } })

type Json = Record<string, unknown>
const asList = (v: unknown): Json[] => Array.isArray(v) ? v as Json[] : []
/** Each fake reply's parts are newer than the last, as a server's would be after any change. */
let version = 1

/** A host form that lists `rows` (old roster rows) Swarm by Swarm, plus Swarms in `tabs` with no rows: an empty Swarm's rows
 *  are replaced by none. Pools and assignments go with their Swarm. */
export function hostForm(rows: unknown, options: { tabs?: string[]; pools?: unknown; assignments?: unknown } = {}): Json {
  const roster = asList(rows), pools = asList(options.pools), assignments = asList(options.assignments)
  const ids = [...new Set([...roster, ...pools, ...assignments].map(row => String(row.tabId)).concat(options.tabs ?? []))]
  return { format: 2, full: true, cursor: `host-${++version}`, removedTabIds: [], tabs: ids.map(tabId => ({ tabId, lastChangedAt: version,
    roster: roster.filter(row => row.tabId === tabId), pool: pools.find(pool => pool.tabId === tabId) ?? null,
    assignments: assignments.filter(work => work.tabId === tabId) })) }
}

/** A first load of a Swarm whose state (in the old shape) is `state`: every record a part, nothing derived. */
export function partsOf(state: Json, options: { githubApp?: boolean; lastChangedAt?: number } = {}): Json {
  const v = ++version
  const part = (key: unknown, data: Json) => ({ key: String(key), version: v, changedAt: v, data })
  const { people, agents, conversations, machines, starts, otherProjectsWork, mentionsWaiting, ...head } = state
  return { format: 2, tabId: String(state.id ?? 'tab'), cursor: `tab-${v}`, serverTime: v, lastChangedAt: options.lastChangedAt ?? v, epoch: 1,
    ...(options.githubApp ? { githubApp: true } : {}),
    head: part('head', head), members: asList(people).map(p => part(p.id, p)), agents: asList(agents).map(a => part(a.id, a)),
    groups: asList(conversations).map((c, i) => part(c.id ?? `group-${i}`, c)), machines: asList(machines).map(m => part(m.machineId, m)),
    starts: asList(starts).map(s => part(s.id, s)), progress: [],
    derived: { ...(otherProjectsWork !== undefined ? { otherProjectsWork } : {}), ...(mentionsWaiting !== undefined ? { mentionsWaiting } : {}) } }
}

/** A fake Swarm read: a changes read asks for a reload, so every read is a first load of the state the test holds now (a
 *  fake keeps no history to send tombstones from). */
export const swarmReply = (path: string, state: Json, options: { githubApp?: boolean; lastChangedAt?: number } = {}): Json =>
  /\/changes\?cursor=/.test(path) && !path.includes('/hosts/') ? { reload: true } : partsOf(state, options)
