import { inspectCapacity, startAgent } from './start.js'
import { object } from './host.js'
import { routeTask } from './routeCommand.js'
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, type Frame } from '../agentClient/model.js'
import { identifier } from './host.js'
import { resolve } from 'node:path'
import { uploadAttachments } from './attach.js'

const USAGE = 'harness super-tab --tab ID [--agent ID] [--port N --machine ID] status | messages GROUP | message GROUP MESSAGE_ID | post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]... | command OPERATION_ID JSON | start OPERATION_ID JSON | resume START_ID | capacity MACHINE_ID JSON | route GROUP JSON | help'
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
    const attach: string[] = []
    for (let i = 4; i < positional.length; i += 2) {
      const [flag, value] = [positional[i], positional[i + 1]]
      if (flag === '--reply-to' && identifier(value) && replyTo === null) replyTo = value
      else if (flag === '--attach' && value && attach.length < 10) attach.push(resolve(value))
      else throw new Error(USAGE)
    }
    // A screenshot or a log may go without words.
    if (!second.trim() && !attach.length) throw new Error(USAGE)
    Object.assign(payload, { action: 'command', operationId: third, ...(attach.length ? { attach } : {}),
      command: { type: 'message.send', conversationId: first, text: second, replyTo, recipientIds: [] } })
  } else if (action === 'command' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, command: JSON.parse(second) })
  } else if (action === 'start' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { operationId: first, request: JSON.parse(second) })
  } else if (action === 'resume' && identifier(first) && positional.length === 2) payload.startId = first
  else if (action === 'capacity' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { targetMachineId: first, request: JSON.parse(second) })
  } else if (action === 'route' && identifier(first) && second && positional.length === 3) {
    Object.assign(payload, { conversationId: first, assessment: JSON.parse(second) })
  } else if (!['status', 'help'].includes(action) || positional.length !== 1) throw new Error(USAGE)
  return { where: target, payload }
}

export async function superTabCommand(argv: readonly string[], deps: {
  where?: () => Where; open?: typeof openDaemon; print?: (text: string) => void; pane?: string; fetch?: typeof fetch
} = {}): Promise<number> {
  let daemon: Daemon | null = null
  let operationId: unknown
  const print = deps.print ?? console.log
  try {
    const request = parseSuperTabArgs(argv, (deps.where ?? (() => whereFor(process.env.TMUX_PANE)))())
    operationId = request.payload.operationId
    daemon = await (deps.open ?? openDaemon)(request.where)
    if (request.payload.action !== 'help' && !request.payload.agentId) {
      const listed = await daemon.request('agents_list')
      const frames = Array.isArray(listed.agents) ? listed.agents as Frame[] : []
      const caller = callerOf(frames, deps.pane ?? process.env.TMUX_PANE, request.where.machineId)
      if (!caller) throw new Error('Run this command inside the participating harness, or supply its --agent ID.')
      request.payload.harnessId = caller.agentId
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
    } else if (request.payload.action === 'route') {
      result = await routeTask({ tabId: String(request.payload.tabId), conversationId: String(request.payload.conversationId),
        assessment: request.payload.assessment }, scoped, request.where, deps.open)
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
