import type { Command, CommandContext } from './commands.js'
import { findCredentials } from './credentials.js'
import { machineContribution, teamPoolsOf, type ContributedMachine } from './machines.js'
import { fail, stableId, type Actor, type SuperTabState } from './model.js'
import { ledProject } from './projects.js'

/**
 * What a machine can reach, by macOS account (task #3047, docs/design/2026-11-05-machine-access.md): short names people
 * already use ("Lamp", "Fusion 360", "Email (dee@)"), so a task that needs one runs where it is. An entry never holds the
 * secret itself; a note may say where the connection info lives. Having access listed grants no permission.
 */
export interface AccessEntry {
  /** 16 hex, made by the server. */
  id: string
  name: string
  /** `own`: the machine owner's macOS account; `team`: the Mac's Harness Team account. Both live on the Mac's own entry. */
  account: 'own' | 'team'
  /** `unconfirmed`: someone other than the owner said it (or the owner's word could not be checked); it counts for nothing
   *  until the owner confirms, and goes after UNCONFIRMED_ACCESS_MS. */
  state: 'ok' | 'unconfirmed'
  /** An own-account entry teammates' tasks that need it may use, in the owner's account: set only from the owner's session. */
  teammates?: true
  /** A production system: the route notes that writes still need a person's go. */
  production?: true
  /** How the machine could confirm it by itself (phase 2). Only its owner reads it. */
  check?: string
  /** How to use it. Only its owner and agents running on that machine, in that entry's account, read it. */
  note?: string
  /** The person who added or confirmed it: the owner, or for an unconfirmed entry whoever said it. */
  addedBy: string
  addedAt: string
  /** Whoever's chat message an unconfirmed entry came from, for "waiting for you: Dee said it". */
  saidBy?: string
  /** The chat message a Lead passed on. */
  askedIn?: { conversationId: string; messageId: string }
}

export const MAX_ACCESS = 32
export const UNCONFIRMED_ACCESS_MS = 7 * 24 * 60 * 60_000

/** Names match without case or surrounding space: "lamp" is "Lamp". */
export const accessKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()
export const sameAccessName = (a: string, b: string): boolean => accessKey(a) === accessKey(b)

const KNOWN_PREFIX = /(^|[^A-Za-z0-9])(sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[a-z]-|AKIA|ASIA)[A-Za-z0-9]/
/** `user:pass@host`: a password in an address. */
const PASSWORD_IN_ADDRESS = /[^\s:@/]+:[^\s:@/]+@[^\s@]/
/**
 * Whether [text] looks like a secret rather than a name or where one lives: whatever chat redaction finds (credentials.ts),
 * a key block, a known token prefix, a password in an address, or a run of 20 or more key-like characters that mixes letters
 * and digits. Paths and words pass: "connection info in ~/.argocd/config".
 */
export function secretLike(text: string): boolean {
  if (findCredentials(text).length || text.includes('-----BEGIN') || KNOWN_PREFIX.test(text) || PASSWORD_IN_ADDRESS.test(text)) return true
  return text.split(/[^A-Za-z0-9+=_-]+/).some(run => run.length >= 20 && /[A-Za-z]/.test(run) && /\d/.test(run))
}

/** Drops unconfirmed entries nobody confirmed in UNCONFIRMED_ACCESS_MS, on every write and read, as expireRemovals. */
export function expireAccess(state: Pick<SuperTabState, 'machines'>, now: number): void {
  for (const pool of state.machines ?? []) {
    if (!pool.access) continue
    const kept = pool.access.filter(e => e.state !== 'unconfirmed' || now - Date.parse(e.addedAt) < UNCONFIRMED_ACCESS_MS)
    if (kept.length === pool.access.length) continue
    if (kept.length) pool.access = kept
    else delete pool.access
  }
}

/** The Mac a pool is: itself, or for a Harness Team account's pool the Mac it lives on, whose entry holds both lists. */
export function macOf(state: Pick<SuperTabState, 'machines'>, pool: ContributedMachine): ContributedMachine | undefined {
  return pool.hostMachineId ? state.machines?.find(m => m.machineId === pool.hostMachineId && m.contributorId === pool.contributorId) : pool
}

type AccessCommand = Extract<Command, { type: 'machine.access' }>
type AskedIn = AccessCommand['askedIn']

/**
 * Applies one machine.access command and returns the entry's id. Its owner changes anything from their own session. A
 * Lead passes on what people say in chat (design section 2): the owner's own word from the last day, in a chat it leads,
 * counts at once ([ownerWord], as machine.projects); anything else (someone else's word, an older message, another chat)
 * is kept unconfirmed until the owner confirms. Sharing an entry with teammates loosens a privacy guard, and marking one
 * not production hides a warning, so both are the owner's own session only.
 */
export function changeAccess(state: SuperTabState, actor: Actor, command: AccessCommand, context: Pick<CommandContext, 'now' | 'askedIn'>,
  ownerWord: (pool: ContributedMachine, askedIn: AskedIn) => boolean, operationId: string): string {
  const pool = machineContribution(state, command.machineId)
  // A Harness Team account's entries live on its Mac: it is that Mac, under its name.
  if (!pool || pool.hostMachineId || pool.buddyOnly) fail('NOT_FOUND', 'This machine has not been contributed.', 404)
  if (pool.removal) fail('MACHINE_REMOVED', 'This machine is being removed from the Swarm.')
  const owners = ownerWord(pool, command.askedIn)
  const session = actor.kind === 'person' && actor.userId === pool.contributorId
  const lead = actor.kind === 'agent' && !!ledProject(state, actor.agentId)
  const message = context.askedIn
  // Whose chat message a Lead records unconfirmed: a person's, not a system row.
  const saidBy = !owners && lead && command.askedIn && message && message.author.kind === 'person' && !message.source ? message.author.id : undefined
  const refuseOwner = (): never => fail('OWNER_REQUIRED',
    "Only the machine's owner, or the Lead passing on a chat message the owner wrote in the last day, changes what it can reach.", 403)
  const ownerSession = (what: string): never => fail('OWNER_SESSION_REQUIRED', `Only the machine's owner can ${what}, from Harness on their own computer.`, 403)
  for (const text of [command.name, command.note, command.check]) {
    if (text && secretLike(text)) fail('ACCESS_SECRET', 'That looks like a password or key. Write where it lives instead, such as a file or profile name.', 400)
  }
  if (command.teammates === true && !session) ownerSession('share what it can reach with teammates')
  if (command.production === false && !session) ownerSession('mark an entry as not a production system')
  const relayed = actor.kind === 'agent' && command.askedIn
    ? { askedIn: { conversationId: command.askedIn.conversationId, messageId: command.askedIn.messageId } } : {}
  const at = new Date(context.now).toISOString()
  const list = pool.access ?? []
  const taken = (name: string, account: AccessEntry['account'], except?: string) =>
    list.some(e => e.id !== except && e.account === account && sameAccessName(e.name, name))
  const exists = (name: string): never => fail('ACCESS_EXISTS', `${name} is already listed for that account on ${pool.name}.`)
  if (command.action === 'add') {
    if (!command.name) fail('INVALID_REQUEST', 'Name the access to add.', 400)
    if (!owners && !saidBy) refuseOwner()
    const account = command.account ?? 'own'
    if (account === 'team' && !teamPoolsOf(state, pool).length) fail('NO_TEAM_ACCOUNT', `${pool.name} has no Harness Team account in this Swarm.`, 400)
    if (account === 'team' && command.teammates) teamEntry()
    if (taken(command.name, account)) exists(command.name)
    if (list.length >= MAX_ACCESS) fail('ACCESS_FULL', `${pool.name} lists ${MAX_ACCESS} things it can reach, the most it keeps. Remove one first.`)
    const id = stableId(operationId, 'machine.access').slice(0, 16)
    pool.access = [...list, { id, name: command.name, account, state: owners ? 'ok' : 'unconfirmed',
      ...(command.teammates ? { teammates: true as const } : {}), ...(command.production ? { production: true as const } : {}),
      ...(command.check && owners ? { check: command.check } : {}), ...(command.note ? { note: command.note } : {}),
      addedBy: owners ? pool.contributorId : saidBy!, addedAt: at, ...(owners ? {} : { saidBy }), ...relayed }]
    return id
  }
  const entry = (command.entryId && list.find(e => e.id === command.entryId)) || fail('NOT_FOUND', 'That entry is not on this machine.', 404)
  if (command.action === 'remove') {
    // A Lead takes back what it recorded unconfirmed (the owner said "Not right"); anything else is the owner's.
    if (!owners && !(lead && entry.state === 'unconfirmed')) refuseOwner()
    const kept = list.filter(e => e !== entry)
    if (kept.length) pool.access = kept
    else delete pool.access
    return entry.id
  }
  if (!owners) refuseOwner()
  if (command.action === 'confirm') {
    entry.state = 'ok'
    entry.addedBy = pool.contributorId
    delete entry.saidBy
    if (relayed.askedIn) entry.askedIn = relayed.askedIn
    else delete entry.askedIn
    return entry.id
  }
  if (command.account !== undefined) fail('INVALID_REQUEST', 'Remove the entry and add it again to move it to the other account.', 400)
  if (command.name !== undefined) {
    if (taken(command.name, entry.account, entry.id)) exists(command.name)
    entry.name = command.name
  }
  if (command.teammates !== undefined) {
    if (entry.account === 'team') teamEntry()
    if (command.teammates) entry.teammates = true
    else delete entry.teammates
  }
  if (command.production !== undefined) {
    if (command.production) entry.production = true
    else delete entry.production
  }
  for (const key of ['note', 'check'] as const) {
    const value = command[key]
    if (value === undefined) continue
    if (value === null) delete entry[key]
    else entry[key] = value
  }
  return entry.id
}

const teamEntry = (): never =>
  fail('TEAM_ACCOUNT_ENTRY', 'A Harness Team account always runs teammates\' work: only an entry in your own account is shared.', 400)
