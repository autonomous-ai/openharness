import { readCapabilities } from './capacity.js'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { CoreApi, ServiceRequests, SuperTabsPort } from '../core/api.js'
import { backend, hostJournalFile, identifier, object, SuperTabHost, SuperTabHostError } from './host.js'
import { within } from './wire.js'
import { createJevDecide, type JevDecide } from '../lib/jev/jevClient.js'
import { machineChoices } from '../lib/newCommand.js'
import { START_REQUIREMENTS } from './capacity.js'
import { CapacityReservations, type ReservationBook } from './reservations.js'
import { ContributionPreparations, prepareContribution } from './contribution.js'
import { messageIdOf } from './attach.js'

const HELP = {
  status: 'Read the shared tab roster and work.',
  messages: 'messages GROUP: read recent messages in a conversation.',
  message: 'message GROUP MESSAGE_ID: read one exact message, including an earlier question or result referenced by a reply.',
  post: 'post GROUP TEXT OPERATION_ID [--reply-to MESSAGE_ID] [--attach PATH]...: reply in that conversation. Use a unique ID per message and reuse it after an interrupted request. Answer a message once, with --reply-to its ID. --attach sends a file (a screenshot, a log; up to 10 files of 10 MB each), and TEXT may then be empty.',
  start: 'start OPERATION_ID JSON: create one agent in a conversation on a machine in this Swarm\'s Machines list; to use another machine, a person adds it to the Swarm first. Repeat exactly after an interruption; it follows the same native creation receipt. It does not assign work. With worktree true, the agent starts from the repository\'s default branch, fetched first, unless you set branchRef (refs/heads/BRANCH, or refs/remotes/origin/BRANCH to fetch it first) to start from another branch, such as the one this work builds on.',
  release: 'When a worker finishes, decide reuse, keep or stop; prefer stop unless more work is coming soon. Reuse assigns new work; agent.release records keep or requests stop. Wait for the execution host to confirm a stop. A person can withdraw a stuck stop; the session cannot receive new work in that Swarm. Its native capacity stays reserved until its host confirms stopping. Other Swarms wait up to two minutes for an in-flight close, then may reuse it.',
  resume: 'resume START_ID: finish a pending start without creating another agent.',
  route: 'route GROUP JSON: before starting or assigning work, choose who does it. JSON: {"difficulty":"low|medium|high","risk":"low|medium|high","size":"small|medium|large","why":"one sentence","needs":{"tools":[],"devices":[],"cwd":"/absolute/repo"}}. size is how long the work runs: small about 20 minutes, medium about an hour, large about three hours. Start or assign the pick with its routeDecisionId; to choose otherwise, pass overrideReason.',
  capacity: 'capacity MACHINE_ID JSON: inspect machine, engine and quota headroom. JSON uses the start request fields below. Unknown allowances are not reported as free tokens.',
  startRequest: { conversationId: 'GROUP', machineId: 'MACHINE', engine: 'codex', name: 'Builder', cwd: '/absolute/repo/on/that/machine', worktree: true, branchRef: 'refs/remotes/origin/BASE_BRANCH', requirements: START_REQUIREMENTS,
    model: 'opus', effort: 'high', routeDecisionId: 'DECISION' },
  command: 'command OPERATION_ID JSON: send one of the commands below. Reuse exactly the same ID and JSON after an interrupted request. When your assignment needs a person to decide, set work.status needs_human; when you cannot go on, blocked. Set working again once it moves.',
  commands: [
    { type: 'project.report', projectId: 'PROJECT', throughRevision: 123, text: 'What changed, what is blocked, and what comes next. Use null when nothing merits repeating.' },
    { type: 'project.repository', projectId: 'PROJECT', repositoryUrl: 'https://github.com/OWNER/REPOSITORY' },
    { type: 'message.send', conversationId: 'GROUP', text: 'A message addressed to an agent', replyTo: null, recipientIds: ['AGENT'] },
    { type: 'conversation.create', title: 'Outcome', task: { goal: 'An independently assignable result', changes: 'What changes', constraints: 'What must stay true', owns: ['Paths or code areas'] }, checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'conversation.agent', conversationId: 'GROUP', agentId: 'AGENT', present: true, lead: false },
    { type: 'work.define', conversationId: 'GROUP', task: { goal: 'What to deliver', changes: 'What changes', constraints: 'What must stay true', owns: ['Paths or code areas'] }, checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'agent.release', agentId: 'AGENT', decision: 'keep|stop' },
    { type: 'work.assign', conversationId: 'GROUP', agentId: 'AGENT', routeDecisionId: 'DECISION' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'working', result: null },
    // Both reach the Lead and alert the Harness Pro on the machine running the agent until the status moves on.
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'needs_human', result: 'The decision you need from a person, asked as one short question' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'blocked', result: 'Why you are stuck and what would unblock you, in one or two sentences' },
    { type: 'work.check', conversationId: 'GROUP', assignmentId: 'ATTEMPT', checkId: 'CHECK', passed: true, evidence: 'Exact test command, revision and observed result' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'done', result: 'Exact revision, evidence and deliverable links' },
  ],
}

const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []

function taskCommand(command: Record<string, unknown>): Record<string, unknown> {
  if (command.type !== 'conversation.create' && command.type !== 'work.define') return command
  const task = object(command.task), missing: string[] = []
  for (const part of ['goal', 'changes', 'constraints']) {
    if (typeof task[part] !== 'string' || !task[part].trim()) missing.push(part)
  }
  if (!Array.isArray(task.owns) || !task.owns.length || task.owns.some(area => typeof area !== 'string' || !area.trim())) missing.push('owns')
  if (!Array.isArray(command.checks) || !command.checks.length || command.checks.some(check => typeof object(check).description !== 'string' || !String(object(check).description).trim())) missing.push('acceptance checks')
  if (missing.length) throw new SuperTabHostError('TASK_REQUIRED', `Complete the task: ${missing.join(', ')}.`, 400)
  const trimmed = { ...task, goal: (task.goal as string).trim(), changes: (task.changes as string).trim(),
    constraints: (task.constraints as string).trim(), owns: (task.owns as string[]).map(area => area.trim()) }
  if ([trimmed.goal, trimmed.changes, trimmed.constraints].some(part => part.length > 8000) || trimmed.owns.length > 40 || trimmed.owns.some(area => area.length > 4096)) {
    throw new SuperTabHostError('INVALID_TASK', 'Task sections may have up to 8,000 characters; owns needs 1–40 paths or areas of up to 4,096 characters each.', 400)
  }
  const brief = `Goal:\n${trimmed.goal}\n\nChanges:\n${trimmed.changes}\n\nConstraints:\n${trimmed.constraints}\n\nOwns:\n${trimmed.owns.map(area => `- ${area}`).join('\n')}`
  const limit = command.type === 'conversation.create' ? 8000 : 32_000
  if (brief.length > limit) throw new SuperTabHostError('INVALID_TASK', `Keep the rendered task within ${limit.toLocaleString('en-US')} characters.`, 400)
  return { ...command, task: trimmed, brief }
}

/** Tell the agent which messages sent to it it has already answered, so it posts once (a Lead answered one question twice on
 * 2026-10-20). A message is answered when a later message of the agent's own replies to it. */
function markAnswered(page: unknown, later: unknown[], agentId: string): unknown {
  const body = object(page)
  if (!Array.isArray(body.messages)) return page
  const mine = new Set([...body.messages, ...later].map(object).filter(m => object(m.author).id === agentId && typeof m.replyTo === 'string').map(m => m.replyTo))
  return { ...body, messages: body.messages.map(object).map(m => {
    const asked = Array.isArray(m.recipientIds) && m.recipientIds.includes(agentId) && object(m.author).id !== agentId
    return asked ? { ...m, answered: mine.has(m.id) } : m
  }) }
}

export interface SuperTabServiceOptions {
  prepareContribution?: typeof prepareContribution
  capacity?: typeof readCapabilities
  host?: (core: CoreApi, machineId: string) => SuperTabHost
  reservations?: (core: CoreApi, machineId: string) => ReservationBook
  /** Jev for `route`; Harness's hosted key through the backend when the person has no key of their own. */
  jev?: (core: CoreApi) => JevDecide
}
export function superTabService(core: CoreApi, options: SuperTabServiceOptions = {}): { requests: ServiceRequests; port: SuperTabsPort } {
  const preparations = new ContributionPreparations(input => (options.prepareContribution ?? prepareContribution)(core, input))
  let host: SuperTabHost | null = null
  let book: ReservationBook | null = null, bookMachine: string | null = null
  const reservations = () => {
    const machine = core.daemon.machineId()
    if (bookMachine !== machine) { book?.stop(); book = null; bookMachine = machine }
    book ??= (options.reservations ?? ((api, id) => new CapacityReservations(api, id)))(core, machine)
    return book
  }
  const wake = () => {
    const machine = core.daemon.machineId()
    if (host?.machineId !== machine) { host?.stop(); host = null }
    host ??= (options.host ?? ((api, id) => new SuperTabHost(api, id)))(core, machine)
    host.start()
    return host
  }
  const disconnect = () => { preparations.clear(); host?.stop(); host = null; book?.stop(); book = null; bookMachine = null }
  const port = {
    connected: () => {
      if (identifier(core.daemon.machineId()) && existsSync(hostJournalFile(core.dataDir, core.daemon.machineId()))) wake()
    },
    disconnected: disconnect,
    stop: disconnect,
  }
  const requests: ServiceRequests = {
    super_tabs: async (payload, asker, closed) => {
      try {
        // Existing machine access routes the frame. Waking reads this host's own
        // registered contributions only, and grants the caller no account access.
        if (payload.action === 'wake') { wake(); return { ok: true } }
        if (payload.action === 'capacity') return (options.capacity ?? readCapabilities)(payload)
        // Machine access also authorizes native creation. These actions expose
        // only that host's admission/receipt, never its account or private roster.
        if (payload.action === 'reserveCapacity') return await reservations().reserve(payload, closed)
        if (payload.action === 'observeCapacity') return await reservations().observe(payload.creationId, closed)
        // A backend-issued context scopes provenance only. Existing machine
        // control is still required to open/write the native terminal itself.
        if (payload.action === 'prepareNative' || payload.action === 'renewNative') {
          return await wake().prepareNative(payload.tabId, payload.contextId, payload.action === 'renewNative', closed)
        }
        if (!asker.owner || (!asker.local && asker.accountOwner !== true)) return { error: 'OWNER_REQUIRED' }
        if (payload.action === 'prepareContribution') return preparations.read(payload)
        if (payload.action === 'backend') {
          const { method, path } = payload
          if (!['GET', 'POST'].includes(String(method)) || typeof path !== 'string'
            || !/^\/api\/super-tabs(?:\/[A-Za-z0-9_-]+)*(?:\?[A-Za-z0-9_=&%-]+)?$/.test(path)) {
            return { error: 'INVALID_REQUEST', detail: 'Choose a Super Tab endpoint.' }
          }
          const value = await backend(core, method as string, path, payload.body)
          return { ok: true, value }
        }
        if (payload.action === 'help') return { ok: true, help: HELP }
        const agentId = identifier(payload.agentId) ? payload.agentId
          : identifier(payload.harnessId) ? createHash('sha256').update(JSON.stringify([core.daemon.machineId(), payload.harnessId])).digest('hex').slice(0, 24) : null
        if (!identifier(payload.tabId) || !agentId) return { error: 'INVALID_REQUEST' }
        const path = `/api/super-tabs/${payload.tabId}`
        const identity = `asAgentId=${agentId}`
        const answer = object(await backend(core, 'GET', `${path}?${identity}`))
        const state = object(answer.state)
        const agent = Array.isArray(state.agents) ? state.agents.map(object).find(a => a.id === agentId) : undefined
        if (!agent || agent.machineId !== core.daemon.machineId() || typeof agent.harnessId !== 'string' || !core.agents.byAgent(agent.harnessId)) {
          return { error: 'AGENT_UNAVAILABLE', detail: 'This agent is not a running contribution on this machine.' }
        }
        wake()
        if (payload.action === 'startStatus' && identifier(payload.startId)) {
          return { ok: true, value: await backend(core, 'GET', `${path}/starts/${payload.startId}?${identity}`) }
        }
        if (payload.action === 'status') return { ok: true, value: answer }
        if (payload.action === 'routeContext') {
          const [policy, machines] = await Promise.all([
            backend(core, 'GET', `${path}/routing-policy?${identity}`),
            core.account.machines().catch(() => null),
          ])
          // A list that could not be read is not an empty one: the Lead's route says so.
          const readable = machines?.status === 200
          // Machines shared with the account but not yet added refuse it, so they are not offered.
          return { ok: true, value: { tab: answer, policy, agentId,
            machines: readable ? machineChoices(object(object(machines.body).data), null).filter(m => !m.toAdd).map(m => ({ machineId: m.machineId, name: m.label, status: m.status })) : [],
            ...(readable ? {} : { machinesUnreadable: true }) } }
        }
        // What Jev reads besides the candidates. Apart from `routeContext` so the Lead reads it while it probes the
        // machines; the group's Lead only, like the route itself.
        if (payload.action === 'routeHistory') {
          const group = list(state.conversations).find(c => c.id === payload.conversationId)
          if (!group || group.leadId !== agentId) return { error: 'LEAD_REQUIRED', detail: 'The coordinating Lead of this group owns routing.', status: 403 }
          const [written, logged, tried] = await Promise.all([
            within(backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}`)),
            within(backend(core, 'GET', `${path}/route-decisions?${identity}`)),
            // An older backend has no such route: its 404 is unreadable like any other failure.
            within(backend(core, 'GET', `${path}/conversations/${payload.conversationId}/attempts?${identity}`)),
          ])
          // Jev reads the group's talk as roles: an email is a person's name here, so it never leaves this step.
          // Native rows are an agent's own transcript and route rows are the log's, so only the talk is kept.
          const rows = Array.isArray(object(written).messages) ? list(object(written).messages) : null
          const messages = rows?.filter(m => !m.source).slice(-10).map(m => {
            const by = object(m.author)
            return { from: by.kind === 'person' ? 'person' : by.id === group.leadId ? 'Lead' : String(list(state.agents).find(a => a.id === by.id)?.name ?? 'agent'),
              text: String(m.text ?? '').slice(0, 1000) }
          })
          // The log's records carry every candidate's line; Jev needs only who was picked and how it went. The route also
          // needs the account and expected spend of what actually runs, which an open pick still holds: after an override
          // that is the person's chosen candidate, and a Lead's own choice outside the list has no known account.
          const decisions = Array.isArray(logged) ? logged.slice(0, 50).map(object).map(d => {
            const record = object(d.record), final = object(d.final), candidates = list(record.candidates), pick = candidates.find(c => c.id === record.pick)
            const runs = d.override ? candidates.find(c => c.id === object(d.override).candidateId) : pick, fit = object(runs?.fit)
            return { id: d.id, conversationId: d.conversationId, title: String(pick?.title ?? 'unknown pick'),
              ...(typeof fit.account === 'string' ? { account: fit.account, spend: object(fit.spend), size: object(record.assessment).size ?? 'medium' } : {}),
              ...(typeof record.via === 'string' ? { via: record.via } : {}), outcome: d.outcome ?? null, assignmentId: d.assignmentId ?? null, createdAt: d.createdAt,
              final: final.kind === 'member' ? { kind: 'member', agentId: final.agentId } : final.kind === 'new' ? { kind: 'new', engine: final.engine, model: final.model } : null }
          }) : null
          // Every attempt the group had, also the ones `work.define` took out of the state; the server already cut the results.
          const attempts = Array.isArray(tried) ? tried.slice(0, 50).map(object).map(a => ({ id: a.id, agentId: a.agentId, status: a.status, result: typeof a.result === 'string' ? a.result.slice(0, 500) : null, createdAt: a.createdAt ?? null })) : null
          return { ok: true, value: { ...(messages ? { messages, ...(rows!.length && !messages.length ? { noneInLatest: true } : {}) } : { messagesUnreadable: true }),
            ...(decisions ? { decisions } : { decisionsUnreadable: true }), ...(attempts ? { attempts } : { attemptsUnreadable: true }) } }
        }
        if (payload.action === 'routeJev') {
          // Jev costs money and the decision is the Lead's, so both rules are checked before it is asked.
          const group = Array.isArray(state.conversations) ? state.conversations.map(object).find(c => c.id === payload.conversationId) : undefined
          if (!group || group.leadId !== agentId) return { error: 'LEAD_REQUIRED', detail: 'The coordinating Lead of this group owns routing.', status: 403 }
          const decisions = await backend(core, 'GET', `${path}/route-decisions?${identity}`)
          const hourAgo = Date.now() - 60 * 60_000
          if ((Array.isArray(decisions) ? decisions : []).filter(d => Date.parse(String(object(d).createdAt)) >= hourAgo).length >= 30) {
            return { error: 'RATE_LIMITED', detail: 'This Super Tab routed 30 tasks in the last hour. Wait before routing again.', status: 429 }
          }
          const decide = (options.jev ?? (api => createJevDecide({ backend: (m, p, b) => api.account.backend(m, p, b) })))(core)
          try {
            // Routing never waits on Jev beyond three seconds; the policy order decides instead.
            return { ok: true, value: { answers: await decide(payload.state, object(payload.questions) as never, AbortSignal.timeout(3000)) } }
          } catch (error) {
            // A timeout is a DOMException whose `code` is a number; Jev's own refusals carry a string code.
            const name = error instanceof Error ? error.name : ''
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null
            return { ok: true, value: { unavailable: name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : code ?? 'UNAVAILABLE' } }
          }
        }
        if (payload.action === 'messages' && identifier(payload.conversationId)) {
          const page = await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}`)
          return { ok: true, value: markAnswered(page, [], agentId) }
        }
        if (payload.action === 'message' && identifier(payload.conversationId) && identifier(payload.messageId)) {
          const page = await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&messageId=${payload.messageId}`)
          // One exact message cannot show its own answer, so what came after it is read, but only for a question put to
          // this agent. If that read fails the message is still returned, just without a verdict.
          const sent = object(list(object(page).messages)[0])
          const asked = Array.isArray(sent.recipientIds) && sent.recipientIds.includes(agentId) && object(sent.author).id !== agentId
          if (!asked || !Number.isInteger(Number(sent.sequence))) return { ok: true, value: page }
          try {
            const later = object(await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&after=${sent.sequence}`)).messages
            return { ok: true, value: markAnswered(page, list(later), agentId) }
          } catch { return { ok: true, value: page } }
        }
        if (payload.action === 'command' && identifier(payload.operationId) && payload.command && typeof payload.command === 'object' && !Array.isArray(payload.command)) {
          const command = taskCommand(object(payload.command))
          const send = (command: Record<string, unknown>) => backend(core, 'POST', `${path}/commands`,
            { operationId: payload.operationId, command, asAgentId: agentId })
          let value: unknown
          try { value = await send(command) } catch (error) {
            if (command.type === 'agent.release' && error instanceof SuperTabHostError && error.status === 400 && ['VALIDATION_ERROR', 'INVALID_REQUEST'].includes(error.code)) {
              return { error: 'RELEASE_UNSUPPORTED', detail: 'This backend does not support releasing workers yet. Update the backend and try again.' }
            }
            if (!['conversation.create', 'work.define'].includes(String(command.type)) || !command.task || !(error instanceof SuperTabHostError)) throw error
            const oldSchema = error.status === 400 && error.code === 'VALIDATION_ERROR'
              && /^(?:command: )?Unrecognized (?:key: "task"|key\(s\) in object: 'task')$/.test(error.message)
            // A legacy write may commit before its reply is lost and the backend upgrades. Its receipt checks the exact
            // legacy content before returning success, so checking that form cannot create a second operation.
            const legacyReceipt = error.status === 409 && error.code === 'OPERATION_REUSED'
            if (!oldSchema && !legacyReceipt) throw error
            const { task: _task, ...legacy } = command
            value = await send(legacy)
          }
          return { ok: true, operationId: payload.operationId, value }
        }
        // `post --attach` asks first whether this post already went out with its files.
        if (payload.action === 'attachment' && identifier(payload.conversationId) && payload.step === 'sent' && identifier(payload.operationId)) {
          const sent = object(await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}&messageId=${messageIdOf(payload.tabId, agentId, payload.operationId)}`))
          const earlier = object(list(sent.messages)[0])
          // The agent's id goes back too: the files are uploaded as this agent, through the daemon's local upload route.
          return { ok: true, value: { agentId, attachmentIds: Array.isArray(earlier.attachments) ? list(earlier.attachments).map(a => String(a.id)) : null } }
        }
        return { error: 'INVALID_REQUEST' }
      } catch (error) {
        return error instanceof SuperTabHostError
          ? { error: error.code, detail: error.message, status: error.status }
          : { error: 'SUPER_TAB_UNAVAILABLE', detail: error instanceof Error ? error.message : 'This Super Tab is unavailable.' }
      }
    },
  }
  return { requests, port }
}
