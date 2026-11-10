/**
 * A Product Manager runs on its machine's default account alone. In Swarm v4 an agent runs on its own person's computers under
 * their own login, and Desktop dropped the page where a person offered another account of theirs to the Swarm and could take it
 * back (F9): nothing would show them a PM spending it. So lead.switch takes the default account only, whatever an older CLI
 * still reports, and a PM a switch left on another account is moved back by the liveness sweep.
 */

import { logger } from '../utils/logger.js'
import { agentDisplayName } from './agentNames.js'
import { BELOW_LEAD_EFFORT, leadEffort } from './leadStart.js'
import { contributedEngines, defaultProfileId, machineOffline, storedProfileId } from './machines.js'
import { fail, stableId, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { BUILT_IN_ROLE_DEFAULTS, ledProject, withRoleDefaults } from './projects.js'

/** What a host reports it can do for a Product Manager's switch; a host from before it is never asked (HOST_OUTDATED). */
export const SWITCH_CAPABILITY = 'leadSwitch'
/** After this many failed tries its project chat hears, once, that the PM is still on the other account. */
export const ACCOUNT_RETURN_TRIES = 3
/** The wait after a failed try, doubled after each one, up to [ACCOUNT_RETURN_MAX_WAIT_MS]. */
export const ACCOUNT_RETURN_WAIT_MS = 2 * 60_000
/** A PM that cannot move keeps being asked, this far apart at most: its account is spent while it stays. */
export const ACCOUNT_RETURN_MAX_WAIT_MS = 6 * 3_600_000

/** The refusal of a switch onto any account but the destination's default one. */
export function defaultAccountOnly(name: string, machine: string): never {
  fail('DEFAULT_ACCOUNT_ONLY', `A ${name} runs on ${machine}'s default account only.`, 403)
}

/**
 * Each PM still on another account of its machine (`profileId`, from a switch before the server took the default alone, or a
 * rebind an older CLI reported) is asked to move to its engine's default account there, as Switch PM would: the model it runs,
 * at high effort or above. The sweep runs on a machine's report at most every 30 seconds, and the PM's machine carries the switch
 * out with a handoff, so the PM keeps its work: one is asked within about 30 seconds of its machine being online with this server.
 * A failed try is asked again 2, 4, 8 … minutes after it ended, at most 6 hours apart; after the third its project chat hears
 * once that it is still there. The project chat hears when it starts; each switch's result line says how it went.
 */
export function pmsToDefaultAccount(state: SuperTabState, now: number): MessageDraft[] {
  const rows: MessageDraft[] = []
  for (const pm of state.agents) {
    if (!pm.profileId && !pm.accountReturn) continue
    const engine = pm.configuration?.engine ?? ''
    if (storedProfileId(pm.machineId, engine, pm.profileId) === undefined) {
      delete pm.accountReturn
      continue
    }
    if (pm.switchRequest || pm.switchLanded) continue
    const project = ledProject(state, pm.id)
    if (!project) continue
    const returning = pm.accountReturn, tries = returning?.tries ?? 0
    const pool = state.machines?.find(m => m.machineId === pm.machineId)
    const machine = pool?.name ?? 'its machine'
    // The wait starts when a try ended, which the sweep sees with the request gone: a switch can run for minutes.
    if (returning?.asking) {
      pm.accountReturn = { tries, at: now, ...returning.gaveUp ? { gaveUp: true as const } : {} }
      continue
    }
    if (returning && tries >= ACCOUNT_RETURN_TRIES && !returning.gaveUp) {
      returning.gaveUp = true
      logger.warn('[swarm] a PM could not move to its default account', { agentId: pm.id, machineId: pm.machineId, tries })
      rows.push(line(state, pm, project.leadConversationId, stableId('account-return-failed', pm.id, String(returning.at)),
        `The PM still runs on another account on ${machine}: moving it to the default account failed ${tries} times. Use Switch PM to move it.`))
    }
    if (returning && now < returning.at + Math.min(ACCOUNT_RETURN_WAIT_MS * 2 ** (tries - 1), ACCOUNT_RETURN_MAX_WAIT_MS)) continue
    if (!pool || machineOffline(pool, now) || !pool.observation?.capabilities?.includes(SWITCH_CAPABILITY)
      || !contributedEngines(pool).includes(engine)) continue
    // Its own id each time: a host keeps what it did for a switch id (cli superTabs/leadSwitchRequest.ts).
    const id = stableId('account-return', pm.id, String(now))
    const { model, effort } = pm.configuration
    const asked = leadEffort(withRoleDefaults({ engine, ...model ? { model } : {},
      ...effort && !BELOW_LEAD_EFFORT.has(effort.toLowerCase()) ? { effort } : {} }, BUILT_IN_ROLE_DEFAULTS.lead), 'PM')
    pm.switchRequest = { id, ...asked, profileId: defaultProfileId(pm.machineId, engine), requestedBy: pm.machineOwnerId, at: new Date(now).toISOString() }
    pm.accountReturn = { tries: tries + 1, at: now, asking: true, ...returning?.gaveUp ? { gaveUp: true as const } : {} }
    logger.info('[swarm] a PM is asked to move to its default account', { agentId: pm.id, machineId: pm.machineId, tries: tries + 1 })
    if (!tries) rows.push(line(state, pm, project.leadConversationId, stableId(id, 'line'), `Moving the PM to ${machine}'s default account.`))
  }
  return rows
}

const line = (state: SuperTabState, pm: Agent, conversationId: string, id: string, text: string): MessageDraft => ({
  id, conversationId, replyTo: null, recipients: [], text, source: { kind: 'switch', agentId: pm.id },
  author: { kind: 'agent', id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration } })
