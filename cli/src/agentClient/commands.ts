/**
 * Harness for agents (docs/design/2026-10-11-agent-client.md): the verbs an agent runs from its own pane to see,
 * read, wait for and close other harnesses. `harness new` and `harness send` are the other two; this file gives
 * `new` what it needs when an agent runs it (`agentOrigin`).
 *
 *     harness ps [--machine <name>] [--all] [--json]
 *     harness show [--machine <name>] <name> [--chars N] [--json]
 *     harness wait [--machine <name>] <name>[,<name>…] [--any] [--timeout 30m] [--json]
 *     harness close [--machine <name>] <name> [--now] [--json]
 *
 * `--machine` names another of the owner's machines, as `harness new` takes it; without it, this one.
 *
 * Text by default, because agents read it as well as people do and it costs them a fraction of the tokens;
 * `--json` for programs. Everything is composed from requests the daemon already answers: `agents_list`,
 * `agent_recent`, a bounded `session_get` page, and `agent_close` (its `inspect` mode tells needs-input from idle).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { askThePersonFirst, readAgentSettings } from '../lib/agentSettings.js'
import { MAX_FIRST_PROMPT_CHARS } from '../lib/engineLaunch.js'
import { NewUsageError, resolveNewMachine, type NewMachine, type NewOrigin } from '../lib/newCommand.js'
import { engineName, MessageError } from '../messages/model.js'
import { machineListCachePath } from '../device/machineList.js'
import { readAuthSession } from '../lib/authSession.js'
import { buildContext, formatContext, type Context, type SpawnCount, type SpawnReason } from './context.js'
import { formatNext, type NextStep } from './next.js'
import { AgentClientError, openDaemon, whereFor, type Daemon, type Where } from './daemon.js'
import { Ledger, ledgerPath, type Pending, type Started, type Told } from './ledger.js'
import { messagesRpc, type Rpc } from '../messages/rpc.js'
import { TELL_OFF_TEXT } from '../messages/tell.js'
import { sendPane } from '../messages/command.js'
import { asSaid, callerOf, clip, cloudTurn, forAgent, isAgent, lastTurn, matching, outsideCaller, rowsOf, stateOf, STOPPED_WITHIN_MS, type Caller, type Frame, type HistoryEvent, type Row, type State } from './model.js'

export interface ClientDeps {
  pane?: string | undefined
  /** The caller's environment: an agent outside Harness is told by what it sets there (`outsideCaller`). */
  env?: NodeJS.ProcessEnv
  where?: () => Where
  open?: (where: Where, machineId?: string) => Promise<Daemon>
  ledger?: (dataDir: string) => Ledger
  out?: (line: string) => void
  err?: (line: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How often `wait` looks. */
  intervalMs?: number
  /** How a start is recorded on another machine (the messages service's `started`). */
  record?: Rpc
  /** The account's machines, for `--machine` (cli.ts asks the backend, as `harness new` does). */
  machines?: () => Promise<NewMachine[]>
}

const ON_MACHINE = '--machine <name> is another of your machines, by its name or id as harness new takes it; this one when left out.'

export const PS_USAGE = `Usage: harness ps [--machine <name>] [--all] [--json]

The harnesses on a machine: name, agent, state, who started it, when it was last active, and what it is about.
--all adds the ones stopped in the last week.
${ON_MACHINE}`
export const SHOW_USAGE = `Usage: harness show [--machine <name>] <name> [--chars N] [--json]

A harness's state and its last turn: what it was asked and what it answered (the first N characters, 4000 by default).
${ON_MACHINE}`
export const REPLY_USAGE = `Usage: harness reply [--machine <name>] <name> [--json] -- <words…>

Says <words> to a cloud harness (Devin Cloud, Cursor Cloud, Fo): its answer to the question it asked, or what to do next.
The person's, or a program's acting for them; an agent does not answer for the person.
${ON_MACHINE}`
export const TELL_USAGE = `Usage: harness tell [--machine <name>] <name> [--json] -- <work…>

Gives more work to a harness you started: typed into it once it is free, or given at its next tool call while it
works. Then wait for it (harness wait <name>) and read its answer (harness show <name>). Only a harness you started,
and only while the person allows it (harness settings agents-tell-agents).
${ON_MACHINE}`
export const WAIT_USAGE = `Usage: harness wait [--machine <name>] <name>[,<name>…] [--any] [--timeout 30m] [--json]

Waits until each harness has stopped working, then prints its state. --any returns when the first one does.
Exit status: 0 idle or closed by you, 3 one needs the person (a question or a permission), 4 one stopped or is gone,
124 timed out.
--timeout takes 90s, 30m, 2h; 0 waits as long as it takes.
${ON_MACHINE}`
export const CLOSE_USAGE = `Usage: harness close [--machine <name>] <name> [--now] [--json]

Saves the harness's screen and stops it. Its conversation is kept: the person can resume it.
It is refused while the harness is working, unless --now. An agent may close only harnesses it started:
closing another's exits 5.
${ON_MACHINE}`
export const WHOAMI_USAGE = `Usage: harness whoami [--json]

Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now
and, if not, who can change that; how many of yours are open, and how many starts are left.`

export const EXIT = { ok: 0, failed: 1, usage: 2, needsInput: 3, stopped: 4, refused: 5, timeout: 124 } as const

/** Not a failure: the caller may not do this. It should not retry; it tells the person or does the work itself.
 *  `TELL_OFF` and `NOT_RUNNING` are `harness tell`'s: retried, they are refused the same. */
export const REFUSED_CODES: ReadonlySet<string> = new Set(['SPAWN_LIMIT', 'TURNED_OFF', 'NOT_YOURS', 'TELL_OFF', 'NOT_RUNNING'])

/** What a refused caller may do instead: close one of its own when it is at its limit; otherwise the message says. */
export function refusalNext(env: NodeJS.ProcessEnv, error: AgentClientError): NextStep[] {
  return error.reason === 'OPEN_LIMIT' ? [{ run: step(env, 'close', '<name>'), when: 'one you are done with, to free a place' }] : []
}

/** A state as an agent reads it: one that waits on a question or a permission says who answers it. JSON keeps the word. */
const stateSaid = (state: string): string => (state === 'needs-input' ? 'needs the person' : state)

/** Set by `harness mcp` (mcp.ts) for the verbs it runs: their next steps are then named as its tools. */
export const VIA_MCP_ENV = 'HARNESS_VIA_MCP'
const TOOL_OF = { ps: 'harness_list', show: 'harness_read', wait: 'harness_wait', close: 'harness_close', tell: 'harness_tell' } as const

/**
 * A next step as the caller can take it: the shell's `harness show x`, or the tool `harness mcp` offers for it. An MCP
 * client may have no shell at all (Claude Desktop), and its agent was told to run `harness show x` (2026-10-11, in a
 * clean VM). [option] is a flag and its MCP argument: `--chars 9000` / `chars: 9000`.
 */
export function step(env: NodeJS.ProcessEnv, verb: keyof typeof TOOL_OF, name = '', option?: { flag: string; arg: string }): string {
  if (env[VIA_MCP_ENV] !== '1') return ['harness', verb, name, option?.flag].filter(Boolean).join(' ')
  // A name quoted for the shell (`"code review"`, addressOf) is quoted once, as the tool's argument.
  const bare = name.replace(/^"(.*)"$/, '$1')
  const args = [bare && `${verb === 'wait' ? 'names' : 'name'}: "${bare}"`, option?.arg].filter(Boolean)
  return `${TOOL_OF[verb]}${args.length ? ` (${args.join(', ')})` : ''}`
}

const DEFAULT_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_INTERVAL_MS = 3_000
/** How many harnesses `ps` asks what they are about; the rest list without it. */
const ABOUT_MAX = 40
/** A harness that never worked while waited on, with nothing in its transcript: nothing to wait for. */
const QUIET_LOOKS = 3
/** How long a new harness may take to start and have its task typed (a Codex start with its trust prompt is the
 *  slowest seen). Before it, a harness that is not working may simply not have begun. */
const STARTING_MS = 2 * 60_000

class UsageError extends Error {}

/** What an agent's `harness new` (and MCP's `harness_start`) says while the person has not let agents start agents: an
 *  account experiment, off by default (lib/agentSettings.ts), so it says where the person turns it on, as `harness send`
 *  does. */
export const AGENTS_START_AGENTS_OFF = `Agents may not start harnesses yet. ${askThePersonFirst('agents-start-agents', 'do the work yourself.')}`

const ORPHAN = 'This pane\'s harness is no longer running, so nothing here may close or start harnesses. Only the person can.'

/**
 * A harness the caller asked for that has not started, as its machine says now: still on its way (`installing` while
 * Harness installs its engine), or never started (`failed`, with why). `harness new` answers before an install is done,
 * so an agent follows such a harness by its name with `ps` and `wait` until it starts by itself.
 */
export interface Asked { row: Pending; state: 'installing' | 'starting' | 'failed'; detail: string }

interface Opened {
  where: Where; daemon: Daemon; frames: Frame[]; caller: Caller | null; ledger: Ledger; machine: string
  /** The caller's harnesses asked for and not started (`Asked`). */
  asked: Asked[]
  /** Run from a pane Harness made whose harness it no longer knows (closed, forgotten): what is left of an agent,
   *  a background job it started, say. Never the person: it may look, not close or start. */
  orphan: boolean
  /** `frames` holds the stopped harnesses too. */
  stopped: boolean
}

function setup(deps: ClientDeps) {
  const pane = 'pane' in deps ? deps.pane : sendPane(deps.env ?? process.env)
  return {
    pane,
    env: deps.env ?? process.env,
    where: deps.where ?? (() => whereFor(pane)),
    open: deps.open ?? ((where: Where, machineId?: string) => openDaemon(where, machineId)),
    ledger: deps.ledger ?? ((dataDir: string) => new Ledger(ledgerPath(dataDir))),
    out: deps.out ?? ((line: string) => console.log(line)),
    err: deps.err ?? ((line: string) => console.error(line)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    intervalMs: deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    record: deps.record ?? messagesRpc,
    machines: deps.machines ?? (async (): Promise<NewMachine[]> => {
      throw new AgentClientError('MACHINES_UNAVAILABLE', 'Harness could not list your machines here.')
    }),
  }
}
type Setup = ReturnType<typeof setup>

/** Another machine named with `--machine`: as typed, and its id and name as the account knows them. */
export interface Away { word: string; machineId: string; label: string }

/**
 * The machine `--machine` names, resolved as `harness new` resolves it (an id, else a name, case-blind); null for this
 * one, which is then read exactly as with no `--machine` at all. The lamp (lamp-4ace, 2026-10-14 21:36), a program running the CLI
 * outside Harness, started `lamp-first-task` on office with `harness new claude @office`, and `show` and `wait` could
 * not reach it: they looked on the lamp alone, and only an agent's starts are recorded for them to follow.
 */
async function machineOf(s: Setup, where: Where, word: string | null): Promise<Away | null> {
  if (word === null) return null
  let machine: NewMachine
  try { machine = resolveNewMachine(word, await s.machines()) } catch (error) {
    if (error instanceof NewUsageError) throw new AgentClientError('UNKNOWN_MACHINE', error.message)
    throw error
  }
  return machine.current || machine.machineId === where.machineId ? null : { word, machineId: machine.machineId, label: machine.label }
}

/** `--machine <name>` as a shell takes it: the name quoted when it has a space (`--machine "Mac mini"`). */
export const machineOption = (word: string): string =>
  `--machine ${/^[\w.:-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, '\\$1')}"`}`

/** A next step's harness, with the machine it was named on: `--machine office lamp-first-task`. */
const onAway = (name: string, away: Away | null): string => (away ? `${machineOption(away.word)} ${name}` : name)

/** This machine's name as Harness shows it (`machine-name` in the data folder), else the host's. */
export function machineNameOf(dataDir: string): string {
  try {
    const name = readFileSync(join(dataDir, 'machine-name'), 'utf8').trim()
    if (name) return name
  } catch { /* the host's name below */ }
  return hostname().replace(/\.local$/, '')
}

async function list(daemon: Daemon, includeStopped: boolean): Promise<Frame[]> {
  const reply = await daemon.request('agents_list', { includeStopped })
  if (reply.error) throw new AgentClientError(String(reply.error), 'Harness could not list its harnesses. Try again.')
  return Array.isArray(reply.agents) ? reply.agents as Frame[] : []
}

/**
 * The line to the caller's daemon, its harnesses, who is calling, and the ledger. Live ones (and offline ones) only,
 * unless asked: the list with every stopped harness took 128 ms against 10 ms on the owner's Mac (391 harnesses, 21
 * live), and a stopped harness keeps no pane, so the caller is never one.
 */
async function opened(s: Setup, includeStopped = false): Promise<Opened> {
  const where = s.where()
  const daemon = await s.open(where)
  try {
    const frames = await list(daemon, includeStopped)
    const inPane = callerOf(frames, s.pane, where.machineId)
    // Any status: the core marks every session inactive as it starts (core/main.ts), and a person's terminal is theirs
    // through it. A stopped harness keeps no pane (`toStoppedProject`), so an old pane number never matches one.
    const terminal = frames.some((f) => f.tmuxPane === s.pane && f.engine === 'terminal')
    const orphan = !!s.pane && !!where.harnessPane && !inPane && !terminal
    // Not a harness: an agent outside Harness when its shell says so, even in a terminal of Harness's own.
    const caller = inPane ?? (orphan ? null : outsideCaller(s.env, where.machineId))
    const ledger = s.ledger(where.dataDir)
    const asked = await askAfter(s, where, daemon, ledger, caller)
    return { where, daemon, frames, caller, orphan, stopped: includeStopped, ledger, machine: machineNameOf(where.dataDir), asked }
  } catch (error) { daemon.close(); throw error }
}

/** What a held creation waits for, in the machine's words (`held.detail`). */
const heldDetail = (status: Record<string, unknown>): string => {
  const held = status.held as { detail?: unknown } | undefined
  return typeof held?.detail === 'string' ? held.detail.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) : ''
}

/** How it stands, from a creation's status: null once there is nothing left to follow (made, cancelled, unknown). */
export function askedOf(row: Pending, status: Record<string, unknown>): Asked | null {
  if (status.state === 'pending') {
    const install = (status.held as { service?: unknown } | undefined)?.service === 'install'
    return { row, state: install ? 'installing' : 'starting', detail: heldDetail(status) }
  }
  if (status.state !== 'failed') return null
  const failure = (status.failure ?? {}) as { code?: unknown; detail?: unknown }
  const detail = typeof failure.detail === 'string' && failure.detail ? failure.detail : typeof failure.code === 'string' ? failure.code : ''
  return { row, state: 'failed', detail: detail.slice(0, 500) }
}

/**
 * Records a harness asked for and made since as started by who asked (`Started`, with its creation), here and, for one
 * on another machine, there too, as `harness new` does (`created`): there its limits and depth start from it.
 */
async function recordMade(s: Setup, where: Where, ledger: Ledger, row: Pending, agent: Frame): Promise<void> {
  const started: Started = { at: row.at, by: row.by, depth: row.depth,
    child: { machineId: row.creation.machineId, agentId: agent.id, name: agent.name || row.creation.name, creationId: row.creation.creationId } }
  if (ledger.parentOf(started.child)) return
  ledger.record(started)
  if (row.creation.machineId !== where.machineId) {
    await s.record({ port: where.port, dataDir: where.dataDir, machineId: row.creation.machineId }, { action: 'started', row: started }, 10_000).catch(() => {})
  }
}

/**
 * The pending lines (ledger.ts `Pending`) asked of their machines. One now made is recorded as started by who asked, as
 * `harness new` would have had it not answered first: anyone's on this machine, so a harness that started by itself
 * has its depth before it runs a verb of its own, and the caller's anywhere. The rest of the caller's are what it still
 * follows. A machine that cannot be asked keeps its line as starting: a second harness by that name is the risk here.
 */
async function askAfter(s: Setup, where: Where, daemon: Daemon, ledger: Ledger, caller: Caller | null): Promise<Asked[]> {
  const asked: Asked[] = []
  const mine = (row: Pending) => !!caller && row.by.machineId === caller.machineId && row.by.agentId === caller.agentId
  for (const row of ledger.pendingOf(null, s.now())) {
    const here = row.creation.machineId === where.machineId
    if (!here && !mine(row)) continue
    let line: Daemon | null = here ? daemon : null
    try {
      line ??= await s.open(where, row.creation.machineId)
      const status = await line.request('agent_create_status', { creationId: row.creation.creationId }, 8_000)
      const agent = (status.agent ?? {}) as Frame
      if (status.state === 'created' && typeof agent.id === 'string' && agent.id) { await recordMade(s, where, ledger, row, agent); continue }
      const now = mine(row) ? askedOf(row, status) : null
      if (now) asked.push(now)
    } catch { if (mine(row)) asked.push({ row, state: 'starting', detail: '' }) }
    finally { if (!here) line?.close() }
  }
  return asked
}

/** How a harness asked for is called: its name, else its creation's start. */
const askedName = (a: Asked): string => a.row.creation.name || a.row.creation.creationId.slice(0, 8)

/** What the caller asked for by [name] that has not started: the latest, by the name it was given or its creation's start.
 *  On [machineId] alone when a machine was named with `--machine`. */
const askedNamed = (o: Opened, name: string, machineId?: string): Asked | undefined => {
  const wanted = name.trim().toLowerCase()
  return o.asked.filter((a) => (machineId === undefined || a.row.creation.machineId === machineId)
    && (askedName(a).toLowerCase() === wanted || (wanted.length >= 6 && a.row.creation.creationId.toLowerCase().startsWith(wanted)))).at(-1)
}

/** One line on a harness that has not started: what it waits for, or why it never will. */
function askedLine(env: NodeJS.ProcessEnv, a: Asked, away: Away | null = null): string {
  const name = askedName(a), engine = engineName(a.row.creation.engine)
  if (a.state === 'failed') return `${name} never started: ${a.detail || 'its machine refused it'}.`
  const why = a.state === 'installing' ? `Harness is installing ${engine}` : `it is starting${a.detail ? ` (${a.detail.replace(/\.$/, '')})` : ''}`
  return `${name} has not started yet: ${why}. It starts by itself; wait for it with ${step(env, 'wait', onAway(name, away))}.`
}

const notStarted = (env: NodeJS.ProcessEnv, a: Asked, away: Away | null = null): AgentClientError =>
  new AgentClientError(a.state === 'failed' ? 'NEVER_STARTED' : 'NOT_STARTED', askedLine(env, a, away))

interface Target { daemon: Daemon; frame: Frame; machineId: string; machine: string; yours: boolean; remote: boolean }

/** A machine's harnesses by the names the verbs call them: a terminal is the person's, and an unnamed one is its id's start. */
const named = (frames: Frame[]) => frames.filter(isAgent).map((f) => ({ ...f, name: f.name || f.id.slice(0, 8) }))

/** Exactly [name], by its name or its id. */
const exactly = (name: string) => (f: Frame) => f.name?.toLowerCase() === name.trim().toLowerCase() || f.id.toLowerCase() === name.trim().toLowerCase()

/** The caller started it, as the ledger says. */
const yoursOn = (o: Opened, machineId: string, agentId: string): boolean => {
  const parent = o.ledger.parentOf({ machineId, agentId })
  return !!o.caller && !!parent && parent.by.agentId === o.caller.agentId && parent.by.machineId === o.caller.machineId
}

/** The one of [found] [name] means: a live harness before a stopped one of the same name; null for none. */
function oneOf<T extends Frame & { name: string }>(name: string, found: T[]): T | null {
  if (found.some((f) => f.status !== 'stopped')) found = found.filter((f) => f.status !== 'stopped')
  if (found.length > 1) {
    throw new AgentClientError('AMBIGUOUS', `"${name}" could be ${found.slice(0, 6).map((f) => `${f.name} (${f.id.slice(0, 8)}, ${stateOf(f)})`).join(', ')}. Use more of the name, or the id.`)
  }
  return found[0] ?? null
}

/**
 * The harness [name] means: one on this machine, else one the caller started on another machine. A live harness
 * is preferred over a stopped one of the same name. With `--machine` ([away]), one on that machine (`targetAway`).
 */
async function target(s: Setup, o: Opened, name: string, away: Away | null = null): Promise<Target> {
  if (away) return targetAway(s, o, name, away)
  // Asked for by exactly this name and not started: it, before a harness whose name merely starts so.
  const pending = askedNamed(o, name)
  if (pending && !named(o.frames).some(exactly(name))) throw notStarted(s.env, pending)
  let found = matching(name, named(o.frames))
  // No live one by that name: the stopped ones too, read once.
  if (!found.length && !o.stopped) {
    o.frames = await list(o.daemon, true)
    o.stopped = true
    found = matching(name, named(o.frames))
  }
  const frame = oneOf(name, found)
  if (frame) return { daemon: o.daemon, frame, machineId: o.where.machineId, machine: o.machine, yours: yoursOn(o, o.where.machineId, frame.id), remote: false }
  // One the caller started, by the name it was started with (an unnamed harness takes its session's title once it
  // has one), here or on another machine.
  const mine = o.caller ? o.ledger.childrenOf(o.caller) : []
  const elsewhere = matching(name, mine.map((row) => ({ name: row.child.name || row.child.agentId.slice(0, 8), id: row.child.agentId, row })))
  const here = elsewhere.length === 1 && elsewhere[0].row.child.machineId === o.where.machineId
    ? named(o.frames).find((f) => f.id === elsewhere[0].row.child.agentId) : undefined
  if (here) return { daemon: o.daemon, frame: here, machineId: o.where.machineId, machine: o.machine, yours: true, remote: false }
  if (elsewhere.length === 1 && elsewhere[0].row.child.machineId !== o.where.machineId) {
    const { row } = elsewhere[0]
    const daemon = await s.open(o.where, row.child.machineId)
    const frame = named(await list(daemon, true)).find((f) => f.id === row.child.agentId)
    if (!frame) { daemon.close(); throw new AgentClientError('GONE', `${elsewhere[0].name} is no longer on its machine.`) }
    return { daemon, frame, machineId: row.child.machineId, machine: row.child.machineId.slice(0, 8), yours: true, remote: true }
  }
  const asked = askedNamed(o, name)
  if (asked) throw notStarted(s.env, asked)
  // A harness on another machine is named with its machine: the lamp's program was told only "on this machine".
  const elsewhereHint = s.env[VIA_MCP_ENV] === '1' ? '' : ` One on another of your machines: add --machine <name> (\`harness ps --machine <name>\` lists those).`
  throw new AgentClientError('UNKNOWN_HARNESS', `No harness named "${name}" on this machine. \`${step(s.env, 'ps')}\` lists them.${elsewhereHint}`)
}

/**
 * The harness [name] means on the machine named with `--machine`: any harness there, as on this machine, read through
 * that machine as one an agent started there is. What the caller may do with it is what it may do here: an agent
 * closes only what it started (`yoursOn`), whichever machine it is on.
 */
async function targetAway(s: Setup, o: Opened, name: string, away: Away): Promise<Target> {
  const pending = askedNamed(o, name, away.machineId)
  const daemon = await s.open(o.where, away.machineId)
  try {
    const live = named(await list(daemon, false))
    if (pending && !live.some(exactly(name))) throw notStarted(s.env, pending, away)
    let found = matching(name, live)
    if (!found.length) found = matching(name, named(await list(daemon, true)))
    const frame = oneOf(name, found)
    if (frame) return { daemon, frame, machineId: away.machineId, machine: away.label, yours: yoursOn(o, away.machineId, frame.id), remote: true }
    throw new AgentClientError('UNKNOWN_HARNESS', `No harness named "${name}" on ${away.label}. \`${step(s.env, 'ps', machineOption(away.word))}\` lists them.`)
  } catch (error) { daemon.close(); throw error }
}

type Screen = 'working' | 'needs-input' | 'idle' | 'draft'

/** What the screen says now (the windows' read, `agent_close` `inspect`); null when it cannot be read. `draft`:
 *  text waits in its box, the person's or a message being typed, so the agent is about to work. */
async function inspect(t: { daemon: Daemon; frame: Frame }): Promise<Screen | null> {
  const reply = await t.daemon.request('agent_close', {
    agentId: t.frame.id, sessionId: t.frame.sessionId ?? '', createdAt: t.frame.createdAt ?? '', mode: 'inspect',
  }).catch(() => ({} as Record<string, unknown>))
  switch (reply.activity) {
    case 'working': return 'working'
    case 'needs_input': return 'needs-input'
    case 'idle': return 'idle'
    case 'draft': return 'draft'
    default: return null
  }
}

/** The last turn, from the end of the transcript, a page at a time: never the whole file (the attach OOM). */
async function readLastTurn(t: { daemon: Daemon; frame: Frame }, pages = 4) {
  if (t.frame.location === 'cloud') {
    const reply = await t.daemon.request('cloud_transcript', { agentId: t.frame.id })
    if (typeof reply.error === 'string') return null
    return cloudTurn(Array.isArray(reply.messages) ? reply.messages as Array<Record<string, unknown>> : [])
  }
  if (!t.frame.sessionId) return null
  let before: string | undefined
  let events: HistoryEvent[] = []
  for (let i = 0; i < pages; i++) {
    const page = await t.daemon.request('session_get', { sessionId: t.frame.sessionId, limit: 80, ...(before ? { before } : {}) })
    if (page.error) return null
    events = [...(Array.isArray(page.events) ? page.events as HistoryEvent[] : []), ...events]
    const turn = lastTurn(events)
    if (turn || page.hasMore !== true || typeof page.oldestCursor !== 'string') return turn
    before = page.oldestCursor
  }
  return lastTurn(events)
}

/** `harness new claude @office`, the old way to name a machine, said as it is now typed. */
export const atMachineRefusal = (word: string): string =>
  `Name the machine with ${word.length > 1 ? machineOption(word.slice(1)) : '--machine <name>'}.`

/** The words and options of a verb. Every verb takes `--machine <name>`, which is returned apart. */
function words(argv: readonly string[], known: Record<string, 'flag' | 'value'>): { names: string[]; flags: Map<string, string | true>; machine: string | null } {
  const names: string[] = [], flags = new Map<string, string | true>()
  let machine: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--help' || word === '-h') throw new UsageError('')
    if (word.startsWith('--')) {
      const [key, inline] = word.split('=', 2)
      const kind = key === '--machine' ? 'value' : known[key]
      if (!kind) throw new UsageError(`Unknown option ${key}.`)
      if (kind === 'flag') flags.set(key, true)
      else {
        const value = inline ?? argv[++i]
        if (value === undefined || (key === '--machine' && (!value || value.startsWith('-')))) throw new UsageError(`${key} needs a value.`)
        if (key !== '--machine') flags.set(key, value)
        else if (machine !== null) throw new UsageError('Name one machine.')
        else machine = value
      }
    // `@office` named a machine in `harness new` once; read as a harness's name, it would only be not found.
    } else if (word.startsWith('@')) throw new UsageError(atMachineRefusal(word))
    else names.push(word)
  }
  return { names, flags, machine }
}

export function parseDuration(value: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(value.trim())
  if (!m) throw new UsageError(`"${value}" is not a time: use 90s, 30m or 2h.`)
  return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : m[2] === 's' ? 1_000 : 60_000)
}

const ago = (iso: string | null, now: number): string => {
  if (!iso) return '-'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86_400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86_400)}d`
}

const home = process.env.HOME ?? ''
const tilde = (path: string | null): string => (!path ? '-' : home && path.startsWith(home) ? `~${path.slice(home.length)}` : path)

async function run(usage: string, deps: ClientDeps, json: (argv: readonly string[]) => boolean, argv: readonly string[],
  body: (s: Setup) => Promise<number>): Promise<number> {
  const s = setup(deps)
  try { return await body(s) } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) s.err(error.message)
      ;(error.message ? s.err : s.out)(usage)
      return error.message ? EXIT.usage : EXIT.ok
    }
    const code = error instanceof AgentClientError ? error.code : 'FAILED'
    const message = error instanceof Error ? error.message : String(error)
    const refused = error instanceof AgentClientError && REFUSED_CODES.has(code)
    if (json(argv)) {
      s.out(JSON.stringify({ error: code, detail: message,
        ...(refused ? { code, ...(error.reason ? { reason: error.reason } : {}), next: refusalNext(s.env, error) } : {}) }))
    } else s.err(message)
    return refused ? EXIT.refused : EXIT.failed
  }
}
const wantsJson = (argv: readonly string[]): boolean => argv.includes('--json')

// ── ps ─────────────────────────────────────────────────────────────────────────────────────────────

export function formatRows(rows: Row[], now: number, on = 'this machine'): string {
  if (!rows.length) return `No harnesses on ${on}.`
  const width = Math.min(32, Math.max(4, ...rows.map((r) => r.name.length)))
  const head = `${'NAME'.padEnd(width)}  ${'AGENT'.padEnd(11)}  ${'STATE'.padEnd(11)}  ${'STARTED BY'.padEnd(12)}  ${'ACTIVE'.padEnd(6)}  FOLDER`
  const lines = rows.map((r) => {
    const name = clip(r.name, width).padEnd(width)
    const line = `${name}  ${clip(r.agent, 11).padEnd(11)}  ${r.state.padEnd(11)}  ${clip(r.self ? `${r.startedBy} (you)` : r.startedBy, 12).padEnd(12)}  ${ago(r.lastActive, now).padEnd(6)}  ${tilde(r.folder)}${r.branch ? ` (${r.branch})` : ''}`
    const about = r.about ?? (r.asks?.length ? `asked: ${r.asks[0]}` : '')
    return about ? `${line}\n${' '.repeat(2)}${clip(about.replace(/\s+/g, ' '), 200)}` : line
  })
  return [head, ...lines].join('\n')
}

export function psCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(PS_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--all': 'flag', '--json': 'flag' })
    const away = await machineOf(s, s.where(), machine)
    if (names.length) throw new UsageError(`harness ps takes no names. To read one: harness show ${onAway(names[0], away)}`)
    const all = flags.has('--all')
    const o = await opened(s, all)
    let line: Daemon | null = null
    try {
      // With `--machine`, that machine's harnesses, through it; who started each is still this machine's ledger's to say.
      const on = away
        ? { daemon: line = await s.open(o.where, away.machineId), machineId: away.machineId, machine: away.label }
        : { daemon: o.daemon, machineId: o.where.machineId, machine: o.machine }
      const frames = line ? await list(line, all) : o.frames
      const rows = rowsOf(frames, { machineId: on.machineId, machine: on.machine, caller: o.caller, ledger: o.ledger, now: s.now(), all })
      // What each is about: the summaries the daemon keeps (no transcript read), for the live ones.
      await Promise.all(rows.filter((r) => r.state !== 'stopped').slice(0, ABOUT_MAX).map(async (row) => {
        const recent = await on.daemon.request('agent_recent', { agentId: row.id, n: 3 }, 3_000).catch(() => null)
        if (!recent || recent.error) return
        const asks = (Array.isArray(recent.asks) ? recent.asks as unknown[] : []).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 2)
        const about = (Array.isArray(recent.events) ? recent.events as Array<Record<string, unknown>> : [])
          .map((e) => (typeof e.recap === 'string' && e.recap ? e.recap : typeof e.text === 'string' ? e.text : '').replace(/\s+/g, ' ').trim())
          .filter(Boolean).slice(0, 3).map((t) => clip(t, 140))
        if (asks.length) row.asks = asks.map((a) => clip(asSaid(a).replace(/\s+/g, ' ').trim(), 200))
        if (about.length) row.about = about.join(' / ')
      }))
      // Asked for and not started yet: listed by the name it was given, and what it waits for.
      rows.unshift(...o.asked.filter((a) => !away || a.row.creation.machineId === away.machineId).map((a): Row => ({
        name: askedName(a), id: a.row.creation.creationId, agent: engineName(a.row.creation.engine),
        machine: away ? away.label : a.row.creation.machineId === o.where.machineId ? o.machine : a.row.creation.machineId.slice(0, 8), state: a.state,
        folder: null, branch: null, startedBy: 'you', yours: true, self: false, lastActive: new Date(a.row.at).toISOString(), about: askedLine(s.env, a, away),
      })))
      // An agent is told where it is and what it may do before the list, and what to do next after it; a person's ps is
      // as it was.
      const agent = !!o.caller || o.orphan
      const context = contextFor(s, o)
      const next = o.caller ? psNext(s.env, rows, !!context.canStart?.ok) : []
      // An agent reads its own first and at most AGENT_ROWS, unless it asked for all; programs and the person get every row.
      const { shown, more } = agent && !all ? forAgent(rows) : { shown: rows, more: 0 }
      // `--all` lists the stopped ones too: said, so the agent knows what it asks for.
      const hiddenYours = more > 0 && shown.filter((r) => r.yours).length < rows.filter((r) => r.yours).length
      const rest = more ? `and ${more} more${hiddenYours ? '' : ', none of them yours'}: ${step(s.env, 'ps', away ? machineOption(away.word) : '', { flag: '--all', arg: 'all: true' })} (lists every one, and those stopped this week)` : null
      s.out(flags.has('--json') ? JSON.stringify({ you: o.caller ? o.caller.name : null, machine: on.machine, context, harnesses: rows, next }, null, 1)
        : [agent ? formatContext(context) : null, formatRows(shown, s.now(), away ? away.label : undefined), rest, formatNext(next)].filter(Boolean).join('\n'))
      return EXIT.ok
    } finally { line?.close(); o.daemon.close() }
  })
}

/** What `show` says to do next, from its state and whose it is: never `close` for a harness the caller did not start.
 *  Idle and the caller's: a harness left open after its answer is read sits there for nobody (owner, October 12). */
function showNext(env: NodeJS.ProcessEnv, state: State, yours: boolean, at: string, canTell = false): NextStep[] {
  if (state === 'needs-input') return [{ tell: 'tell the person; only they answer it (a question or a permission).' }]
  if (state === 'working' || state === 'unknown' || state === 'starting' || state === 'installing') return [{ run: step(env, 'wait', at), when: 'until it stops working' }]
  if (state === 'idle' && yours) {
    const close: NextStep = { run: step(env, 'close', at), when: 'once you have what you need' }
    // It keeps what it learned: more work for it costs less than a new harness told everything again.
    return canTell ? [{ run: tellStep(env, at), when: 'to give it more work in the same conversation' }, close] : [close]
  }
  return []
}

/** `harness tell x -- <work>`, or the tool `harness mcp` offers for it. */
const tellStep = (env: NodeJS.ProcessEnv, at: string): string => step(env, 'tell', at, { flag: '-- <work>', arg: 'text: "<work>"' })

/** Whether [o]'s caller may tell the harnesses it started: a harness in a pane, while the person allows it. */
const tellsHere = (o: Opened, pane: string | undefined): boolean =>
  !!o.caller && !o.caller.outside && !!pane && readAgentSettings(o.where.dataDir).agentsTellAgents

/**
 * What an agent's `ps` ends with: its idle harness to read and then close (one left open after its answer is read sits
 * there for nobody), its busy ones to wait for, or, with none of its own and leave to start one, a start.
 */
export function psNext(env: NodeJS.ProcessEnv, rows: readonly Row[], canStart: boolean): NextStep[] {
  const at = (r: Row) => addressOf({ machineId: '', agentId: r.id, name: r.name, engine: '' })
  const open = rows.filter((r) => r.yours && r.state !== 'stopped' && r.state !== 'failed')
  const idle = open.filter((r) => r.state === 'idle'), busy = open.filter((r) => r.state !== 'idle')
  const steps: NextStep[] = []
  if (idle.length) steps.push({ run: step(env, 'show', at(idle[0])), when: `read its answer, then close it: ${step(env, 'close', at(idle[0]))}` })
  if (busy.length) steps.push({ run: step(env, 'wait', busy.map(at).join(',')), when: 'until it stops working' })
  if (!open.length && canStart) {
    steps.push({ run: env[VIA_MCP_ENV] === '1' ? 'harness_start (name: "<name>", task: "<task>")' : 'harness new <agent> --name <name> <project> -- <task>',
      when: 'to hand work to another agent; do quick work yourself' })
  }
  return steps
}

/**
 * The account's machines for the context block, as this computer's daemon keeps them (`<data>/machines.json`,
 * device/machineList.ts, read again every minute), or none. Never the backend: a request still open after the block
 * printed held the process 10 to 35 s, and a person's `ps` waited on the network for nothing (review, 2026-10-15).
 * Only a list kept for the account signed in now, as the daemon serves it (`MachineListCache.lastResponse`).
 */
function machinesForContext(where: Where): NewMachine[] {
  const owner = readAuthSession()?.machineId
  try {
    const kept = JSON.parse(readFileSync(machineListCachePath(where.dataDir), 'utf8')) as { machines?: unknown; bodyOwner?: unknown }
    if (!owner || kept.bodyOwner !== owner || !Array.isArray(kept.machines)) return []
    return (kept.machines as Array<Record<string, unknown>>).filter((m) => typeof m.machineId === 'string').map((m) => ({
      machineId: String(m.machineId), label: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : '(unnamed)',
      // The daemon's `ready` is what `harness machines` calls running.
      status: m.state === 'ready' ? 'running' : typeof m.state === 'string' ? m.state : 'unknown',
      current: m.local === true || m.machineId === where.machineId || m.machineId === owner,
    }))
  } catch { return [] }
}

/** Where the caller is and what it may do (context.ts), from what `opened` read: this machine's live harnesses only,
 *  so it costs no other machine a question; `new` still counts the other machines' exactly. */
function contextFor(s: Setup, o: Opened): Context {
  const live = new Set(o.frames.filter((f) => f.status === 'active').map((f) => memberKey(o.where.machineId, f.id)))
  const waiting = o.asked.filter((a) => a.state !== 'failed').map((a) => a.row)
  const caller = o.caller
  return buildContext({
    caller, orphan: o.orphan, machine: o.machine,
    signedIn: !!readAuthSession(), switchOn: readAgentSettings(o.where.dataDir).agentsStartAgents,
    check: caller ? spawnCheck(caller, live, o.ledger, o.where.machineId, s.now(), waiting) : null,
    count: caller ? spawnCount(caller, live, o.ledger, s.now(), waiting) : null,
    limits: SPAWN_LIMITS, machines: machinesForContext(o.where), closeStep: step(s.env, 'close', '<name>'),
  })
}

// ── whoami ─────────────────────────────────────────────────────────────────────────────────────────

export function whoamiCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(WHOAMI_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (names.length || machine !== null) throw new UsageError('harness whoami takes no names and no --machine: it is about you, here.')
    const o = await opened(s)
    try {
      const context = contextFor(s, o)
      s.out(flags.has('--json') ? JSON.stringify({ context }, null, 1) : formatContext(context))
      return EXIT.ok
    } finally { o.daemon.close() }
  })
}

// ── show ───────────────────────────────────────────────────────────────────────────────────────────

export function showCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(SHOW_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--chars': 'value', '--json': 'flag' })
    if (names.length !== 1) throw new UsageError(names.length ? 'Name one harness.' : 'Name the harness to show.')
    const chars = flags.has('--chars') ? Number(flags.get('--chars')) : DEFAULT_CHARS
    if (!Number.isInteger(chars) || chars < 1) throw new UsageError('--chars takes a whole number.')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      t = await target(s, o, names[0], away)
      const listed = stateOf(t.frame)
      // A cloud harness has no screen: its state is the cloud service's.
      const screen = listed === 'stopped' || listed === 'offline' || t.frame.location === 'cloud' ? null : await inspect(t)
      const state: State = screen === 'draft' ? 'idle' : screen ?? listed
      const turn = await readLastTurn(t)
      const parent = o.ledger.parentOf({ machineId: t.machineId, agentId: t.frame.id })
      const startedBy = t.yours ? 'you' : parent ? parent.by.name : 'person'
      const answer = turn?.answer ?? ''
      // A name the verbs take: an unnamed harness is called by its session title, a sentence, so by its id's start.
      const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)
      // Told more work it has not taken yet: what it says now answers the work before.
      const pendingTell = t.frame.location === 'cloud' ? null : toldPending(o, t, turn, s.now())
      const next = t.frame.location === 'cloud' && state === 'needs-input' && !o.caller && !o.orphan
        // Answered by the person, or a program speaking for them (the lamp): no agent tool says it.
        ? [{ run: `harness reply ${at} -- <the person's answer>`, when: 'it waits for the person: tell them what it asks' }]
        : pendingTell && state !== 'needs-input' ? [{ run: step(s.env, 'wait', at), when: 'until it has taken the work you told it' }]
        // `close` and `tell` take no cloud harness.
        : showNext(s.env, state, t.yours && t.frame.location !== 'cloud', at, tellsHere(o, s.pane))
      const result = {
        name: t.frame.name, id: t.frame.id, agent: engineName(t.frame.engine ?? ''), machine: t.machine, state, startedBy,
        folder: t.frame.project?.cwd ?? null, branch: t.frame.project?.branch ?? null,
        ask: turn?.ask ?? null, answer: clip(answer, chars), truncated: answer.length > chars, tools: turn?.tools ?? 0, next,
        ...(state === 'needs-input' ? { needsPerson: true } : {}),
        ...(t.frame.cloud?.links?.length ? { links: t.frame.cloud.links } : {}),
        ...(pendingTell ? { told: { at: new Date(pendingTell.at).toISOString(), taken: false } } : {}),
      }
      if (flags.has('--json')) s.out(JSON.stringify(result, null, 1))
      else {
        s.out(`${result.name} on ${result.machine}: ${stateSaid(state)} · ${result.agent} · started by ${startedBy}`)
        s.out(`folder: ${tilde(result.folder)}${result.branch ? ` (${result.branch})` : ''}`)
        if (!turn) s.out('No turn yet.')
        else {
          s.out(`asked: ${clip(result.ask ?? '', 600)}`)
          s.out(`answer${result.tools ? ` (after ${result.tools} tool calls)` : ''}:`)
          s.out(result.answer || '(no text)')
          if (result.truncated) s.out(`… ${answer.length - chars} more characters: ${step(s.env, 'show', onAway(result.name ?? t.frame.id, away), { flag: `--chars ${answer.length}`, arg: `chars: ${answer.length}` })}`)
        }
        for (const link of result.links ?? []) s.out(`${link.label}: ${link.url}`)
        if (pendingTell) s.out(`It has not taken the work you told it ${ago(new Date(pendingTell.at).toISOString(), s.now())} ago yet: this answer is to the work before.`)
        const said = formatNext(next)
        if (said) s.out(said)
      }
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

// ── reply ──────────────────────────────────────────────────────────────────────────────────────────

export function replyCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(REPLY_USAGE, deps, wantsJson, argv, async (s) => {
    const dash = argv.indexOf('--')
    const { names, flags, machine } = words(dash < 0 ? argv : argv.slice(0, dash), { '--json': 'flag' })
    const text = dash < 0 ? '' : argv.slice(dash + 1).join(' ').trim()
    if (names.length !== 1) throw new UsageError(names.length ? 'Name one harness.' : 'Name the harness to reply to.')
    if (!text) throw new UsageError('Give the words after --: harness reply <name> -- <words>')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      if (o.caller || o.orphan) throw new AgentClientError('NOT_YOURS', 'Only the person replies to a cloud harness: tell them what it asked.')
      t = await target(s, o, names[0], away)
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      // A terminal agent is typed to in its pane; nothing here sends it words.
      if (t.frame.location !== 'cloud') throw new UsageError(`${name} is not a cloud harness: open it in Harness to talk to it.`)
      const reply = await t.daemon.request('cloud_send', { agentId: t.frame.id, text }, 3 * 60_000)
      if (typeof reply.error === 'string') throw new AgentClientError(reply.error, typeof reply.detail === 'string' && reply.detail ? reply.detail : `${name} did not take it (${reply.error}).`)
      const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)
      const next: NextStep[] = [{ run: step(s.env, 'wait', at), when: 'for its answer' }]
      s.out(flags.has('--json') ? JSON.stringify({ ok: true, name, id: t.frame.id, next }) : `Sent to ${name}.\n${formatNext(next)}`)
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

// ── tell ───────────────────────────────────────────────────────────────────────────────────────────

/** How much of the words a `Told` line keeps to know the turn they asked (ledger.ts `Told`). */
const PROBE_CHARS = 80
/** The words as a turn's ask holds them, to compare: spaces as one, since a pane may wrap or trim them. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * More work for a harness the caller started (messages/tell.ts): asked of the machine it runs on, which checks its own
 * record of who started it and queues the words in its mailbox. Recorded here (`Told`), so `wait` does not take the
 * harness's answer to the work before for its answer to this.
 */
export function tellCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(TELL_USAGE, deps, wantsJson, argv, async (s) => {
    const dash = argv.indexOf('--')
    const { names, flags, machine } = words(dash < 0 ? argv : argv.slice(0, dash), { '--json': 'flag' })
    const text = dash < 0 ? '' : argv.slice(dash + 1).join(' ').trim()
    if (names.length !== 1) throw new UsageError(names.length ? 'Tell one harness at a time.' : 'Name the harness to tell.')
    if (!text) throw new UsageError('Give the work after --: harness tell <name> -- <work>')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      if (o.orphan) throw new AgentClientError('NOT_YOURS', ORPHAN, 'ORPHAN')
      const caller = o.caller
      // The machine names the starter by its pane: an agent outside Harness, or the person, has none to tell from.
      if (!caller || caller.outside || !s.pane) {
        throw new AgentClientError('NOT_YOURS', 'harness tell runs in the pane of the harness that started the one it tells. To talk to a harness yourself, open it in Harness.')
      }
      if (!readAgentSettings(o.where.dataDir).agentsTellAgents) throw new AgentClientError('TELL_OFF', TELL_OFF_TEXT)
      t = await target(s, o, names[0], away)
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      if (t.frame.location === 'cloud') throw new UsageError(`${name} runs in its maker's cloud: harness tell reaches a harness in a pane only.`)
      if (!t.yours) throw new AgentClientError('NOT_YOURS', `You did not start ${name}, so you may not tell it. Only the person can.`)
      // Harness closes one another agent started once it has sat idle half an hour (services/agentCleanup.ts).
      if (stateOf(t.frame) === 'stopped') {
        throw new AgentClientError('NOT_RUNNING', `${name} is no longer running: it was closed or stopped. Start a new harness with the whole task.`)
      }
      // From a pane here the machine reads the starter from the pane; another machine takes this one's word for it.
      const here = t.machineId === o.where.machineId
      const payload = here
        ? { action: 'tell', pane: s.pane, machine: o.machine, agentId: t.frame.id, text }
        : { action: 'tell', from: { machineId: caller.machineId, agentId: caller.agentId }, machine: o.machine, agentId: t.frame.id, text }
      let reply: Record<string, unknown>
      try { reply = await s.record({ port: o.where.port, dataDir: o.where.dataDir, machineId: t.machineId }, payload, 20_000) } catch (error) {
        if (error instanceof MessageError) throw new AgentClientError(error.code, error.message)
        throw error
      }
      try { o.ledger.append({ at: s.now(), by: { machineId: caller.machineId, agentId: caller.agentId }, told: { machineId: t.machineId, agentId: t.frame.id }, probe: flat(text).slice(0, PROBE_CHARS) }) }
      catch { /* `wait` then reads its last answer as it would without the line */ }
      const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)
      const next: NextStep[] = [{ run: step(s.env, 'wait', at), when: `until it has answered; then read it: ${step(s.env, 'show', at)}` }]
      const state = typeof reply.state === 'string' ? reply.state : 'queued'
      const failed = state === 'failed'
      const effect = failed ? `${name} did not take it: ${typeof reply.reason === 'string' ? reply.reason : 'its machine refused it'}.`
        : `${name} has it: typed once it is free, or given at its next tool call while it works.`
      s.out(flags.has('--json') ? JSON.stringify({ name, id: t.frame.id, message: reply.id ?? null, state, effect, next: failed ? [] : next })
        : [`${name} on ${t.machine}: told. ${effect}`, failed ? null : formatNext(next)].filter(Boolean).join('\n'))
      return failed ? EXIT.failed : EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

/** How long after a tell an idle harness is still taken to be about to take it. Past it, the harness is read as it is:
 *  its machine refused the words, or something holds its pane (a dialog, the person's draft), and `show` says so. */
const TOLD_HOLD_MS = 10 * 60_000

/**
 * The work the caller last told [t] that it has not taken yet, or null. Taken: a turn asked with those words (typed
 * into an idle harness), or anything it did after the tell (given at a tool call, inside the turn it was in). Until
 * then its last answer is to the work before: the answer a `wait` returned at once, and wrongly, after a tell.
 */
function toldPending(o: Opened, t: Target, turn: { ask?: string | null } | null, now: number): Told | null {
  const told = o.caller ? o.ledger.toldBy(o.caller, { machineId: t.machineId, agentId: t.frame.id }) : null
  if (!told || now - told.at > TOLD_HOLD_MS) return null
  if (turn?.ask && flat(turn.ask).includes(told.probe)) return null
  // Another machine's clock: a minute either way says nothing, and the turn's words still do.
  const active = Date.parse(t.frame.updatedAt ?? '')
  return active > told.at + (t.machineId === o.where.machineId ? 0 : CLOCK_SLACK_MS) ? null : told
}

// ── wait ───────────────────────────────────────────────────────────────────────────────────────────

/** How far another machine's clock may be off from this one's, for what happened before or after a close. */
const CLOCK_SLACK_MS = 60_000

/** `closed`: stopped or gone because the caller closed it (`harness close`, the ledger's `Closed` line). */
type Settled = 'idle' | 'needs-input' | 'stopped' | 'gone' | 'closed' | 'timeout' | 'failed'

/** What to do once a wait has ended on [state], with the commands that read it, wait again, and list the stopped ones. */
function waitNext(state: string, run: { read: string; again: string; list: string }): NextStep[] {
  switch (state) {
    case 'idle': return [{ run: run.read, when: 'to read its answer' }]
    case 'needs-input': return [{ tell: 'tell the person; only they answer it (a question or a permission).' }]
    case 'timeout': case 'installing': case 'starting': return [{ run: run.again, when: 'to keep waiting' }]
    case 'stopped': return [{ run: run.read, when: 'its answer is kept' }]
    case 'gone': return [{ run: run.list, when: 'to see whether it was closed' }]
    default: return []
  }
}

export function waitCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(WAIT_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--any': 'flag', '--timeout': 'value', '--json': 'flag' })
    const wanted = names.flatMap((n) => n.split(',')).map((n) => n.trim()).filter(Boolean)
    if (!wanted.length) throw new UsageError('Name the harness to wait for.')
    const timeoutMs = flags.has('--timeout') ? parseDuration(String(flags.get('--timeout'))) : DEFAULT_TIMEOUT_MS
    // Every name on the one machine `--machine` names.
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    const targets: Target[] = []
    /** Harnesses asked for that have not started (`Asked`): followed by their creation until they start, then waited on
     *  as any other. `harness new` answers an agent before an engine's install is done, and the harness starts by itself. */
    const following: Asked[] = []
    const gave = new Map<Asked, Settled>()
    try {
      for (const name of wanted) {
        let t: Target
        try { t = await target(s, o, name, away) } catch (error) {
          const asked = error instanceof AgentClientError && (error.code === 'NOT_STARTED' || error.code === 'NEVER_STARTED') ? askedNamed(o, name, away?.machineId) : undefined
          if (!asked) throw error
          if (!following.includes(asked)) following.push(asked)
          if (asked.state === 'failed') gave.set(asked, 'failed')
          continue
        }
        if (!targets.some((x) => x.machineId === t.machineId && x.frame.id === t.frame.id)) targets.push(t)
        // Two names for one harness on another machine (`a,a`, a name and its prefix): each opened a connection there,
        // and the one not kept would hold the process open after it printed (review of #1333).
        else if (t.remote) t.daemon.close()
      }
      /** Asks a creation how it stands: made, it joins the harnesses waited on, recorded as the caller's. */
      const follow = async (a: Asked): Promise<void> => {
        const here = a.row.creation.machineId === o.where.machineId
        const line = here ? o.daemon : await s.open(o.where, a.row.creation.machineId)
        let kept = false
        try {
          const status = await line.request('agent_create_status', { creationId: a.row.creation.creationId }, 8_000)
          const frame = (status.agent ?? {}) as Frame
          if (status.state === 'created' && typeof frame.id === 'string' && frame.id) {
            await recordMade(s, o.where, o.ledger, a.row, frame)
            targets.push({ daemon: line, frame: { ...frame, name: frame.name || a.row.creation.name }, machineId: a.row.creation.machineId,
              machine: here ? o.machine : away?.label ?? a.row.creation.machineId.slice(0, 8), yours: true, remote: !here })
            following.splice(following.indexOf(a), 1)
            kept = true
            return
          }
          const now = askedOf(a.row, status)
          if (!now) gave.set(a, 'gone')
          else { a.state = now.state; a.detail = now.detail; if (now.state === 'failed') gave.set(a, 'failed') }
        } finally { if (!here && !kept) line.close() }
      }
      const deadline = timeoutMs > 0 ? s.now() + timeoutMs : Infinity
      const settled = new Map<Target, Settled>()
      const sawWorking = new Set<Target>()
      /** Idle looks in a row, on the same turn. */
      const idle = new Map<Target, { turn: string; looks: number }>()
      // Ended because the caller closed it: what it asked for, not a failure. A real Codex lead closed its harness and
      // then waited on it, as it had queued, and was answered "Failed (exit 4) · stopped · it was stopped". Not when its
      // conversation went on after that close (the person reopened it), or a minute past it on another machine's clock.
      const ended = (t: Target, state: 'stopped' | 'gone'): Settled => {
        const closedAt = o.caller ? o.ledger.closedBy(o.caller, { machineId: t.machineId, agentId: t.frame.id }) : null
        const active = Date.parse(t.frame.updatedAt ?? '')
        return closedAt !== null && !(active > closedAt + CLOCK_SLACK_MS) ? 'closed' : state
      }
      const look = async (t: Target, frames: Frame[]): Promise<Settled | null> => {
        const frame = frames.find((f) => f.id === t.frame.id)
        // Not live: stopped, or gone. Asked of the full list only then.
        if (!frame) return ended(t, (await list(t.daemon, true)).some((f) => f.id === t.frame.id) ? 'stopped' : 'gone')
        t.frame = frame
        if (frame.status === 'stopped') return ended(t, 'stopped')
        // A cloud harness says where it is itself, with no screen to read: done once it is no longer starting or working.
        if (frame.location === 'cloud') {
          const state = stateOf(frame)
          return state === 'idle' || state === 'needs-input' || state === 'failed' ? state : null
        }
        // The daemon says it is working: no need to read its screen.
        const screen = frame.activity?.state === 'working' ? 'working' : await inspect(t)
        if (screen === 'working') { sawWorking.add(t); idle.delete(t); return null }
        if (screen === 'needs-input') return 'needs-input'
        if (screen === 'draft' || (screen === null && stateOf(frame) !== 'idle')) { idle.delete(t); return null }
        // Idle, on two looks in a row with the same last turn: a message sent just before is typed within a look,
        // and the turn it starts shows as working. One idle look returned before it, on the turn before (#1180).
        const turn = await readLastTurn(t, 1)
        // Told more work it has not taken yet: idle on the answer to the work before.
        if (toldPending(o, t, turn, s.now())) { idle.delete(t); return null }
        const key = turn ? `${turn.ask}\u0000${turn.tools}\u0000${turn.answer.length}` : ''
        const before = idle.get(t)
        const looks = before && before.turn === key ? before.looks + 1 : 1
        idle.set(t, { turn: key, looks })
        if (sawWorking.has(t)) return looks >= 2 ? 'idle' : null
        if (turn) return looks >= 2 && turn.answered ? 'idle' : null
        // Nothing asked of it at all, past its start: a harness started without a task has nothing to finish. A harness
        // just started with a task is idle for a moment before the task is typed.
        const age = frame.createdAt ? s.now() - Date.parse(frame.createdAt) : Infinity
        return age > STARTING_MS && looks >= QUIET_LOOKS ? 'idle' : null
      }
      for (;;) {
        for (const a of [...following]) {
          if (gave.has(a)) continue
          // Its machine out of reach for a moment (a timeout, a relay): asked again next round, as `ps` keeps it starting.
          await follow(a).catch((error) => {
            if (error instanceof AgentClientError) return
            throw error
          })
        }
        // One list per connection a round: every harness on this machine shares one; each named on another has its own.
        const lists = new Map<Daemon, Promise<Frame[]>>()
        for (const t of targets) {
          if (settled.has(t)) continue
          const result = await (async () => {
            if (!lists.has(t.daemon)) lists.set(t.daemon, list(t.daemon, false))
            return look(t, await lists.get(t.daemon)!)
          })().catch((error) => {
            if (error instanceof AgentClientError && error.code === 'TIMEOUT') return null
            throw error
          })
          if (result) settled.set(t, result)
        }
        const total = targets.length + following.length
        const count = settled.size + gave.size
        const done = flags.has('--any') ? count > 0 : count === total
        if (done) break
        if (s.now() >= deadline) {
          for (const t of targets) if (!settled.has(t)) settled.set(t, 'timeout')
          for (const a of following) if (!gave.has(a)) gave.set(a, 'timeout')
          break
        }
        await s.sleep(Math.min(s.intervalMs, Math.max(0, deadline - s.now())))
      }
      const results: Array<{ name: string; id: string; state: Settled | 'installing' | 'starting'; detail?: string }> = [
        ...targets.filter((t) => settled.has(t)).map((t) => ({ name: t.frame.name ?? t.frame.id.slice(0, 8), id: t.frame.id, state: settled.get(t)! })),
        // Not started yet when the wait ended: said as what it waits for, which is what the agent waits on.
        ...following.filter((a) => gave.has(a)).map((a) => {
          const given = gave.get(a)!
          return { name: askedName(a), id: a.row.creation.creationId, state: given === 'timeout' && a.state !== 'failed' ? a.state : given, detail: a.detail }
        }),
      ]
      // A name the verbs take: quoted when it is two words, the id's start when it is a sentence (a session's title).
      const nextOf = (r: (typeof results)[number]): NextStep[] => {
        const at = onAway(addressOf({ machineId: '', agentId: r.id, name: r.name, engine: '' }), away)
        return waitNext(r.state, { read: step(s.env, 'show', at), again: step(s.env, 'wait', at),
          list: step(s.env, 'ps', away ? machineOption(away.word) : '', { flag: '--all', arg: 'all: true' }) })
      }
      if (flags.has('--json')) {
        s.out(JSON.stringify({ harnesses: results.map((r) => ({ ...r, ...(r.state === 'needs-input' ? { needsPerson: true } : {}), next: nextOf(r) })) }, null, 1))
      }
      else for (const r of results) {
        if (r.state === 'closed') { s.out(`${r.name}: closed (you closed it)`); continue }
        const read = step(s.env, 'show', onAway(addressOf({ machineId: '', agentId: r.id, name: r.name, engine: '' }), away))
        const next = r.state === 'idle' ? `read it: ${read}`
          : r.state === 'needs-input' ? 'it waits for the person (a question or a permission); only the person answers it'
          : r.state === 'timeout' ? `still working; wait again or read it: ${read}`
          : r.state === 'installing' || r.state === 'starting' ? `${askedLine(s.env, following.find((a) => a.row.creation.creationId === r.id)!, away)}`
          : r.state === 'failed' && targets.some((t) => t.frame.id === r.id) ? `it failed in the cloud; what it said and its links: ${read}`
          : r.state === 'failed' ? `it never started: ${r.detail || 'its machine refused it'}`
          // Harness closes one another agent started once it has sat idle half an hour (services/agentCleanup.ts): its
          // answer is still there to read.
          : r.state === 'stopped' ? `it was stopped; its answer is kept: ${read}` : 'it is gone'
        s.out(`${r.name}: ${stateSaid(r.state)} · ${next}`)
        // Gone says nothing of why: whether it was closed is in the list of the stopped ones.
        if (r.state === 'gone') s.out(formatNext(nextOf(r))!)
      }
      const states = results.map((r) => r.state)
      return states.some((x) => x === 'timeout' || x === 'installing' || x === 'starting') ? EXIT.timeout : states.includes('needs-input') ? EXIT.needsInput
        : states.some((x) => x === 'stopped' || x === 'gone' || x === 'failed') ? EXIT.stopped : EXIT.ok
    } finally {
      for (const t of targets) if (t.remote) t.daemon.close()
      o.daemon.close()
    }
  })
}

// ── close ──────────────────────────────────────────────────────────────────────────────────────────

export function closeCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(CLOSE_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--now': 'flag', '--json': 'flag' })
    if (names.length !== 1) throw new UsageError(names.length ? 'Close one harness at a time.' : 'Name the harness to close.')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      try { t = await target(s, o, names[0], away) } catch (error) {
        // Asked for and not started: closing it is not starting it. Cancelled by its creation, which its machine takes only
        // before the launch is claimed (lib/agentCreationReceipt.ts `cancelIntent`).
        const asked = error instanceof AgentClientError && error.code === 'NOT_STARTED' ? askedNamed(o, names[0], away?.machineId) : undefined
        if (!asked) throw error
        const name = askedName(asked), here = asked.row.creation.machineId === o.where.machineId
        const line = here ? o.daemon : await s.open(o.where, asked.row.creation.machineId)
        try {
          const reply = await line.request('agent_create_cancel', { creationId: asked.row.creation.creationId }, 20_000)
          const refused = askedOf(asked.row, reply)
          if (reply.state === 'created' || reply.state === 'unconfirmed') {
            throw new AgentClientError('STARTING', `${name} is starting now, so it was not cancelled. Close it once it has: ${step(s.env, 'close', onAway(name, away))}.`)
          }
          if (refused?.state === 'failed') throw new AgentClientError('NEVER_STARTED', `${name} never started: ${refused.detail || 'its machine refused it'}. Nothing to close.`)
          if (reply.state !== 'cancelled') {
            throw new AgentClientError(typeof reply.error === 'string' ? reply.error : 'NOT_CANCELLED', `${name} could not be cancelled${typeof reply.error === 'string' ? ` (${reply.error})` : ''}. Check it with ${step(s.env, 'ps', away ? machineOption(away.word) : '')}.`)
          }
        } finally { if (!here) line.close() }
        s.out(flags.has('--json') ? JSON.stringify({ name, id: asked.row.creation.creationId, cancelled: true }) : `Cancelled ${name} before it started.`)
        return EXIT.ok
      }
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      // `agent_close` has no cloud harness to close (lib/closeAgentService.ts): it answered "changed, try again" for good.
      if (t.frame.location === 'cloud') throw new UsageError(`${name} runs in its maker's cloud: stop it in Harness. Its conversation is kept either way.`)
      if (o.orphan) throw new AgentClientError('NOT_YOURS', ORPHAN, 'ORPHAN')
      if (o.caller && o.caller.agentId === t.frame.id && t.machineId === o.where.machineId) {
        throw new AgentClientError('NOT_YOURS', 'That is your own harness. The person closes it.')
      }
      // An agent closes only what it started; the person, at a terminal, closes anything.
      if (o.caller && !t.yours) throw new AgentClientError('NOT_YOURS', `You did not start ${name}, so you may not close it. Only the person can.`)
      const reply = await t.daemon.request('agent_close', {
        agentId: t.frame.id, sessionId: t.frame.sessionId ?? '', createdAt: t.frame.createdAt ?? '', mode: flags.has('--now') ? 'now' : 'idle',
      }, 60_000)
      if (reply.error === 'SESSION_NOT_IDLE') {
        throw new AgentClientError('WORKING', `${name} is ${reply.activity === 'needs_input' ? 'waiting for the person' : 'working'}. Wait for it (${step(s.env, 'wait', onAway(name, away))}), or close it anyway with ${s.env[VIA_MCP_ENV] === '1' ? 'now: true' : '--now'}.`)
      }
      if (reply.error === 'AGENT_CHANGED') throw new AgentClientError('AGENT_CHANGED', `${name} changed while closing. Check it with ${step(s.env, 'show', onAway(name, away))}, then try again.`)
      // Its machine cannot read which conversation it is in just now, and closing it would lose that conversation. The
      // machine's own reason ("the native control descriptor type is unavailable") means nothing to the agent asking.
      if (reply.error === 'IDENTITY_UNAVAILABLE') {
        throw new AgentClientError('IDENTITY_UNAVAILABLE', `${name} was not closed: Harness cannot tell which conversation it is in right now, and closing it would lose that conversation. Try again in a moment.`)
      }
      if (reply.error) throw new AgentClientError(String(reply.error), typeof reply.detail === 'string' && reply.detail ? reply.detail : `Could not close ${name}.`)
      // Recorded for `wait`, which then says the caller closed it rather than that it stopped. The close is done either way.
      if (o.caller) {
        try { o.ledger.append({ at: s.now(), by: { machineId: o.caller.machineId, agentId: o.caller.agentId }, closed: { machineId: t.machineId, agentId: t.frame.id } }) }
        catch { /* `wait` then says it stopped */ }
      }
      // Closed while still starting, before its machine could read its conversation: there is none to keep.
      const kept = reply.withoutConversation !== true
      // Still starting, or at a question its engine asks first (the folder's trust, an MCP server): it had none yet.
      const effect = kept ? 'Its conversation is kept; the person can resume it.' : 'It had not started a conversation, so none was kept.'
      // How many of its own are left, counted as `whoami` counts them, without the one just closed.
      const closedHere = t.machineId === o.where.machineId, closedId = t.frame.id
      o.frames = o.frames.filter((f) => !(closedHere && f.id === closedId))
      const open = o.caller ? contextFor(s, o).quota?.open ?? null : null
      s.out(flags.has('--json')
        ? JSON.stringify({ name, id: t.frame.id, closed: true, ...(kept ? {} : { conversationKept: false }), effect, next: [], ...(open === null ? {} : { open }) })
        : [`${name} on ${t.machine}: closed. ${effect}`, open === null ? null : `Next: nothing; you have ${open} open of ${SPAWN_LIMITS.livePerHarness}.`].filter(Boolean).join('\n'))
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

// ── new, run by an agent ───────────────────────────────────────────────────────────────────────────

/**
 * Limits on starting harnesses (the design's "Limits"): runaway spawning is the risk, and every harness started is
 * the person's tokens. Four at once and one level down (owner, October 12: "be very careful about when to start a new
 * agent so we don't waste user token"): a harness another agent started does its work itself. They were eight and two.
 */
export const SPAWN_LIMITS = { livePerHarness: 4, livePerMachine: 40, depth: 1, perWindow: 20, windowMs: 10 * 60_000 } as const

/** Said to a harness another agent started when it runs `harness new`. */
export const DEPTH_REFUSAL = 'A harness another agent started may not start harnesses itself. Do the work yourself, or say in your answer what else is needed.'

/** How long a harness the caller started by a name stops it starting another by that name: a retry, not new work. */
export const DUPLICATE_WITHIN_MS = 10 * 60_000

/** A harness by machine and id, as the limits count the live ones. */
const memberKey = (machineId: string, agentId: string): string => `${machineId}/${agentId}`

/**
 * What the limits count for [caller]: its live harnesses, and those asked for and not started yet ([waiting]), its
 * starts in the window, and its depth.
 */
export function spawnCount(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, now: number, waiting: readonly Pending[] = []): SpawnCount {
  const mine = ledger.childrenOf(caller)
  const liveMine = new Set(mine.filter((row) => live.has(memberKey(row.child.machineId, row.child.agentId))).map((row) => memberKey(row.child.machineId, row.child.agentId)))
  const recent = [...mine, ...waiting].map((row) => row.at).filter((at) => now - at < SPAWN_LIMITS.windowMs)
  // Its depth by the record, or by the core's row when the record has no line for it: rotated away, a write that failed,
  // or a start from another machine or from outside Harness, recorded only where the starter ran.
  return {
    open: liveMine.size + waiting.length, starts: recent.length, depth: Math.max(ledger.depthOf(caller), caller.startedByAgent ? 1 : 0),
    oldestStartAt: recent.length ? Math.min(...recent) : null,
  }
}

/**
 * Which limit refuses [caller] another harness now, and what it is told, or null. [live] holds the live harnesses the
 * limits count: this machine's, and the caller's on the other machines it reached.
 */
export function spawnCheck(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, localMachineId: string, now: number, waiting: readonly Pending[] = []): { reason: SpawnReason; message: string } | null {
  const count = spawnCount(caller, live, ledger, now, waiting)
  if (count.depth >= SPAWN_LIMITS.depth) return { reason: 'DEPTH', message: DEPTH_REFUSAL }
  // Harnesses asked for and not started yet ([waiting]) count as running: each starts by itself once its engine is
  // installed, and an agent asking for more meanwhile would otherwise pass every limit until they all started at once.
  if (count.open >= SPAWN_LIMITS.livePerHarness) {
    return { reason: 'OPEN_LIMIT', message: `You have ${count.open} harnesses running${waiting.length ? ' or starting' : ''}. Close one you are done with first (harness close <name>).` }
  }
  const machineWide = new Set(ledger.all().filter((row) => row.child.machineId === localMachineId && live.has(memberKey(localMachineId, row.child.agentId))).map((row) => row.child.agentId))
  if (machineWide.size + waiting.filter((row) => row.creation.machineId === localMachineId).length >= SPAWN_LIMITS.livePerMachine) {
    return { reason: 'MACHINE_LIMIT', message: `Agents have ${machineWide.size} harnesses running on this machine, the most allowed. Close some first.` }
  }
  if (count.starts >= SPAWN_LIMITS.perWindow) {
    return { reason: 'START_RATE', message: `You started ${SPAWN_LIMITS.perWindow} harnesses in 10 minutes. Wait, or work with the ones you have.` }
  }
  return null
}

/** Why [caller] may not start another harness now, or null: `spawnCheck`'s message. */
export function spawnRefusal(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, localMachineId: string, now: number, waiting: readonly Pending[] = []): string | null {
  return spawnCheck(caller, live, ledger, localMachineId, now, waiting)?.message ?? null
}

/** How long a harness started on another machine counts toward the limits when that machine cannot be asked. */
const UNREACHABLE_LIVE_MS = 24 * 60 * 60_000

/**
 * The live harnesses the limits count: this machine's, and those the caller started on other machines, asked of
 * each (a harness closed there frees its place: counted for a day whatever became of it, eight of them on another
 * machine refused every start for that day, and `close` did not help; the review of #1180). A machine that cannot be
 * asked has its last day's starts counted.
 */
async function liveFor(s: Setup, o: Opened, caller: Caller): Promise<Set<string>> {
  const live = new Set(o.frames.filter((f) => f.status === 'active').map((f) => memberKey(o.where.machineId, f.id)))
  const away = new Map<string, Started[]>()
  for (const row of o.ledger.childrenOf(caller)) {
    if (row.child.machineId === o.where.machineId || s.now() - row.at > STOPPED_WITHIN_MS) continue
    away.set(row.child.machineId, [...(away.get(row.child.machineId) ?? []), row])
  }
  await Promise.all([...away].map(async ([machineId, rows]) => {
    try {
      const daemon = await s.open(o.where, machineId)
      try {
        const reply = await daemon.request('agents_list', {}, 8_000)
        for (const f of Array.isArray(reply.agents) ? reply.agents as Frame[] : []) if (f.status === 'active') live.add(memberKey(machineId, f.id))
      } finally { daemon.close() }
    } catch {
      for (const row of rows) if (s.now() - row.at < UNREACHABLE_LIVE_MS) live.add(memberKey(machineId, row.child.agentId))
    }
  }))
  return live
}

/** How a next step names a harness: its name when that is a plain word or two, else its id's start. An unnamed
 *  harness is called by its session title, which is a sentence ("so we have built harness web,") that `wait`'s list
 *  of names splits at the comma. */
export function addressOf(caller: Caller): string {
  return /^[\w.-]+( [\w.-]+)?$/.test(caller.name) && caller.name.length <= 40 ? (caller.name.includes(' ') ? `"${caller.name}"` : caller.name) : caller.agentId.slice(0, 8)
}

/** A start refused before anything is asked of the machine. */
const refusing = (code: string, message: string, reason?: string): NewOrigin => ({
  check: async () => { throw new AgentClientError(code, message, reason) }, prompt: (text) => text, created: async () => null, answer: () => ({ effect: '', next: [] }),
})

/**
 * When an agent runs `harness new`, from its pane or from outside Harness: its limits, the header on its task, and the
 * record of it. Null for the person. A pane Harness made whose harness cannot be told is refused, never taken for the
 * person: a daemon that did not answer used to mean no limits, no header and no record (the review of #1180).
 */
export async function agentOrigin(deps: ClientDeps = {}, record: Rpc = messagesRpc): Promise<NewOrigin | null> {
  const s = setup(deps)
  const agentOutside = !!outsideCaller(s.env, '')
  if (!s.pane && !agentOutside) return null
  let o: Opened
  try { o = await opened(s) } catch (error) {
    // Out of reach is said as it is (a sandbox, or nothing running): "try again in a moment" was tried again in the
    // same sandbox.
    if (error instanceof AgentClientError && error.code === 'DAEMON_UNREACHABLE') return refusing(error.code, error.message)
    return s.where().harnessPane || agentOutside ? refusing('UNKNOWN_CALLER', 'Harness could not tell who is starting this. Try again in a moment.') : null
  }
  o.daemon.close()
  if (o.orphan) return refusing('NOT_YOURS', ORPHAN, 'ORPHAN')
  const caller = o.caller
  if (!caller) return null
  // The person's say: the account's experiment, as the machine the agent runs on keeps it (Settings ▸ Experimental,
  // `harness settings`).
  if (!readAgentSettings(o.where.dataDir).agentsStartAgents) return refusing('TURNED_OFF', AGENTS_START_AGENTS_OFF, 'SWITCH_OFF')
  return {
    // A harness in a pane here: the new one is opened beside it in the windows. An agent outside Harness has no pane.
    ...(caller.outside ? {} : { parentAgentId: caller.agentId }),
    check: async () => {
      const refusal = spawnCheck(caller, await liveFor(s, o, caller), o.ledger, o.where.machineId, s.now(),
        o.asked.filter((a) => a.state !== 'failed').map((a) => a.row))
      if (refusal) throw new AgentClientError('SPAWN_LIMIT', refusal.message, refusal.reason)
    },
    existing: async (name, asking) => {
      if (!name?.trim()) return null
      const wanted = name.trim().toLowerCase()
      // The same name for the same agent on the same machine: a retry. Another machine or agent is other work.
      // A store harness (owner/name) is asked for by its id and recorded by the engine it runs on: the machine decides.
      const same = (machineId: string, engine?: string) => machineId === asking.machineId && (!engine || asking.engine.includes('/') || engine === asking.engine)
      // Still on its way: an agent whose call to `harness new` timed out (an MCP client's minute) and asked again got a
      // second harness for the same work once both launches went ahead.
      const asked = o.asked.filter((a) => a.state !== 'failed' && a.row.creation.name.toLowerCase() === wanted
        && same(a.row.creation.machineId, a.row.creation.engine)).at(-1)
      if (asked) {
        const called = asked.row.creation.name
        return { name: called, machineId: asked.row.creation.machineId, state: 'starting',
          note: `"${called}" is already starting: ${asked.state === 'installing' ? `Harness is installing ${engineName(asked.row.creation.engine)}` : asked.detail.replace(/\.$/, '') || 'it has not started yet'}. `
            + `It starts by itself; wait for it with ${step(s.env, 'wait', called)}. Do not start it again.` }
      }
      // Started by the caller a few minutes ago and running: the same retry, a little later.
      const engineOf = (row: Started) => row.child.machineId === o.where.machineId ? o.frames.find((f) => f.id === row.child.agentId)?.engine : undefined
      const recent = o.ledger.childrenOf(caller).filter((row) => s.now() - row.at < DUPLICATE_WITHIN_MS && row.child.name.toLowerCase() === wanted
        && same(row.child.machineId, engineOf(row)))
      if (!recent.length) return null
      const live = await liveFor(s, o, caller)
      const running = recent.findLast((row) => live.has(memberKey(row.child.machineId, row.child.agentId)))
      if (!running) return null
      // Under a minute is "just now": rounded up to a minute, a harness started two seconds earlier was "1 min ago".
      const called = running.child.name, age = s.now() - running.at
      const when = age < 60_000 ? 'just now' : `${Math.round(age / 60_000)} min ago`
      return { name: called, machineId: running.child.machineId, agentId: running.child.agentId, state: 'running',
        note: `"${called}" is already running: you started it ${when}. Wait for it with ${step(s.env, 'wait', called)} `
          + `or read it with ${step(s.env, 'show', called)}. Do not start it again; to start a new one by that name, close it first (${step(s.env, 'close', called)}).` }
    },
    pending: (machineId, creation) => {
      o.ledger.append({ at: s.now(), by: { machineId: caller.machineId, agentId: caller.agentId, name: caller.name, engine: caller.engine },
        creation: { machineId, ...creation }, depth: o.ledger.depthOf(caller) + 1 })
    },
    prompt: (text, machineId) => {
      // Said once, at the top: the task is from an agent, not the person (a teammate's tmux paste read as the
      // owner's). It reads the answer itself (`show`): an invitation to reply had the first eval's agent send its
      // whole report back as a message as well, which would land in the middle of the starter's own turn. Nor is the
      // new harness told to message it: being started by it gives no way to, only sharing a tab does (owner,
      // 2026-10-11: "Agent Messages off means off").
      const here = machineId === o.where.machineId
      const header = caller.outside
        ? `[from ${caller.name} outside Harness · ${o.machine}, the agent that started you. It reads your answer itself.]\n\n`
        : `[from ${caller.name} · ${engineName(caller.engine)} · ${o.machine}, the harness that started you. It reads your answer itself.]\n\n`
      if (header.length + text.length <= MAX_FIRST_PROMPT_CHARS) return header + text
      // A first message holds 2,000 characters (engineLaunch.ts), and a task an agent hands on is often longer: the
      // first eval's prompts were refused whole. The task goes in a file the new harness is told to read.
      if (!here) throw new AgentClientError('PROMPT_TOO_LONG', `A task for another machine holds at most ${MAX_FIRST_PROMPT_CHARS - header.length} characters. Shorten it.`)
      const dir = join(o.where.dataDir, 'agent-client', 'tasks')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${new Date(s.now()).toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}.md`)
      writeFileSync(file, text, { mode: 0o600 })
      const lead = `Your task is longer than a first message holds. All of it is in ${file}: read the whole file before you start. It begins:\n\n`
      const room = MAX_FIRST_PROMPT_CHARS - header.length - lead.length - 1
      return `${header}${lead}${clip(text, room)}`
    },
    created: async (machineId, agent, creationId) => {
      const id = typeof agent.id === 'string' ? agent.id : ''
      if (!id) return null
      const name = typeof agent.name === 'string' ? agent.name : ''
      const row: Started = {
        at: s.now(),
        by: { machineId: caller.machineId, agentId: caller.agentId, name: caller.name, engine: caller.engine },
        child: { machineId, agentId: id, name, ...(creationId ? { creationId } : {}) },
        depth: o.ledger.depthOf(caller) + 1,
      }
      o.ledger.record(row)
      if (machineId === o.where.machineId) return null
      // The other machine keeps the line too: there the new harness's limits and depth start from it. Without it a
      // harness started on another machine was one the person started there, and a chain hopping between machines had
      // no depth at all (the review of #1180).
      try {
        await record({ port: o.where.port, dataDir: o.where.dataDir, machineId }, { action: 'started', row }, 10_000)
        return null
      } catch {
        return `${name || 'The harness'} runs on a machine whose Harness did not record who started it: there, its limits start from zero.`
      }
    },
    answer: (agent, at) => {
      const name = addressOf({ machineId: '', agentId: String(agent.id ?? ''), name: String(agent.name ?? ''), engine: '' })
      // Under MCP the tools take no machine: harness_wait finds the caller's own by its record, on any machine.
      const target = at.local || at.machine === null || s.env[VIA_MCP_ENV] === '1' ? name : `${machineOption(at.machine)} ${name}`
      return {
        // The windows open it beside the caller's pane only for a harness in a pane on this computer.
        effect: caller.outside || !at.local ? 'The person sees it in Harness.' : 'The person sees it in Harness, beside you.',
        next: [{ run: step(s.env, 'wait', target), when: `until it has answered; then read it: ${step(s.env, 'show', target)}` }],
      }
    },
  }
}
