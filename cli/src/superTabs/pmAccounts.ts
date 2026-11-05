/**
 * Which route candidates spend the account a project's PM runs on, any project's in the Swarm (Ken, 11-05). A PM routed work
 * onto a machine and account another project's PM ran on, and could drain it until that PM stopped mid-week: the route said
 * nothing about whose PM an account keeps alive, and the project's Routing guards only its own PM's account. The note is a
 * fact on the candidate; the project's Routing instructions say what it means for the choice.
 */
import { accountOf, type Probe } from './route.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

export const PM_ACCOUNT_NOTE = (pms: string[]) => `This account runs the PM of ${pms.join(' and ')}.`

/** [probes] with PM_ACCOUNT_NOTE on each one whose account a project's PM runs on. An account is the subscription a reading
 *  names (route.ts accountOf), so a Mac's Harness Team account spending the Mac's subscription is that account too; with no
 *  candidate probed on the PM's own machine and engine, it is that machine and engine. Grid models spend no subscription. */
export function withPmAccounts(state: Json, probes: Probe[]): Probe[] {
  const conversations = list(state.conversations), agents = list(state.agents)
  const pms = new Map<string, string[]>()
  for (const project of list(state.projects)) {
    const leadId = text(conversations.find(c => c.id === project.leadConversationId)?.leadId)
    const pm = agents.find(a => a.id === leadId)
    const machineId = text(pm?.machineId), engine = text(object(pm?.configuration).engine)
    if (!pm || !machineId || !engine) continue
    const own = probes.find(p => !p.gridModel && p.machineId === machineId && p.engine === engine)
    const account = own ? accountOf(own) : `${machineId}:${engine}`
    const named = `${text(project.name) ?? text(project.id)} (${text(pm.displayName) ?? text(pm.name) ?? String(pm.id)})`
    pms.set(account, [...pms.get(account) ?? [], named])
  }
  return probes.map(p => {
    const runs = p.gridModel ? undefined : pms.get(accountOf(p))
    return runs ? { ...p, notes: [...p.notes, PM_ACCOUNT_NOTE(runs)] } : p
  })
}
