import { encodeRuntimeProfile } from '../engines/kit/runtime.js'
import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { createHash, randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { admission, memoryShortIn, quotaOf, type Requirements } from './capacity.js'
import { groupSkillMode, identifier, object } from './host.js'
import { permissionModeFlags } from '../lib/engineLaunch.js'
import type { AgentEngine } from '../engines/types.js'
import { isSwarmSkillMode, swarmSkillUse, type SwarmSkillMode } from '../lib/swarmSkills.js'

type Json = Record<string, unknown>
export type ScopedRequest = (payload: Json) => Promise<Json>
const text = (v: unknown) => typeof v === 'string' ? v : null
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
// These native validations run before dispatch. Storage errors, conflicts and
// unknown failures deliberately stay uncertain: they cannot prove no launch.
const PRE_DISPATCH_REFUSALS = new Set([
  'INVALID_ENGINE', 'INVALID_CWD', 'INVALID_PROJECT_SOURCE', 'INVALID_REPOSITORY',
  'INVALID_GRID', 'INVALID_CODEX_HOME', 'INVALID_DSH', 'INVALID_PROMPT',
  'INVALID_SWARM_ROLE', 'PROMPT_TOO_LONG', 'PROMPT_UNSUPPORTED', 'INVALID_AGENT', 'AGENT_UNSUPPORTED',
  'INVALID_PERMISSION_MODE', 'INVALID_SESSION', 'INVALID_STARTED_BY', 'UNSUPPORTED_ON_REMOTE',
])
// A daemon that cannot take the launch model answers these before it makes a receipt, so the same creation id can be
// sent again without it. Any other refusal still ends the start.
const LAUNCH_MODEL_REFUSALS = new Set(['LAUNCH_MODEL_UNSUPPORTED', 'INVALID_LAUNCH_MODEL'])
// The join turn must finish before the pane accepts a model switch, and it ends only once the roster shows the agent.
const MODEL_SWITCH_WAIT_MS = 60_000
const MODEL_SWITCH_RETRY_MS = 1_000
const CANCELLED_START = 'The machine cancelled this request before starting an agent. Review its settings and create a new start request.'
function requireSuccess(reply: Json): Json {
  // The code says whether the backend answered (a refusal) or the reply was lost on the way (a transport code, or none).
  if (reply.error || reply.ok !== true) throw Object.assign(new Error(String(reply.detail ?? reply.error ?? 'This Super Tab request did not succeed.')),
    { code: typeof reply.error === 'string' ? reply.error : null })
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
    target.request('super_tabs', { action: 'capacity', cwd: request.cwd, worktree: request.worktree === true, tools: requirements.tools, devices: requirements.devices }, 20_000),
    target.request('engines_probe', { engines: [request.engine] }, 20_000),
    target.request('usage_read', {}, 20_000),
  ])
  const capacity = capability.status === 'fulfilled' ? capability.value : {}
  const choices = engines.status === 'fulfilled' && Array.isArray(engines.value.engines) ? engines.value.engines.map(object) : []
  const engine = choices.find(e => e.engine === request.engine) ?? {}
  const quota = quotaOf(usage.status === 'fulfilled' ? usage.value : {}, String(request.engine), !!request.codexHome || !!request.gridModel)
  return { capacity, engine, quota, ...admission(capacity, engine, quota, requirements, !!request.codexHome || !!request.gridModel) }
}

/** What the start reads from the Swarm about the project whose group the agent joins:
 *
 * - its skills, so the agent starts on that text and is never moved to it at once. A project from before modes, or a
 *   state this start cannot read, is orchestration; the host moves a running agent to its project's mode
 *   (superTabs/host.ts) if that guess is wrong.
 * - whether the agent does another person's project work (the project's owner is not the machine's owner) on a server
 *   with the Harness GitHub App, and whom that work is for. Then git and gh in the session use the app's token for its
 *   task instead of the machine owner's GitHub login (lib/swarmGitHub.ts, docs/swarm-github-app.md). A person's own
 *   agents, a server without the app, and a state this start cannot read launch as before.
 */
export async function projectFacts(scoped: ScopedRequest, conversationId: unknown, machineOwnerId: unknown):
  Promise<{ mode: SwarmSkillMode; github: { requester: string } | null }> {
  const answer = object(object(await scoped({ action: 'status' }).catch(() => ({}))).value)
  const state = object(answer.state)
  const group = (Array.isArray(state.conversations) ? state.conversations.map(object) : []).find(group => group.id === conversationId)
  const mode = groupSkillMode(state, group)
  // A Swarm from before projects is one project, its owner's.
  const project = Array.isArray(state.projects) ? state.projects.map(object).find(p => p.id === (group?.projectId ?? 'lead')) : { ownerId: state.ownerId }
  const ownerId = project?.ownerId
  const requester = (Array.isArray(state.people) ? state.people.map(object) : []).find(p => p.id === ownerId)?.email
  const github = answer.githubApp === true && group && identifier(ownerId) && identifier(machineOwnerId) && ownerId !== machineOwnerId
    && typeof requester === 'string' && requester ? { requester } : null
  return { mode, github }
}

/** What an agent doing another person's project work is told about git, gh and its pull requests. */
export const githubPromptLine = (requester: string) => `git and gh here use a Harness GitHub App token for this project's repository while you `
  + `have a task, not this computer's own GitHub login. Start each pull request body with: Requested by ${requester} through Harness.`

/** Whether the machine launches `engine` with a model of its own for that session (lib/launchModel.ts). A daemon from
 *  before the flags does not name the field, and agent_create would silently drop a model it does not know. */
const launchesWithModel = (capacity: Json, engine: unknown) => Array.isArray(capacity.launchModel) && capacity.launchModel.includes(engine)

/** Starts through the ordinary native launch protocol, with its durable receipt.
 * This CLI owns no machine credential and does not change legacy spawn settings.
 * Every invocation resumes the backend intent before it may open a native pane.
 *
 * A Lead's routed start that fails before its agent exists is never left there (the round-device group, 2026-10-27: a
 * contributed host failed it in preparation, the Lead had been told only "queued", and the group sat without a worker).
 * A queued start is watched for a short while; a failed one starts once on the route's next machine, or the group and its
 * requester are told it has no worker. Resuming the failed start later does the same, under the same operations. */
export async function startAgent(input: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon = openDaemon,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<Json> {
  let result = await startOnce(input, scoped, where, open)
  // The host settles its own queued starts; the Lead's route and retry are the Lead's alone.
  if (input.hostDispatch === true) return result
  if (result.queued === true && input.action === 'start') result = await watchQueued(result, scoped, pause)
  if (result.error !== 'START_FAILED' || !identifier(result.startId)) return result
  const failed = requireSuccess(await scoped({ action: 'startStatus', startId: result.startId }))
  // An agent that joined is the group's worker, and a start nobody routed has no route to try again.
  if (failed.harnessId || !failed.error || !identifier(failed.routeDecisionId)) return result
  return startElsewhere(input, failed, scoped, where, open, pause)
}

const WATCH_READS = 10, WATCH_EVERY_MS = 2_000
/** A contributed machine's host readies a queued start on its next pass (5 s apart, machines.ts): the Lead reads its
 *  receipt for about 20 s, so a start its host fails in preparation is known before the Lead moves on. Later failures
 *  are delivered to the Lead (backend agent.startFailed), which resumes the start. */
async function watchQueued(queued: Json, scoped: ScopedRequest, pause: (ms: number) => Promise<void>): Promise<Json> {
  for (let read = 0; read < WATCH_READS; read++) {
    await pause(WATCH_EVERY_MS)
    const start = requireSuccess(await scoped({ action: 'startStatus', startId: queued.startId }))
    if (start.error && !start.harnessId) return { error: 'START_FAILED', startId: queued.startId, detail: start.error }
    if (start.dispatched || start.harnessId) break
  }
  return queued
}

/** Hard rules this client reads before it moves a task. A rule of any other kind may bind the task to its machine, so the
 *  task then stays where it is and is reported instead. */
const KNOWN_RULES = new Set(['forbidModel', 'machines', 'minEffort', 'preferEngine', 'preferIdle'])
const RETRY = /^retry-[0-9a-f]{24}$/
/** Answers that are not the request's own (routeCommand.ts): the backend may still have recorded it. */
const TRANSPORT = new Set(['AGENT_UNAVAILABLE', 'SUPER_TAB_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'BACKEND_TIMEOUT', 'BACKEND_UNREACHABLE'])
/** A start in these states may still launch, or has already been settled by the start itself (superTabs/machines.ts). */
const UNSETTLED = new Set(['START_UNCERTAIN', 'START_PENDING', 'START_REFUSED'])
const derived = (prefix: string, startId: string) => `${prefix}-${createHash('sha256').update(startId).digest('hex').slice(0, 24)}`

/** One more start for a routed start that failed before its agent existed: the stored route without the failed machine,
 *  recorded again so the backend checks the new pick against the owner's hard rules, then started there. A retry is never
 *  retried; with no machine left, the group is told. Every operation is named after the failed start, so a Lead that
 *  resumes it again replays the same ones. */
async function startElsewhere(input: Json, failed: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon,
  pause: (ms: number) => Promise<void>): Promise<Json> {
  const startId = String(failed.id ?? input.startId ?? input.operationId), request = object(failed.request)
  const state = object(object(requireSuccess(await scoped({ action: 'status' }))).state)
  const group = (Array.isArray(state.conversations) ? state.conversations.map(object) : []).find(g => g.id === request.conversationId)
  const machines = Array.isArray(state.machines) ? state.machines.map(object) : []
  const project = (Array.isArray(state.projects) ? state.projects.map(object) : []).find(p => p.id === group?.projectId)
  const machineName = (id: unknown) => text(machines.find(m => m.machineId === id)?.name) ?? 'its machine'
  const blocked = async (on: Json, required = false): Promise<Json> => {
    const requester = identifier(group?.requesterId) ? [group.requesterId] : []
    // People read why in the failure row the backend wrote; this one says only what it means, never the raw error. A task's
    // requirement names no machine at all: the one it failed on is a required one, which a reader may not see (backend
    // model.ts TaskRequirement; review of #1847). A memory shortage is named, with only the numbers members see in the Machines
    // view: "until that machine is fixed" sent people looking for a fault on Ken's MacBook Pro (2026-10-28).
    const short = memoryShortIn(on.error)
    requireSuccess(await scoped({ action: 'command', operationId: derived('start-blocked', String(on.id)), command: { type: 'message.send',
      conversationId: request.conversationId, replyTo: null, recipientIds: [], ...(requester.length ? { mentions: requester } : {}),
      text: required
        ? `${String(request.name)} could not start. This task needs a particular machine or device, so it was not moved to another machine. `
          + 'It has no worker until a machine that has what it needs can start it.'
        : short
          ? `${String(request.name)} could not start on ${machineName(object(on.request).machineId)}: not enough free memory (${short.free} free, ${short.needed} needed), `
            + 'and no other machine allowed for this task could take it. This task has no worker until memory frees up on that machine or another one is added.'
          : `${String(request.name)} could not start on ${machineName(object(on.request).machineId)}, and no other machine allowed for this task could take it. `
            + 'This task has no worker until that machine is fixed or another one is added.' } }))
    return { error: 'START_BLOCKED', startId: on.id, detail: `${String(on.error)} ${required
      ? 'This task requires its machine or device, so it was not moved; the group was told.'
      : 'No other machine allowed for this task could start it; the group was told.'}` }
  }
  if (RETRY.test(startId)) return blocked(failed)
  // A task that requires its machines or devices waits for them (#1829): a Lead who cannot see a required machine reads only
  // how many there are, and no machine reports its devices, so nothing tells this client another machine could do it.
  const requires = object(object(group?.task).requires)
  if (Array.isArray(requires.machines) || (number(requires.unseenMachines) ?? 0) > 0 || (Array.isArray(requires.devices) && requires.devices.length)) return blocked(failed, true)
  const rules = (Array.isArray(state.rules) ? state.rules.map(object) : []).filter(r => !r.projectId || r.projectId === group?.projectId)
  if (rules.some(r => !KNOWN_RULES.has(String(object(r.rule).kind)))) return blocked(failed)
  const decision = object(requireSuccess(await scoped({ action: 'routeDecision', decisionId: failed.routeDecisionId })))
  const record = object(decision.record), repository = object(project?.repository)
  /** Where the project's folder is on a machine: as the route says it (routeCommand.ts); unknown elsewhere. */
  const folder = (machineId: unknown) => {
    if (repository.machineId === machineId && text(repository.cwd)) return text(repository.cwd)
    const pool = machines.find(m => m.machineId === machineId)
    return pool?.scope === 'swarm' && text(pool.cwd) && identifier(project?.id) ? `${String(pool.cwd).replace(/\/+$/, '')}/${project.id}` : null
  }
  // A Mac's Harness Team account is that Mac (backend machines.ts teamStartRequest): neither runs the retry.
  const failedOn = new Set([request.machineId, machines.find(m => m.machineId === request.machineId)?.hostMachineId].filter(identifier))
  const all = Array.isArray(record.candidates) ? record.candidates.map(object) : []
  const others = all.filter(c => !failedOn.has(String(c.machineId)))
  // A person who chose the machine chooses another; a Lead's override keeps holding: never the pick it moved the task away
  // from, and the engine and model it chose to run.
  const override = object(decision.override)
  if (override.by === 'person') return blocked(failed)
  const avoided = override.by === 'lead' ? all.find(c => c.id === record.pick) : undefined
  const chosen = (c: Json) => !avoided || (c.machineId !== avoided.machineId && c.engine === request.engine
    && (c.gridModel ?? null) === (request.gridModel ?? null) && (c.gridName ?? null) === (request.gridName ?? null)
    && (c.gridModel !== undefined || (c.model === (request.model ?? 'default') && c.effort === (request.effort ?? 'default'))))
  const pick = others.find(c => c.kind === 'new' && folder(c.machineId) && chosen(c))
  if (!pick) return blocked(failed)
  const reason = 'Its machine could not start this task.'
  const why = `Retry: ${String(request.name)} could not start on ${machineName(request.machineId)}.`.slice(0, 300)
  const rerouted = await scoped({ action: 'command', operationId: derived('reroute', startId), command: { type: 'route.record',
    conversationId: request.conversationId, decision: { ...record, assessment: { ...object(record.assessment), why }, candidates: others,
      excluded: [...all.filter(c => failedOn.has(String(c.machineId))).map(c => ({ title: c.title, reason })),
        ...(Array.isArray(record.excluded) ? record.excluded : [])].slice(0, 200),
      pick: pick.id, via: 'order', fallback: undefined, p: null, belowFloor: false, why } } })
  // The backend refuses a pick that breaks a hard rule, the task's requirement set since it was read, or cannot take a
  // teammate's work: then nothing else may run it.
  const routeDecisionId = rerouted.ok === true ? object(object(rerouted.value).result).routeDecisionId : null
  if (!identifier(routeDecisionId)) return blocked(failed, rerouted.error === 'REQUIREMENT_UNMET')
  // What named the failed machine's own setup stays with it; the pick says what runs on the new one.
  const { permissionMode: _mode, model: _model, effort: _effort, gridModel: _grid, gridName: _name, codexHome: _home, ...kept } = request
  const retryId = derived('retry', startId), retryRequest = { ...kept, machineId: pick.machineId, engine: pick.engine, cwd: folder(pick.machineId),
    ...(pick.gridModel ? { gridModel: pick.gridModel, gridName: pick.gridName } : { model: pick.model, effort: pick.effort }), routeDecisionId }
  const refused = (error: unknown) => blocked({ id: retryId, request: retryRequest, error })
  const uncertain = { error: 'START_UNCERTAIN', startId: retryId, retriedFrom: startId,
    detail: 'The retry was sent but not confirmed. Resume the failed start to finish it; it sends the same retry again, never another.' }
  let retry: Json
  try { retry = await startOnce({ action: 'start', tabId: input.tabId, operationId: retryId, request: retryRequest }, scoped, where, open) } catch (error) {
    // A lost reply may follow a recorded start: its own receipt, read again, says which. Only a backend that answered with
    // a refusal and holds no such start refused it.
    const code = object(error).code, receipt = await scoped({ action: 'startStatus', startId: retryId }).catch((): Json => ({}))
    if (receipt.ok !== true && receipt.error === 'NOT_FOUND' && code === 'REQUIREMENT_UNMET') return blocked(failed, true)
    if (receipt.ok !== true) return receipt.error === 'NOT_FOUND' && typeof code === 'string' && !TRANSPORT.has(code) ? refused((error as Error).message) : uncertain
    try { retry = await startOnce({ action: 'resume', tabId: input.tabId, startId: retryId }, scoped, where, open) } catch { return uncertain }
  }
  const settled = retry.queued === true ? await watchQueued(retry, scoped, pause) : retry
  if (settled.error === undefined || UNSETTLED.has(String(settled.error))) return { ...settled, retriedFrom: startId }
  const receipt = requireSuccess(await scoped({ action: 'startStatus', startId: retryId }))
  if (receipt.harnessId) return { ...settled, retriedFrom: startId }
  // Refused before it was dispatched (capacity, the machine's sharing): fail it, so it holds no slot and its notice is written.
  if (!receipt.error) requireSuccess(await scoped({ action: 'command', operationId: derived('retry-refused', retryId),
    command: { type: 'agent.startFailed', startId: retryId, error: String(settled.detail ?? settled.error) } }))
  return refused(receipt.error ?? settled.detail ?? settled.error)
}

async function startOnce(input: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon): Promise<Json> {
  let startId = input.startId
  let routed: unknown
  let permissionWarning: string | undefined
  if (input.action === 'start') {
    // The routing decision belongs to the command, not to the machine-side request.
    const { routeDecisionId, overrideReason, ...request } = object(input.request)
    routed = routeDecisionId
    const submit = (request: Json) => scoped({ action: 'command', operationId: input.operationId,
      command: { type: 'agent.start', request, ...(routeDecisionId ? { routeDecisionId } : {}), ...(overrideReason ? { overrideReason } : {}) } })
    let reply = await submit({ ...request, permissionMode: 'full' })
    // Older backends refused this field before recording a start. A recorded
    // legacy retry may instead report a hash mismatch after its reply was lost:
    // replay its exact payload with the same operation ID to recover that receipt.
    // Other refusals and uncertain replies never authorize another intent.
    if (reply.error === 'OPERATION_REUSED' || (reply.error === 'OUTSIDE_CONTRIBUTION' && typeof reply.detail === 'string' &&
      reply.detail.endsWith('Refused: permissionMode (it runs with its own default account settings, so leave it out).'))) {
      const { permissionMode: _mode, ...legacyRequest } = request
      if (reply.error === 'OUTSIDE_CONTRIBUTION') {
        permissionWarning = "This backend cannot request full permissions. Older machine hosts run the agent with the machine's default. Update Harness on the backend and machine."
      }
      reply = await submit(legacyRequest)
    }
    const result = requireSuccess(reply)
    startId = object(result.result).startId
  }
  if (!identifier(startId)) throw new Error('The start has no durable receipt. Do not create an agent without it.')
  const start = requireSuccess(await scoped({ action: 'startStatus', startId }))
  routed ??= start.routeDecisionId
  const request = object(start.request), creationId = start.creationId
  if (!identifier(request.machineId) || !identifier(creationId)) throw new Error('This start receipt is invalid.')
  if (start.error) return { error: 'START_FAILED', startId, detail: start.error }
  if (!start.dispatched && !start.harnessId && request.engine !== 'claude' && request.engine !== 'codex') {
    const detail = 'A Swarm agent runs only Claude Code or Codex.'
    requireSuccess(await scoped({ action: 'command', operationId: `unsupported-${randomUUID()}`,
      command: { type: 'agent.startFailed', startId, error: detail } }))
    return { error: 'SWARM_ENGINE', startId, detail }
  }
  if (start.harnessId && (!start.poolGeneration || start.poolSettled)) return { ok: true, startId, machineId: request.machineId, harnessId: start.harnessId,
    ...(permissionWarning ? { permissionWarning } : {}) }
  // Contributed capacity is executed by its owner. A collaborator receives no
  // machine credentials and cannot issue arbitrary commands to that computer.
  // Its machine reports it preparing (backend liveness.ts): the backend waits up to 15 minutes, and so should the Lead.
  if (start.poolGeneration && input.hostDispatch !== true) return start.preparing === true
    ? { ok: true, queued: true, preparing: true, startId, machineId: request.machineId, ...(permissionWarning ? { permissionWarning } : {}),
      detail: 'Its machine is still preparing it (fetching the project, checking its worktree out); that can take up to 15 minutes. Resume this start ID to read its receipt; do not start another.' }
    : { ok: true, queued: true, startId, machineId: request.machineId,
      ...(permissionWarning ? { permissionWarning } : {}),
      detail: 'Queued on the contributed machine. Resume this start ID to read its receipt.' }
  const target = await open(where, request.machineId)
  /** What the agent runs now, as its frame says; null when the frame cannot say. */
  const ranNow = async (agentId: string, engine: string) => {
    const listed = await target.request('agents_list', {}, 10_000).catch((): Json => ({}))
    const frame = (Array.isArray(listed.agents) ? listed.agents.map(object) : []).find(f => f.id === agentId)
    const ran = parseRuntimeProfile(frame?.selectedModel)
    return ran && ran.sessionId === agentId && ran.engine === engine ? ran : null
  }
  /** The model and effort routed for this start; `default` keeps what the engine launches with. */
  const model = text(request.model), effort = text(request.effort)
  const routedModel = !!model && !!effort && !(model === 'default' && effort === 'default')
  /** Whether this start may launch the agent with them: a grid model chooses its own. */
  const canLaunch = routedModel && request.gridModel === undefined && request.gridName === undefined
  /** Whether the agent was launched with them, so that nothing is left to switch. Unknown (undefined) when this
   *  invocation sent no create: a resumed start, which then reads what the agent runs. */
  let launched: boolean | undefined
  try {
    let refusal: string | null = null
    let native = await target.request('agent_create_status', { creationId }, 10_000)
    if (native.creationId !== creationId) return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The machine did not confirm the requested creation receipt. Nothing was dispatched.' }
    if (native.state === 'missing') {
      if (start.dispatched) return { error: 'START_UNCERTAIN', startId, creationId,
        detail: 'This start was submitted but its machine has no receipt. Inspect the machine before creating another agent.' }
      const resources = await inspectCapacity(target, request)
      if (resources.capacity.error === 'GUEST_NOT_ALLOWED') return {
        error: 'CONTRIBUTION_REQUIRED', startId,
        detail: 'Ask the machine owner to use Add machine in this Swarm, or to add a running agent. Guest machine sharing does not grant access to the owner’s Swarm controls.',
      }
      if (!resources.allowed) return { error: 'CAPACITY_UNAVAILABLE', startId, ...resources }
      const reservation = await target.request('super_tabs', { action: 'reserveCapacity', creationId,
        cwd: request.cwd, worktree: request.worktree === true, requirements: request.requirements }, 20_000).catch(() => null)
      if (!reservation || (reservation.ok === true && reservation.reservationId !== creationId)) {
        return { error: 'START_UNCERTAIN', startId, creationId,
          detail: 'The machine did not confirm its capacity reservation. Keep this start ID and resume it; nothing was dispatched.' }
      }
      if (reservation.error || reservation.ok !== true) return { error: reservation.error ?? 'CAPACITY_UNAVAILABLE', startId,
        detail: reservation.detail ?? 'Update Harness on the execution machine to reserve capacity before starting this agent.' }
      // A new invocation uses a new claim. A lost claim reply never authorizes
      // native dispatch, even if retrying the backend operation returns a receipt.
      requireSuccess(await scoped({ action: 'command', operationId: `dispatch-${randomUUID()}`,
        command: { type: 'agent.startDispatch', startId } }))
      // Both direct and contributed-host starts reach this boundary. Existing
      // native receipts are read above and never have their permissions changed.
      // Engines without a full mode retain their existing approving launch flags.
      // The backend starts a Reviewer only on Claude Code or Codex, the engines with built-in Swarm skills.
      const skilled = ['claude', 'codex'].includes(String(request.engine)), reviewer = request.role === 'reviewer'
      // A contributed machine's host cannot read the tab as a Lead does: it asked the backend whose work this is when it
      // readied the start, and prepared it with the app's token if it is another person's (superTabs/projectFolder.ts).
      // Its Swarm read was refused with a 400 at every start until 2026-10-28, and its agents ran Harness orchestration
      // whatever their project's skills: the start read names them, and a backend from before that keeps orchestration.
      const role = reviewer ? 'review' : 'dev', hosted = input.hostDispatch === true ? object(input.github) : null
      const facts = skilled && !hosted ? await projectFacts(scoped, request.conversationId, start.machineOwnerId) : null
      const mode = !skilled ? null : isSwarmSkillMode(start.skillMode) ? start.skillMode : facts?.mode ?? 'orchestration'
      const github = hosted ? (typeof hosted.requester === 'string' && hosted.requester ? { requester: hosted.requester } : null) : facts?.github ?? null
      const payload: Json = { engine: request.engine, name: request.name, creationId, startedBy: 'agent', bypassPermission: true,
        ...(permissionModeFlags(request.engine as AgentEngine, 'full') ? { permissionMode: 'full' } : {}),
        ...(mode ? { swarmRole: role, swarmSkillMode: mode } : {}),
        ...(github ? { swarmGitHub: true } : {}),
        prompt: `You are joining a shared Super Tab${reviewer ? ' as a Reviewer' : ''}. ${mode ? `${swarmSkillUse(role, mode)} ` : ''}Run harness super-tab --tab ${input.tabId} status until this harness appears in the roster. ${reviewer
          ? `Do not review yet. You review work in conversation ${request.conversationId} when it is ready for review.`
          : `Do not begin project work yet. Your lead will assign work in conversation ${request.conversationId}.`} Reply in that conversation using harness super-tab --tab ${input.tabId} post ${request.conversationId} 'your message' UNIQUE_OPERATION_ID. Run harness super-tab help for commands. If sandbox restrictions block this local command, request permission to run it outside the sandbox.${github ? ` ${githubPromptLine(github.requester)}` : ''}`,
        ...(request.worktree ? { projectSource: 'worktree', gitSource: request.cwd, branchName: `super-tab/${startId}`,
          // No branch named: the repository's default branch, fetched, not the host checkout's old HEAD.
          ...(request.branchRef ? { branchRef: request.branchRef } : { branchBase: 'default' }) } : { cwd: request.cwd }),
      }
      for (const key of ['codexHome', 'gridModel', 'gridName']) if (request[key] !== undefined) payload[key] = request[key]
      // The routed model goes on the command line of this session alone. Typing /model into the pane afterwards saves
      // it as the person's default in their own Claude settings (manual run 2, 2026-10-19).
      launched = canLaunch && launchesWithModel(resources.capacity, request.engine)
      if (launched) { payload.model = model; payload.effort = effort }
      native = await target.request('agent_create', payload, 25_000)
      if (launched && LAUNCH_MODEL_REFUSALS.has(String(native.error))) {
        // A machine that refuses them (this value, or this Claude Code build) made no receipt: the same creation id
        // starts the agent as it always did, and the switch below sets the model after the start.
        delete payload.model; delete payload.effort
        launched = false
        native = await target.request('agent_create', payload, 25_000)
      }
      if (PRE_DISPATCH_REFUSALS.has(String(native.error))) {
        refusal = String(native.detail ?? native.error)
        // A durable cancellation also fences a delayed copy of this create.
        // If dispatch won, keep its receipt and reconcile it normally instead.
        native = await target.request('agent_create_cancel', { creationId }, 10_000).catch(() => ({}))
        if (native.error || native.creationId !== creationId) {
          return { error: 'START_UNCERTAIN', startId, creationId,
            detail: `${refusal} The machine did not confirm cancellation. Keep this start ID and resume it before starting another agent.` }
        }
      }
    }
    if (native.error) return { error: 'START_REFUSED', startId, creationId,
      detail: String(native.detail ?? native.error) }
    if (native.creationId !== creationId) return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The machine answered for a different creation receipt. Nothing further was dispatched.' }
    if (native.state === 'failed' || native.state === 'cancelled') {
      await target.request('super_tabs', { action: 'observeCapacity', creationId }, 10_000).catch(() => {})
      const failure = object(native.failure)
      const detail = native.state === 'cancelled' ? CANCELLED_START : String(failure.detail ?? failure.code ?? 'Native creation failed.')
      // The machine's own refusal tells the Lead where else the work can run. Only the invocation that saw it knows it,
      // so it goes under its own operation; one that finds only the durable cancellation tombstone sends the generic
      // text under the other, byte-identical on every retry. Whichever the backend records first fails the start.
      const command = refusal ? { operationId: `refused-${startId}`, error: refusal } : { operationId: `failed-${startId}`, error: detail }
      requireSuccess(await scoped({ action: 'command', operationId: command.operationId, command: { type: 'agent.startFailed', startId, error: command.error } }))
      return { error: 'START_FAILED', startId, detail: refusal ?? detail }
    }
    const frame = object(native.agent)
    const nativeId = native.state === 'unavailable' ? native.createdAgentId : frame.id
    if (!['created', 'unavailable'].includes(String(native.state)) || !identifier(nativeId)) {
      return { error: 'START_PENDING', startId, creationId, state: native.state ?? 'unknown',
        detail: 'Keep this start ID. Run resume with it to check the same native creation; do not make another start request.' }
    }
    const reservation = await target.request('super_tabs', { action: 'observeCapacity', creationId }, 10_000).catch(() => null)
    if (reservation?.ok !== true || reservation.reservationId !== creationId || reservation.harnessId !== nativeId) {
      return { error: 'START_UNCERTAIN', startId, creationId,
        detail: 'The agent was created, but its capacity receipt is not confirmed. Keep this start ID and resume it before starting another agent.' }
    }
    if (reservation.released === true) {
      const detail = 'The agent was created and has since stopped. Create a new start request to continue.'
      requireSuccess(await scoped({ action: 'command', operationId: `failed-${startId}`, command: { type: 'agent.startFailed', startId, error: detail } }))
      return { error: 'START_FAILED', startId, detail }
    }
    if (native.state !== 'created') return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The created agent is unavailable, but its stop is not confirmed. Inspect the execution machine before starting another agent.' }
    // Reports what the engine launched with; the routed model, once launched or switched, is observed afterwards.
    const profile = parseRuntimeProfile(frame.selectedModel)
    const matched = profile && profile.sessionId === nativeId && profile.engine === frame.engine ? profile : null
    // Claude Code does not report an effort it was launched with, so its frame reads auto: the agent runs the effort this
    // start launched it with (a resumed start: the one the machine accepted at launch). Builders started with opus high
    // were stored as auto until 2026-10-27.
    const launchedEffort = launched ? effort : launched === undefined ? text(object(native.launchModel).effort) : null
    const configuration = { engine: text(frame.engine) ?? String(request.engine), model: matched?.model ?? null,
      effort: matched?.effort === 'auto' && launchedEffort ? launchedEffort : matched?.effort ?? null,
      contextWindow: number(frame.contextWindow), engineVersion: text(frame.engineVersion) }
    const startedSession = typeof frame.sessionId === 'string' && frame.sessionId && typeof frame.createdAt === 'string' && Number.isFinite(Date.parse(frame.createdAt))
      ? { sessionId: frame.sessionId, createdAt: frame.createdAt } : undefined
    // New native frames have their creation time before the engine binds. Wait for its original session identity.
    if (typeof frame.createdAt === 'string' && !startedSession) return { error: 'START_PENDING', startId, creationId,
      detail: 'Waiting for the launched engine to record its session identity. Resume this same start request.' }
    const join = { type: 'agent.started', startId, harnessId: nativeId, configuration }
    let joined: Json = { result: {} }
    if (!start.harnessId) {
      let reply = await scoped({ action: 'command', operationId: `joined-${startId}`, command: { ...join, ...(startedSession ? { startedSession } : {}) } })
      if (startedSession && ['VALIDATION_ERROR', 'INVALID_REQUEST'].includes(String(reply.error))) {
        // Older backends retain the launch, but cannot attest its native identity for automatic stopping.
        reply = await scoped({ action: 'command', operationId: `joined-legacy-${startId}`, command: join })
      }
      joined = requireSuccess(reply)
    }
    await target.request('super_tabs', { action: 'wake' }).catch(() => {})
    await target.request('harness_share_rosters', {}).catch(() => {})
    // A launched agent already runs the routed model. Any other (Codex, a grid model, a machine that does not list the
    // engine or refused the model) is switched once it has joined: agent_create submits the join prompt, which tells the
    // agent to poll the roster. The agent enters the roster first, so that turn can finish; the ordinary runtime switch
    // answers BUSY until the turn ends, and is retried for a bounded time. A fresh Claude has no CLI version until its
    // first transcript records, and the switch answers UNSUPPORTED_CLI_VERSION until then (the 2026-10-19 manual run):
    // the daemon does not put that version on the agent's frame, so an old version cannot be told from an unknown one
    // and both retry within the bound. `default` keeps what the engine launched with. The start returns only after the
    // switch settles, so the Lead assigns work only once the routed model is in place.
    let modelWarning: string | undefined
    let switching = routedModel && launched === false
    if (routedModel && launched === undefined) {
      // This invocation did not send the create, and the one that did may have launched with the model, fallen back to
      // the switch, or been cut off before either. A concrete runtime difference still needs a switch. A temporary
      // automatic effort is not a difference when the completed native receipt proves that effort was passed at launch.
      // /model is never typed blind, as Claude Code would save it as the person's default.
      const ran = await ranNow(nativeId, String(request.engine))
      const same = (wanted: string, actual: string) => wanted === 'default' || wanted === 'auto' || wanted === actual
      if (!ran) modelWarning = `Could not confirm that the agent runs ${model} ${effort}; its configuration could not be read, so it was left as it is.`
      else {
        const accepted = object(native.launchModel)
        const effortStillUnknown = ran.effort === 'auto' && accepted.effort === effort && same(String(model), ran.model)
        switching = !same(String(model), ran.model) || (!same(String(effort), ran.effort) && !effortStillUnknown)
      }
    }
    if (switching) {
      const selectedModel = encodeRuntimeProfile({ sessionId: nativeId, engine: String(request.engine) as never, model: String(model), effort: effort as never })
      const giveUp = Date.now() + MODEL_SWITCH_WAIT_MS
      let reply: Json
      // BUSY ends with the agent's first turn. Claude alone learns its version late; for any other engine the same
      // answer means its driver cannot load, which waiting does not change.
      const retryable = (error: string) => error === 'BUSY' || (error === 'UNSUPPORTED_CLI_VERSION' && request.engine === 'claude')
      // Each try gets only what is left of the budget, and none starts with under a retry interval left, so a
      // hanging daemon cannot stretch the whole switch past the Lead's own shell timeout.
      for (;;) {
        reply = await target.request('agent_update', { agentId: nativeId, selectedModel }, Math.min(60_000, giveUp - Date.now())).catch(() => ({ error: 'MODEL_UNAVAILABLE' }))
        if (!retryable(String(reply.error)) || giveUp - Date.now() < 2 * MODEL_SWITCH_RETRY_MS) break
        await new Promise(resolve => setTimeout(resolve, MODEL_SWITCH_RETRY_MS))
      }
      if (reply.error) {
        // A client timeout can follow a switch the daemon did apply: then the agent runs the routed model.
        const ran = await ranNow(nativeId, String(request.engine))
        if (ran?.model !== model || ran.effort !== effort) {
          modelWarning = `Started with the engine's own model; switching to ${model} ${effort} failed (${String(reply.error)}).`
          // The decision log says who was actually started, so it must not keep the model that was asked for.
          if (identifier(routed)) {
            const corrected = ran && await scoped({ action: 'command', operationId: `model-result-${startId}`,
              command: { type: 'route.modelResult', decisionId: routed, startId, model: ran.model, effort: ran.effort } })
              .then(requireSuccess).then(() => true, () => false)
            if (!corrected) modelWarning += ' The routing decision log could not be corrected to the model that ran.'
          }
        }
      }
    }
    return { ok: true, startId, machineId: request.machineId, harnessId: nativeId, ...object(joined.result),
      ...(permissionWarning ? { permissionWarning } : {}), ...(modelWarning ? { modelWarning } : {}) }
  } finally { target.close() }
}
