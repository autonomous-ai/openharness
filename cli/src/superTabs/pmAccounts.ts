/**
 * Which route candidates spend the account a project's PM runs on, any project's in the Swarm (Ken, 11-05). A PM routed work
 * onto a machine and account another project's PM ran on, and could drain it until that PM stopped mid-week. The note is a
 * fact on the candidate, with the share of its week the account keeps for its PMs (keepFor, task #3222); the project's
 * Routing says what it means (below that share left, no new work there).
 *
 * The route reads the Swarm as one project's agent, which sees no other project, so the backend sends every project's PM
 * account in the read (`pmAccounts`, backend superTabs/model.ts), naming a project the reader may not read only as
 * "another project" (review of #3134). A backend from before it sends none: the route then knows its own project's PM.
 */
import { accountOf, type Probe } from './route.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

const DAY_MS = 86_400_000
/** What an account keeps for its PMs while one of them has fewer than 3 measured days (#3134). */
export const FIXED_KEEP = 20
/** The least a measured PM's account keeps: a day's slack for a PM that spends more than it did (task #3222). */
export const MIN_KEEP = 5

/** What an account keeps for the PMs on it: the days to its weekly reset × their measured daily shares (backend pmSpend.ts),
 *  at least MIN_KEEP; while one is not measured, at least FIXED_KEEP. */
export interface Keep { percent: number; days?: number; daily?: number; measured: boolean }

const round = (n: number) => Math.round(n * 10) / 10
const daysText = (days: number) => `${round(days)} ${round(days) === 1 ? 'day' : 'days'}`

export const PM_ACCOUNT_NOTE = (pms: string[], keep: Keep = { percent: FIXED_KEEP, measured: false }) => {
  const whom = pms.length > 1 ? 'its PMs' : 'its PM'
  const why = keep.days !== undefined && keep.daily !== undefined ? `${daysText(keep.days)} to the reset × ${round(keep.daily)}% a day` : null
  const unmeasured = `until ${pms.length > 1 ? 'each' : 'the'} PM's daily spend is measured (3 days)`
  return `This account runs the PM of ${pms.join(' and ')}. It keeps ${round(keep.percent)}% of its week for ${whom}`
    + (keep.measured ? `: ${why}.` : why && keep.percent > FIXED_KEEP ? `: ${why} for those measured, and at least ${FIXED_KEEP}% ${unmeasured}.` : ` ${unmeasured}.`)
}

/** The share [accounts] (the PMs on one account) keep, with [resetsAt] the account's weekly reset. */
export function keepFor(accounts: Json[], resetsAt: number | null, now: number): Keep {
  const shares = accounts.map(a => object(a.daily).share).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  const measured = shares.length === accounts.length && shares.length > 0
  if (!shares.length || resetsAt === null) return { percent: FIXED_KEEP, measured: false }
  const days = Math.max(0, (resetsAt - now) / DAY_MS), daily = shares.reduce((a, b) => a + b, 0)
  const spend = Math.min(100, days * daily)
  return { percent: measured ? Math.max(MIN_KEEP, spend) : Math.max(FIXED_KEEP, spend), days, daily, measured }
}

/** The PM accounts the read carries, or, from an older backend, those of the projects the reader sees (a Swarm from before
 *  projects has one, its Lead conversation `lead`). */
function accountsOf(state: Json): Json[] {
  if (Array.isArray(state.pmAccounts)) return list(state.pmAccounts)
  const conversations = list(state.conversations), agents = list(state.agents)
  const projects = Array.isArray(state.projects) ? list(state.projects) : [{ id: 'lead', name: state.name, leadConversationId: 'lead' }]
  return projects.flatMap(project => {
    const pm = agents.find(a => a.id === conversations.find(c => c.id === project.leadConversationId)?.leadId)
    return pm ? [{ machineId: pm.machineId, engine: object(pm.configuration).engine, project: text(project.name) ?? text(project.id),
      pm: text(pm.displayName) ?? text(pm.name) ?? pm.id }] : []
  })
}

/** [probes] with PM_ACCOUNT_NOTE on each one that spends an account a project's PM runs on. A Mac and its Harness Team account
 *  spend one subscription, so an account is the Mac and the engine; and the subscription a reading on that Mac names
 *  (route.ts accountOf), wherever else it is signed in. Grid models spend no subscription. */
export function withPmAccounts(state: Json, probes: Probe[], now = Date.now()): Probe[] {
  const macOf = new Map(list(state.machines).filter(m => text(m.hostMachineId)).map(m => [String(m.machineId), String(m.hostMachineId)]))
  const mac = (machineId: string) => macOf.get(machineId) ?? machineId
  const pms = new Map<string, Map<string, Json>>()
  const add = (key: string, name: string, account: Json) => pms.set(key, (pms.get(key) ?? new Map()).set(name, account))
  for (const account of accountsOf(state)) {
    const machineId = text(account.machineId), engine = text(account.engine)
    if (!machineId || !engine) continue
    const name = `${text(account.project) ?? 'another project'} (${text(account.pm) ?? 'its PM'})`
    const home = text(account.hostMachineId) ?? mac(machineId)
    add(`${home}:${engine}`, name, account)
    for (const p of probes) if (!p.gridModel && p.engine === engine && mac(p.machineId) === home) add(accountOf(p), name, account)
  }
  return probes.map(p => {
    if (p.gridModel) return p
    const runs = new Map([...pms.get(`${mac(p.machineId)}:${p.engine}`) ?? [], ...pms.get(accountOf(p)) ?? []])
    if (!runs.size) return p
    // The account's own weekly reset, else the candidate's weekly window's (its quota's own reset is the tightest window's).
    const accounts = [...runs.values()]
    const weekly = p.quota.windows?.find(w => w.name === 'weekly')?.resetsAt
    const reset = accounts.map(a => a.resetsAt).find((at): at is number => typeof at === 'number' && Number.isFinite(at))
      ?? (typeof weekly === 'number' && Number.isFinite(weekly) ? weekly : null)
    return { ...p, notes: [...p.notes, PM_ACCOUNT_NOTE([...runs.keys()], keepFor(accounts, reset, now))] }
  })
}
