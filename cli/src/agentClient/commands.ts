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
import { randomBytes, randomUUID } from 'node:crypto'
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
import { PERSON_AGENT_ID, REPLY_OFF_TEXT } from '../messages/replyLocal.js'
import { TELL_OFF_TEXT } from '../messages/tell.js'
import { sendPane } from '../messages/command.js'
import { asSaid, callerOf, clip, cloudMeta, cloudTurn, failureOf, forAgent, isAgent, lastTurn, matching, outsideCaller, rowsOf, stateOf, STOPPED_WITHIN_MS, type Caller, type CloudMeta, type Failure, type Frame, type HistoryEvent, type Row, type State } from './model.js'

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
  /** Waits [ms], or until [signal] says a change was pushed (`wait` and `watch` on pushed events). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** How often `wait` looks at what is not pushed: a cloud harness, a harness on another machine, an older daemon. */
  intervalMs?: number
  /** How a start is recorded on another machine (the messages service's `started`). */
  record?: Rpc
  /** The account's machines, for `--machine` (cli.ts asks the backend, as `harness new` does). */
  machines?: () => Promise<NewMachine[]>
  /** How long `ps --machines` waits on each other machine. */
  answerMs?: number
}

const ON_MACHINE = '--machine <name> is another of your machines, by its name or id as harness new takes it; this one when left out.'

export const PS_USAGE = `Usage: harness ps [--machine <name> | --machines] [--all] [--json]

The harnesses on a machine: name, agent, state, who started it, when it was last active, and what it is about.
--all adds the ones stopped in the last week.
--machines lists every machine of yours at once: each is asked for 5 s, and one that does not answer is listed as
unreachable.
${ON_MACHINE}`
export const SHOW_USAGE = `Usage: harness show [--machine <name>] <name> [--chars N] [--work] [--json]

A harness's state and its last turn: what it was asked and what it answered (the first N characters, 4000 by default).
--work says its work instead, as facts read on its machine: its branch, its pull request, the files and lines it
changed, and its checks.
${ON_MACHINE}`
export const REPLY_USAGE = `Usage: harness reply [--machine <name>] <name> [--json] -- <words…>

Says <words> to a cloud harness (Devin Cloud, Cursor Cloud, Fo): its answer to the question it asked, or what to do next.
To a harness in a pane, only when it is idle and the person allows it (harness settings programs-reply): more work,
typed into it once its composer is free. Then wait for it (harness wait <name>) and read its answer (harness show <name>).
The person's, or a program's acting for them; an agent does not answer for the person.
${ON_MACHINE}`
export const ROUTE_USAGE = `Usage: harness route [--machine <name>] [--send] [--json] -- <words…>

Says which of a machine's harnesses in a pane <words> belong to, as the person's ⌘B does: one of them, or new work.
With --send, words for an idle one are typed into it, as harness reply does; nothing is ever started. For a program
acting for the person, while they allow it (harness settings programs-reply).
--json answers {"decided":"session","id","name","machine","confidence","reason"} or {"decided":"new","reason"},
and with --send "sent": {"state":"queued"} or {"error":"NOT_IDLE"|"NOT_RUNNING",…}. NOT_IDLE: it is still working
on the last words or waits for the person. Wait for it (harness wait <name>) and send them with harness reply, or
say so: never start new work for them, or a follow-up ("how is it going?") becomes a second harness.
Exit status: 0 once decided (sent or not: read "sent"), 5 refused (switch off), 1 nothing decided (ROUTER_UNAVAILABLE).
${ON_MACHINE}`
export const RESUME_USAGE = `Usage: harness resume [--machine <name>] <name> [--json]

Opens a harness that was closed or stopped again, with the same name and folder, and its conversation where its agent
can resume one; one still running is left as it is. Then give it the words with harness reply. harness ps --all lists
those closed in the last week; any closed one is found by its id. For a program acting for the person, while they
allow it (harness settings programs-reply); never an agent.
--json answers {"ok":true,"name","id","state","resumed","effect","next"}. "resumed": false: it is open again in a new
conversation, as its agent could not resume the earlier one.
Exit status: 0 open, 5 refused, 1 not opened (RESUME_UNCONFIRMED: its machine has not confirmed it yet; check its
terminal, then run harness resume again).
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
export const WATCH_USAGE = `Usage: harness watch [--machine <name>] <name> | --mine [--chars N] [--timeout 30m] [--json]

Follows one harness and prints a line each time it changes: started, working, needs_person (its last words),
done (its answer), idle (nothing asked of it), failed, stopped (with its last answer). With --json each line is one
JSON object, for a program to read. The first line is how it stands now; the same state with new words is a new line.
It hears each change of a harness here as Harness pushes it, as wait does, and looks every 3 s at a cloud harness
or a harness on another machine. A cloud harness's state is its maker's: Devin Cloud says needs_person both when it
asks and when it has only finished, so read the words and cloud.providerStatus.
--mine follows every harness you started, on every machine, in one stream: each line names its harness and machine.
Exit status: 4 once it stops or is gone (with --mine, once every one has), 124 when --timeout passes. --timeout takes
90s, 30m, 2h; 0, the default, follows as long as they live.
${ON_MACHINE}`
export const CLOSE_USAGE = `Usage: harness close [--machine <name>] <name> [--now] [--json]

Saves the harness's screen and stops it. Its conversation is kept: the person can resume it.
It is refused while the harness is working, unless --now. An agent may close only harnesses it started:
closing another's exits 5.
${ON_MACHINE}`
export const DELETE_USAGE = `Usage: harness delete <name> [--json]

Stops the harness and erases its conversation and everything Harness keeps of it: its saved screen, recaps, search
rows and task records. Its folder is kept. An engine's own store Harness cannot erase is kept, and the output says so.
A closed harness can be deleted too. An agent may delete only harnesses it started: deleting another's exits 5.
This computer only.`
export const WHOAMI_USAGE = `Usage: harness whoami [--json]

Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now
and, if not, who can change that; how many of yours are open, and how many starts are left.`

export const EXIT = { ok: 0, failed: 1, usage: 2, needsInput: 3, stopped: 4, refused: 5, timeout: 124 } as const

/** Not a failure: the caller may not do this. It should not retry; it tells the person or does the work itself.
 *  `TELL_OFF` and `NOT_RUNNING` are `harness tell`'s, `REPLY_OFF` is `harness reply`'s, and `NOT_HACHI`, `GOAL_EMPTY`,
 *  `GOAL_LIMIT`, `GOAL_DONE` and `GOAL_FULL` are `harness goal`'s (services/goals.ts): retried, they are refused the
 *  same. `NOT_IDLE` is not among them: once the harness has finished, the reply is taken. */
export const REFUSED_CODES: ReadonlySet<string> = new Set(['SPAWN_LIMIT', 'TURNED_OFF', 'NOT_YOURS', 'TELL_OFF', 'NOT_RUNNING', 'REPLY_OFF',
  'NOT_HACHI', 'GOAL_EMPTY', 'GOAL_LIMIT', 'GOAL_DONE', 'GOAL_FULL'])

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
/**
 * How long `wait` and `watch` go without a look while every harness they follow here is followed by push: a backstop
 * for a change no event carries, not a round. A waiting agent asked for the whole list every 3 s, 20 requests a
 * minute over the machine link while its harness worked; followed by push it asks about once a minute.
 */
const PUSHED_BACKSTOP_MS = 60_000
/** How many harnesses `ps` asks what they are about; the rest list without it. */
const ABOUT_MAX = 40
/** How long `ps --machines` waits on each other machine (docs/design/2026-11-12-hachi.md): Hachi's read of every
 *  harness, after a restart too, must not hang on one machine that is asleep. */
const PS_MACHINES_ANSWER_MS = 5_000
/** How many other machines `ps --machines` asks at once: the rest are listed as not asked. */
const PS_MACHINES_MAX = 32
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
    sleep: deps.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
      // Cut short by a push, the timer goes too: a minute's timer left behind would hold the process open after it printed.
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', () => { clearTimeout(timer); done() }, { once: true })
    })),
    intervalMs: deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    record: deps.record ?? messagesRpc,
    answerMs: deps.answerMs ?? PS_MACHINES_ANSWER_MS,
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
    // Asked with the stopped ones too (`opened(s, true)`): an exact stopped name before a live one it merely starts.
    let found = matching(name, o.stopped ? named(await list(daemon, true)) : live)
    if (!found.length && !o.stopped) found = matching(name, named(await list(daemon, true)))
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

/** A failed launch as `ps` and `show` say it: its words, or its code when it has none. */
const failedLine = (failure: Failure): string => `failed: ${failure.detail ?? failure.error}`

export function formatRows(rows: Row[], now: number, on = 'this machine'): string {
  if (!rows.length) return `No harnesses on ${on}.`
  const width = Math.min(32, Math.max(4, ...rows.map((r) => r.name.length)))
  const head = `${'NAME'.padEnd(width)}  ${'AGENT'.padEnd(11)}  ${'STATE'.padEnd(11)}  ${'STARTED BY'.padEnd(12)}  ${'ACTIVE'.padEnd(6)}  FOLDER`
  const lines = rows.map((r) => {
    const name = clip(r.name, width).padEnd(width)
    const line = `${name}  ${clip(r.agent, 11).padEnd(11)}  ${r.state.padEnd(11)}  ${clip(r.self ? `${r.startedBy} (you)` : r.startedBy, 12).padEnd(12)}  ${ago(r.lastActive, now).padEnd(6)}  ${tilde(r.folder)}${r.branch ? ` (${r.branch})` : ''}`
    // Why it started nothing comes first: what it was about never ran.
    const about = r.failure ? failedLine(r.failure) : r.about ?? (r.asks?.length ? `asked: ${r.asks[0]}` : '')
    return about ? `${line}\n${' '.repeat(2)}${clip(about.replace(/\s+/g, ' '), 200)}` : line
  })
  return [head, ...lines].join('\n')
}

/** What each live one of [rows] is about: the person's last asks and the summaries the daemon keeps (no transcript
 *  read), filled in place. `harness ps`'s, and what `harness route` shows the router. */
async function describeRows(daemon: Daemon, rows: Row[]): Promise<void> {
  await Promise.all(rows.filter((r) => r.state !== 'stopped').slice(0, ABOUT_MAX).map(async (row) => {
    const recent = await daemon.request('agent_recent', { agentId: row.id, n: 3 }, 3_000).catch(() => null)
    if (!recent || recent.error) return
    const asks = (Array.isArray(recent.asks) ? recent.asks as unknown[] : []).filter((a): a is string => typeof a === 'string' && !!a.trim()).slice(0, 2)
    const about = (Array.isArray(recent.events) ? recent.events as Array<Record<string, unknown>> : [])
      .map((e) => (typeof e.recap === 'string' && e.recap ? e.recap : typeof e.text === 'string' ? e.text : '').replace(/\s+/g, ' ').trim())
      .filter(Boolean).slice(0, 3).map((t) => clip(t, 140))
    if (asks.length) row.asks = asks.map((a) => clip(asSaid(a).replace(/\s+/g, ' ').trim(), 200))
    if (about.length) row.about = about.join(' / ')
  }))
}

export function psCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(PS_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--all': 'flag', '--json': 'flag', '--machines': 'flag' })
    if (flags.has('--machines')) {
      if (machine !== null) throw new UsageError('--machines lists every machine: leave out --machine.')
      if (names.length) throw new UsageError(`harness ps takes no names. To read one: harness show ${names[0]}`)
      return psMachines(s, flags.has('--all'), flags.has('--json'))
    }
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
      await describeRows(on.daemon, rows)
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

/** One machine in `ps --machines`: its harnesses, or why it has none to show. */
interface MachineRows {
  machineId: string; machine: string; current: boolean
  state: 'ok' | 'unreachable' | 'not_asked'
  detail?: string
  harnesses?: Row[]
}

/**
 * `ps --machines`: the harnesses of every machine of the account's own (never one shared with it), all asked at once,
 * each for [s.answerMs] at most: Hachi's read of where things are, and of what is still its own after a restart. One
 * that does not answer is listed as unreachable with why, never left out; one that answers late is closed unread.
 */
async function psMachines(s: Setup, all: boolean, json: boolean): Promise<number> {
  const mine = (await s.machines()).filter((m) => !m.sharedBy && !m.toAdd)
  const o = await opened(s, all)
  try {
    const rowsOn = async (daemon: Daemon, machineId: string, machine: string, frames: Frame[]): Promise<Row[]> => {
      const rows = rowsOf(frames, { machineId, machine, caller: o.caller, ledger: o.ledger, now: s.now(), all })
      await describeRows(daemon, rows)
      return rows
    }
    const others = mine.filter((m) => !m.current && m.machineId !== o.where.machineId)
    const ask = async (m: NewMachine): Promise<MachineRows> => {
      const one = { machineId: m.machineId, machine: m.label, current: false }
      let late = false, line: Daemon | null = null, timer: NodeJS.Timeout | undefined
      const answered = (async () => {
        const daemon = line = await s.open(o.where, m.machineId)
        if (late) { daemon.close(); return null }
        try { return await rowsOn(daemon, m.machineId, m.label, await list(daemon, all)) } finally { daemon.close() }
      })()
      const due = new Promise<null>((done) => { timer = setTimeout(done, s.answerMs, null) })
      try {
        const rows = await Promise.race([answered, due])
        if (rows) return { ...one, state: 'ok', harnesses: rows }
        // Its line closed now, not when its own request gives up: an open line holds the process after it printed.
        late = true
        ;(line as Daemon | null)?.close()
        answered.catch(() => {})
        return { ...one, state: 'unreachable', detail: `It did not answer in ${PS_MACHINES_ANSWER_MS / 1000} s.` }
      } catch (error) {
        return { ...one, state: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
      } finally { clearTimeout(timer) }
    }
    const machines: MachineRows[] = [
      { machineId: o.where.machineId, machine: o.machine, current: true, state: 'ok', harnesses: await rowsOn(o.daemon, o.where.machineId, o.machine, o.frames) },
      ...await Promise.all(others.slice(0, PS_MACHINES_MAX).map(ask)),
      ...others.slice(PS_MACHINES_MAX).map((m): MachineRows => ({ machineId: m.machineId, machine: m.label, current: false, state: 'not_asked',
        detail: `At most ${PS_MACHINES_MAX} machines are asked at once.` })),
    ]
    const context = contextFor(s, o)
    if (json) { s.out(JSON.stringify({ you: o.caller ? o.caller.name : null, context, machines }, null, 1)); return EXIT.ok }
    const said = machines.map((m) => m.state === 'ok' ? `${m.machine}${m.current ? ' (this machine)' : ''}:\n${formatRows(m.harnesses!, s.now(), m.machine)}`
      : m.state === 'unreachable' ? `${m.machine}: unreachable. ${m.detail}`
      : `${m.machine}: not asked; at most ${PS_MACHINES_MAX} machines are asked at once.`)
    s.out([o.caller || o.orphan ? formatContext(context) : null, ...said].filter(Boolean).join('\n\n'))
    return EXIT.ok
  } finally { o.daemon.close() }
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
  !!o.caller && !o.caller.outside && !!pane && tellsOn(o.where.dataDir, o.caller)

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
    signedIn: !!readAuthSession(), switchOn: caller ? startsOn(o.where.dataDir, caller) : readAgentSettings(o.where.dataDir).agentsStartAgents,
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
    const { names, flags, machine } = words(argv, { '--chars': 'value', '--json': 'flag', '--work': 'flag' })
    if (names.length !== 1) throw new UsageError(names.length ? 'Name one harness.' : 'Name the harness to show.')
    const chars = flags.has('--chars') ? Number(flags.get('--chars')) : DEFAULT_CHARS
    if (!Number.isInteger(chars) || chars < 1) throw new UsageError('--chars takes a whole number.')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      t = await target(s, o, names[0], away)
      if (flags.has('--work') && t.frame.location === 'cloud') {
        const name = t.frame.name ?? t.frame.id.slice(0, 8)
        throw new UsageError(`${name} runs in its maker's cloud: it has no folder here to read. Its links are in ${step(s.env, 'show', onAway(name, away))}.`)
      }
      const listed = stateOf(t.frame)
      // A cloud harness has no screen: its state is the cloud service's.
      const screen = listed === 'stopped' || listed === 'offline' || t.frame.location === 'cloud' ? null : await inspect(t)
      const state: State = screen === 'draft' ? 'idle' : screen ?? listed
      const parent = o.ledger.parentOf({ machineId: t.machineId, agentId: t.frame.id })
      const startedBy = t.yours ? 'you' : parent ? parent.by.name : 'person'
      if (flags.has('--work')) {
        const work = await workOf(t)
        const head = { name: t.frame.name, id: t.frame.id, agent: engineName(t.frame.engine ?? ''), machine: t.machine, state, startedBy }
        if (flags.has('--json')) s.out(JSON.stringify({ ...head, work }, null, 1))
        else for (const line of [`${head.name} on ${head.machine}: ${stateSaid(state)} · ${head.agent} · started by ${startedBy}`, ...workLines(work)]) s.out(line)
        return EXIT.ok
      }
      const turn = await readLastTurn(t)
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
      const cloud = cloudMeta(t.frame)
      const failure = failureOf(t.frame)
      const result = {
        name: t.frame.name, id: t.frame.id, agent: engineName(t.frame.engine ?? ''), machine: t.machine, state, startedBy,
        folder: t.frame.project?.cwd ?? null, branch: t.frame.project?.branch ?? null,
        ask: turn?.ask ?? null, answer: clip(answer, chars), truncated: answer.length > chars, tools: turn?.tools ?? 0, next,
        ...(state === 'needs-input' ? { needsPerson: true } : {}),
        ...(cloud ? { cloud } : {}),
        ...(failure ? { failure } : {}),
        ...(t.frame.cloud?.links?.length ? { links: t.frame.cloud.links } : {}),
        ...(pendingTell ? { told: { at: new Date(pendingTell.at).toISOString(), taken: false } } : {}),
      }
      if (flags.has('--json')) s.out(JSON.stringify(result, null, 1))
      else {
        s.out(`${result.name} on ${result.machine}: ${stateSaid(state)} · ${result.agent} · started by ${startedBy}`)
        s.out(`folder: ${tilde(result.folder)}${result.branch ? ` (${result.branch})` : ''}`)
        if (failure) s.out(failedLine(failure))
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

/** A harness's work as `show --work` says it: its branch, and its pull request with what it changed and its checks, or
 *  `none` (there is none yet) or `unavailable` (its machine could not read one). */
interface Work {
  branch: string | null
  pullRequest: 'none' | 'unavailable' | {
    number: number; url: string; state: string; title?: string
    files?: number; additions?: number; deletions?: number; ci?: string; checks?: { passed: number; failed: number; pending: number; total: number }
  }
}

/**
 * [t]'s work, read on the machine that owns it with the requests its windows' pull request label asks
 * (services/projects.ts `git_pull_request`, then `git_pull_requests_status` for what it changed and its checks): never
 * git or gh run here on another machine's folder. Each is bounded; a read that fails says so rather than failing.
 */
async function workOf(t: Target): Promise<Work> {
  const branch = t.frame.project?.branch ?? null
  const found: Record<string, unknown> = await t.daemon.request('git_pull_request', { agentId: t.frame.id }, 15_000).catch(() => ({ status: 'unavailable' }))
  if (found.status !== 'found' || typeof found.url !== 'string') return { branch, pullRequest: found.status === 'none' ? 'none' : 'unavailable' }
  const status = await t.daemon.request('git_pull_requests_status', { urls: [found.url] }, 15_000).catch(() => ({}) as Record<string, unknown>)
  const row = (Array.isArray(status.rows) ? status.rows[0] : null) as Record<string, unknown> | null
  return { branch, pullRequest: {
    number: Number(found.number), url: found.url, state: String(found.state), ...(typeof found.title === 'string' ? { title: found.title } : {}),
    ...(row?.status === 'found' ? { files: Number(row.changedFiles), additions: Number(row.additions), deletions: Number(row.deletions),
      ci: String(row.ci), checks: row.checks as { passed: number; failed: number; pending: number; total: number } } : {}),
  } }
}

/** `show --work` as a line, then the pull request's address. */
function workLines(work: Work): string[] {
  const branch = `branch: ${work.branch ?? '-'}`
  const pr = work.pullRequest
  if (pr === 'none') return [`${branch} · no pull request`]
  if (pr === 'unavailable') return [`${branch} · its pull request could not be read on its machine`]
  const changed = pr.files === undefined ? '' : `: ${pr.files} file${pr.files === 1 ? '' : 's'}, +${pr.additions} -${pr.deletions}, checks ${pr.ci}`
    + (pr.checks?.total ? ` (${pr.checks.passed} of ${pr.checks.total})` : '')
  return [`${branch} · PR #${pr.number} (${pr.state})${changed}`, pr.url]
}

/** How much of the words a `Told` line keeps to know the turn they asked (ledger.ts `Told`). */
const PROBE_CHARS = 80
/** The words as a turn's ask holds them, to compare: spaces as one, since a pane may wrap or trim them. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

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
      if (o.caller || o.orphan) throw new AgentClientError('NOT_YOURS', 'Only the person replies to a harness: tell them what it asked. To give more work to one you started, use harness tell.')
      t = await target(s, o, names[0], away)
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)
      const next: NextStep[] = [{ run: step(s.env, 'wait', at), when: 'for its answer' }]
      if (t.frame.location !== 'cloud') {
        // A harness in a pane, for a program acting for the person (messages/replyLocal.ts): the machine it runs on
        // checks the switch and that it is idle again, and queues the words in its mailbox.
        if (!readAgentSettings(o.where.dataDir).programsReply) throw new AgentClientError('REPLY_OFF', REPLY_OFF_TEXT)
        const reply = await replyInPane(s, o, t, text, at)
        const failed = reply.state === 'failed'
        const effect = failed ? `${name} did not take it: ${typeof reply.reason === 'string' ? reply.reason : 'its machine refused it'}.` : `${name} has it: typed once its composer is free.`
        s.out(flags.has('--json') ? JSON.stringify({ ok: !failed, name, id: t.frame.id, message: reply.id ?? null, state: reply.state ?? 'queued', effect, next: failed ? [] : next })
          : [`${name} on ${t.machine}: ${effect}`, failed ? null : formatNext(next)].filter(Boolean).join('\n'))
        return failed ? EXIT.failed : EXIT.ok
      }
      const reply = await t.daemon.request('cloud_send', { agentId: t.frame.id, text }, 3 * 60_000)
      if (typeof reply.error === 'string') throw new AgentClientError(reply.error, typeof reply.detail === 'string' && reply.detail ? reply.detail : `${name} did not take it (${reply.error}).`)
      s.out(flags.has('--json') ? JSON.stringify({ ok: true, name, id: t.frame.id, next }) : `Sent to ${name}.\n${formatNext(next)}`)
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

/** How long words sent from here still steer a follow-up that names nothing ("and the other one?") to where they went. */
const ROUTE_LAST_MS = 10 * 60_000

/**
 * Where a program's words for the person go (docs/design/2026-10-09-auto-router.md): the machine's harnesses in a
 * pane, as `ps` reads them, are shown to this machine's router (services/router.ts `route_decide`), which picks one or
 * says new work. With `--send` the words go into the one picked, idle only, as `harness reply` types them; new work is
 * the caller's to start (`harness new`). The same caller policy as `reply` (#1628): the person's switch, never an agent.
 */
export function routeCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(ROUTE_USAGE, deps, wantsJson, argv, async (s) => {
    const dash = argv.indexOf('--')
    const { names, flags, machine } = words(dash < 0 ? argv : argv.slice(0, dash), { '--json': 'flag', '--send': 'flag' })
    const text = dash < 0 ? '' : argv.slice(dash + 1).join(' ').trim()
    if (names.length) throw new UsageError('harness route takes no name: it picks one. Give the words after --.')
    if (!text) throw new UsageError('Give the words after --: harness route -- <words>')
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let line: Daemon | null = null
    try {
      if (o.caller || o.orphan) throw new AgentClientError('NOT_YOURS', 'Only the person, or a program acting for them, routes words to a harness. To give more work to one you started, use harness tell.')
      if (!readAgentSettings(o.where.dataDir).programsReply) throw new AgentClientError('REPLY_OFF', REPLY_OFF_TEXT)
      const on = away
        ? { daemon: line = await s.open(o.where, away.machineId), machineId: away.machineId, machine: away.label }
        : { daemon: o.daemon, machineId: o.where.machineId, machine: o.machine }
      // Harnesses in a pane only: a cloud one is answered with `harness reply`, through its maker.
      const frames = (line ? await list(line, false) : o.frames).filter((f) => isAgent(f) && f.location !== 'cloud')
      const rows = rowsOf(frames, { machineId: on.machineId, machine: on.machine, caller: o.caller, ledger: o.ledger, now: s.now(), all: false })
        .filter((r) => r.state !== 'stopped')
      await describeRows(on.daemon, rows)
      // Where this computer's last words for that machine went, within ROUTE_LAST_MS. This computer's ledger, so one
      // lamp's follow-up is never steered by another's.
      const told = o.ledger.lastToldBy({ machineId: o.where.machineId, agentId: PERSON_AGENT_ID }, on.machineId)
      const last = told && s.now() - told.at <= ROUTE_LAST_MS && rows.some((r) => r.id === told.told.agentId)
        ? { id: told.told.agentId, agoMs: s.now() - told.at } : undefined
      const sessions = rows.map((r) => ({ id: r.id, name: r.name, asks: r.asks ?? [], ...(r.about ? { about: r.about } : {}) }))
      // Asked of THIS machine's router, as the owner over its own socket: the list is the caller's, so a harness on
      // another computer is routed to as well as one here.
      const verdict = await o.daemon.request('route_decide', { text, sessions, projects: [], agents: [], ...(last ? { last } : {}) }, 15_000)
      if (typeof verdict.error === 'string') {
        throw new AgentClientError('ROUTER_UNAVAILABLE', `Nothing was decided (${verdict.error}${typeof verdict.detail === 'string' ? `: ${verdict.detail}` : ''}). Act on nothing, or ask the person.`)
      }
      const row = verdict.decided === 'session' ? rows.find((r) => r.id === verdict.id) : undefined
      if (!row) {
        const reason = typeof verdict.reason === 'string' ? verdict.reason : 'new work'
        s.out(flags.has('--json') ? JSON.stringify({ decided: 'new', reason }) : `New work: ${reason}. Start it with harness new.`)
        return EXIT.ok
      }
      const decided = { decided: 'session', id: row.id, name: row.name, machine: on.machine,
        confidence: typeof verdict.p === 'number' ? Math.round(verdict.p * 1000) / 1000 : null,
        reason: typeof verdict.trace === 'string' ? verdict.trace : null }
      if (!flags.has('--send')) {
        s.out(flags.has('--json') ? JSON.stringify(decided) : `${row.name} on ${on.machine}${decided.confidence !== null ? ` (${Math.round(decided.confidence * 100)}%)` : ''}`)
        return EXIT.ok
      }
      const frame = frames.find((f) => f.id === row.id)!
      const at = onAway(addressOf({ machineId: '', agentId: row.id, name: row.name, engine: '' }), away)
      let sent: Record<string, unknown>
      try {
        const reply = await replyInPane(s, o, { daemon: on.daemon, frame, machineId: on.machineId, machine: on.machine, yours: false, remote: !!line }, text, at)
        sent = reply.state === 'failed'
          ? { error: 'FAILED', detail: typeof reply.reason === 'string' ? reply.reason : 'its machine refused it' }
          : { state: typeof reply.state === 'string' ? reply.state : 'queued', message: reply.id ?? null }
      } catch (error) {
        if (!(error instanceof AgentClientError) || !['NOT_IDLE', 'NOT_RUNNING'].includes(error.code)) throw error
        sent = { error: error.code, detail: error.message }
      }
      const next: NextStep[] = sent.error === 'NOT_IDLE'
        ? [{ run: step(s.env, 'wait', at), when: 'it is still on the last words: then send these with harness reply. Never start new work for them' }]
        : sent.error ? [] : [{ run: step(s.env, 'wait', at), when: 'for its answer' }]
      s.out(flags.has('--json') ? JSON.stringify({ ...decided, sent, next })
        : [`${row.name} on ${on.machine}: ${sent.error ? `not sent (${sent.detail})` : 'has it: typed once its composer is free.'}`, formatNext(next)].filter(Boolean).join('\n'))
      return EXIT.ok
    } finally { line?.close(); o.daemon.close() }
  })
}

/**
 * [text] typed into [t], a harness in a pane, for the person (messages/replyLocal.ts): only while it is idle. The
 * machine it runs on checks the switch and that it is idle again, and queues the words in its mailbox; its answer is
 * returned. `harness reply`'s and `harness route --send`'s, which check the person's switch first.
 */
async function replyInPane(s: Setup, o: Opened, t: Target, text: string, at: string): Promise<Record<string, unknown>> {
  const name = t.frame.name ?? t.frame.id.slice(0, 8)
  const state = stateOf(t.frame)
  if (state === 'stopped' || state === 'offline') {
    throw new AgentClientError('NOT_RUNNING', `${name} is no longer running: it was closed or stopped. Resume it with harness resume ${at}, then reply; or start a new harness with the whole task.`)
  }
  if (state !== 'idle') throw new AgentClientError('NOT_IDLE', state === 'working' ? `${name} is working. Wait for it to finish (${step(s.env, 'wait', at)}), then reply.` : `${name} is not idle: it may be waiting for the person (a question or a permission). Only they answer that.`)
  let reply: Record<string, unknown>
  try { reply = await s.record({ port: o.where.port, dataDir: o.where.dataDir, machineId: t.machineId }, { action: 'reply_local', machine: o.machine, agentId: t.frame.id, text }, 20_000) } catch (error) {
    if (error instanceof MessageError) throw new AgentClientError(error.code, error.message)
    throw error
  }
  // As a tell's: `wait` and `show` then hold the answer to the work before until it has taken these words, and the
  // next `harness route` from here takes it for where the last words went (`Ledger.lastToldBy`).
  try { o.ledger.append({ at: s.now(), by: { machineId: o.where.machineId, agentId: PERSON_AGENT_ID }, told: { machineId: t.machineId, agentId: t.frame.id }, probe: flat(text).slice(0, PROBE_CHARS) }) }
  catch { /* `wait` then reads its last answer as it would without the line */ }
  return reply
}

// ── resume ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A closed harness opened again (`agent_resume`, core/agents/launches.ts), for a program acting for the person: the lamp
 * hands follow-up work to the session the person names, and `reply` refuses one that was closed (NOT_RUNNING). The same
 * caller policy as `reply` and `route`: the person's switch, never an agent. Only a resume: launch words and a permission
 * mode are the owner's own app's to change. Asked with a receipt, so an answer lost on the way is asked after by it
 * (`agent_create_status`) rather than by a second resume.
 */
export function resumeCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(RESUME_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (names.length !== 1) throw new UsageError(names.length ? 'Resume one harness at a time.' : 'Name the harness to resume.')
    const away = await machineOf(s, s.where(), machine)
    // The stopped ones too, from the start: a closed `weather` is meant before a live `weather-api` its name starts.
    const o = await opened(s, true)
    let t: Target | null = null
    try {
      if (o.caller || o.orphan) throw new AgentClientError('NOT_YOURS', 'Only the person, or a program acting for them, resumes a harness. Tell the person which one to resume.')
      if (!readAgentSettings(o.where.dataDir).programsReply) throw new AgentClientError('REPLY_OFF', RESUME_OFF_TEXT)
      t = await target(s, o, names[0], away)
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      if (t.frame.location === 'cloud') throw new UsageError(`${name} runs in its maker's cloud: harness resume reopens a harness in a pane only.`)
      const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)
      const creationId = randomUUID()
      let reply: Record<string, unknown>
      // As long as a new harness may take to start: the machine answers once the engine is back, or that it is not.
      try { reply = await t.daemon.request('agent_resume', { agentId: t.frame.id, creationId }, STARTING_MS) } catch (error) {
        if (!(error instanceof AgentClientError) || error.code !== 'TIMEOUT') throw error
        reply = await t.daemon.request('agent_create_status', { creationId })
        // The machine has no record of it: the resume never reached it.
        if (reply.state === 'missing') throw error
      }
      const agent = resumedAgent(s, name, at, t.frame.id, reply)
      const resumed = reply.resumed !== false
      // Said alike whether it was relaunched or found still running: the machine's answer does not say which.
      const effect = resumed ? `${name} is open, with its conversation.` : `${name} is open, in a new conversation: its agent could not resume the earlier one.`
      const next: NextStep[] = [{ run: `harness reply ${at} -- <words>`, when: 'to give it more work' }]
      s.out(flags.has('--json') ? JSON.stringify({ ok: true, name, id: t.frame.id, state: stateOf(agent), resumed, effect, next })
        : [`${name} on ${t.machine}: ${effect}`, formatNext(next)].join('\n'))
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

/** Said when the person has not allowed it: `reply`'s switch, as resuming is only ever to give a closed harness more work. */
export const RESUME_OFF_TEXT = `Programs may not open your closed harnesses again yet. ${askThePersonFirst('programs-reply', 'tell them which harness to resume, and they open it in Harness.')}`

/** The harness a resume's receipt says is open again, or why it is not, said for a program rather than the app. */
function resumedAgent(s: Setup, name: string, at: string, agentId: string, reply: Record<string, unknown>): Frame {
  const agent = reply.agent as Frame | undefined
  if (reply.state === 'created' && agent?.id === agentId) return agent
  // Relaunched but not seen to resume its conversation, or still opening: a second resume checks it again rather than
  // starting another process (lib/resumeAgentService.ts).
  if (reply.state === 'unconfirmed' || reply.state === 'pending') {
    throw new AgentClientError('RESUME_UNCONFIRMED', `${name} was started again, but Harness has not confirmed its conversation yet. Check its terminal, then run harness resume ${at} again.`)
  }
  if (reply.state === 'created' || reply.state === 'unavailable') {
    throw new AgentClientError('AGENT_CHANGED', `${name} changed while resuming. Check it with ${step(s.env, 'show', at)}.`)
  }
  const failure = (reply.state === 'failed' ? reply.failure ?? {} : reply) as { code?: unknown; error?: unknown; detail?: unknown }
  const code = typeof failure.code === 'string' ? failure.code : typeof failure.error === 'string' ? failure.error : 'FAILED'
  throw new AgentClientError(code, typeof failure.detail === 'string' && failure.detail ? failure.detail : `${name} was not resumed (${code}).`)
}

// ── tell ───────────────────────────────────────────────────────────────────────────────────────────

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
      if (!tellsOn(o.where.dataDir, caller)) throw new AgentClientError('TELL_OFF', TELL_OFF_TEXT)
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
  // No caller is the person, or a program acting for them: their replies are recorded as the person's (`harness reply`).
  const by = o.caller ?? (o.orphan ? null : { machineId: o.where.machineId, agentId: PERSON_AGENT_ID })
  const told = by ? o.ledger.toldBy(by, { machineId: t.machineId, agentId: t.frame.id }) : null
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

/**
 * The harnesses `wait` or `watch` follows by what each daemon pushes when one changes (`agents_watch`,
 * core/toolWatches.ts), and a sleep a push from any of them cuts short. A daemon too old to push to tools says no once,
 * and is not asked again: the verb then looks every interval, as it always did. So does a line to another machine,
 * which pushes nothing to a tool.
 */
function pushedBy(s: Setup) {
  const lines = new Map<Daemon, { followed: string; ids: Set<string>; on: boolean; refused: boolean }>()
  let changed = false
  let wake: (() => void) | null = null
  return {
    /** Follows [agentIds] on [daemon] (every harness there the verb waits on): true while it pushes their changes. */
    async follow(daemon: Daemon, agentIds: string[]): Promise<boolean> {
      let line = lines.get(daemon)
      if (!line) lines.set(daemon, line = { followed: '', ids: new Set(), on: false, refused: false })
      const key = [...new Set(agentIds)].sort().join('\u0000')
      if (line.refused || !daemon.watch || key === line.followed) return line.on
      const followed = line
      followed.followed = key
      followed.ids = new Set(agentIds)
      followed.on = await daemon.watch([...followed.ids], (agentId) => {
        if (!followed.ids.has(agentId)) return
        changed = true
        wake?.()
      }).catch((error) => {
        if (error instanceof AgentClientError) return false
        throw error
      })
      followed.refused = !followed.on
      return followed.on
    },
    /** [ms], or less when a harness followed changed meanwhile: at once when it changed during the last look. */
    async sleep(ms: number): Promise<void> {
      if (!changed) {
        const cut = new AbortController()
        await Promise.race([s.sleep(ms, cut.signal), new Promise<void>((done) => { wake = done })])
        wake = null
        cut.abort()
      }
      changed = false
    },
  }
}

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
      const push = pushedBy(s)
      /** Looked at last as working by the daemon's word: its next change, whatever it is, is pushed. */
      const pushedNext = new Set<Target>()
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
        // Not live: stopped, or gone. Asked of the full list only then. The stopped frame is the one this wait
        // ended on: the frame from before the wait still has the maker's earlier status (lampOS, #1449).
        if (!frame) {
          const stopped = (await list(t.daemon, true)).find((f) => f.id === t.frame.id)
          if (stopped) t.frame = stopped
          return ended(t, stopped ? 'stopped' : 'gone')
        }
        t.frame = frame
        if (frame.status === 'stopped') return ended(t, 'stopped')
        // A cloud harness says where it is itself, with no screen to read: done once it is no longer starting or working.
        if (frame.location === 'cloud') {
          const state = stateOf(frame)
          return state === 'idle' || state === 'needs-input' || state === 'failed' ? state : null
        }
        // The daemon says it is working: no need to read its screen.
        const screen = frame.activity?.state === 'working' ? 'working' : await inspect(t)
        // Working, by the daemon's word or the screen's: what comes next is pushed, whatever it is (its turn's end, its
        // activity, a question, which the daemon looks for on the screen of a harness a tool follows). Not a draft.
        if (screen === 'working' && !t.remote) pushedNext.add(t)
        else pushedNext.delete(t)
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
        // Before the looks, so a change during them is kept. Pushed: the harnesses here in a pane. A cloud harness's maker
        // pushes nothing, and another machine's harnesses are not pushed here.
        const pushing = await push.follow(o.daemon, targets.filter((t) => !t.remote && t.frame.location !== 'cloud').map((t) => t.frame.id))
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
        // A harness not started yet is followed by its creation, which is not pushed.
        const quiet = pushing && !following.length && targets.every((t) => settled.has(t) || pushedNext.has(t))
        await push.sleep(Math.min(quiet ? PUSHED_BACKSTOP_MS : s.intervalMs, Math.max(0, deadline - s.now())))
      }
      const results: Array<{ name: string; id: string; state: Settled | 'installing' | 'starting'; detail?: string; cloud?: CloudMeta }> = [
        ...targets.filter((t) => settled.has(t)).map((t) => {
          const cloud = cloudMeta(t.frame)
          return { name: t.frame.name ?? t.frame.id.slice(0, 8), id: t.frame.id, state: settled.get(t)!, ...(cloud ? { cloud } : {}) }
        }),
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

// ── watch ──────────────────────────────────────────────────────────────────────────────────────────

/** What `harness watch` says changed. `idle`: idle with nothing asked of it, so nothing done to report. */
export type WatchEvent = 'started' | 'working' | 'needs_person' | 'done' | 'idle' | 'failed' | 'stopped'

/** A cloud harness's maker state as an event; none while it is unknown. */
const CLOUD_EVENTS: Partial<Record<State, WatchEvent>> = {
  starting: 'started', installing: 'started', working: 'working', 'needs-input': 'needs_person', idle: 'done', failed: 'failed', stopped: 'stopped',
}

/** The state a harness here is in at each event: its frame says only working or idle, the screen the rest. */
const EVENT_STATES: Record<WatchEvent, State> = {
  started: 'starting', working: 'working', needs_person: 'needs-input', done: 'idle', idle: 'idle', failed: 'failed', stopped: 'stopped',
}

type LastTurn = Awaited<ReturnType<typeof readLastTurn>>

/** A machine's live harnesses, or null for a round its machine was too slow to answer: looked at again next round. */
const listOrNull = (daemon: Daemon): Promise<Frame[] | null> => list(daemon, false).catch((error) => {
  if (error instanceof AgentClientError && error.code === 'TIMEOUT') return null
  throw error
})

/**
 * One harness `watch` follows, by `wait`'s looks (the maker's state for a cloud harness; the daemon's activity, then the
 * screen, then two idle looks on one turn for one here): [say] is told each change once.
 */
function follower(s: Setup, o: Opened, h: Target, say: (event: WatchEvent, turn: LastTurn) => void) {
  /** The last line said, as its event and the turn it spoke of: a line is said only when this changes. */
  let printed: string | null = null
  let sawWorking = false
  let idle: { turn: string; looks: number } | null = null
  /** The turn read for the frame last seen changed (its `updatedAt`): read again only when that moves. */
  let turnFor: { updatedAt: string; turn: LastTurn } | null = null
  const turnNow = async () => {
    const updatedAt = h.frame.updatedAt ?? ''
    if (!turnFor || turnFor.updatedAt !== updatedAt || !updatedAt) turnFor = { updatedAt, turn: await readLastTurn(h, 1) }
    return turnFor.turn
  }
  const keyOf = (turn: LastTurn): string => (turn ? `${turn.ask}\u0000${turn.tools}\u0000${turn.answer.length}` : '')
  /** The last look told the harness's state for certain, so its next change is pushed: working, its question, its
   *  answer. A draft in its box is looked at again in an interval: the person typing is pushed by nothing. */
  let pushedNext = false
  /** This round's event: null while it can't be told yet (an idle look not yet confirmed, a state unknown). */
  const look = async (live: Frame[]): Promise<WatchEvent | null> => {
    pushedNext = false
    const frame = live.find((f) => f.id === h.frame.id)
    if (!frame) {
      const stopped = (await list(h.daemon, true)).find((f) => f.id === h.frame.id)
      if (stopped) h.frame = stopped
      return 'stopped'
    }
    h.frame = frame
    if (frame.status === 'stopped') return 'stopped'
    if (frame.location === 'cloud') return CLOUD_EVENTS[stateOf(frame)] ?? null
    const screen = frame.activity?.state === 'working' ? 'working' : await inspect(h)
    if (screen === 'working' || screen === 'draft') { sawWorking = true; idle = null; pushedNext = screen === 'working'; return 'working' }
    if (screen === 'needs-input') { idle = null; pushedNext = true; return 'needs_person' }
    if (screen === null && stateOf(frame) !== 'idle') { idle = null; return null }
    // Idle on two looks in a row with the same last turn, as `wait` decides it (#1180).
    const turn = await turnNow()
    if (toldPending(o, h, turn, s.now())) { idle = null; return 'working' }
    const key = keyOf(turn)
    const looks = idle && idle.turn === key ? idle.looks + 1 : 1
    idle = { turn: key, looks }
    if (looks < 2) return null
    pushedNext = true
    if (sawWorking || turn?.answered) return 'done'
    const age = frame.createdAt ? s.now() - Date.parse(frame.createdAt) : Infinity
    if (age > STARTING_MS && looks >= QUIET_LOOKS) return 'idle'
    pushedNext = false
    return null
  }
  return {
    target: h,
    pushedNext: (): boolean => pushedNext,
    /** One look at it in [live], its machine's live harnesses now: the event, said when it is news. */
    async round(live: Frame[]): Promise<WatchEvent | null> {
      const event = await look(live).catch((error) => {
        // A round that timed out (its machine slow for a moment) is looked at again next round, as `wait` does.
        if (error instanceof AgentClientError && error.code === 'TIMEOUT') return null
        throw error
      })
      if (!event) return null
      const turn = event !== 'started' && event !== 'idle' ? await turnNow() : null
      const key = `${event}\u0000${event === 'working' ? turn?.ask ?? '' : keyOf(turn)}`
      if (key !== printed) {
        printed = key
        say(event, turn)
      }
      return event
    },
  }
}

/**
 * Follows one harness by `wait`'s looks (the maker's state for a cloud harness; the daemon's activity, then the screen,
 * then two idle looks on one turn for one here) and prints each change once: what a program driving something from a
 * harness (lampOS's lamp, which moves and speaks as Devin works) polled `show` for and worked out itself. Read-only:
 * the same requests over the same local socket, so an older harnessd answers it as it answers `wait`.
 */
export function watchCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(WATCH_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--chars': 'value', '--timeout': 'value', '--json': 'flag', '--mine': 'flag' })
    const mine = flags.has('--mine')
    if (mine && names.length) throw new UsageError('--mine follows every harness you started: leave out the name.')
    if (mine && machine !== null) throw new UsageError('--mine follows every harness you started, on every machine: leave out --machine.')
    if (!mine && names.length !== 1) throw new UsageError(names.length ? 'Watch one harness.' : 'Name the harness to watch.')
    const chars = flags.has('--chars') ? Number(flags.get('--chars')) : DEFAULT_CHARS
    if (!Number.isInteger(chars) || chars < 1) throw new UsageError('--chars takes a whole number.')
    const timeoutMs = flags.has('--timeout') ? parseDuration(String(flags.get('--timeout'))) : 0
    const json = flags.has('--json')
    if (mine) return watchMine(s, json, chars, timeoutMs)
    const away = await machineOf(s, s.where(), machine)
    const o = await opened(s)
    let t: Target | null = null
    try {
      t = await target(s, o, names[0], away)
      const h = t
      const deadline = timeoutMs > 0 ? s.now() + timeoutMs : Infinity
      const push = pushedBy(s)
      const pushing = !h.remote && h.frame.location !== 'cloud' && await push.follow(o.daemon, [h.frame.id])
      const f = follower(s, o, h, (event, turn) => printWatch(s, json, chars, h, event, turn))
      for (;;) {
        const live = await listOrNull(h.daemon)
        const event = live && await f.round(live)
        if (event === 'stopped') return EXIT.stopped
        if (s.now() >= deadline) return EXIT.timeout
        await push.sleep(Math.min(pushing && live && f.pushedNext() ? PUSHED_BACKSTOP_MS : s.intervalMs, Math.max(0, deadline - s.now())))
      }
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

/**
 * `watch --mine`: one stream of `watch`'s lines for every harness the caller started that is running, on every machine,
 * as they change; what Hachi runs inside a turn while it waits on several at once (docs/design/2026-11-12-hachi.md).
 * Each machine is listed once a round. This machine's are followed by push, as `watch` follows one here; another
 * machine's are looked at every interval, as `watch --machine` looks at one there. A machine that cannot be reached is
 * said once and left out; the rest are followed. It ends once every one has stopped.
 */
async function watchMine(s: Setup, json: boolean, chars: number, timeoutMs: number): Promise<number> {
  const o = await opened(s)
  const lines: Daemon[] = []
  try {
    const caller = o.caller
    if (!caller) throw new AgentClientError('NOT_YOURS', 'harness watch --mine follows the harnesses an agent started: run it in that agent\'s pane.')
    const byMachine = new Map<string, string[]>()
    for (const row of o.ledger.childrenOf(caller)) {
      if (s.now() - row.at > STOPPED_WITHIN_MS) continue
      const ids = byMachine.get(row.child.machineId) ?? []
      if (!ids.includes(row.child.agentId)) byMachine.set(row.child.machineId, [...ids, row.child.agentId])
    }
    // Names for the other machines, asked only when there are any.
    const away = [...byMachine.keys()].some((id) => id !== o.where.machineId) ? await s.machines().catch((): NewMachine[] => []) : []
    const labelOf = (machineId: string): string => machineId === o.where.machineId ? o.machine : away.find((m) => m.machineId === machineId)?.label ?? machineId.slice(0, 8)
    const followers: Array<ReturnType<typeof follower>> = []
    for (const [machineId, ids] of byMachine) {
      const here = machineId === o.where.machineId
      let daemon: Daemon = o.daemon, live: Frame[] = o.frames
      if (!here) {
        try {
          lines.push(daemon = await s.open(o.where, machineId))
          live = await list(daemon, false)
        } catch (error) {
          if (!(error instanceof AgentClientError)) throw error
          s.err(`${labelOf(machineId)}: not followed. ${error.message}`)
          continue
        }
      }
      for (const frame of ids.map((id) => named(live).find((f) => f.id === id && f.status !== 'stopped')).filter((f): f is Frame & { name: string } => !!f)) {
        const t: Target = { daemon, frame, machineId, machine: labelOf(machineId), yours: true, remote: !here }
        followers.push(follower(s, o, t, (event, turn) => printWatch(s, json, chars, t, event, turn, t.machine)))
      }
    }
    if (!followers.length) {
      if (!json) s.out('You have no harnesses running.')
      return EXIT.ok
    }
    const push = pushedBy(s)
    const pushing = await push.follow(o.daemon, followers.filter((f) => !f.target.remote && f.target.frame.location !== 'cloud').map((f) => f.target.frame.id))
    const deadline = timeoutMs > 0 ? s.now() + timeoutMs : Infinity
    const active = new Set(followers)
    for (;;) {
      const listed = new Map<Daemon, Promise<Frame[] | null>>()
      /** A line to another machine that dropped, whatever it was asked (its list, a turn, a stopped row): its harnesses
       *  are no longer followed and the rest are, so one flaky relay line does not end Hachi's wait on every harness. */
      const dropped = (f: (typeof followers)[number], error: unknown): null => {
        const { daemon, remote, machine } = f.target
        if (!remote || !(error instanceof AgentClientError)) throw error
        if (![...active].some((one) => one.target.daemon === daemon)) return null
        s.err(`${machine}: no longer followed. ${error.message}`)
        for (const gone of active) if (gone.target.daemon === daemon) active.delete(gone)
        return null
      }
      for (const f of [...active]) {
        if (!active.has(f)) continue
        const { daemon } = f.target
        if (!listed.has(daemon)) listed.set(daemon, listOrNull(daemon).catch((error) => dropped(f, error)))
        const live = await listed.get(daemon)!
        if (live && await f.round(live).catch((error) => dropped(f, error)) === 'stopped') active.delete(f)
      }
      if (!active.size) return EXIT.stopped
      if (s.now() >= deadline) return EXIT.timeout
      // Quiet while every one left is here, followed by push, and its next change is pushed.
      const quiet = pushing && [...active].every((f) => !f.target.remote && f.target.frame.location !== 'cloud' && f.pushedNext())
      await push.sleep(Math.min(quiet ? PUSHED_BACKSTOP_MS : s.intervalMs, Math.max(0, deadline - s.now())))
    }
  } finally {
    for (const line of lines) line.close()
    o.daemon.close()
  }
}

/** The line `harness new` puts before an agent's task, saying who started it (`startHeader`): not the person's words. */
const START_HEADER = /^\[from [^\]\n]*, the (?:agent|harness) that started you\. It reads your answer itself\.\]\n\n/
const withoutStartHeader = (ask: string): string => ask.replace(START_HEADER, '')

/** One `watch` line: a JSON object with `--json`, else the time, the harness, the event and its words. */
function printWatch(s: Setup, json: boolean, chars: number, t: Target, event: WatchEvent,
  turn: { ask: string | null; answer: string; tools: number } | null, machine?: string): void {
  const text = turn?.answer ?? ''
  const words: Record<string, unknown> = event === 'working' ? { ask: turn?.ask ? withoutStartHeader(turn.ask) : null }
    : event === 'needs_person' ? { question: clip(text, chars), truncated: text.length > chars }
    : event === 'done' || event === 'failed' ? { summary: clip(text, chars), truncated: text.length > chars, tools: turn?.tools ?? 0 }
    // Stopped after a turn (Devin put to sleep once it finished, #1449): its answer is still the one to read.
    : event === 'stopped' && text ? { summary: clip(text, chars), truncated: text.length > chars }
    : {}
  const cloud = cloudMeta(t.frame)
  const at = new Date(s.now()).toISOString()
  const line = {
    event, at, name: t.frame.name ?? t.frame.id.slice(0, 8), id: t.frame.id, ...(machine ? { machine } : {}), agent: engineName(t.frame.engine ?? ''),
    state: t.frame.location === 'cloud' && event !== 'stopped' ? stateOf(t.frame) : EVENT_STATES[event], ...words,
    ...(cloud ? { cloud } : {}), ...(t.frame.cloud?.links?.length ? { links: t.frame.cloud.links } : {}),
  }
  if (json) { s.out(JSON.stringify(line)); return }
  const said = typeof words.question === 'string' ? words.question : typeof words.summary === 'string' ? words.summary
    : typeof words.ask === 'string' ? `asked: ${clip(words.ask, 200)}` : ''
  s.out(`${at.slice(11, 19)}Z ${line.name}${machine ? ` @${machine}` : ''}: ${event.replace('_', ' ')}${said ? `: ${said}` : ''}`)
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

// ── delete ─────────────────────────────────────────────────────────────────────────────────────────

/** What an engine's own store kept, and why: the person deletes it with that engine. */
type Kept = { what: string; reason: string }

/** The deletion Harness already has (`agent_purge`, lib/purgeAgentService.ts), reviewed and then done, from a
 *  terminal: the conversation and everything Harness kept of it, never the folder. This machine's daemon only: the
 *  purge answers its owner alone. */
export function deleteCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(DELETE_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (names.length !== 1) throw new UsageError(names.length ? 'Delete one harness at a time.' : 'Name the harness to delete.')
    if (machine !== null) throw new UsageError('harness delete works on this computer only.')
    // Stopped ones too: a closed harness's conversation is still there to delete.
    const o = await opened(s, true)
    let t: Target | null = null
    try {
      t = await target(s, o, names[0])
      const name = t.frame.name ?? t.frame.id.slice(0, 8)
      if (t.frame.location === 'cloud') throw new UsageError(`${name} runs in its maker's cloud: delete it there.`)
      // An agent's harness on another machine is found by its record: its purge is that machine's owner's to ask.
      if (t.remote) throw new UsageError(`${name} runs on another machine: harness delete works on this computer only.`)
      if (o.orphan) throw new AgentClientError('NOT_YOURS', ORPHAN, 'ORPHAN')
      if (o.caller && o.caller.agentId === t.frame.id && t.machineId === o.where.machineId) {
        throw new AgentClientError('NOT_YOURS', 'That is your own harness. The person deletes it.')
      }
      if (o.caller && !t.yours) throw new AgentClientError('NOT_YOURS', `You did not start ${name}, so you may not delete it. Only the person can.`)
      // A harness with no conversation yet lists '' and purge reads it as none (null): '' was "changed" for good.
      const which = { agentId: t.frame.id, sessionId: t.frame.sessionId || null, createdAt: Date.parse(t.frame.createdAt ?? '') }
      const failed = (reply: Record<string, unknown>) => {
        if (reply.error) throw new AgentClientError(String(reply.error), typeof reply.detail === 'string' && reply.detail ? reply.detail : `Could not delete ${name}.`)
      }
      const review = await t.daemon.request('agent_purge', { ...which, mode: 'inspect' }, 60_000)
      failed(review)
      const reply = await t.daemon.request('agent_purge', {
        ...which, mode: 'delete', reviewId: review.reviewId, choices: { sessionData: true, worktreeData: false },
      }, 120_000)
      failed(reply)
      const kept = Array.isArray(reply.kept) ? reply.kept as Kept[] : []
      if (flags.has('--json')) s.out(JSON.stringify({ name, id: t.frame.id, deleted: true, kept }))
      else {
        s.out(kept.length ? `${name} on ${t.machine}: deleted. Everything Harness kept of it is erased.`
          : `${name} on ${t.machine}: deleted. Its conversation and everything Harness kept of it are erased.`)
        for (const k of kept) s.out(k.reason)
      }
      return EXIT.ok
    } finally { if (t?.remote) t.daemon.close(); o.daemon.close() }
  })
}

// ── goal ───────────────────────────────────────────────────────────────────────────────────────────

export const GOAL_USAGE = `Usage: harness goal open <title…> [--json]
       harness goal done <id> [--json]
       harness goal list [--json]

Hachi's goals. open names one in the person's own words (at most 80 characters) and says its id: start each harness
for it with harness new --goal <id>. done closes it once its harnesses are done, which tells the person; it is refused
for a goal no harness was started for. list shows the open ones and those closed this week.
Only Hachi keeps goals: any other caller exits 5.`

/** A goal as the goals service answers it (services/goals.ts `Goal`). */
interface GoalRow { id: string; title: string; harnesses: unknown[]; openedAt: number; lastStartAt: number | null; doneAt: number | null }

/** One of Hachi's goal requests to the daemon of the caller's pane, which reads who asks from that pane, never from
 *  what is sent: a refusal is thrown with the service's own words. */
async function askGoals(s: Setup, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const daemon = await s.open(s.where())
  try {
    const reply = await daemon.request(type, { ...payload, pane: s.pane ?? '' })
    if (typeof reply.error === 'string') {
      throw new AgentClientError(reply.error, typeof reply.message === 'string' && reply.message ? reply.message : `Harness did not keep the goal (${reply.error}).`)
    }
    return reply
  } finally { daemon.close() }
}

/** `harness goal`: Hachi opens, closes and lists its goals (docs/design/2026-11-12-hachi.md, "Goals"). */
export function goalCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(GOAL_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (machine !== null) throw new UsageError('harness goal takes no --machine: Hachi keeps its goals where it runs.')
    const [verb, ...rest] = names
    const json = flags.has('--json')
    if (verb === 'open') {
      const title = rest.join(' ').trim()
      if (!title) throw new UsageError('Give the goal in the person\'s words: harness goal open <title>')
      const goal = (await askGoals(s, 'goal_open', { title })).goal as GoalRow
      const next: NextStep[] = [{ run: `harness new <agent> --goal ${goal.id} --name <name> <project> -- <task>`, when: 'for each piece of its work' }]
      s.out(json ? JSON.stringify({ goal, next }) : `Goal ${goal.id} opened: ${goal.title}.\n${formatNext(next)}`)
      return EXIT.ok
    }
    if (verb === 'done') {
      if (rest.length !== 1) throw new UsageError('Name one goal by its id.')
      const goal = (await askGoals(s, 'goal_done', { id: rest[0] })).goal as GoalRow
      s.out(json ? JSON.stringify({ goal }) : `Goal ${goal.id} done: ${goal.title}.`)
      return EXIT.ok
    }
    if (verb === 'list') {
      if (rest.length) throw new UsageError('harness goal list takes nothing more.')
      const goals = (await askGoals(s, 'goal_list', {})).goals as GoalRow[]
      const count = (n: number) => `${n} harness${n === 1 ? '' : 'es'}`
      const width = Math.max(0, ...goals.map((g) => count(g.harnesses.length).length))
      s.out(json ? JSON.stringify({ goals }) : goals.length
        ? goals.map((g) => `${g.id}  ${g.doneAt === null ? 'open' : 'done'}  ${count(g.harnesses.length).padEnd(width)}  ${g.title}`).join('\n')
        : 'No goals.')
      return EXIT.ok
    }
    throw new UsageError(verb ? `Unknown goal command ${verb}.` : '')
  })
}

// ── new, run by an agent ───────────────────────────────────────────────────────────────────────────

/**
 * Limits on starting harnesses (the design's "Limits"): runaway spawning is the risk, and every harness started is
 * the person's tokens. One level down (owner, October 12: "be very careful about when to start a new agent so we don't
 * waste user token"): a harness another agent started does its work itself. That, the forty a computer and the starts
 * in ten minutes are what stop a runaway. Eight at once for one agent (owner, November 11, of the four set a month
 * before: "that was too long. let's update it"): with four, one agent could not hand a night's packages to a builder
 * each. It was four from October 12, and eight before.
 */
export const SPAWN_LIMITS = { livePerHarness: 8, livePerMachine: 40, depth: 1, perWindow: 20, windowMs: 10 * 60_000 } as const

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

/**
 * Whether the person lets [caller] start harnesses (`agents-start-agents`), or tell the ones it started
 * (`agents-tell-agents`), as this machine keeps the account's experiments. The Hachi harness may while the account has
 * Hachi on: turning Hachi on is the person's yes to Hachi doing so, and to no other agent
 * (docs/design/2026-11-12-hachi.md, "Starting others needs the person's yes"). Every limit still holds.
 */
const startsOn = (dataDir: string, caller: Caller): boolean => {
  const settings = readAgentSettings(dataDir)
  return settings.agentsStartAgents || (!!caller.hachi && settings.hachi)
}
const tellsOn = (dataDir: string, caller: Caller): boolean => {
  const settings = readAgentSettings(dataDir)
  return settings.agentsTellAgents || (!!caller.hachi && settings.hachi)
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
  if (!startsOn(o.where.dataDir, caller)) return refusing('TURNED_OFF', AGENTS_START_AGENTS_OFF, 'SWITCH_OFF')
  const by = { machineId: caller.machineId, agentId: caller.agentId, name: caller.name, engine: caller.engine, ...(caller.hachi ? { hachi: true as const } : {}) }
  return {
    ...(caller.hachi ? { hachi: true as const } : {}),
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
    // Both records follow the create: a failure to keep one is said, never a refusal, whose "try again" would start
    // a second harness.
    pending: (machineId, creation) => {
      try {
        o.ledger.append({ at: s.now(), by, creation: { machineId, ...creation }, depth: o.ledger.depthOf(caller) + 1 })
        return null
      } catch {
        return `Harness could not record that you asked for ${creation.name || 'the harness'}: it may still start. Do not start it again.`
      }
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
        by,
        child: { machineId, agentId: id, name, ...(creationId ? { creationId } : {}) },
        depth: o.ledger.depthOf(caller) + 1,
      }
      try { o.ledger.record(row) } catch {
        return `${name || 'The harness'} is starting, but Harness could not record that you started it. Do not start it again.`
      }
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
    goal: {
      // Asked of the goals service, which answers Hachi alone: anyone else's check is refused there (NOT_HACHI).
      check: async (id) => {
        const goal = ((await askGoals(s, 'goal_list', {})).goals as GoalRow[]).find((g) => g.id === id)
        if (!goal) throw new AgentClientError('UNKNOWN_GOAL', `No goal ${id}. harness goal list lists them.`)
        if (goal.doneAt !== null) throw new AgentClientError('GOAL_DONE', `Goal ${id} is done. Open a new one for new work.`)
      },
      add: async (id, harness) => {
        try { await askGoals(s, 'goal_add', { id, ...harness }); return null } catch (error) {
          return `It was started, but not recorded under goal ${id}: ${(error as Error).message}`
        }
      },
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
