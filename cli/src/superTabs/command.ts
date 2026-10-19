import { inspectCapacity, startAgent } from './start.js'
import { object } from './host.js'
import { routeTask } from './routeCommand.js'
import { openDaemon, whereFor, type Daemon, type Where } from '../agentClient/daemon.js'
import { callerOf, type Frame } from '../agentClient/model.js'
import { identifier } from './host.js'

const USAGE = 'harness super-tab --tab ID [--agent ID] [--port N --machine ID] status | messages GROUP | message GROUP MESSAGE_ID | post GROUP TEXT OPERATION_ID | command OPERATION_ID JSON | start OPERATION_ID JSON | resume START_ID | capacity MACHINE_ID JSON | route GROUP JSON | help'
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
  else if (action === 'post' && identifier(first) && second?.trim() && identifier(third) && positional.length === 4) {
    Object.assign(payload, { action: 'command', operationId: third,
      command: { type: 'message.send', conversationId: first, text: second, replyTo: null, recipientIds: [] } })
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
  where?: () => Where; open?: typeof openDaemon; print?: (text: string) => void; pane?: string
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
    } else result = await daemon.request('super_tabs', request.payload, 30_000)
    print(JSON.stringify({ ...result, ...(operationId ? { operationId } : {}) }))
    return result.error ? 1 : 0
  } catch (error) {
    print(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(operationId ? { operationId } : {}) }))
    return 1
  } finally { daemon?.close() }
}
