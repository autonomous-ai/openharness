/**
 * `harness tell`: an agent gives more work to a harness it started, on this machine or another of the owner's. The
 * starter stays the one who directs it: it read the answer (`harness show`) and now says what to do next, without
 * starting a new harness and losing the context the first one built.
 *
 * It is not Agent Messages. The owner ruled that a harness another started gets no exception there (2026-10-11,
 * docs/design/2026-10-11-agent-client.md "Agent Messages off means off"): the first version let a harness and the
 * ones it started message each other with no tab, both ways, and agents did so before the person had turned anything
 * on. This is narrower and the person's to allow: one way only, from the starter to the harness it started, behind a
 * switch of its own (`agents-tell-agents`, off by default), checked by the machine the harness runs on against its own
 * record of who started it. It rides the mailbox (mailbox.ts), which types a message into an idle agent once its
 * composer is free and gives one to a working agent at its next tool call, so a person's draft is never typed over.
 *
 * Its messages are kept under the pseudo-tab `told`: no tab carries them, and nothing that reads a tab's log shows them.
 */
import type { Ledger, LedgerMember } from '../agentClient/ledger.js'
import { askThePersonFirst } from '../lib/agentSettings.js'
import { engineName, shown, type Message } from './model.js'

/** The tab id a told message is kept under. No desk tab has it: ids there are the backend's. */
export const TOLD_TAB = 'told'

/** Said when the person has not allowed it: the agent asks them, and retries only after their yes. */
export const TELL_OFF_TEXT = `Agents may not give more work to harnesses they started yet. ${askThePersonFirst('agents-tell-agents', 'start a new harness with the whole task, or do the work yourself.')}`

export interface TellRefusal { code: 'TELL_OFF' | 'NOT_YOURS' | 'NOT_RUNNING'; message: string }

export interface TellCheck {
  /** The switch, as this machine keeps the account's experiments. */
  on: boolean
  /** Who started which harness, as this machine records it. */
  lineage: Pick<Ledger, 'parentOf'>
  /** This machine's id. */
  self: string
  /** Whether [agentId] is a live harness here. */
  live: (agentId: string) => boolean
}

/**
 * Why [from] may not tell [agentId] on this machine, or null. The machine the harness runs on decides from its own
 * record: a harness the starter's machine says it started, which this one has no line for, is refused here (its
 * record could not be written when it started: `harness new` said so then).
 */
export function tellRefusal(check: TellCheck, from: LedgerMember, agentId: string): TellRefusal | null {
  if (!check.on) return { code: 'TELL_OFF', message: TELL_OFF_TEXT }
  const parent = check.lineage.parentOf({ machineId: check.self, agentId })
  if (!parent || parent.by.machineId !== from.machineId || parent.by.agentId !== from.agentId) {
    return { code: 'NOT_YOURS', message: 'You did not start that harness, as its machine records it, so you may not tell it. Only the person can.' }
  }
  // Harness closes one another agent started once it has sat idle half an hour (services/agentCleanup.ts).
  if (!check.live(agentId)) {
    return { code: 'NOT_RUNNING', message: 'That harness is no longer running: it was closed or stopped. Start a new harness with the whole task.' }
  }
  return null
}

/**
 * A told message as the harness reads it: who it is from and that it is more work, then the words. Said as its first
 * task was (agentClient/commands.ts `agentOrigin` prompt): from an agent, not the person, and its starter reads the
 * answer itself, so it answers here and does not message back.
 */
export function toldText(message: Message): string {
  const from = message.from
  // Names another machine recorded: no control or format character reaches the pane (model.ts `header`).
  return `[from ${shown(from.name)} · ${engineName(shown(from.engine))} · ${shown(from.machine)}, the harness that started you: more work. It reads your answer itself.]\n\n${message.text}`
}
