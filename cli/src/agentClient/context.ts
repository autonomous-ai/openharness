/**
 * Where an agent is and what it may do, said before it acts (docs/design/2026-10-15-agent-experience.md, part 1).
 * Pure: commands.ts gathers what it says.
 */
import { PERSON_SAID_YES } from '../lib/agentSettings.js'
import type { NewMachine } from '../lib/newCommand.js'
import { engineName } from '../messages/model.js'
import type { Caller } from './model.js'

/** Which limit refuses a start (commands.ts `spawnCheck`). */
export type SpawnReason = 'DEPTH' | 'OPEN_LIMIT' | 'MACHINE_LIMIT' | 'START_RATE'

/** What the limits count for one caller: its open harnesses, its starts in the window, its depth. */
export interface SpawnCount { open: number; starts: number; depth: number; oldestStartAt: number | null }

export type CanStartReason = 'SIGNED_OUT' | 'SWITCH_OFF' | 'ORPHAN' | SpawnReason

export interface ContextInput {
  /** The agent calling, or null: the person, or what is left of an agent ([orphan]). */
  caller: Caller | null
  orphan: boolean
  /** This machine's name. */
  machine: string
  signedIn: boolean
  /** "Agents can start other agents", as this computer keeps the account's choice. */
  switchOn: boolean
  check: { reason: SpawnReason; message: string } | null
  count: SpawnCount | null
  limits: { livePerHarness: number; perWindow: number; windowMs: number; depth: number }
  /** The account's machines, this one included (marked `current`); empty when they could not be read. */
  machines: readonly NewMachine[]
  /** How this caller closes one of its harnesses: a command, or an MCP tool call. */
  closeStep: string
}

export interface Context {
  caller: { kind: 'agent' | 'person'; agent: string | null; name: string | null; id: string | null; inside: boolean; machine: string }
  /** Null for the person: they are never refused. */
  canStart: { ok: boolean; reason: CanStartReason | null; message: string; fix: string | null; fixBy: 'person' | 'you' | null } | null
  quota: { open: number; maxOpen: number; starts: number; maxStarts: number; windowMinutes: number; depth: number; maxDepth: number; nextStartAt: string | null } | null
  machines: Array<{ name: string; state: string }>
}

const TURN_ON = 'harness settings agents-start-agents on'
/** What the agent runs itself once the person said yes (agentClient/settings.ts). */
const TURN_ON_ONCE_ASKED = `${TURN_ON} ${PERSON_SAID_YES}`
/** Other machines named on line 3; the rest are counted. */
const MACHINES_SHOWN = 4
const oneLine = (text: string, max = 40): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function buildContext(i: ContextInput): Context {
  const agent = !!i.caller || i.orphan
  const caller: Context['caller'] = {
    kind: agent ? 'agent' : 'person',
    agent: i.caller ? (i.caller.outside ? i.caller.name : engineName(i.caller.engine)) : null,
    name: i.caller && !i.caller.outside ? i.caller.name : null,
    id: i.caller && !i.caller.outside ? i.caller.agentId : null,
    inside: !i.caller?.outside,
    machine: i.machine,
  }
  const machines = i.machines.filter((m) => !m.current).map((m) => ({ name: m.label, state: m.status }))
  if (!agent) return { caller, canStart: null, quota: null, machines }
  const minutes = Math.round(i.limits.windowMs / 60_000)
  const quota = i.caller && i.count ? {
    open: i.count.open, maxOpen: i.limits.livePerHarness, starts: i.count.starts, maxStarts: i.limits.perWindow,
    windowMinutes: minutes, depth: i.count.depth, maxDepth: i.limits.depth,
    nextStartAt: i.count.starts >= i.limits.perWindow && i.count.oldestStartAt !== null ? new Date(i.count.oldestStartAt + i.limits.windowMs).toISOString() : null,
  } : null
  const no = (reason: CanStartReason, message: string, fix: string | null = null, fixBy: 'person' | 'you' | null = null) =>
    ({ ok: false, reason, message, fix, fixBy })
  // In the order a start is refused: who may start at all (the pane, the account), then the limits (`spawnCheck`).
  const canStart: NonNullable<Context['canStart']> =
    i.orphan && !i.caller ? no('ORPHAN', 'This pane\'s harness is no longer running. Only the person can start or close harnesses here.', null, 'person')
    : !i.signedIn ? no('SIGNED_OUT', 'This computer is signed out of Harness, and starting is the account\'s choice.', `harness login, then ${TURN_ON}`, 'person')
    : !i.switchOn ? no('SWITCH_OFF', 'The person has not turned on "Agents can start other agents".', TURN_ON_ONCE_ASKED, 'person')
    : i.check?.reason === 'DEPTH' ? no('DEPTH', 'An agent started you, and only one level is allowed. Do the work yourself, or say in your answer what else is needed.')
    : i.check?.reason === 'OPEN_LIMIT' ? no('OPEN_LIMIT', `You have ${quota?.open ?? i.limits.livePerHarness} open, the most.`, i.closeStep, 'you')
    : i.check?.reason === 'MACHINE_LIMIT' ? no('MACHINE_LIMIT', i.check.message)
    : i.check?.reason === 'START_RATE' ? no('START_RATE', `${i.limits.perWindow} starts in ${minutes} minutes.`, null, 'you')
    : { ok: true, reason: null, message: '', fix: null, fixBy: null }
  return { caller, canStart, quota, machines }
}

/** A time as the person's clock shows it. */
const hhmm = (iso: string): string => new Date(iso).toTimeString().slice(0, 5)

export function formatContext(c: Context): string {
  const who = c.caller.kind === 'person' ? `You: the person, on ${c.caller.machine}.`
    : !c.caller.agent ? `You: an agent in a Harness pane whose harness is gone, on ${c.caller.machine}.`
    : c.caller.inside ? `You: ${c.caller.agent} "${oneLine(c.caller.name ?? '')}" (${(c.caller.id ?? '').slice(0, 8)}), inside Harness, on ${c.caller.machine}.`
    : `You: ${c.caller.agent}, outside Harness, on ${c.caller.machine}. Nothing can message you here.`
  if (!c.canStart) return who
  const s = c.canStart
  // The switch is the person's yes: the agent asks them with its own tool for it, and runs the command only after it
  // (settings.ts). Signing in is theirs alone: a code on their phone.
  const asking = s.fixBy === 'you' ? 'To free a place'
    : s.reason === 'SWITCH_OFF' ? 'Ask them, with your tool for asking them (Claude Code: AskUserQuestion; Codex: request_user_input) or in your reply; only after their yes, run'
    : 'Ask the person to run, in their own terminal'
  const can = s.ok ? 'Can start harnesses: yes.'
    : s.reason === 'START_RATE' && c.quota?.nextStartAt ? `Can start harnesses: not until ${hhmm(c.quota.nextStartAt)} (${s.message.replace(/\.$/, '')}).`
    : `Can start harnesses: no. ${s.message}${s.fix ? ` ${asking}: ${s.fix}` : ''}`
  if (!c.quota) return [who, can].join('\n')
  const shown = c.machines.slice(0, MACHINES_SHOWN).map((m) => `${oneLine(m.name, 24)} (${m.state})`)
  const more = c.machines.length > MACHINES_SHOWN ? [`+${c.machines.length - MACHINES_SHOWN} more`] : []
  const others = shown.length ? ` · other machines: ${[...shown, ...more].join(', ')}` : ''
  return [who, can, `Yours: ${c.quota.open} open of ${c.quota.maxOpen} · ${c.quota.starts} of ${c.quota.maxStarts} starts in the last ${c.quota.windowMinutes} minutes${others}`].join('\n')
}
