import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { CoreApi, ServiceRequests, SuperTabsPort } from '../core/api.js'
import { backend, hostJournalFile, identifier, object, SuperTabHost, SuperTabHostError } from './host.js'

const HELP = {
  status: 'Read the shared tab roster and work.',
  messages: 'messages GROUP: read recent messages in a conversation.',
  post: 'post GROUP TEXT OPERATION_ID: reply in that conversation. Use a unique ID per message and reuse it after an interrupted request.',
  command: 'command OPERATION_ID JSON: send one of the commands below. Reuse exactly the same ID and JSON after an interrupted request.',
  commands: [
    { type: 'message.send', conversationId: 'GROUP', text: 'A message addressed to an agent', replyTo: null, recipientIds: ['AGENT'] },
    { type: 'conversation.create', title: 'Outcome', brief: 'An independently assignable result', checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'conversation.agent', conversationId: 'GROUP', agentId: 'AGENT', present: true, lead: false },
    { type: 'work.define', conversationId: 'GROUP', brief: 'What to deliver', checks: [{ description: 'Observable acceptance evidence', independent: false }] },
    { type: 'work.assign', conversationId: 'GROUP', agentId: 'AGENT' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'working', result: null },
    { type: 'work.check', conversationId: 'GROUP', assignmentId: 'ATTEMPT', checkId: 'CHECK', passed: true, evidence: 'Exact test command, revision and observed result' },
    { type: 'work.status', conversationId: 'GROUP', assignmentId: 'ATTEMPT', status: 'done', result: 'Exact revision, evidence and deliverable links' },
  ],
}

export interface SuperTabServiceOptions { host?: (core: CoreApi, machineId: string) => SuperTabHost }
export function superTabService(core: CoreApi, options: SuperTabServiceOptions = {}): { requests: ServiceRequests; port: SuperTabsPort } {
  let host: SuperTabHost | null = null
  const wake = () => {
    const machine = core.daemon.machineId()
    if (host?.machineId !== machine) { host?.stop(); host = null }
    host ??= (options.host ?? ((api, id) => new SuperTabHost(api, id)))(core, machine)
    host.start()
  }
  const disconnect = () => { host?.stop(); host = null }
  const port = {
    connected: () => {
      if (identifier(core.daemon.machineId()) && existsSync(hostJournalFile(core.dataDir, core.daemon.machineId()))) wake()
    },
    disconnected: disconnect,
    stop: disconnect,
  }
  const requests: ServiceRequests = {
    super_tabs: async (payload, asker) => {
      try {
        // Existing machine access routes the frame. Waking reads this host's own
        // registered contributions only, and grants the caller no account access.
        if (payload.action === 'wake') { wake(); return { ok: true } }
        if (!asker.owner) return { error: 'OWNER_REQUIRED' }
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
        if (payload.action === 'status') return { ok: true, value: answer }
        if (payload.action === 'messages' && identifier(payload.conversationId)) {
          return { ok: true, value: await backend(core, 'GET', `${path}/conversations/${payload.conversationId}/messages?${identity}`) }
        }
        if (payload.action === 'command' && identifier(payload.operationId) && payload.command && typeof payload.command === 'object' && !Array.isArray(payload.command)) {
          return { ok: true, operationId: payload.operationId, value: await backend(core, 'POST', `${path}/commands`,
            { operationId: payload.operationId, command: payload.command, asAgentId: agentId }) }
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
