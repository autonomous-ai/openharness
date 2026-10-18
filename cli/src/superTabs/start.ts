import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { admission, quotaOf, type Requirements } from './capacity.js'
import { identifier, object } from './host.js'

type Json = Record<string, unknown>
export type ScopedRequest = (payload: Json) => Promise<Json>
const text = (v: unknown) => typeof v === 'string' ? v : null
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
function requireSuccess(reply: Json): Json {
  if (reply.error || reply.ok !== true) throw new Error(String(reply.detail ?? reply.error ?? 'This Super Tab request did not succeed.'))
  return object(reply.value)
}
export async function inspectCapacity(target: Daemon, request: Json) {
  const wanted = object(request.requirements)
  const requirements: Requirements = {
    memoryBytes: number(wanted.memoryBytes) ?? 0, diskBytes: number(wanted.diskBytes) ?? 0,
    maxCpuPercent: number(wanted.maxCpuPercent) ?? 100,
    tools: Array.isArray(wanted.tools) ? wanted.tools as string[] : [], devices: Array.isArray(wanted.devices) ? wanted.devices as string[] : [],
    quotaRequired: wanted.quotaRequired === true,
  }
  const [capability, engines, usage] = await Promise.allSettled([
    target.request('super_tabs', { action: 'capacity', cwd: request.cwd, tools: requirements.tools, devices: requirements.devices }, 20_000),
    target.request('engines_probe', { engines: [request.engine] }, 20_000),
    target.request('usage_read', {}, 20_000),
  ])
  const capacity = capability.status === 'fulfilled' ? capability.value : {}
  const choices = engines.status === 'fulfilled' && Array.isArray(engines.value.engines) ? engines.value.engines.map(object) : []
  const engine = choices.find(e => e.engine === request.engine) ?? {}
  const quota = quotaOf(usage.status === 'fulfilled' ? usage.value : {}, String(request.engine), !!request.codexHome || !!request.gridModel)
  return { capacity, engine, quota, ...admission(capacity, engine, quota, requirements, !!request.codexHome || !!request.gridModel) }
}

/** Starts through the ordinary native launch protocol, with its durable receipt.
 * This CLI owns no machine credential and does not change legacy spawn settings.
 * Every invocation resumes the backend intent before it may open a native pane. */
export async function startAgent(input: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon = openDaemon): Promise<Json> {
  let startId = input.startId
  if (input.action === 'start') {
    const result = requireSuccess(await scoped({ action: 'command', operationId: input.operationId,
      command: { type: 'agent.start', request: input.request } }))
    startId = object(result.result).startId
  }
  if (!identifier(startId)) throw new Error('The start has no durable receipt. Do not create an agent without it.')
  const start = requireSuccess(await scoped({ action: 'startStatus', startId }))
  const request = object(start.request), creationId = start.creationId
  if (!identifier(request.machineId) || !identifier(creationId)) throw new Error('This start receipt is invalid.')
  if (start.error) return { error: 'START_FAILED', startId, detail: start.error }
  if (start.harnessId) return { ok: true, startId, machineId: request.machineId, harnessId: start.harnessId }
  const target = await open(where, request.machineId)
  try {
    let native = await target.request('agent_create_status', { creationId }, 10_000)
    if (native.creationId !== creationId) return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The machine did not confirm the requested creation receipt. Nothing was dispatched.' }
    if (native.state === 'missing') {
      if (start.dispatched) return { error: 'START_UNCERTAIN', startId, creationId,
        detail: 'This start was submitted but its machine has no receipt. Inspect the machine before creating another agent.' }
      const resources = await inspectCapacity(target, request)
      if (!resources.allowed) return { error: 'CAPACITY_UNAVAILABLE', startId, ...resources }
      // A new invocation uses a new claim. A lost claim reply never authorizes
      // native dispatch, even if retrying the backend operation returns a receipt.
      requireSuccess(await scoped({ action: 'command', operationId: `dispatch-${randomUUID()}`,
        command: { type: 'agent.startDispatch', startId } }))
      const payload: Json = { engine: request.engine, name: request.name, creationId, startedBy: 'agent',
        prompt: `You are joining a shared Super Tab. Run harness super-tab --tab ${input.tabId} status until this harness appears in the roster. Do not begin project work yet. Your lead will assign work in conversation ${request.conversationId}. Reply in that conversation using harness super-tab --tab ${input.tabId} post ${request.conversationId} 'your message' UNIQUE_OPERATION_ID. Run harness super-tab help for commands. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`,
        ...(request.worktree ? { projectSource: 'worktree', gitSource: request.cwd, branchName: `super-tab/${startId}`, ...(request.branchRef ? { branchRef: request.branchRef } : {}) } : { cwd: request.cwd }),
      }
      for (const key of ['permissionMode', 'codexHome', 'gridModel', 'gridName']) if (request[key] !== undefined) payload[key] = request[key]
      native = await target.request('agent_create', payload, 25_000)
    }
    if (native.error) return { error: 'START_REFUSED', startId, creationId,
      detail: String(native.detail ?? native.error) }
    if (native.creationId !== creationId) return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The machine answered for a different creation receipt. Nothing further was dispatched.' }
    if (native.state === 'failed') {
      const failure = object(native.failure)
      const detail = String(failure.detail ?? failure.code ?? 'Native creation failed.')
      requireSuccess(await scoped({ action: 'command', operationId: `failed-${startId}`, command: { type: 'agent.startFailed', startId, error: detail } }))
      return { error: 'START_FAILED', startId, detail }
    }
    const frame = object(native.agent)
    if (native.state !== 'created' || !identifier(frame.id)) {
      return { error: 'START_PENDING', startId, creationId, state: native.state ?? 'unknown',
        detail: 'Keep this start ID. Run resume with it to check the same native creation; do not make another start request.' }
    }
    const profile = parseRuntimeProfile(frame.selectedModel)
    const matched = profile?.sessionId === frame.id && profile.engine === frame.engine ? profile : null
    const configuration = { engine: text(frame.engine) ?? String(request.engine), model: matched?.model ?? null, effort: matched?.effort ?? null,
      contextWindow: number(frame.contextWindow), engineVersion: text(frame.engineVersion) }
    const joined = requireSuccess(await scoped({ action: 'command', operationId: `joined-${startId}`,
      command: { type: 'agent.started', startId, harnessId: frame.id, configuration } }))
    await target.request('super_tabs', { action: 'wake' }).catch(() => {})
    await target.request('harness_share_rosters', {}).catch(() => {})
    return { ok: true, startId, machineId: request.machineId, harnessId: frame.id, ...object(joined.result) }
  } finally { target.close() }
}
