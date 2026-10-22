import { z } from 'zod'

/**
 * Why a host reports that it cannot type a delivery into an agent's terminal yet. These are the reasons the
 * harness core gives (cli/src/engines/kit/screen.ts); the host sends the code and the words live here, so
 * every client and every language of the conversation reads the same sentence.
 */
export const holdReason = z.enum(['team_waiting_unavailable', 'team_waiting_user', 'team_waiting_draft', 'team_waiting_idle', 'team_waiting_control'])
export type HoldReason = z.infer<typeof holdReason>

const WHY: Record<HoldReason, (name: string) => string> = {
  team_waiting_unavailable: name => `${name}'s terminal cannot be read right now.`,
  team_waiting_user: name => `${name} is showing a question or menu that needs a person to answer it.`,
  team_waiting_draft: name => `There is unsent text in ${name}'s input box.`,
  team_waiting_idle: name => `${name} is still busy, or its input box is not ready.`,
  team_waiting_control: name => `Someone else is using ${name}'s terminal right now.`,
}

/** Where the waiting agent runs and who owns that machine: the only person who can reach the screen. Either may be unknown. */
export interface HoldHost { machine: string | null; owner: string | null }

/** The one notice a conversation gets about a delivery that has waited over 30 seconds (2026-10-21: minutes, unexplained). */
export const holdNoticeText = (agentName: string, reason: HoldReason, host?: HoldHost): string => {
  // A question on screen is answered at that machine, so name it and its owner; never anyone who cannot reach it.
  const where = reason === 'team_waiting_user' && host
    ? `${host.machine ? ` ${agentName} is on ${host.machine}.` : ''}${host.owner ? ` Only ${host.owner} (owner of ${host.machine ? 'that' : 'the'} machine${host.machine ? '' : ' it runs on'}) can answer it.` : ''}`
    : ''
  return `A message for ${agentName} is waiting. ${WHY[reason](agentName)}${where} It stays queued and goes in by itself as soon as that clears.`
}
