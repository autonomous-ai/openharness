/** A Lead's routed start that the machine's host fails, with no other machine to try, on the real native protocol: a private
 * daemon, tmux and data dir, a fake Claude engine and the fake backend. The group is told the task has no worker, and its
 * requester is tagged only if the task still has none after a while (backend mentions.ts), which this checks by the
 * command the backend would receive. Database behaviour is covered by the backend's tests. */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'd7'.repeat(16), computerId: 'e2e-super-tab-blocked-computer', name: 'Fixture Mac', token: 'e2e-super-tab-blocked-token' }
const TAB = 'blocked-tab'
let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.close())
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
})

it('tells the group a failed start left no worker, and tags the requester only on hold', async () => {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId, ANTHROPIC_API_KEY: 'fixture-not-a-credential',
  } }); daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-160).join('\n')))
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(made.error, JSON.stringify(made)).toBeUndefined()
  const leadId = createHash('sha256').update(JSON.stringify([ME.machineId, made.agent.id])).digest('hex').slice(0, 24)
  const agents = [{ id: leadId, name: 'Lead', machineId: ME.machineId, harnessId: made.agent.id, configuration: { engine: 'claude', model: 'opus', effort: 'high' } }]
  const conversations = [{ id: 'g1', title: 'API', projectId: 'p1', leadId, agentIds: [leadId], archived: false, brief: 'Add the endpoint.',
    checks: [{ description: 'Tests pass' }], assignment: null, requesterId: 'person-1' }]
  const candidate = { id: 'c0', kind: 'new', machineId: ME.machineId, engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 10,
    title: 'Builder · Claude opus high', label: 'Fixture Mac' }
  const decision = { id: 'd-1', conversationId: 'g1', outcome: 'failed', final: null, override: null,
    record: { assessment: { difficulty: 'medium', risk: 'low', why: 'Fixture.', size: 'medium' }, candidates: [candidate], excluded: [],
      floor: 2, notes: false, pick: 'c0', via: 'order', p: null, belowFloor: false, why: 'Policy order.' } }
  const starts = new Map<string, Record<string, any>>()
  const commands: Array<Record<string, any>> = []
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/${TAB}` && method === 'GET') return { data: { revision: commands.length, state: { id: TAB, agents, conversations,
      projects: [{ id: 'p1', name: 'API', ownerId: 'owner-1', repository: { machineId: ME.machineId, cwd } }],
      machines: [{ machineId: ME.machineId, name: ME.name, scope: 'swarm', cwd }], rules: [],
      people: [{ id: 'person-1', email: 'requester@example.com', role: 'collaborator' }] } } }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: TAB, agent, lead: true, leadsConversationId: null, observers: [] })) }
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools` || path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    if (path === `/api/super-tabs/${TAB}/route-decisions/d-1`) return { data: decision }
    if (path.startsWith(`/api/super-tabs/${TAB}/starts/`)) {
      const start = starts.get(path.split('/').at(-1)!)
      // The machine's host fails the queued start in preparation, the second time the Lead looks.
      if (start && start.read) start.error = 'The Harness GitHub App token is not in the form GitHub gives.'
      if (start) start.read = true
      return { data: start }
    }
    if (path === `/api/super-tabs/${TAB}/commands`) {
      const command = body.command
      commands.push(body)
      if (command.type === 'agent.start') {
        const startId = `start-${body.operationId}`
        starts.set(startId, { id: startId, creationId: `super-${startId}`, poolGeneration: 'pool', routeDecisionId: command.routeDecisionId,
          request: command.request, dispatched: false, harnessId: null, error: null })
        return { data: { result: { startId } } }
      }
      if (command.type === 'agent.startFailed') starts.get(String(command.startId))!.error = command.error
      return { data: { result: { messageId: body.operationId } } }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  })
  const where = { port: d.port, dataDir: d.dataDir, machineId: ME.machineId, harnessPane: true }
  let answer: Record<string, any> = {}
  const code = await superTabCommand(['--tab', TAB, '--agent', leadId, 'start', 'first-start', JSON.stringify({ conversationId: 'g1',
    machineId: ME.machineId, engine: 'claude', model: 'opus', effort: 'high', name: 'Builder', cwd, worktree: false,
    requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, routeDecisionId: 'd-1' })],
  { where: () => where, print: text => { answer = JSON.parse(text) } })
  expect(answer, JSON.stringify(answer)).toMatchObject({ error: 'START_BLOCKED', startId: 'start-first-start' })
  expect(code).not.toBe(0)
  const notices = commands.filter(c => c.command.type === 'message.send')
  expect(notices).toHaveLength(1)
  expect(notices[0]!.command).toMatchObject({ conversationId: 'g1', mentions: ['person-1'], mentionsIfNoWorker: true, recipientIds: [],
    text: 'Builder could not start on Fixture Mac, and no other machine allowed for this task could take it. This task has no worker. '
      + 'Fix that machine or add another one, then ask the Lead to start it again.' })
  // Nothing but the notice and the failed start went to the backend for it: no second start.
  expect(commands.filter(c => c.command.type === 'agent.start')).toHaveLength(1)
})
