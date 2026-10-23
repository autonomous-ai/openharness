/**
 * A Swarm's own grid (docs/plans/2026-10-23-swarm-local-models.md): created by the Swarm owner's computer once the owner
 * turns the Local models add-on on, and kept so its members are the Swarm's people who may act there. Only the owner, the
 * grid's admin, changes its members (owner, 2026-10-23), so this runs on the owner's computer alone.
 *
 * Every call goes through `grid` (`gridExec.ts`): the control plane owns the grid and its member list, Harness only asks.
 */
import { ensureHarnessGrid, type EnsureResult } from './gridEnsure.js'
import { gridExec, gridJson, type GridResult } from './gridExec.js'

const REMOTE = '--remote'
/** A member that can both use and serve models (owner, 2026-10-23). */
const ROLE = 'both'

export interface SwarmGridDeps {
  ensure: (name: string) => Promise<EnsureResult>
  exec: (args: readonly string[]) => Promise<GridResult>
  json: <T>(args: readonly string[]) => Promise<{ value: T | null; result: GridResult }>
}
const DEPS: SwarmGridDeps = { ensure: name => ensureHarnessGrid(name), exec: args => gridExec(args), json: args => gridJson(args) }

/** [final]: grid refused for a reason only the person can change (its plan's grid limit); asking again changes nothing. */
export interface SwarmGridSync { ready: boolean; error?: string; final?: boolean; added: string[]; removed: string[] }

const said = (r: GridResult) => (r.stderr.trim() || r.message || 'grid refused the request.').slice(0, 400)
const normal = (email: string) => email.trim().toLowerCase()

/** Creates [name] if it is missing, then adds the [members] it lacks and removes members the Swarm no longer has. The
 *  admin (the owner) is never removed: grid keeps the creator's role on every membership write. */
export async function syncSwarmGrid(name: string, members: readonly string[], deps: SwarmGridDeps = DEPS): Promise<SwarmGridSync> {
  const ensured = await deps.ensure(name)
  if (!['created', 'existed', 'adopted'].includes(ensured.status)) {
    return { ready: false, error: ensured.message || 'The grid could not be set up.', ...(ensured.status === 'refused' ? { final: true } : {}), added: [], removed: [] }
  }
  const listed = await deps.json<unknown>([REMOTE, 'members', 'list', name])
  if (listed.result.code !== 'OK') return { ready: false, error: said(listed.result), added: [], removed: [] }
  const rows = Array.isArray(listed.value) ? listed.value : Array.isArray((listed.value as { members?: unknown } | null)?.members)
    ? (listed.value as { members: unknown[] }).members : []
  const current = rows.flatMap(row => {
    const r = (row && typeof row === 'object' ? row : {}) as { email?: unknown; roles?: unknown }
    const roles = Array.isArray(r.roles) ? r.roles : []
    return typeof r.email === 'string' ? [{ email: normal(r.email), admin: roles.includes('admin') }] : []
  })
  const wanted = new Set(members.map(normal).filter(Boolean))
  const added: string[] = [], removed: string[] = []
  for (const email of wanted) {
    if (current.some(m => m.email === email)) continue
    const result = await deps.exec([REMOTE, 'members', 'add', name, email, '--role', ROLE])
    if (result.code !== 'OK') return { ready: false, error: `Could not add ${email}: ${said(result)}`, added, removed }
    added.push(email)
  }
  for (const member of current) {
    if (member.admin || wanted.has(member.email)) continue
    const result = await deps.exec([REMOTE, 'members', 'remove', name, member.email])
    if (result.code !== 'OK') return { ready: false, error: `Could not remove ${member.email}: ${said(result)}`, added, removed }
    removed.push(member.email)
  }
  return { ready: true, added, removed }
}
