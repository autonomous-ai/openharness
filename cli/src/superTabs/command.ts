import { inspectCapacity, startAgent } from './start.js'
import { object } from './host.js'
import { routeTask } from './routeCommand.js'
import { planWork } from './planCommand.js'
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, outsideCaller, type Frame } from '../agentClient/model.js'
import { identifier } from './host.js'
import { resolve } from 'node:path'
import { uploadAttachments } from './attach.js'
import { keyName } from './terminal.js'
import { randomUUID } from 'node:crypto'

const USAGE = 'harness super-tab --tab ID [--agent ID] [--port N --machine ID] status | messages GROUP | message GROUP MESSAGE_ID | post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]... [--mention PERSON]... | command OPERATION_ID JSON | start OPERATION_ID JSON | resume START_ID | capacity MACHINE_ID JSON | route GROUP JSON | plan [JSON] | remove-machine MACHINE_ID [--yes] | screen AGENT [--scrollback N] | type AGENT [TEXT] [--key K]... | help'
export function parseSuperTabArgs(argv: readonly string[], where: Where) {
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
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !identifier(target.machineId)) throw new Error(USAGE)
  const [action, first, second, third] = positional
  if (action !== 'help' && (!identifier(tabId) || (agentId && !identifier(agentId)))) throw new Error(USAGE)
  const payload: Record<string, unknown> = { action, tabId, agentId }
  if (action === 'messages' && identifier(first) && positional.length === 2) payload.conversationId = first
  else if (action === 'message' && identifier(first) && identifier(second) && positional.length === 3) {
    Object.assign(payload, { conversationId: first, messageId: second })
  }
  else if (action === 'post' && identifier(first) && typeof second === 'string' && identifier(third)) {
    let replyTo: string | null = null
    const attach: string[] = [], mentions: string[] = []
    for (let i = 4; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--reply-to' && identifier(value) && replyTo === null) replyTo = value
      else if (flag === '--attach' && value && attach.length < 10) attach.push(resolve(value))
      // A person's id or email, as written; the service maps it to the person (spec 2026-10-24-lead-mentions).
      else if (flag === '--mention' && value?.trim()) mentions.push(value.trim())
      else throw new Error(USAGE)
    }
    // A screenshot or a log may go without words.
    if (!second.trim() && !attach.length) throw new Error(USAGE)
    Object.assign(payload, { action: 'command', operationId: third, ...(attach.length ? { attach } : {}),
      command: { type: 'message.send', conversationId: first, text: second, replyTo, recipientIds: [], ...(mentions.length ? { mentions } : {}) } })
  } else if (action === 'command' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, command: JSON.parse(second) })
  } else if (action === 'start' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, request: JSON.parse(second) })
  } else if (action === 'resume' && identifier(first) && positional.length === 2) payload.startId = first
  else if (action === 'capacity' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { targetMachineId: first, request: JSON.parse(second) })
  } else if (action === 'remove-machine' && identifier(first) && (positional.length === 2 || positional.length === 3 && second === '--yes')) {
    // The machine's owner, as the person: without --yes, what removal would do (the agents it stops, a refusal); with it,
    // the removal. The daemon's owner-only backend request carries both.
    Object.assign(payload, second === '--yes'
      ? { action: 'backend', method: 'POST', path: `/api/super-tabs/${tabId}/commands`,
        body: { operationId: `machine-remove-${randomUUID()}`, command: { type: 'machine.remove', machineId: first } } }
      : { action: 'backend', method: 'GET', path: `/api/super-tabs/${tabId}/machines/${first}/removal` })
  } else if (action === 'route' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { conversationId: first, assessment: JSON.parse(second) })
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
        if (!key) throw new Error(USAGE)
        keys.push(key)
      } else if (text === undefined && !keys.length) text = positional[i]
      else throw new Error(USAGE)
    }
    if (!text && !keys.length) throw new Error(USAGE)
    Object.assign(payload, { operationId: `terminal-${randomUUID()}`,
      command: { type: 'agent.input', agentId: first, ...(text ? { text } : {}), ...(keys.length ? { keys } : {}) } })
  } else if (!['status', 'help'].includes(action) || positional.length !== 1) throw new Error(USAGE)
  return { where: target, payload }
}

export async function superTabCommand(argv: readonly string[], deps: {
  where?: () => Where; open?: typeof openDaemon; print?: (text: string) => void; pane?: string; fetch?: typeof fetch; env?: NodeJS.ProcessEnv
} = {}): Promise<number> {
  let daemon: Daemon | null = null
  let operationId: unknown
  const print = deps.print ?? console.log
  try {
    const request = parseSuperTabArgs(argv, (deps.where ?? (() => whereFor(process.env.TMUX_PANE)))())
    operationId = request.payload.operationId
    daemon = await (deps.open ?? openDaemon)(request.where)
    if (request.payload.action === 'backend') {
      // The owner's own act: it deletes this machine's Swarm folders, so neither a Swarm agent on it (its pane, or --agent)
      // nor an outside agent's shell may run it with the owner's authority.
      const listed = request.payload.agentId || outsideCaller(deps.env ?? process.env, request.where.machineId) ? null : await daemon.request('agents_list')
      if (!listed || callerOf(Array.isArray(listed.agents) ? listed.agents as Frame[] : [], deps.pane ?? process.env.TMUX_PANE, request.where.machineId)) {
        throw new Error('Remove a machine from your own terminal or from Desktop, not from an agent.')
      }
    }
    // Help names the caller when it can, so a Lead also reads its own options; outside a harness it is the plain help.
    const help = request.payload.action === 'help'
    if (request.payload.action !== 'backend' && !request.payload.agentId && (!help || request.payload.tabId)) {
      const listed = await daemon.request('agents_list')
      const frames = Array.isArray(listed.agents) ? listed.agents as Frame[] : []
      const caller = callerOf(frames, deps.pane ?? process.env.TMUX_PANE, request.where.machineId)
      if (caller) request.payload.harnessId = caller.agentId
      else if (!help) throw new Error('Run this command inside the participating harness, or supply its --agent ID.')
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
        const target = await (deps.open ?? openDaemon)(request.where, String(request.payload.targetMachineId))
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
        command.attachmentIds = await uploadAttachments(attach as string[], String(payload.operationId), { tabId: String(payload.tabId),
          conversationId: String(command.conversationId), port: request.where.port, dataDir: request.where.dataDir }, scoped, deps.fetch)
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
