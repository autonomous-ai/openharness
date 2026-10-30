/** `harness super-tab route` on the real native protocol: a private daemon, tmux and data dir, fake Claude
 * engines and the fake backend (with Jev available to verify routing bypasses it). Database authorization is covered by the backend's tests. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'e2e-super-tab-route-computer', name: 'Fixture', token: 'e2e-super-tab-route-token' }
const TAB = 'route-tab'
const POLICY = { version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '', models: [
  { engine: 'claude', model: 'sonnet', effort: 'medium', quality: 2, cost: 2, enabled: true },
  { engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 3, enabled: true },
  { engine: 'codex', model: 'default', effort: 'default', quality: 3, cost: 2, enabled: false },
] }
let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined, nowhere: string | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.close())
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
  if (nowhere) rmSync(nowhere, { recursive: true, force: true }); nowhere = undefined
})

async function setup(hostedJev: FakeBackend['jev'], options: { workerBusy?: boolean } = {}) {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME); relay.jev = hostedJev
  // A regression to Jev should reach the fake backend, never OpenRouter: empty the environment's key and
  // point both credential locations at an empty folder. Defaults are under the isolated HOME.
  nowhere = mkdtempSync(join(tmpdir(), 'route-e2e-no-key-'))
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential',
    OPENROUTER_API_KEY: '', ORI_CREDENTIALS_PATH: join(nowhere, 'credentials.json'), TYPESAFE_CREDENTIALS: join(nowhere, 'typesafe'),
  } }); daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-160).join('\n')))
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  const create = async () => {
    const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(made.error, JSON.stringify(made)).toBeUndefined()
    return made.agent.id as string
  }
  const idFor = (harnessId: string) => createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)
  const leadHarness = await create(), workerHarness = await create()
  const leadId = idFor(leadHarness), workerId = idFor(workerHarness)
  const agents = [
    { id: leadId, name: 'Lead', machineId: ME.machineId, harnessId: leadHarness, configuration: { engine: 'claude', model: 'opus', effort: 'high' } },
    { id: workerId, name: 'Multiply', machineId: ME.machineId, harnessId: workerHarness, configuration: { engine: 'claude', model: 'sonnet', effort: 'medium' } },
  ]
  const conversations = [
    { id: 'lead', title: 'Lead', leadId, agentIds: [leadId, workerId], archived: false, brief: '', checks: [],
      assignment: options.workerBusy ? { id: 'busy', agentId: workerId, status: 'working' } : null },
    { id: 'g1', title: 'API', leadId, agentIds: [leadId], archived: false, brief: 'Add the endpoint.', checks: [{ description: 'Tests pass' }], assignment: null },
  ]
  const records: Array<Record<string, any>> = []
  const commands: Array<Record<string, any>> = []
  const starts = new Map<string, Record<string, any>>()
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/${TAB}` && method === 'GET') return { data: { revision: records.length, state: { id: TAB, agents, conversations } } }
    if (path === `/api/super-tabs/${TAB}/routing-policy`) return { data: { policy: POLICY, warnings: [], overridden: [] } }
    if (path === `/api/super-tabs/${TAB}/route-decisions`) return { data: [] }
    if (path === `/api/super-tabs/${TAB}/commands` && body.command?.type === 'route.record') {
      records.push(body)
      return { data: { revision: records.length, result: { routeDecisionId: `d-${records.length}` } } }
    }
    // The roster lists this machine's agents, as a server's does: the daemon learns its caller there (#1726).
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.filter(agent => agent.machineId === ME.machineId)
      .map(agent => ({ tabId: TAB, agent, lead: agent.id === leadId, leadsConversationId: null, observers: [] })) }
    if (path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: [] }
    if (path.startsWith(`/api/super-tabs/${TAB}/starts/`)) return { data: starts.get(path.split('/').at(-1)!) }
    if (path === `/api/super-tabs/${TAB}/commands`) {
      const command = body.command
      commands.push(body)
      if (command.type === 'agent.start') {
        const startId = `start-${body.operationId}`
        starts.set(startId, { id: startId, creationId: `super-${startId}`, request: command.request, dispatched: false, harnessId: null })
        return { data: { result: { startId } } }
      }
      const start = starts.get(String(command.startId))!
      if (command.type === 'agent.startDispatch') start.dispatched = true
      if (command.type === 'agent.started') { start.harnessId = command.harnessId; return { data: { result: { agentId: idFor(command.harnessId) } } } }
      return { data: { result: {} } }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  })
  const where = { port: d.port, dataDir: d.dataDir, machineId: ME.machineId, harnessPane: true }
  async function route(group = 'g1') {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', TAB, '--agent', leadId, 'route', group,
      JSON.stringify({ difficulty: 'medium', risk: 'low', why: 'Endpoint.' })], { where: () => where, print: text => { answer = JSON.parse(text) } })
    return { code, answer }
  }
  async function start(operationId: string, request: Record<string, unknown>) {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', TAB, '--agent', leadId, 'start', operationId, JSON.stringify(request)],
      { where: () => where, print: text => { answer = JSON.parse(text) } })
    return { code, answer }
  }
  async function resume(startId: string) {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', TAB, '--agent', leadId, 'resume', startId],
      { where: () => where, print: text => { answer = JSON.parse(text) } })
    return { code, answer }
  }
  return { route, start, resume, records, commands, relay, client, cwd, leadHarness, workerHarness }
}

it('routes by policy even when Jev is available and records the decision', async () => {
  const asked: Array<Record<string, any>> = []
  const { route, records } = await setup(body => {
    asked.push(body)
    const ids = Object.keys(body.questions.who.criteria)
    return { who: { choice: 'c1', probabilities: Object.fromEntries(ids.map(id => [id, id === 'c1' ? 0.9 : 0.1 / (ids.length - 1)])) } }
  })
  const { code, answer } = await route()
  expect(code, JSON.stringify(answer)).toBe(0)
  expect(answer).toMatchObject({ ok: true, routeDecisionId: 'd-1', via: 'order', pick: { id: 'c0' } })
  expect(asked).toHaveLength(0)
  expect(records).toHaveLength(1)
  expect(records[0].command.decision).toMatchObject({ via: 'order', pick: 'c0' })
  // The idle worker is a candidate; the Lead never is.
  const titles = (records[0].command.decision.candidates as Array<{ title: string }>).map(c => c.title)
  expect(titles.some(t => t.startsWith('Multiply ·'))).toBe(true)
  expect(titles.some(t => t.startsWith('Lead ·'))).toBe(false)
  // The service runs in its own process, which reads the account's machines through the core: titles carry the
  // machine's name, not its id (the 2026-10-19 manual run).
  expect(titles.every(t => t.endsWith(` · ${ME.name}`))).toBe(true)
}, 180_000)

it('uses the policy order when Jev is unavailable', async () => {
  const { route, records, relay } = await setup(null)
  const { code, answer } = await route()
  expect(code, JSON.stringify(answer)).toBe(0)
  expect(relay.seen.some(line => line.startsWith('POST /api/route/jev'))).toBe(false)
  expect(answer).toMatchObject({ ok: true, routeDecisionId: 'd-1', via: 'order', pick: { id: 'c0' } })
  expect(records[0].command.decision).toMatchObject({ via: 'order', pick: 'c0' })
}, 180_000)

it('starts the routed pick as a new agent with its decision, model and effort', async () => {
  const { route, start, resume, commands, client, cwd, leadHarness, workerHarness } = await setup(null, { workerBusy: true })
  const routed = await route()
  expect(routed.code, JSON.stringify(routed.answer)).toBe(0)
  const pick = routed.answer.pick
  expect(pick).toMatchObject({ kind: 'new', engine: 'claude', model: 'sonnet', effort: 'medium' })
  const request = { conversationId: 'g1', machineId: pick.machineId, engine: pick.engine, model: pick.model, effort: pick.effort, name: 'Builder',
    cwd, worktree: false, permissionMode: 'auto', requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false },
    routeDecisionId: routed.answer.routeDecisionId }
  let started = await start('route-start', request)
  if (started.answer.error === 'START_PENDING') {
    expect(started.answer).toMatchObject({ startId: 'start-route-start', creationId: 'super-start-route-start' })
    await until('routed Claude Code session to bind', async () => {
      const listed = await client.request('agents_list', {}, 30_000)
      return (listed.agents as Array<{ id: string; sessionId?: string }>).some(a =>
        a.id !== leadHarness && a.id !== workerHarness && !!a.sessionId) || null
    }, 60_000, 250)
    started = await resume(started.answer.startId)
  }
  expect(started.code, JSON.stringify(started.answer)).toBe(0)
  expect(started.answer.harnessId).toBeTruthy()
  expect(commands.filter(c => c.command.type === 'agent.start')).toHaveLength(1)
  const command = commands.find(c => c.command.type === 'agent.start')!.command
  // The decision rides on the command, never inside the machine-side request.
  expect(command.routeDecisionId).toBe('d-1')
  expect(command.request).toMatchObject({ model: 'sonnet', effort: 'medium', engine: 'claude' })
  expect(command.request).not.toHaveProperty('routeDecisionId')
  const listed = await client.request('agents_list', {}, 30_000)
  expect((listed.agents as Array<{ id: string }>).some(a => a.id === started.answer.harnessId)).toBe(true)
  // The routed model is a flag of that session alone: it is on the new agent's command line, and nothing typed
  // /model into its pane, which Claude Code would save as the person's default.
  const launches = readFileSync(join(daemon!.engineConfig.root, 'launch-argv'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { engine: string; args: string[] })
  const routedLaunch = launches.filter(l => l.engine === 'claude' && l.args.includes('--model'))
  expect(routedLaunch).toHaveLength(1)
  expect(routedLaunch[0]!.args.slice(routedLaunch[0]!.args.indexOf('--model'))).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'medium']))
  expect(existsSync(join(daemon!.engineConfig.root, 'model-control-commands'))).toBe(false)
}, 240_000)
