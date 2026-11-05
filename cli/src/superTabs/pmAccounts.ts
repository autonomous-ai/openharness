/**
 * Which route candidates spend the account a project's PM runs on, any project's in the Swarm (Ken, 11-05). A PM routed work
 * onto a machine and account another project's PM ran on, and could drain it until that PM stopped mid-week. The note is a
 * fact on the candidate; the project's Routing says what it means (below 20% of its weekly quota, no new work there).
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
export function withPmAccounts(state: Json, probes: Probe[]): Probe[] {
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
    return runs.size ? { ...p, notes: [...p.notes, PM_ACCOUNT_NOTE([...runs])] } : p
  })
}
