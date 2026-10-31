import { inspectCapacity, startAgent } from './start.js'
import { object } from './host.js'
import { routeTask } from './routeCommand.js'
import { planWork } from './planCommand.js'
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, outsideCaller, type Frame } from '../agentClient/model.js'
import { identifier } from './host.js'
import { resolve } from 'node:path'
import { readInsideFolder, uploadAttachments, type UploadTarget } from './attach.js'
import { keyName } from './terminal.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isatty } from 'node:tty'
import { inDaemonPane, NOT_IN_PANE, runningPane, type PaneProbe } from './callerPane.js'
// cli.ts's way to it: this file is its door to the Swarm's code (architecture.spec.ts SWARM_DOORS).
export { buddyRefusal } from './buddyPane.js'
import { agentShell, buddiesHere, paneBuddy, WINDOWS_BUDDY } from './buddyPane.js'
import { sendPane } from '../messages/command.js'

/** A frame with its terminals, as agents_list sends them: a pty host pane is named by its instance and pane (Windows). */
type PaneFrame = Frame & { terminal?: { runtimes?: Array<{ backend?: string; instance?: string; paneId?: string }> } }
/** Whether [pane] is a harness's here: a tmux pane as `callerOf` finds it, or a pty host's `<instance>:%N`. */
function harnessIn(frames: PaneFrame[], pane: string, machineId: string): boolean {
  const pty = /^([^:]+):(%\d+)$/.exec(pane)
  if (!pty) return !!callerOf(frames, pane, machineId)
  return frames.some(frame => frame.terminal?.runtimes?.some(r => r.backend === 'ptyhost' && r.instance === pty[1] && r.paneId === pty[2]))
}

const ELSEWHERE = 'From a harness, Swarm commands go to this computer\'s own Harness only: leave out --machine and --port, or give this computer\'s own.'

const USAGE = 'harness super-tab --tab ID [--agent ID] [--port N --machine ID] status [--archived [PAGE]] | messages GROUP [--thread ROOT] [--before SEQUENCE MESSAGE_ID] | message GROUP MESSAGE_ID | decisions [--answered] | costs [--days N] | post GROUP TEXT|- OPERATION_ID [--to AGENT]... [--reply-to MESSAGE_ID] [--attach PATH]... [--mention PERSON]... | react GROUP MESSAGE_ID EMOJI OPERATION_ID [--off] | command OPERATION_ID JSON | propose OPERATION_ID JSON [--attach PATH]... | start OPERATION_ID JSON | resume START_ID | capacity MACHINE_ID JSON | route GROUP JSON | plan [JSON] | remove-machine MACHINE_ID [--yes] | set-agents MACHINE_ID COUNT | instructions [PROJECT] | screen AGENT [--scrollback N] | type AGENT [TEXT] [--key K]... | help'
/** A Buddy's guard refuses a post or a proposal read from stdin (#2358): there its words would skip the secret check. A Buddy
 *  that followed the stdin form here was refused and tried again (#2360 took it out of a Buddy's help), so a Buddy's usage
 *  line and JSON hints never offer it. */
const BUDDY_USAGE = USAGE.replace('post GROUP TEXT|- OPERATION_ID', 'post GROUP TEXT OPERATION_ID')
/** The actions that take an id and then one JSON argument, and what that id names. */
const JSON_ACTIONS: Readonly<Record<string, string>> = { command: 'OPERATION_ID', propose: 'OPERATION_ID', start: 'OPERATION_ID', capacity: 'MACHINE_ID', route: 'GROUP' }
const JSON_STDIN = (action: string) => `${action} ${JSON_ACTIONS[action]} - <<'JSON' (the JSON on the next lines, then JSON alone on a line)`
const stdinHint = (action: string, buddy: boolean) => buddy
  ? `with the JSON in single quotes: ${action} ${JSON_ACTIONS[action]} '{...}' (an apostrophe inside it as \\u0027)`
  : `or send the JSON on stdin with - in its place: ${JSON_STDIN(action)}`

/** A refusal worded for any caller, and for a Buddy (BUDDY_USAGE): which one it is is asked only once the command is refused. */
class UsageError extends Error {
  constructor(readonly words: (buddy: boolean) => string) { super(words(false)) }
}
const usageError = () => new UsageError(buddy => buddy ? BUDDY_USAGE : USAGE)

/** The JSON argument, or why it is not one.
 *
 *  Codex Builders on Mac Auto (Swarm groups #13 and #16, 2026-10-29/30) got only the usage line back for a work.status
 *  done: one left out the operation id, one quoted its JSON in single quotes around a result that held `'%h %s'`, so
 *  the shell split it into several arguments. Neither could tell what to fix, and the finished task stayed open. */
function jsonArgument(action: string, text: string): unknown {
  try { return JSON.parse(text) } catch (error) {
    throw new UsageError(buddy => `The ${action} JSON is not valid (${(error as Error).message}). Pass it as one argument, ${stdinHint(action, buddy)}.`)
  }
}
/** Why [positional] is not `ACTION ID JSON`, in words an agent can act on; null to leave it to the usage line. */
function jsonShapeError(positional: readonly string[], buddy: boolean): string | null {
  const [action, first = ''] = positional
  const id = JSON_ACTIONS[action]
  if (!id) return null
  const hint = stdinHint(action, buddy)
  // Nothing after the action: the id and JSON went on the next lines, which the shell ran as commands of their own.
  if (positional.length === 1) return `${action} needs ${id} and the JSON on the same command line: ${action} ${id} JSON. A line break without \\ before it ends the command; ${buddy ? 'send it again ' : ''}${hint}.`
  if (!identifier(first)) {
    return (first as string).trim().startsWith('{')
      ? `${action} needs ${id} before the JSON: ${action} ${id} JSON. ${id === 'OPERATION_ID' ? 'Use a new unique id of letters, digits, - or _ (reuse it only to repeat an interrupted request).' : ''}`.trim()
      : `${action} needs ${id} first, as letters, digits, - or _ only: ${action} ${id} JSON.`
  }
  if (positional.length < 3 || !positional[2]) return `${action} needs its JSON after ${id}: ${action} ${first} JSON, ${hint}.`
  if (action !== 'propose' && positional.length > 3) {
    return `${action} takes ${id} and the JSON as one argument, but got ${positional.length - 2} arguments after ${id}: a quote inside the JSON ended the shell's quoting. Quote it so it stays one argument, ${hint}.`
  }
  return null
}

/** A message on stdin, for post's TEXT `-`.
 *
 *  `post GROUP - OPERATION_ID` posted a literal dash: three Reviewer verdicts on 2026-10-30, #2345's findings among them,
 *  arrived as "-". So `-` reads the message from stdin, once, before anything is sent, and an empty or a terminal stdin is
 *  refused: nothing is posted, and nothing waits on a terminal for input that never comes. */
const POST_STDIN = "post GROUP - OPERATION_ID <<'MSG' (the message on the next lines, then MSG alone on a line)"
function postStdin(stdin: (what: string) => string, terminal: () => boolean): string {
  if (terminal()) throw new Error(`post - reads the message from stdin, but stdin is a terminal, so nothing was posted. Send the message on stdin: ${POST_STDIN}, or pass it as TEXT.`)
  // A heredoc ends the message with one line break, which is not part of it.
  const text = stdin('post').replace(/\r?\n$/, '')
  if (!text.trim()) throw new Error(`post - read no message from stdin, so nothing was posted. Send the message on stdin: ${POST_STDIN}. A message that is only - goes on stdin too.`)
  return text
}
/** A JSON action's JSON on stdin, for its `-`; a terminal is refused as post's is, worded for a Buddy too (stdinHint). */
function jsonStdin(action: string, stdin: (what: string) => string, terminal: () => boolean): string {
  if (terminal()) throw new UsageError(buddy => `${action} - reads the JSON from stdin, but stdin is a terminal, so nothing was sent. Pass it as one argument, ${stdinHint(action, buddy)}.`)
  return stdin(action)
}
/** How long `-` waits on stdin while nothing arrives. #2355's review: `post GROUP - OPERATION_ID` from a pipe its writer left
 *  open (a tool that never closes it) read with no limit and waited for good. A heredoc or a pipe closes stdin at its end;
 *  every chunk starts the wait again, so a slow writer that keeps sending is never cut off. */
const STDIN_IDLE_MS = 30_000
export class StdinIdle extends Error {
  constructor() { super(`Nothing more came on stdin for ${STDIN_IDLE_MS / 1000} s, and it was never closed.`) }
}
/** All of [stream], until it ends; StdinIdle once nothing has come for [idleMs], and the stream is let go, so the command can
 *  exit while its writer still holds the pipe open. */
export function readStdin(stream: NodeJS.ReadableStream & { destroy(): void }, idleMs = STDIN_IDLE_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '', timer: ReturnType<typeof setTimeout> | undefined
    const wait = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { stream.destroy(); reject(new StdinIdle()) }, idleMs)
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { text += chunk; wait() })
    stream.once('end', () => { clearTimeout(timer); resolve(text) })
    stream.once('error', error => { clearTimeout(timer); reject(error) })
    wait()
  })
}
/** Why `-` read nothing usable from a stdin left open, and how to end it. */
function idleRefusal(what: string): string {
  const waited = `${what} - read stdin until nothing more came for ${STDIN_IDLE_MS / 1000} s, but stdin was never closed`
  return what === 'post'
    ? `${waited}, so nothing was posted. Close stdin after the message, as a heredoc does: ${POST_STDIN}, or pass it as TEXT.`
    : `${waited}, so nothing was sent. Close stdin after the JSON, as a heredoc does: ${JSON_STDIN(what)}, or pass it as one argument.`
}
/** Stands in for stdin while the arguments are parsed the first time: stdin is read only for a command that wants it. */
class WantsStdin { constructor(readonly what: string) {} }

/** Whether the harness in this pane is a Buddy, by this computer's launch record (service.ts `buddyCheck`, what turns its
 *  guard on), for a refusal's wording alone. Asked of this computer's daemon, never one named with --machine. Anything it
 *  cannot tell is no Buddy: the guard still refuses what a Buddy may not send. */
async function buddyHere(open: typeof openDaemon, local: Where, pane: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  // Windows has no cheap check of a pty host pane (buddyPane.ts): an agent's shell on a computer that runs a Buddy.
  if (platform !== 'win32' && !pane) return false
  try {
    const daemon = await open(local)
    try {
      if (platform === 'win32') return agentShell(env) && await buddiesHere(daemon) === true
      // The guard's own steps (buddyPane.ts paneBuddy), without its pane check: a wording, not a refusal.
      return await paneBuddy(daemon, pane!, local.machineId) === 'buddy'
    } finally { daemon.close() }
  } catch { return false }
}

/** The files one proposal may carry (backend buddies.ts MAX_PROPOSAL_ATTACHMENTS). */
const MAX_PROPOSAL_FILES = 5
/** [stdin] is asked for what `-` stands for: `post`'s message, or the JSON of the action it names. */
export function parseSuperTabArgs(argv: readonly string[], where: Where, stdin: (what: string) => string = () => readFileSync(0, 'utf8'),
  terminal: () => boolean = () => isatty(0)) {
  const positional: string[] = []
  let tabId = '', agentId = ''
  const target = { ...where }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--tab') tabId = argv[++i] ?? ''
    else if (flag === '--agent') agentId = argv[++i] ?? ''
    else if (flag === '--port') target.port = Number(argv[++i])
    else if (flag === '--machine') target.machineId = argv[++i] ?? ''
    else { positional.push(...argv.slice(i)); break }
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !identifier(target.machineId)) throw usageError()
  // `-` in the JSON's place reads it from stdin, where no shell quoting can split it. A terminal is refused at once, as post's
  // is: read, it waited 30 s for input that never comes and then said stdin was never closed (review of #2379).
  if (JSON_ACTIONS[positional[0]] && positional[2] === '-') positional[2] = jsonStdin(positional[0], stdin, terminal)
  const [action, first, second, third] = positional
  if (action !== 'help' && (!identifier(tabId) || (agentId && !identifier(agentId)))) throw usageError()
  const payload: Record<string, unknown> = { action, tabId, agentId }
  if (action === 'messages' && identifier(first) && positional.length === 2) payload.conversationId = first
  // Older messages, a page before the cursor the last page named: its sequence and message id together, as messages may
  // share a sequence and a sequence alone skipped them (security review 2 of #2115). A Buddy reads a task's history this way.
  else if (action === 'messages' && identifier(first) && positional.length === 5 && second === '--before' && /^(0|[1-9][0-9]{0,15})$/.test(third ?? '')
    && Number.isSafeInteger(Number(third)) && identifier(positional[4])) {
    Object.assign(payload, { conversationId: first, before: Number(third), beforeId: positional[4] })
  }
  // One thread, its root and replies (a Buddy's thread session reads its own this way, with the main-chat messages it started
  // from), paged as the conversation is.
  else if (action === 'messages' && identifier(first) && second === '--thread' && identifier(third) && (positional.length === 4
    || (positional.length === 7 && positional[4] === '--before' && /^(0|[1-9][0-9]{0,15})$/.test(positional[5] ?? '')
      && Number.isSafeInteger(Number(positional[5])) && identifier(positional[6])))) {
    Object.assign(payload, { conversationId: first, thread: third,
      ...(positional.length === 7 ? { before: Number(positional[5]), beforeId: positional[6] } : {}) })
  }
  // A Buddy's archived tasks, a page at a time from the page the last one named (cli/src/superTabs/buddyStatus.ts).
  else if (action === 'status' && first === '--archived' && (positional.length === 2 || positional.length === 3 && /^[A-Za-z0-9_-]{1,512}$/.test(second ?? ''))) {
    Object.assign(payload, { archived: true, ...(second ? { before: second } : {}) })
  }
  else if (action === 'decisions' && (positional.length === 1 || (positional.length === 2 && first === '--answered'))) payload.state = first ? 'answered' : 'open'
  else if (action === 'instructions' && (positional.length === 1 || positional.length === 2 && identifier(first))) {
    if (first) payload.projectId = first
  }
  else if (action === 'costs' && (positional.length === 1 || (positional.length === 3 && first === '--days' && /^[1-9][0-9]?$/.test(second ?? '') && Number(second) <= 90))) {
    payload.days = positional.length === 3 ? Number(second) : 7
  }
  else if (action === 'message' && identifier(first) && identifier(second) && positional.length === 3) {
    Object.assign(payload, { conversationId: first, messageId: second })
  }
  else if (action === 'post' && identifier(first) && typeof second === 'string' && identifier(third)) {
    let replyTo: string | null = null
    const attach: string[] = [], mentions: string[] = [], to: string[] = []
    for (let i = 4; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--reply-to' && identifier(value) && replyTo === null) replyTo = value
      // The agents it reaches, any agent of this project; with none, an agent's post reaches the PM (project instructions).
      else if (flag === '--to' && identifier(value) && (to.includes(value) || to.length < 16)) { if (!to.includes(value)) to.push(value) }
      else if (flag === '--attach' && value && attach.length < 10) attach.push(resolve(value))
      // A person's id or email, as written; the service maps it to the person (spec 2026-10-24-lead-mentions).
      else if (flag === '--mention' && value?.trim()) mentions.push(value.trim())
      else throw usageError()
    }
    // TEXT `-` is the message on stdin; any other TEXT is the message itself, and stdin is never read.
    const text = second === '-' ? postStdin(stdin, terminal) : second
    // A screenshot or a log may go without words.
    if (!text.trim() && !attach.length) throw usageError()
    Object.assign(payload, { action: 'command', operationId: third, ...(attach.length ? { attach } : {}),
      command: { type: 'message.send', conversationId: first, text, replyTo, recipientIds: to, ...(mentions.length ? { mentions } : {}) } })
  } else if (action === 'react' && identifier(first) && identifier(second) && identifier(third) && identifier(positional[4])
    && (positional.length === 5 || positional.length === 6 && positional[5] === '--off')) {
    // An acknowledgement without a post, as Slack bots do (swarm skills): the backend checks the emoji and who may react.
    Object.assign(payload, { action: 'command', operationId: positional[4],
      command: { type: 'message.react', conversationId: first, messageId: second, emoji: third, on: positional.length === 5 } })
  } else if (action === 'command' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, command: jsonArgument(action, second) })
  } else if (action === 'propose' && identifier(first) && second) {
    const attach: string[] = []
    for (let i = 3; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--attach' && value) attach.push(resolve(value))
      else throw usageError()
    }
    if (attach.length > MAX_PROPOSAL_FILES) throw new Error(`Attach at most ${MAX_PROPOSAL_FILES} files to a proposal.`)
    // A Buddy's proposal for its owner (backend buddies.ts): only ever that command, whatever the JSON says it is.
    Object.assign(payload, { action: 'command', operationId: first, ...(attach.length ? { attach } : {}),
      command: { ...object(jsonArgument(action, second)), type: 'buddy.propose' } })
  } else if (action === 'start' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, request: jsonArgument(action, second) })
  } else if (action === 'resume' && identifier(first) && positional.length === 2) payload.startId = first
  else if (action === 'capacity' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { targetMachineId: first, request: jsonArgument(action, second) })
  } else if (action === 'remove-machine' && identifier(first) && (positional.length === 2 || positional.length === 3 && second === '--yes')) {
    // The machine's owner, as the person: without --yes, what removal would do (the agents it stops, a refusal); with it,
    // the removal. The daemon's owner-only backend request carries both.
    Object.assign(payload, second === '--yes'
      ? { action: 'backend', method: 'POST', path: `/api/super-tabs/${tabId}/commands`,
        body: { operationId: `machine-remove-${randomUUID()}`, command: { type: 'machine.remove', machineId: first } } }
      : { action: 'backend', method: 'GET', path: `/api/super-tabs/${tabId}/machines/${first}/removal` })
  } else if (action === 'set-agents' && identifier(first) && /^[1-9][0-9]{0,3}$/.test(second ?? '') && positional.length === 3) {
    // The machine's owner, as the person: how many Swarm agents may run on it at once (contribution.ts setMachineAgents).
    Object.assign(payload, { action: 'setMachineAgents', machineId: first, maxAgents: Number(second) })
  } else if (action === 'route' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { conversationId: first, assessment: jsonArgument(action, second) })
  } else if (action === 'plan' && positional.length <= 2) {
    if (first !== undefined) payload.request = JSON.parse(first)
  } else if (action === 'screen' && identifier(first) && (positional.length === 2
    || positional.length === 4 && second === '--scrollback' && /^[1-9]\d*$/.test(third ?? '') && Number(third) <= 200)) {
    // The id names this one read; a read sent twice is only read twice.
    Object.assign(payload, { operationId: `terminal-${randomUUID()}`,
      command: { type: 'agent.screen', agentId: first, ...(positional.length === 4 ? { scrollback: Number(third) } : {}) } })
  } else if (action === 'type' && identifier(first)) {
    let text: string | undefined
    const keys: string[] = []
    for (let i = 2; i < positional.length; i++) {
      if (positional[i] === '--key') {
        const key = keyName(positional[++i] ?? '')
        if (!key) throw usageError()
        keys.push(key)
      } else if (text === undefined && !keys.length) text = positional[i]
      else throw usageError()
    }
    if (!text && !keys.length) throw usageError()
    Object.assign(payload, { operationId: `terminal-${randomUUID()}`,
      command: { type: 'agent.input', agentId: first, ...(text ? { text } : {}), ...(keys.length ? { keys } : {}) } })
  } else if (!['status', 'help'].includes(action) || positional.length !== 1) {
    throw new UsageError(buddy => jsonShapeError(positional, buddy) ?? (buddy ? BUDDY_USAGE : USAGE))
  }
  return { where: target, payload }
}

/** The arguments, with stdin read for `-` only when they want it, and then at most until it idles (readStdin). */
async function parse(argv: readonly string[], local: Where, stdin: () => string | Promise<string>, terminal?: () => boolean) {
  try {
    return parseSuperTabArgs(argv, local, what => { throw new WantsStdin(what) }, terminal)
  } catch (error) {
    if (!(error instanceof WantsStdin)) throw error
    const text = await Promise.resolve().then(stdin).catch(failure => {
      throw failure instanceof StdinIdle ? new Error(idleRefusal(error.what)) : failure
    })
    return parseSuperTabArgs(argv, local, () => text, terminal)
  }
}

export async function superTabCommand(argv: readonly string[], deps: {
  where?: () => Where; open?: typeof openDaemon; print?: (text: string) => void; pane?: string; probe?: PaneProbe; fetch?: typeof fetch; env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform; stdin?: () => string | Promise<string>; terminal?: () => boolean
} = {}): Promise<number> {
  let daemon: Daemon | null = null
  let operationId: unknown
  const print = deps.print ?? console.log
  try {
    const platform = deps.platform ?? process.platform, env = deps.env ?? process.env, open = deps.open ?? openDaemon
    // The pane this runs in, from its processes: TMUX_PANE is what the command says, and it may not name another harness's.
    const running = 'pane' in deps ? { pane: deps.pane } : runningPane(env, deps.probe, platform)
    if (running.refused) throw new Error(running.refused)
    const pane = running.pane
    const local = (deps.where ?? (() => whereFor(pane)))()
    const request = await parse(argv, local, deps.stdin ?? (() => readStdin(process.stdin)), deps.terminal)
      .catch(async error => {
        if (error instanceof UsageError && await buddyHere(open, local, pane, env, platform)) throw new Error(error.words(true))
        throw error
      })
    operationId = request.payload.operationId
    // A harness reaches the Swarm through this computer's Harness alone (second review of #2087: a Buddy's --machine reached
    // the owner's other Mac, which knew no pane there). The daemon refuses an agent's request from another computer as well.
    const elsewhere = request.where.port !== local.port || request.where.machineId !== local.machineId
    // Windows has no cheap check of a pty host pane, so its pane is the one the shell names, for the refusal below alone; and
    // while this computer runs a Buddy, an agent's shell there names no agent. Both are asked of this computer's daemon,
    // never the other machine's (re-check of #2093: --machine asked the other one, which does not answer for this computer).
    const asking = pane ?? (platform === 'win32' ? sendPane(env) : undefined)
    const windowsAgent = platform === 'win32' && !!request.payload.agentId && agentShell(env)
    const checks = async (home: Daemon) => {
      if (elsewhere && asking) {
        const listed = await home.request('agents_list')
        if (harnessIn(Array.isArray(listed.agents) ? listed.agents as PaneFrame[] : [], asking, local.machineId)) throw new Error(ELSEWHERE)
      }
      if (windowsAgent && await buddiesHere(home)) throw new Error(WINDOWS_BUDDY)
    }
    if (elsewhere && (asking || windowsAgent)) {
      const home = await open(local)
      try { await checks(home) } finally { home.close() }
    }
    daemon = await open(request.where)
    if (!elsewhere) await checks(daemon)
    const owners = request.payload.action === 'backend' || request.payload.action === 'setMachineAgents'
    if (owners) {
      // The owner's own acts: removal deletes this machine's Swarm folders, and no agent raises its own machine's room
      // (Lead, 2026-10-28). So neither a Swarm agent on it (its pane, or --agent) nor an outside agent's shell may run
      // them with the owner's authority.
      const listed = request.payload.agentId || outsideCaller(env, request.where.machineId) ? null : await daemon.request('agents_list')
      if (!listed || callerOf(Array.isArray(listed.agents) ? listed.agents as Frame[] : [], pane, request.where.machineId)) {
        throw new Error(request.payload.action === 'backend' ? 'Remove a machine from your own terminal or from Desktop, not from an agent.'
          : 'Set a machine\'s agents from your own terminal or from Desktop, not from an agent.')
      }
    }
    // Help names the caller when it can, as every request from a harness does; every agent reads the same help (project
    // instructions, phase 4), and outside a harness it is that help too.
    const help = request.payload.action === 'help'
    // A harness's pane speaks as its own agent alone: with --agent too, its harness goes with the request, and the daemon
    // refuses an agent that is not that harness's (security review of #2087: a Buddy named its Builder). A person's terminal
    // is no harness, and its --agent is the person's as before.
    if (!owners && (!request.payload.agentId || pane) && (!help || request.payload.tabId)) {
      const listed = await daemon.request('agents_list')
      const frames = Array.isArray(listed.agents) ? listed.agents as Frame[] : []
      const caller = callerOf(frames, pane, request.where.machineId)
      if (caller && !await inDaemonPane(daemon, caller.agentId, running.ancestors)) throw new Error(NOT_IN_PANE)
      if (caller) request.payload.harnessId = caller.agentId
      else if (!help && !request.payload.agentId) throw new Error('Run this command inside the participating harness, or supply its --agent ID.')
    }
    const source = daemon
    const scoped = (payload: Record<string, unknown>) => source.request('super_tabs', {
      tabId: request.payload.tabId, agentId: request.payload.agentId, harnessId: request.payload.harnessId, ...payload,
    }, 30_000)
    let result: Record<string, unknown>
    if (['start', 'resume'].includes(String(request.payload.action))) {
      result = await startAgent(request.payload, scoped, request.where, deps.open)
    } else if (request.payload.action === 'capacity') {
      // Establish current Super Tab participation before inspecting a machine;
      // the native relay independently enforces that account's machine access.
      const known = await scoped({ action: 'status' })
      if (known.error) result = known
      else {
        const target = await open(request.where, String(request.payload.targetMachineId))
        try { result = { ok: true, ...await inspectCapacity(target, object(request.payload.request)) } }
        finally { target.close() }
      }
    } else if (request.payload.action === 'screen' || request.payload.action === 'type') {
      const answer = await terminalRequest(request.payload, scoped)
      const value = object(answer.value)
      // The screen is printed as it is, for the Lead to read; anything else, and every failure, as JSON.
      if (request.payload.action === 'screen' && value.ok === true && typeof value.text === 'string') print(value.text)
      else print(JSON.stringify(answer.error ? answer : value))
      return value.ok === true ? 0 : 1
    } else if (request.payload.action === 'instructions') {
      // Printed as text for the agent to work by; every failure, as JSON.
      const answer = await scoped({ ...request.payload })
      const value = object(answer.value)
      if (answer.ok === true && typeof value.text === 'string') {
        // Each note with its id, which note.remove takes, and who asked by name where the status read has it (final review).
        const notes = Array.isArray(value.notes) ? value.notes.map(object) : []
        const coordinator = typeof value.coordinatorName === 'string' && value.coordinatorName ? value.coordinatorName : 'The coordinator'
        const when = (at: unknown) => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : String(at)
        print([`Instructions of project ${value.projectId}, revision ${value.revision}${value.template ? ' (the built-in template)' : ''}`, '', value.text,
          ...(notes.length ? ['', `${coordinator}'s notes:`, ...notes.map(n => `- ${n.text} (note ${n.id}, asked by ${n.askedByName ?? n.askedBy}, ${when(n.at)}`
            + `${n.expiresAt ? `, until ${when(n.expiresAt)}` : ''})`)] : [])].join('\n'))
        return 0
      }
      print(JSON.stringify(answer))
      return 1
    } else if (request.payload.action === 'route') {
      result = await routeTask({ tabId: String(request.payload.tabId), conversationId: String(request.payload.conversationId),
        assessment: request.payload.assessment }, scoped, request.where, deps.open)
    } else if (request.payload.action === 'plan') {
      // Advisory: the plan records nothing, and the solver runs here, on the Lead's machine.
      result = await planWork({ request: request.payload.request }, scoped, { dataDir: request.where.dataDir })
    } else {
      const { attach, ...payload } = request.payload
      // Each file goes to the daemon's local upload route, which streams it to the backend with the account's token;
      // this process holds no account credential.
      if (Array.isArray(attach)) {
        const command = object(payload.command)
        const target = { tabId: String(payload.tabId), conversationId: String(command.conversationId), port: request.where.port, dataDir: request.where.dataDir }
        command.attachmentIds = command.type === 'buddy.propose'
          ? await proposalFiles(attach as string[], String(payload.operationId), command, target, daemon, scoped, { ...deps, pane,
            local: request.where.machineId === local.machineId && request.where.port === local.port })
          : await uploadAttachments(attach as string[], String(payload.operationId), target, scoped, deps.fetch)
      }
      result = await daemon.request('super_tabs', payload, 30_000)
    }
    print(JSON.stringify({ ...result, ...(operationId ? { operationId } : {}) }))
    return result.error ? 1 : 0
  } catch (error) {
    print(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(operationId ? { operationId } : {}) }))
    return 1
  } finally { daemon?.close() }
}

/** A Buddy's proposal files (backend buddies.ts): those in its own folder, as its harness here records it, uploaded to its
 *  chat beside the files its owner sent there, which the proposal names by id. A repeat finds the proposal in the project
 *  chat and names the files it went with. */
async function proposalFiles(paths: string[], operationId: string, command: Record<string, unknown>, target: UploadTarget, daemon: Daemon,
  scoped: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>, deps: { pane?: string; fetch?: typeof fetch; local: boolean }): Promise<string[]> {
  // Its folder is on this machine: through another machine's daemon (--machine, --port) its pane would name someone else's.
  if (!deps.local) throw new Error('Attach files to a proposal from your Buddy\'s own terminal.')
  const named = Array.isArray(command.attachmentIds) ? command.attachmentIds.map(String) : []
  // Counted before any upload, so a refused proposal leaves no file behind.
  if (new Set(named).size + paths.length > MAX_PROPOSAL_FILES) throw new Error(`Attach at most ${MAX_PROPOSAL_FILES} files to a proposal.`)
  const listed = await daemon.request('agents_list')
  const frames = Array.isArray(listed.agents) ? listed.agents as Frame[] : []
  // The pane its parent processes prove (callerPane.ts), never TMUX_PANE as the command says it.
  const caller = callerOf(frames, deps.pane, String(daemon.machineId))
  const folder = frames.find(f => f.id === caller?.agentId)?.project?.cwd
  if (!folder) throw new Error('Attach files to a proposal from your Buddy\'s own terminal.')
  const files = readInsideFolder(paths, folder)
  const state = object(object((await scoped({ action: 'status' })).value).state)
  const projectId = (Array.isArray(state.conversations) ? state.conversations : []).map(object).find(c => c.id === target.conversationId)?.projectId
  const home = (Array.isArray(state.projects) ? state.projects : []).map(object).find(p => p.id === projectId)?.leadConversationId
  if (typeof home !== 'string') throw new Error('Name your own chat: a proposal comes from there.')
  const uploaded = await uploadAttachments(files, operationId, { ...target, sentIn: home }, scoped, deps.fetch)
  return [...new Set([...named, ...uploaded])]
}

/** How often a terminal result is read: the backend holds each read about 20 s, and the worker's machine has 10 s to pick a
 *  request up and 30 s to answer it, after which the backend answers with the reason. */
const TERMINAL_READS = 3
async function terminalRequest(payload: Record<string, unknown>, scoped: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const sent = await scoped({ action: 'command', operationId: payload.operationId, command: payload.command })
  if (sent.error) return sent
  const requestId = object(object(sent.value).result).requestId
  if (!identifier(requestId)) return { error: 'TERMINAL_UNAVAILABLE', detail: 'This Swarm\'s server does not relay terminals yet.' }
  for (let read = 0; read < TERMINAL_READS; read++) {
    // Not `requestId`: the daemon's transport numbers each request under that name (agentClient/daemon.ts).
    const answer = await scoped({ action: 'terminalResult', terminalRequestId: requestId })
    // A read the backend held to its limit while the worker's machine was still answering is read again.
    if (answer.error === 'BACKEND_TIMEOUT' || object(answer.value).pending === true) continue
    return answer
  }
  return { error: 'TERMINAL_PENDING', detail: 'The worker\'s machine has not answered yet. Try again in a moment.' }
}
