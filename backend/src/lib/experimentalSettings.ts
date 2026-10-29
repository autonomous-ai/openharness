import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'

/** The account's experiments. `agent_messages_hide_summary` is stored inverted, like none of the others: every
 *  experiment here is "off unless true", and a default of sharing the one-line summary needs the switch that stops it
 *  (shared-tab activity design, ruling T4). The three before it are what agents may do with Harness: they left each computer's
 *  Settings ▸ Agents for here, one choice for every computer of the account (owner, 2026-10-12). `agents_tell_agents` is
 *  another: an agent may give more work to a harness it started (`harness tell`), behind a switch of its own because a
 *  harness another started gets no exception from Agent Messages (owner, 2026-10-11). `programs_reply` is the last: a
 *  program acting for the person, such as a lamp, may give more work to an idle harness of theirs in a pane (`harness
 *  reply`, #1628), a switch apart from `agents_tell_agents`, which is about agents. */
export const experimentalFeatures = ['focus_bar_creature', 'share_button', 'devices_tab', 'agents_start_agents', 'agent_pull_request_line', 'agent_messages', 'agent_messages_hide_summary', 'agents_tell_agents', 'programs_reply'] as const
export type ExperimentalFeature = typeof experimentalFeatures[number]
export const experimentalSettingsId = (userId: string): string =>
  createHash('sha256').update(JSON.stringify(['experimental-settings', userId])).digest('hex').slice(0, 24)

/** Each experiment's column. A row written before a column existed has none: read as off. */
const FIELDS = {
  focus_bar_creature: 'focusBarCreature', share_button: 'shareButton', devices_tab: 'devicesTab',
  agents_start_agents: 'agentsStartAgents', agent_pull_request_line: 'agentPullRequestLine', agent_messages: 'agentMessages',
  agent_messages_hide_summary: 'agentMessagesHideSummary', agents_tell_agents: 'agentsTellAgents', programs_reply: 'programsReply',
} as const satisfies Record<ExperimentalFeature, string>
type Row = { [K in (typeof FIELDS)[ExperimentalFeature]]?: boolean } & { revision: number }

const snapshot = (row: Row | null) => ({
  revision: row?.revision ?? 0,
  features: Object.fromEntries(experimentalFeatures.map((feature) => [feature, row?.[FIELDS[feature]] === true])) as Record<ExperimentalFeature, boolean>,
})

/** Reading never opts an account in or imports an installation's unscoped preferences. */
export async function readExperimentalSettings(userId: string) {
  const row = await prisma.experimentalSettings.findUnique({ where: { id: experimentalSettingsId(userId) } })
  if (row && row.userId !== userId) throw new Error('Experimental settings identity mismatch')
  return snapshot(row)
}

/** Change one field atomically so two machines editing different switches keep both choices. */
export async function setExperimentalSetting(userId: string, feature: ExperimentalFeature, enabled: boolean) {
  const id = experimentalSettingsId(userId)
  const field = FIELDS[feature]
  const data = { [field]: enabled, revision: { increment: 1 } }
  const off = Object.fromEntries(Object.values(FIELDS).map((column) => [column, false])) as Record<(typeof FIELDS)[ExperimentalFeature], false>
  let row
  try {
    row = await prisma.experimentalSettings.upsert({ where: { id },
      create: { id, userId, ...off, [field]: enabled, revision: 1 },
      update: data })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    row = await prisma.experimentalSettings.update({ where: { id }, data })
  }
  return snapshot(row)
}
