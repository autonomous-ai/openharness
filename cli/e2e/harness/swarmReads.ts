/**
 * The Swarm read API (docs/design/2026-10-26-swarm-state-parts.md section 4) over a Super Tab fixture that answers the old
 * routes: `GET /hosts/:m`, `/hosts/:m/pools`, `/hosts/:m/assignments`, `GET /:tab` and `GET /api/super-tabs`. The scenarios
 * keep their fixtures and what they check; only how the daemon reaches them changes (#1726). Every changes read asks for a
 * reload, so each read is a first load of the state the fixture holds now (it keeps no history to send tombstones from), and
 * every host form is full, as the old roster was.
 */
import { partsOf } from '../../src/superTabs/fixtures/read/index.js'
import type { FakeBackend } from './fakeBackend.js'

type Handler = NonNullable<FakeBackend['superTabs']>
type Json = Record<string, any>
const rows = (answer: { data?: unknown }) => Array.isArray(answer.data) ? answer.data as Json[] : []

export function overOldRoutes(handler: Handler): Handler {
  return async (method, raw, body, machine) => {
    const url = new URL(raw, 'http://fixture'), path = url.pathname, query = url.search
    const old = (route: string) => handler('GET', route, {}, machine)
    const host = /^\/api\/super-tabs\/hosts\/([^/]+)\/changes$/.exec(path)
    if (method === 'GET' && host) {
      const roster = await old(`/api/super-tabs/hosts/${host[1]}`)
      if (roster.error) return roster
      // A scenario that never served pools or assignments had them fail, which the daemon's readers took as none.
      const none = () => ({ data: [] })
      const [pools, assignments] = await Promise.all([old(`/api/super-tabs/hosts/${host[1]}/pools`).catch(none), old(`/api/super-tabs/hosts/${host[1]}/assignments`).catch(none)])
      const all = [...rows(roster), ...rows(pools), ...rows(assignments)]
      const tabs = [...new Set(all.map(row => String(row.tabId)))].map(tabId => ({ tabId, lastChangedAt: 1,
        roster: rows(roster).filter(row => row.tabId === tabId), pool: rows(pools).find(row => row.tabId === tabId) ?? null,
        assignments: rows(assignments).filter(row => row.tabId === tabId) }))
      return { data: { format: 2, full: true, cursor: 'fixture-host', tabs, removedTabIds: [] } }
    }
    if (method === 'GET' && path === '/api/super-tabs/list') {
      const list = await old(`/api/super-tabs${query}`)
      if (list.error) return list
      const page = (list.data ?? {}) as Json
      return { data: { tabs: (Array.isArray(page.tabs) ? page.tabs : []).map((tab: Json) => ({ ...tab, lastChangedAt: tab.revision ?? null })), next: page.next ?? null } }
    }
    const tab = /^\/api\/super-tabs\/([^/]+)\/(parts|changes)$/.exec(path)
    if (method === 'GET' && tab && tab[1] !== 'hosts') {
      if (tab[2] === 'changes') return { data: { reload: true } }
      const as = url.searchParams.get('asAgentId')
      const whole = await old(`/api/super-tabs/${tab[1]}${as ? `?asAgentId=${as}` : ''}`)
      if (whole.error) return whole
      const answer = (whole.data ?? {}) as Json
      return { data: partsOf({ id: tab[1], ...(answer.state ?? {}) }, { githubApp: answer.githubApp === true, lastChangedAt: answer.revision }) }
    }
    const group = /^\/api\/super-tabs\/([^/]+)\/groups\/([^/]+)$/.exec(path)
    if (method === 'GET' && group) {
      const whole = await old(`/api/super-tabs/${group[1]}${query}`)
      if (whole.error) return whole
      const found = ((whole.data as Json)?.state?.conversations ?? []).find((c: Json) => c.id === group[2])
      return found ? { data: { group: { key: group[2], version: 1, changedAt: 1, data: found } } } : { status: 404, error: { code: 'NOT_FOUND', message: 'No such group.' } }
    }
    return handler(method, raw, body, machine)
  }
}
