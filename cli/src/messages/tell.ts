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

/**
 * A person's Buddy passing their words to their own harnesses on their own Mac (#2626, thaibao56: a lead who handed their
 * lead session to their Buddy relayed every message by hand). Not a starter's tell: the Buddy started none of them. Only
 * the person's own Buddy (a Swarm session of role buddy here, whose person the host proved, at their last message within
 * the hour, is the account signed in on this machine: the grant its wide reads hold), only a harness the person started on
 * this machine (never a guest's, which is another person's; never a Swarm session, nor one an agent started), and only
 * while the person allows `agents-tell-agents`, the switch that already covers agents giving harnesses work. One way:
 * the Buddy reads nothing back. Kept under the pseudo-tab `relayed`; checked again at each delivery look.
 */
export const RELAYED_TAB = 'relayed'

/** A harness here a Buddy would pass words to, as this machine's registry records it. */
export interface RelayTarget {
  /** A Swarm session (any role): the Swarm's to direct, not the person's. */
  swarm: boolean
  /** Started by an agent (`harness new`, the Swarm, an agent outside Harness): its starter's to tell. */
  startedByAgent: boolean
  /** A guest's: another person's, on a machine its owner shares. */
  guest: boolean
  /** A terminal, which has no agent to take words. */
  terminal: boolean
  /** The Buddy itself. */
  self: boolean
}

export interface RelayCheck {
  /** `agents-tell-agents`, as this machine keeps it. */
  on: boolean
  /** The Buddy holds its owner's live grant on this machine. */
  granted: boolean
  /** The harness, or null when none of that id runs here. */
  target: RelayTarget | null
}

/** Said when the owner is not proven here: the grant lapses an hour after their last message, and a relaunch drops it. */
export const OWNER_AWAY_TEXT = 'You pass words to your owner\'s harnesses only while they are with you: once they write to you in your chat, on ' +
  'this computer signed in as them, for an hour. Nothing was sent. Tell your owner in one line.'

/** The one refusal for every harness a Buddy may not reach, or that does not run: which kind it is, or that it exists, is
 *  no read a Buddy is given (security review 2 of #2626). The CLI says the same for a name it does not find. */
export const NOT_ONE_TEXT = 'That is not one of your owner\'s harnesses on this computer, or it no longer runs. Nothing was sent.'

/** Why a Buddy may not pass words to [check.target] here, or null. */
export function relayRefusal(check: RelayCheck): { code: 'TELL_OFF' | 'OWNER_AWAY' | 'NOT_YOURS'; message: string } | null {
  if (!check.on) return { code: 'TELL_OFF', message: `Your owner has not allowed agents to give their harnesses work. ${askThePersonFirst('agents-tell-agents', 'tell them what to pass on, and let them do it.')}` }
  if (!check.granted) return { code: 'OWNER_AWAY', message: OWNER_AWAY_TEXT }
  const t = check.target
  return !t || t.self || t.guest || t.swarm || t.startedByAgent || t.terminal ? { code: 'NOT_YOURS', message: NOT_ONE_TEXT } : null
}

/** A relayed message as the harness reads it: passed on by the person's Buddy, which reads no answer. Never called the
 *  person's own words: the machine cannot know whose they are (security review 2 of #2626). */
export function relayedText(message: Message): string {
  const from = message.from
  return `[from ${shown(from.name)} · ${shown(from.machine)}: passed on by your person's Buddy in Harness. It does not read your answer; your person does.]\n\n${message.text}`
}
