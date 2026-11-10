import { identifier, object } from './wire.js'
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, type Frame } from '../agentClient/model.js'
import { resolve } from 'node:path'
import { uploadAttachments } from './attach.js'
import { keyName } from './terminal.js'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isatty } from 'node:tty'
import { inDaemonPane, NOT_IN_PANE, runningPane, windowsRunningPane, type PaneProbe, type RunningPane } from './callerPane.js'
import type { ProcessRow } from '../lib/processTable.js'
// cli.ts's way to it: this file is its door to the Swarm's code (architecture.spec.ts SWARM_DOORS).
export { buddyRefusal } from './buddyPane.js'
import { paneBuddy } from './buddyPane.js'
import { sendPane } from '../messages/command.js'

type PaneFrame = Frame
/** Whether [pane] is a harness's here: a tmux pane as `callerOf` finds it, or a pty host's `<instance>:%N`. */
function harnessIn(frames: PaneFrame[], pane: string, machineId: string): boolean {
  const pty = /^([^:]+):(%\d+)$/.exec(pane)
  if (!pty) return !!callerOf(frames, pane, machineId)
  return frames.some(frame => frame.terminal?.runtimes?.some(r => r.backend === 'ptyhost' && r.instance === pty[1] && r.paneId === pty[2]))
}

const ELSEWHERE = 'From a harness, Swarm commands go to this computer\'s own Harness only: leave out --machine and --port, or give this computer\'s own.'

const USAGE = 'harness super-tab [--tab ID] [--agent ID] [--port N --machine ID] status [--project NAME] [--archived [PAGE]] | messages GROUP [--thread ROOT] [--before SEQUENCE MESSAGE_ID] | message GROUP MESSAGE_ID | post GROUP TEXT|- OPERATION_ID [--to AGENT]... [--answers MESSAGE_ID | --reply-to MESSAGE_ID] [--attach PATH]... [--mention PERSON]... | answer GROUP MESSAGE_ID TEXT|- OPERATION_ID [--to AGENT]... | screen AGENT [--scrollback N] | type AGENT [TEXT] [--key K]...'
/** A Buddy's guard refuses a post read from stdin (#2358): there its words would skip the secret check. A Buddy that followed
 *  the stdin form here was refused and tried again (#2360 took it out of a Buddy's help), so a Buddy's usage line never offers it. */
const BUDDY_USAGE = USAGE.replaceAll('TEXT|- OPERATION_ID', 'TEXT OPERATION_ID')
/** A refusal worded for any caller, and for a Buddy (BUDDY_USAGE): which one it is is asked only once the command is refused. */
class UsageError extends Error {
  constructor(readonly words: (buddy: boolean) => string) { super(words(false)) }
}
const usageError = () => new UsageError(buddy => buddy ? BUDDY_USAGE : USAGE)

/** A message on stdin, for post's TEXT `-`.
 *
 *  `post GROUP - OPERATION_ID` posted a literal dash: three Reviewer verdicts on 2026-10-30, #2345's findings among them,
 *  arrived as "-". So `-` reads the message from stdin, once, before anything is sent, and an empty or a terminal stdin is
 *  refused: nothing is posted, and nothing waits on a terminal for input that never comes. */
const POST_STDIN = "post GROUP - OPERATION_ID <<'MSG' (the message on the next lines, then MSG alone on a line)"
function postStdin(stdin: () => string, terminal: () => boolean): string {
  if (terminal()) throw new Error(`post - reads the message from stdin, but stdin is a terminal, so nothing was posted. Send the message on stdin: ${POST_STDIN}, or pass it as TEXT.`)
  // A heredoc ends the message with one line break, which is not part of it.
  const text = stdin().replace(/\r?\n$/, '')
  if (!text.trim()) throw new Error(`post - read no message from stdin, so nothing was posted. Send the message on stdin: ${POST_STDIN}. A message that is only - goes on stdin too.`)
  return text
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
const idleRefusal = () => `post - read stdin until nothing more came for ${STDIN_IDLE_MS / 1000} s, but stdin was never closed, so nothing was posted. `
  + `Close stdin after the message, as a heredoc does: ${POST_STDIN}, or pass it as TEXT.`
/** Stands in for stdin while the arguments are parsed the first time: stdin is read only for a command that wants it. */
class WantsStdin {}

/** Whether the harness in this pane is a Buddy, by this computer's launch record (service.ts `buddyCheck`, what turns its
 *  guard on), for a refusal's wording alone. Asked of this computer's daemon, never one named with --machine. Anything it
 *  cannot tell is no Buddy: the guard still refuses what a Buddy may not send. */
async function buddyHere(open: typeof openDaemon, local: Where, pane: string | undefined): Promise<boolean> {
  if (!pane) return false
  try {
    const daemon = await open(local)
    try {
      // The guard's own steps (buddyPane.ts paneBuddy), without its pane check: a wording, not a refusal.
      return await paneBuddy(daemon, pane, local.machineId) === 'buddy'
    } finally { daemon.close() }
  } catch { return false }
}

/** [stdin] is asked for what `-` stands for: `post`'s message. */
export function parseSuperTabArgs(argv: readonly string[], where: Where, stdin: () => string = () => readFileSync(0, 'utf8'),
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
  // A person's one Buddy reads one of its projects by its name (status --project NAME, spec 2026-10-31-one-buddy-per-swarm):
  // taken out first, so it goes with status alone or with --archived.
  let statusProject: string | undefined
  const projectAt = positional[0] === 'status' ? positional.indexOf('--project') : -1
  if (projectAt > 0) {
    statusProject = positional[projectAt + 1]
    if (!statusProject || statusProject.length > 200 || /[\u0000-\u001f]/.test(statusProject)) throw usageError()
    positional.splice(projectAt, 2)
  }
  const [action, first, second, third] = positional
  // --tab may be left out in an agent's own pane: its daemon takes the one Swarm the agent is in (superTabs/service.ts).
  if ((tabId && !identifier(tabId)) || (agentId && !identifier(agentId))) throw usageError()
  const payload: Record<string, unknown> = { action, tabId, agentId, ...(statusProject ? { project: statusProject } : {}) }
  if (action === 'messages' && identifier(first) && positional.length === 2) payload.conversationId = first
  // Older messages, a page before the cursor the last page named: its sequence and message id together, as messages may
  // share a sequence and a sequence alone skipped them (security review 2 of #2115).
  else if (action === 'messages' && identifier(first) && positional.length === 5 && second === '--before' && /^(0|[1-9][0-9]{0,15})$/.test(third ?? '')
    && Number.isSafeInteger(Number(third)) && identifier(positional[4])) {
    Object.assign(payload, { conversationId: first, before: Number(third), beforeId: positional[4] })
  }
  // One thread, its root and replies, paged as the conversation is.
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
  else if (action === 'message' && identifier(first) && identifier(second) && positional.length === 3) {
    Object.assign(payload, { conversationId: first, messageId: second })
  }
  else if (action === 'post' && identifier(first) && typeof second === 'string' && identifier(third)) {
    let replyTo: string | null = null, answers: string | null = null
    const attach: string[] = [], mentions: string[] = [], to: string[] = []
    for (let i = 4; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--reply-to' && identifier(value) && replyTo === null && answers === null) replyTo = value
      // The answer right below a message, in the main flow (task #2929); a reply to it goes in its thread.
      else if (flag === '--answers' && identifier(value) && answers === null && replyTo === null) answers = value
      // The agents it reaches, any agent of this project; the server adds @Name, a reply's author and a task's assignee (#2963).
      else if (flag === '--to' && identifier(value) && (to.includes(value) || to.length < 16)) { if (!to.includes(value)) to.push(value) }
      else if (flag === '--attach' && value && attach.length < 10) attach.push(resolve(value))
      // A person's id, username or display name (an email from older callers), as written; the service maps it (task #2954).
      else if (flag === '--mention' && value?.trim()) mentions.push(value.trim())
      else throw usageError()
    }
    // TEXT `-` is the message on stdin; any other TEXT is the message itself, and stdin is never read.
    const text = second === '-' ? postStdin(stdin, terminal) : second
    // A screenshot or a log may go without words.
    if (!text.trim() && !attach.length) throw usageError()
    Object.assign(payload, { action: 'command', operationId: third, ...(attach.length ? { attach } : {}),
      command: { type: 'message.send', conversationId: first, text, replyTo, ...(answers ? { answers } : {}), recipientIds: to, ...(mentions.length ? { mentions } : {}) } })
  } else if (action === 'answer' && identifier(first) && identifier(second) && typeof third === 'string' && identifier(positional[4])) {
    // The answer to the message [second] (task #3403): the server puts it in that message's thread, or right below it, and
    // refuses a second answer saying where the first is.
    const to: string[] = []
    for (let i = 5; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--to' && identifier(value) && (to.includes(value) || to.length < 16)) { if (!to.includes(value)) to.push(value) }
      else throw usageError()
    }
    const text = third === '-' ? postStdin(stdin, terminal) : third
    if (!text.trim()) throw usageError()
    Object.assign(payload, { action: 'command', operationId: positional[4],
      command: { type: 'message.send', conversationId: first, text, replyTo: null, answers: second, answer: true, recipientIds: to } })
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
  } else if (action !== 'status' || positional.length !== 1) {
    throw usageError()
  }
  return { where: target, payload }
}

/** The arguments, with stdin read for `-` only when they want it, and then at most until it idles (readStdin). */
async function parse(argv: readonly string[], local: Where, stdin: () => string | Promise<string>, terminal?: () => boolean) {
  try {
    return parseSuperTabArgs(argv, local, () => { throw new WantsStdin() }, terminal)
  } catch (error) {
    if (!(error instanceof WantsStdin)) throw error
    const text = await Promise.resolve().then(stdin).catch(failure => {
      throw failure instanceof StdinIdle ? new Error(idleRefusal()) : failure
    })
    return parseSuperTabArgs(argv, local, () => text, terminal)
  }
}

export async function superTabCommand(argv: readonly string[], deps: {
  where?: () => Where; open?: typeof openDaemon; print?: (text: string) => void; pane?: string; probe?: PaneProbe; fetch?: typeof fetch; env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform; stdin?: () => string | Promise<string>; terminal?: () => boolean
  readProcesses?: () => Promise<ProcessRow[] | null>
} = {}): Promise<number> {
  let daemon: Daemon | null = null
  let operationId: unknown
  const print = deps.print ?? console.log
  try {
    const platform = deps.platform ?? process.platform, env = deps.env ?? process.env, open = deps.open ?? openDaemon
    // The pane this runs in, from its processes: TMUX_PANE is what the command says, and it may not name another harness's.
    const running: RunningPane = 'pane' in deps ? { pane: deps.pane }
      : platform === 'win32' ? await windowsRunningPane(sendPane(env), deps.readProcesses)
      : runningPane(env, deps.probe, platform)
    if (running.refused) throw new Error(running.refused)
    const pane = running.pane
    const local = (deps.where ?? (() => whereFor(pane)))()
    const request = await parse(argv, local, deps.stdin ?? (() => readStdin(process.stdin)), deps.terminal)
      .catch(async error => {
        if (error instanceof UsageError && await buddyHere(open, local, pane)) throw new Error(error.words(true))
        throw error
      })
    operationId = request.payload.operationId
    // A harness reaches the Swarm through this computer's Harness alone (second review of #2087: a Buddy's --machine reached
    // the owner's other Mac, which knew no pane there). The daemon refuses an agent's request from another computer as well.
    const elsewhere = request.where.port !== local.port || request.where.machineId !== local.machineId
    // Asked of this computer's daemon, never the other machine's (re-check of #2093: --machine asked the other one, which does
    // not answer for this computer).
    if (elsewhere && pane) {
      const home = await open(local)
      try {
        const listed = await home.request('agents_list')
        if (harnessIn(Array.isArray(listed.agents) ? listed.agents as PaneFrame[] : [], pane, local.machineId)) throw new Error(ELSEWHERE)
      } finally { home.close() }
    }
    daemon = await open(request.where)
    // A harness's pane speaks as its own agent alone: with --agent too, its harness goes with the request, and the daemon
    // refuses an agent that is not that harness's (security review of #2087: a Buddy named its Builder). A person's terminal
    // is no harness, and its --agent is the person's as before.
    if (!request.payload.agentId || pane) {
      const listed = await daemon.request('agents_list')
      const frames = Array.isArray(listed.agents) ? listed.agents as Frame[] : []
      const caller = callerOf(frames, pane, request.where.machineId)
      if (caller && !await inDaemonPane(daemon, caller.agentId, running.ancestors)) throw new Error(NOT_IN_PANE)
      if (caller) request.payload.harnessId = caller.agentId
      else if (!request.payload.agentId) throw new Error('Run this command inside the participating harness, or supply its --agent ID.')
    }
    const source = daemon
    const scoped = (payload: Record<string, unknown>) => source.request('super_tabs', {
      tabId: request.payload.tabId, agentId: request.payload.agentId, harnessId: request.payload.harnessId, ...payload,
    }, 30_000)
    let result: Record<string, unknown>
    if (request.payload.action === 'screen' || request.payload.action === 'type') {
      const answer = await terminalRequest(request.payload, scoped)
      const value = object(answer.value)
      // The screen is printed as it is, for the Lead to read; anything else, and every failure, as JSON.
      if (request.payload.action === 'screen' && value.ok === true && typeof value.text === 'string') print(value.text)
      else print(JSON.stringify(answer.error ? answer : value))
      return value.ok === true ? 0 : 1
    } else {
      const { attach, ...payload } = request.payload
      // Each file goes to the daemon's local upload route, which streams it to the backend with the account's token;
      // this process holds no account credential.
      if (Array.isArray(attach)) {
        const command = object(payload.command)
        const target = { tabId: String(payload.tabId), conversationId: String(command.conversationId), port: request.where.port, dataDir: request.where.dataDir }
        command.attachmentIds = await uploadAttachments(attach as string[], String(payload.operationId), target, scoped, deps.fetch)
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
