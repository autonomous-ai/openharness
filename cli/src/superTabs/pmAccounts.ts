/**
 * Which route candidates spend the account a project's PM runs on, any project's in the Swarm (Ken, 11-05). A PM routed work
 * onto a machine and account another project's PM ran on, and could drain it until that PM stopped mid-week. The note is a
 * fact on the candidate; the project's Routing says what it means (past its daily share of its weekly quota, no new work there).
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

export const PM_ACCOUNT_NOTE = (pms: string[]) => `This account runs the PM of ${pms.join(' and ')}.`
/** Where a PM's account stands against its daily share (Ken, 11-05): a seventh of its weekly quota per day of its week,
 *  counted from its weekly reset, unused days carried over (day 1 allows 14.3%, day 2 28.6%, day 7 all of it). 17% a day
 *  reached 100% by day 6 and left the PM nothing for its last two days. */
export const PM_DAY_NOTE = (day: number, allows: number, used: number) => `Day ${day} of its week allows ${allows}% of its weekly quota `
  + `and it has used ${used}%, so it ${used >= allows ? 'takes no new work' : 'takes new work'}.`
const DAY_MS = 86_400_000

/** The day note for [p]'s weekly window, or none without one that names its reset. */
function dayNote(p: Probe, now: number): string[] {
  const week = p.quota.windows?.find(w => w.name === 'weekly')
  if (!week || week.resetsAt === null) return []
  const day = Math.min(7, Math.max(1, Math.floor((now - (week.resetsAt - 7 * DAY_MS)) / DAY_MS) + 1))
  return [PM_DAY_NOTE(day, Math.round(1000 * day / 7) / 10, Math.round(100 - week.leftPercent))]
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
  const pms = new Map<string, Set<string>>()
  const add = (key: string, name: string) => pms.set(key, (pms.get(key) ?? new Set()).add(name))
  for (const account of accountsOf(state)) {
    const machineId = text(account.machineId), engine = text(account.engine)
    if (!machineId || !engine) continue
    const name = `${text(account.project) ?? 'another project'} (${text(account.pm) ?? 'its PM'})`
    const home = text(account.hostMachineId) ?? mac(machineId)
    add(`${home}:${engine}`, name)
    for (const p of probes) if (!p.gridModel && p.engine === engine && mac(p.machineId) === home) add(accountOf(p), name)
  }
  return probes.map(p => {
    if (p.gridModel) return p
    const runs = new Set([...pms.get(`${mac(p.machineId)}:${p.engine}`) ?? [], ...pms.get(accountOf(p)) ?? []])
    return runs.size ? { ...p, notes: [...p.notes, PM_ACCOUNT_NOTE([...runs]), ...dayNote(p, now)] } : p
  })
}
