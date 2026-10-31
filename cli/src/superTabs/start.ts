import { encodeRuntimeProfile } from '../engines/kit/runtime.js'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseRuntimeProfile } from '../lib/runtimeProfileWire.js'
import { randomUUID } from 'node:crypto'
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import { admission, quotaOf, type Requirements } from './capacity.js'
import { groupSkillMode, identifier, object } from './host.js'
import { permissionModeFlags } from '../lib/engineLaunch.js'
import type { AgentEngine } from '../engines/types.js'
import { isSwarmSkillMode, swarmSkillUse, wireRole, type SwarmSkillMode } from '../lib/swarmSkills.js'
import { isTeamDaemon, pmEngineHome } from './teamDaemon.js'
import { BUDDY_HOMES, buddyProjectsOf, prepareBuddyHome } from './buddyHome.js'
import { markBuddyNarrow } from '../lib/buddyGuard.js'
import { projectsRoot } from '../lib/projectFolder.js'
import { worktreeFolderName } from '../lib/agentNames.js'
import { join as joinPath } from 'node:path'
import { codexModelNotOffered, NO_PM_RELAY, offeredCodexModels, teamRelayed } from '../team/relay.js'

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
/** How long a start waits for an agent with no model on record to report one before it joins: a Codex agent at its own
 *  default names it at its first turn, which its join prompt starts. Work assigned before it was recorded with none (Scholes,
 *  2026-10-30, median 34 s after the start). An engine or grid model that never reports one joins without it. */
export const MODEL_REPORT_WAIT_MS = 30_000
const CANCELLED_START = 'The machine cancelled this request before starting an agent. Review its settings and create a new start request.'
function requireSuccess(reply: Json): Json {
  // The code says whether the backend answered (a refusal) or the reply was lost on the way (a transport code, or none).
  if (reply.error || reply.ok !== true) throw Object.assign(new Error(String(reply.detail ?? reply.error ?? 'This Super Tab request did not succeed.')),
    { code: typeof reply.error === 'string' ? reply.error : null, status: typeof reply.status === 'number' ? reply.status : null })
  return object(reply.value)
}
/** Whether the backend answered a command with its own refusal, so it did not record it: a 4xx answer with a code, as the
 *  Lead's daemon relays it or a contributed host's request throws it (wire.ts). A lost reply, a transport code or a server
 *  error may follow a recorded command and proves nothing. START_CLAIMED can mean another run of this start holds the
 *  claim and is creating it now: its row is left to the ledger's deadline (reservations.ts START_DEADLINE_MS). */
function refusedByBackend(error: unknown): error is Error & { code: string } {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown }
  return error instanceof Error && typeof code === 'string' && code !== 'START_CLAIMED' && typeof status === 'number' && status >= 400 && status < 500
}
/** The backend's dispatch refusals (commands.ts agent.startDispatch, machines.ts admitMachineStart) that this start can never
 *  pass: a routing rule, its engine, its machine grant revoked or gone, the machine removed or outside the contribution, and
 *  the Team refusals the backend itself fails a start for (machines.ts LASTING_TEAM_REFUSALS). Any other code, unknown ones
 *  included, may pass by itself (a pause, an offline or full machine, a held Team account, a decision the Lead owes): that
 *  start keeps waiting, as its host retries it on every pass (superTabs/machines.ts). */
const LASTING_REFUSALS = new Set(['RULE_BROKEN', 'REQUIREMENT_UNMET', 'REVIEW_REFUSED', 'STEPPED_UP', 'BUILD_REFUSED', 'SWARM_ENGINE',
  'FORBIDDEN', 'HOST_REQUIRED', 'CONTRIBUTION_REVOKED', 'MACHINE_REMOVED', 'OUTSIDE_CONTRIBUTION', 'NOT_SWARM_MACHINE', 'BUDDY_WINDOWS',
  'TEAM_ACCOUNT_REQUIRED', 'PRIVACY_UNCHECKED', 'PRIVACY_CHECK_FAILED', 'MACHINE_IN_OTHER_WORKSPACE'])
/** A Buddy's start note: its owner's chat, where it talks, and nothing to wait for. */
/** A project's Product Manager the Swarm started here (backend leadStart.ts): the Lead of the project's conversation, with
 *  the lines Desktop's own-machine launch gives one (desktop super_tabs/launch_prompt.dart). */
function leadPrompt(tabId: string, chat: string, roleName: string): string {
  return `You are the Product Manager of the project whose conversation is ${chat}, started by the Swarm on this machine. ${roleLine(roleName)}Run harness super-tab --tab ${tabId} status until this harness appears in the roster. Read the conversation with harness super-tab --tab ${tabId} messages ${chat}; if it is empty, ask there what to work on. Reply with harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID [--reply-to MESSAGE_ID], and answer each message once. ${INSTRUCTIONS_LINE(tabId)} Run harness super-tab help for commands. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}
/** Workflow lives in the project's instructions, not in this prompt (project instructions, phase 3). */
const INSTRUCTIONS_LINE = (tabId: string) => `Read your role in the project's instructions: harness super-tab --tab ${tabId} instructions.`
/** The role the project's document names for this agent, when the backend's start request carries it. */
const roleLine = (roleName: string) => roleName ? `You are joining this project's Swarm as its ${roleName}. ` : ''
function workerPrompt(tabId: string, chat: string, roleName: string): string {
  return `You are joining a shared Super Tab. ${roleLine(roleName)}Run harness super-tab --tab ${tabId} status until this harness appears in the roster. Read the conversation with harness super-tab --tab ${tabId} messages ${chat}. Reply in that conversation using harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID. ${INSTRUCTIONS_LINE(tabId)} Run harness super-tab help for commands. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}

function buddyPrompt(tabId: string, chat: string, mode: SwarmSkillMode | null): string {
  return `You are a person's Buddy in a shared Super Tab. ${mode ? `${swarmSkillUse({ role: 'buddy' }, mode)} ` : ''}Run harness super-tab --tab ${tabId} status until this harness appears in the roster. Your chat with your owner is conversation ${chat}: read it with harness super-tab --tab ${tabId} messages ${chat}, and reply there with harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID. Then greet your owner there and ask what they have in mind. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}
/** A thread session's start note (docs/superpowers/specs/2026-10-30-buddy-thread-sessions-design.md): the same Buddy, for one
 *  thread of its owner's chat. Ids only, never a message's text: a start record is listed in the Lead's status. */
function buddySessionPrompt(tabId: string, chat: string, thread: string, mode: SwarmSkillMode | null): string {
  return `You are a person's Buddy in a shared Super Tab, in a session of your own for one thread of your owner's chat. ${mode ? `${swarmSkillUse({ role: 'buddy' }, mode)} ` : ''}Run harness super-tab --tab ${tabId} status until this harness appears in the roster. Your thread is the one rooted at message ${thread} in conversation ${chat}. Read it, with the main-chat messages it started from, with harness super-tab --tab ${tabId} messages ${chat} --thread ${thread}. Answer your owner only in this thread: harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID --reply-to MESSAGE_ID, naming a message in this thread. Your owner's newest message in the thread is the one to answer first. Your Buddy's other rules are unchanged. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}

/** A person's one Buddy for the Swarm (docs/specs/2026-10-31-one-buddy-per-swarm.md): it reads every project its person
 *  reads, each project's code in its own folder under projects/, and writes only in its person's chat. Names only, never a
 *  message's text: a start record is listed in the Lead's status. */
function swarmBuddyPrompt(tabId: string, chat: string, home: { ready: string[]; missing: string[] }, mode: SwarmSkillMode | null): string {
  const code = home.ready.length ? `Each project's code is in its own folder under projects/ (${home.ready.join(', ')}).` : 'No project\'s code is on this machine.'
  const none = home.missing.length ? ` Not on this machine: ${home.missing.join(', ')}; you still read their chats and tasks.` : ''
  return `You are a person's one Buddy in a shared Super Tab, for every project they read. ${mode ? `${swarmSkillUse({ role: 'buddy' }, mode)} ` : ''}Run harness super-tab --tab ${tabId} status until this harness appears in the roster: it lists your owner's projects, one line each, and the newest tasks; status --project NAME reads one project's tasks. ${code}${none} Your chat with your owner is conversation ${chat}: read it with harness super-tab --tab ${tabId} messages ${chat}, and reply there with harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID. You send nothing into a project: when your owner wants something sent to a project's PM, tell them to start a New session in that project. Then greet your owner there and ask what they have in mind. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}
/** A project session of a person's one Buddy chat: the Buddy for that one project, in one thread, the only Buddy that sends
 *  into it. It reads that project and its owner's words in its thread alone. */
function projectSessionPrompt(tabId: string, chat: string, thread: string, mode: SwarmSkillMode | null): string {
  return `You are a person's Buddy in a shared Super Tab, in a session of your own for one project, in one thread of your owner's chat. ${mode ? `${swarmSkillUse({ role: 'buddy' }, mode)} ` : ''}Run harness super-tab --tab ${tabId} status until this harness appears in the roster: it is your project's tasks, and your folder is its code. Your thread is the one rooted at message ${thread} in conversation ${chat}. Read it with harness super-tab --tab ${tabId} messages ${chat} --thread ${thread}: you read your owner's words there and your own, nothing else of the chat. Answer your owner only in this thread: harness super-tab --tab ${tabId} post ${chat} 'your message' UNIQUE_OPERATION_ID --reply-to MESSAGE_ID, naming a message in this thread. When your owner asks, send their proposal to this project's PM, for their message in this thread. Your owner's newest message in the thread is the one to answer first. If sandbox restrictions block this local command, request permission to run it outside the sandbox.`
}

/** Why a thread session that is not Claude Code's never starts. */
export const BUDDY_SESSION_ENGINE = 'A thread session runs only with Claude Code, under its Buddy guard.'

/** The thread a Buddy start's session is for, if it is one (backend `AgentStartRequest.buddySession`). */
export function buddySessionThread(request: Json): string | null {
  const session = request.buddySession
  if (!session || typeof session !== 'object') return null
  const thread = (session as Json).thread
  return typeof thread === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(thread) ? thread : null
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
 * A start that fails before its agent exists is reported, never left unsaid (the round-device group, 2026-10-27: a
 * contributed host failed it in preparation, and the agent had been told only "queued"): a queued start is watched for a
 * short while. Since the project instructions (phase 4, decision 18) it is moved nowhere: until then this client started it
 * once more on the route's next machine by itself. The agent that made it decides what next, and the backend's failure
 * notice tells the coordinator too, with the model it asked for. */
export async function startAgent(input: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon = openDaemon,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<Json> {
  const result = await startOnce(input, scoped, where, open)
  // The host settles its own queued starts.
  if (input.hostDispatch === true) return result
  return result.queued === true && input.action === 'start' ? watchQueued(result, scoped, pause) : result
}

const WATCH_READS = 10, WATCH_EVERY_MS = 2_000
/** A contributed machine's host readies a queued start on its next pass (5 s apart, machines.ts): the agent reads its
 *  receipt for about 20 s, so a start its host fails in preparation is known before the agent moves on. Later failures
 *  are delivered by the backend (agent.startFailed); resuming the start reads its receipt. */
async function watchQueued(queued: Json, scoped: ScopedRequest, pause: (ms: number) => Promise<void>): Promise<Json> {
  for (let read = 0; read < WATCH_READS; read++) {
    await pause(WATCH_EVERY_MS)
    const start = requireSuccess(await scoped({ action: 'startStatus', startId: queued.startId }))
    if (start.error && !start.harnessId) return { error: 'START_FAILED', startId: queued.startId, detail: start.error }
    if (start.dispatched || start.harnessId) break
  }
  return queued
}

/** How a backend from before `heavy` (backend superTabs/commands.ts startRequestSchema) refuses it, word for word. */
export const HEAVY_REFUSED = 'command.request: Unrecognized key: "heavy"'
export const HEAVY_NOT_RECORDED = 'This server cannot record that the start runs heavy work, so routes in the next minutes will not count it on its machine. Update the Harness server.'

async function startOnce(input: Json, scoped: ScopedRequest, where: Where, open: typeof openDaemon): Promise<Json> {
  let startId = input.startId
  let routed: unknown
  let permissionWarning: string | undefined, heavyWarning: string | undefined
  if (input.action === 'start') {
    // The routing decision belongs to the command, not to the machine-side request.
    const { routeDecisionId, overrideReason, ...request } = object(input.request)
    routed = routeDecisionId
    const submit = (request: Json) => scoped({ action: 'command', operationId: input.operationId,
      command: { type: 'agent.start', request, ...(routeDecisionId ? { routeDecisionId } : {}), ...(overrideReason ? { overrideReason } : {}) } })
    let sent = request
    let reply = await submit({ ...sent, permissionMode: 'full' })
    // A backend from before heavy work was recorded refuses that field in its body check, before it records anything: that
    // refusal alone sends the start again without it. A timeout or any other refusal may have started an agent, so it never
    // does (Lead, 10-31).
    if (reply.error === 'VALIDATION_ERROR' && reply.detail === HEAVY_REFUSED && sent.heavy !== undefined) {
      const { heavy: _heavy, ...plain } = sent
      sent = plain
      heavyWarning = HEAVY_NOT_RECORDED
      reply = await submit({ ...sent, permissionMode: 'full' })
    }
    // Older backends refused this field before recording a start. A recorded
    // legacy retry may instead report a hash mismatch after its reply was lost:
    // replay its exact payload with the same operation ID to recover that receipt.
    // Other refusals and uncertain replies never authorize another intent.
    if (reply.error === 'OPERATION_REUSED' || (reply.error === 'OUTSIDE_CONTRIBUTION' && typeof reply.detail === 'string' &&
      reply.detail.endsWith('Refused: permissionMode (it runs with its own default account settings, so leave it out).'))) {
      const { permissionMode: _mode, ...legacyRequest } = sent
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
    ...(permissionWarning ? { permissionWarning } : {}), ...(heavyWarning ? { heavyWarning } : {}) }
  // Contributed capacity is executed by its owner. A collaborator receives no
  // machine credentials and cannot issue arbitrary commands to that computer.
  // Its machine reports it preparing (backend liveness.ts): the backend waits up to 15 minutes, and so should the Lead.
  if (start.poolGeneration && input.hostDispatch !== true) return start.preparing === true
    ? { ok: true, queued: true, preparing: true, startId, machineId: request.machineId, ...(permissionWarning ? { permissionWarning } : {}), ...(heavyWarning ? { heavyWarning } : {}),
      detail: 'Its machine is still preparing it (fetching the project, checking its worktree out); that can take up to 15 minutes. Resume this start ID to read its receipt; do not start another.' }
    : { ok: true, queued: true, startId, machineId: request.machineId,
      ...(permissionWarning ? { permissionWarning } : {}), ...(heavyWarning ? { heavyWarning } : {}),
      detail: 'Queued on the contributed machine. Resume this start ID to read its receipt.' }
  const target = await open(where, request.machineId)
  /** What the agent runs now, and its frame, as the frame says; null when the frame cannot say. */
  const seenNow = async (agentId: string, engine: string, ms = 10_000) => {
    const listed = await target.request('agents_list', {}, ms).catch((): Json => ({}))
    const frame = (Array.isArray(listed.agents) ? listed.agents.map(object) : []).find(f => f.id === agentId)
    const ran = parseRuntimeProfile(frame?.selectedModel)
    return ran && ran.sessionId === agentId && ran.engine === engine ? { ran, frame: frame! } : null
  }
  const ranNow = async (agentId: string, engine: string) => (await seenNow(agentId, engine))?.ran ?? null
  /** The model and effort routed for this start; `default` keeps what the engine launches with. */
  const model = text(request.model), effort = text(request.effort)
  const routedModel = !!model && !!effort && !(model === 'default' && effort === 'default')
  /** Whether this start may launch the agent with them: a grid model chooses its own. */
  const canLaunch = routedModel && request.gridModel === undefined && request.gridName === undefined
  /** Whether the agent was launched with them, so that nothing is left to switch. Unknown (undefined) when this
   *  invocation sent no create: a resumed start, which then reads what the agent runs. */
  let launched: boolean | undefined
  /** A dispatch the backend refused (a pause, a rule, the machine held or paused) sends no agent_create, and its reservation
   *  was held for good (Diego, 2026-10-30). The backend checks those before the claim itself, so a run that claimed this
   *  start a moment ago and is creating it now can make this one's claim read as one of them: only a start its record
   *  shows unclaimed and not launched gives anything back. One refused for now keeps waiting with its reservation given
   *  back, so its next run reserves again (the review of #2361: a paused machine's starts were lost). One refused for good
   *  is cancelled, which fences any late copy of a create, its row released and the start failed with the reason. */
  const releaseRefused = async (refused: Error & { code: string }): Promise<Json> => {
    const record = await scoped({ action: 'startStatus', startId }).then(requireSuccess).catch(() => null)
    if (record?.dispatched !== false || record.harnessId) throw refused
    if (!LASTING_REFUSALS.has(refused.code)) {
      // An older daemon without the action keeps the row, as before; the ledger's deadline gives it back then.
      await target.request('super_tabs', { action: 'returnCapacity', creationId }, 10_000).catch(() => null)
      throw refused
    }
    const cancelled = await target.request('agent_create_cancel', { creationId }, 10_000).catch((): Json => ({}))
    if (cancelled.error || cancelled.creationId !== creationId || cancelled.state !== 'cancelled') {
      return { error: 'START_UNCERTAIN', startId, creationId,
        detail: `${refused.message} The machine did not confirm cancellation. Keep this start ID and resume it before starting another agent.` }
    }
    await target.request('super_tabs', { action: 'observeCapacity', creationId }, 10_000).catch(() => {})
    // Its creation can no longer launch, so the start ends with the backend's reason and the Lead starts it elsewhere.
    if (!record.error) {
      requireSuccess(await scoped({ action: 'command', operationId: `refused-${startId}`, command: { type: 'agent.startFailed', startId, error: refused.message } }))
    }
    return { error: 'START_FAILED', startId, detail: refused.message }
  }
  try {
    let refusal: string | null = null
    let native = await target.request('agent_create_status', { creationId }, 10_000)
    if (native.creationId !== creationId) return { error: 'START_UNCERTAIN', startId, creationId,
      detail: 'The machine did not confirm the requested creation receipt. Nothing was dispatched.' }
    if (native.state === 'missing') {
      if (start.dispatched) return { error: 'START_UNCERTAIN', startId, creationId,
        detail: 'This start was submitted but its machine has no receipt. Inspect the machine before creating another agent.' }
      // A Codex Product Manager in a Harness Team account runs in an engine home of its own, with no sign-in there: it signs
      // in on the owner's relay, or not at all. With no relay it is refused before anything launches, and the queue moves it
      // on (backend leadStart.ts), rather than starting signed out (security re-check 3 of #2089).
      if (request.engine === 'codex' && request.leadFor && typeof request.leadFor === 'object' && isTeamDaemon() && !teamRelayed()) {
        requireSuccess(await scoped({ action: 'command', operationId: `refused-${startId}`, command: { type: 'agent.startFailed', startId, error: NO_PM_RELAY } }))
        return { error: 'START_FAILED', startId, detail: NO_PM_RELAY }
      }
      // A Codex model the Mac owner's ChatGPT account does not offer launched and then failed every request (Mac Auto, whose
      // owner is offered GPT-6-Luna and the GPT-5.6 models, was asked for gpt-6.1-sol, 2026-10-29). In a Team account on the
      // relay the owner's list is read first, and such a start is refused before anything launches, naming what is offered.
      // A list that cannot be read refuses nothing.
      if (request.engine === 'codex' && model && model !== 'default' && request.gridModel === undefined && isTeamDaemon()) {
        const offered = await offeredCodexModels().catch(() => null)
        if (offered && !offered.slugs.includes(model)) {
          const detail = codexModelNotOffered(model, offered)
          requireSuccess(await scoped({ action: 'command', operationId: `refused-${startId}`, command: { type: 'agent.startFailed', startId, error: detail } }))
          return { error: 'START_FAILED', startId, detail }
        }
      }
      // A Buddy thread session runs only under Claude Code, whose Buddy guard hook holds it: a Codex session would run without
      // that hook (security review 1 of #2345). The backend refuses one too; this refuses it here before anything launches.
      if (request.buddySession !== undefined && request.engine !== 'claude') {
        requireSuccess(await scoped({ action: 'command', operationId: `refused-${startId}`, command: { type: 'agent.startFailed', startId, error: BUDDY_SESSION_ENGINE } }))
        return { error: 'START_FAILED', startId, detail: BUDDY_SESSION_ENGINE }
      }
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
      try {
        requireSuccess(await scoped({ action: 'command', operationId: `dispatch-${randomUUID()}`,
          command: { type: 'agent.startDispatch', startId } }))
      } catch (error) {
        if (!refusedByBackend(error)) throw error
        return await releaseRefused(error)
      }
      // Both direct and contributed-host starts reach this boundary. Existing
      // native receipts are read above and never have their permissions changed.
      // Engines without a full mode retain their existing approving launch flags.
      // The backend starts a Reviewer only on Claude Code or Codex, the engines with built-in Swarm skills.
      const skilled = ['claude', 'codex'].includes(String(request.engine)), reviewer = request.role === 'reviewer'
      // A Buddy's start names its owner (backend buddies.ts): it brainstorms in their chat and is never assigned work.
      const buddy = !!request.buddyOf && typeof request.buddyOf === 'object'
      // A thread session (spec 2026-10-30-buddy-thread-sessions): launched as a Buddy in every way, its prompt aside.
      const session = buddy ? buddySessionThread(request) : null
      // A person's one Buddy for the Swarm, or a plain session of it (spec 2026-10-31-one-buddy-per-swarm): its folder, made
      // here, holds a worktree of each project's checkout on this machine (buddyHome.ts). A project session runs in that
      // project's own worktree, as a project's Buddy always has.
      const swarmBuddy = buddy && request.buddyScope === 'swarm'
      const projectSession = !!session && identifier(object(request.buddySession).projectId)
      // Its folder is in Harness's worktrees folder, named for its start as a Buddy's worktree is, so the cleanup of an ended
      // Buddy's Claude Code traces covers it (host.ts buddyWorktree and ownScrub; security reviews of #2345 and #2375). The
      // backend's folder for it only admits the start.
      const homeFolder = swarmBuddy ? joinPath(projectsRoot(), 'worktrees', BUDDY_HOMES, worktreeFolderName(`super-tab/${startId}`)) : null
      const home = homeFolder ? await prepareBuddyHome(homeFolder, buddyProjectsOf(request)) : null
      // A Buddy of one project launches with no wide guard: its folder is marked before its launch (lib/buddyGuard.ts).
      if (buddy && request.buddyNarrow === true) markBuddyNarrow(worktreeFolderName(`super-tab/${startId}`))
      // A project's Product Manager (backend leadStart.ts): the Lead of its project's conversation once it runs.
      const lead = !buddy && !!request.leadFor && typeof request.leadFor === 'object'
      // A contributed machine's host cannot read the tab as a Lead does: it asked the backend whose work this is when it
      // readied the start, and prepared it with the app's token if it is another person's (superTabs/projectFolder.ts).
      // Its Swarm read was refused with a 400 at every start until 2026-10-28, and its agents ran Harness orchestration
      // whatever their project's skills: the start read names them, and a backend from before that keeps orchestration.
      // Project instructions, phase 4 (decision 1): a coordinator, an agent or a Buddy, sent in the values a machine on an older
      // CLI takes (lead, dev, buddy, and review for an older client's Reviewer, which keeps its swarm-review file).
      const role = wireRole({ role: buddy ? 'buddy' : lead ? 'coordinator' : 'agent', ...(reviewer ? { fallback: 'review' as const } : {}) })
      const hosted = input.hostDispatch === true ? object(input.github) : null
      const facts = skilled && !hosted ? await projectFacts(scoped, request.conversationId, start.machineOwnerId) : null
      const mode = !skilled ? null : isSwarmSkillMode(start.skillMode) ? start.skillMode : facts?.mode ?? 'orchestration'
      // A Buddy never writes code (Lead's ruling, privacy review of #1992): never the GitHub App's token. A Claude Buddy runs
      // past its folder's guard, which allows reads and its Super Tab commands, and the rest is refused without a prompt
      // nobody answers (lib/buddyGuard.ts, Ken 10-29). A Codex Buddy reads in its read-only sandbox and asks before anything
      // outside it: with full permissions it could push and open pull requests with its person's own GitHub login (Lead, 10-29).
      const github = buddy ? null : hosted ? (typeof hosted.requester === 'string' && hosted.requester ? { requester: hosted.requester } : null) : facts?.github ?? null
      const asks = !buddy ? null : request.engine === 'claude' ? 'buddy' : request.engine === 'codex' ? 'readOnlyAsk' : null
      // The role's name from the project's document, when the backend's start request has it; one line, bounded.
      const roleName = typeof request.roleName === 'string' ? request.roleName.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
      const payload: Json = { engine: request.engine, name: request.name, creationId, startedBy: 'agent', bypassPermission: !asks,
        ...(asks ? { permissionMode: asks } : permissionModeFlags(request.engine as AgentEngine, 'full') ? { permissionMode: 'full' } : {}),
        ...(mode ? { swarmRole: role, swarmSkillMode: mode } : {}),
        ...(github ? { swarmGitHub: true } : {}),
        // A thread session (#2345) gets its own Buddy note; a coordinator's and an agent's notes name their role (phase 3).
        prompt: buddy ? (session ? projectSession ? projectSessionPrompt(String(input.tabId), String(request.conversationId), session, mode)
          : buddySessionPrompt(String(input.tabId), String(request.conversationId), session, mode)
          : home ? swarmBuddyPrompt(String(input.tabId), String(request.conversationId), home, mode)
          : buddyPrompt(String(input.tabId), String(request.conversationId), mode))
          : `${lead ? leadPrompt(String(input.tabId), String(request.conversationId), roleName) : workerPrompt(String(input.tabId), String(request.conversationId), roleName)}${github ? ` ${githubPromptLine(github.requester)}` : ''}`,
        ...(homeFolder ? { cwd: homeFolder } : request.worktree ? { projectSource: 'worktree', gitSource: request.cwd, branchName: `super-tab/${startId}`,
          // No branch named: the repository's default branch, fetched, not the host checkout's old HEAD.
          ...(request.branchRef ? { branchRef: request.branchRef } : { branchBase: 'default' }) } : { cwd: request.cwd }),
      }
      for (const key of ['codexHome', 'gridModel', 'gridName']) if (request[key] !== undefined) payload[key] = request[key]
      // A Codex Product Manager in a Harness Team account runs in an engine home of its own, deleted whole when the Swarm
      // ends it, so nothing of its chats stays where the account's next agent reads (teamDaemon.ts, security re-check 2 of #2089).
      const pmHome = lead ? pmEngineHome(String(request.engine), creationId, isTeamDaemon(), homedir()) : null
      if (pmHome) {
        // Codex refuses a CODEX_HOME that is not there; only the Team user reads it.
        mkdirSync(pmHome, { recursive: true, mode: 0o700 })
        payload.codexHome = pmHome
      }
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
    let matched = profile && profile.sessionId === nativeId && profile.engine === frame.engine ? profile : null
    let seenFrame = frame
    // Claude Code does not report an effort it was launched with, so its frame reads auto: the agent runs the effort this
    // start launched it with (a resumed start: the one the machine accepted at launch). Builders started with opus high
    // were stored as auto until 2026-10-27.
    const launchedEffort = launched ? effort : launched === undefined ? text(object(native.launchModel).effort) : null
    const startedSession = typeof frame.sessionId === 'string' && frame.sessionId && typeof frame.createdAt === 'string' && Number.isFinite(Date.parse(frame.createdAt))
      ? { sessionId: frame.sessionId, createdAt: frame.createdAt } : undefined
    // New native frames have their creation time before the engine binds. Wait for its original session identity.
    // The agent it launched goes with it: should the Swarm fail this start meanwhile, its host stops that agent
    // (superTabs/machines.ts `abandoned`).
    if (typeof frame.createdAt === 'string' && !startedSession) return { error: 'START_PENDING', startId, creationId, harnessId: nativeId,
      detail: 'Waiting for the launched engine to record its session identity. Resume this same start request.' }
    // An agent left on its engine's own model (Codex) names it at its first turn: it joins with it, so the work assigned to
    // it records it. Bounded: an engine or grid model that never reports one joins without it, and its first report fills
    // its attempts later (backend leaderboard/record.ts). A routed model is switched in after the join and read then.
    const engine = text(frame.engine) ?? String(request.engine)
    if (!matched && !start.harnessId && !routedModel && request.gridModel === undefined && request.gridName === undefined
      && ['claude', 'codex'].includes(engine)) {
      const giveUp = Date.now() + MODEL_REPORT_WAIT_MS
      for (;;) {
        const seen = await seenNow(nativeId, engine, Math.max(1_000, Math.min(10_000, giveUp - Date.now())))
        if (seen) { matched = seen.ran; seenFrame = seen.frame; break }
        if (giveUp - Date.now() < MODEL_SWITCH_RETRY_MS) break
        await new Promise(resolve => setTimeout(resolve, MODEL_SWITCH_RETRY_MS))
      }
    }
    const configuration = { engine, model: matched?.model ?? null,
      effort: matched?.effort === 'auto' && launchedEffort ? launchedEffort : matched?.effort ?? null,
      contextWindow: number(seenFrame.contextWindow), engineVersion: text(seenFrame.engineVersion) }
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
    // What the agent runs as this start last saw it, for its settle (superTabs/machines.ts): work is assigned only after the
    // settle, so it records the model even before the host's own report of it. None when the agent has named no model.
    const last = switching || routedModel ? await seenNow(nativeId, engine) : matched ? { ran: matched, frame: seenFrame } : null
    const lastEffort = switching && last?.ran.model === model ? effort : launchedEffort
    const settledConfiguration = last && last.ran.model.length <= 200 ? { engine, model: last.ran.model,
      effort: last.ran.effort === 'auto' && lastEffort ? lastEffort : last.ran.effort,
      contextWindow: Number.isSafeInteger(last.frame.contextWindow) && Number(last.frame.contextWindow) > 0 ? Number(last.frame.contextWindow) : null,
      engineVersion: text(last.frame.engineVersion)?.slice(0, 160) ?? null } : null
    return { ok: true, startId, machineId: request.machineId, harnessId: nativeId, ...object(joined.result),
      ...(settledConfiguration ? { configuration: settledConfiguration } : {}),
      ...(permissionWarning ? { permissionWarning } : {}), ...(heavyWarning ? { heavyWarning } : {}), ...(modelWarning ? { modelWarning } : {}) }
  } finally { target.close() }
}
