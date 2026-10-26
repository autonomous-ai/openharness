/** Two accounts with no machine share. The owner executes a tab-scoped queue;
 * Mongo integration tests cover authorization, while this exercises real native receipts. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { overOldRoutes } from './harness/swarmReads.js'

let relay: FakeBackend | undefined
const daemons: IsolatedDaemon[] = [], clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(c => c.close())
  await Promise.allSettled(daemons.splice(0).map(d => d.close()))
  await relay?.close(); relay = undefined
})

it.each(['project', 'swarm'])('queues a teammate start with %s capacity and resumes the same native receipt', async scope => {
  const backend = await FakeBackend.start(); relay = backend
  const specs = [
    { machineId: 'd1'.repeat(16), computerId: 'pool-lead-fixture', name: 'Lead fixture', token: 'fixture-lead-token', account: 'lead', email: 'lead@example.com' },
    { machineId: 'd2'.repeat(16), computerId: 'pool-member-fixture', name: 'Member fixture', token: 'fixture-member-token', account: 'member', email: 'member@example.com' },
  ]
  for (const spec of specs) {
    backend.addMachine(spec)
    const d = await signedInDaemon(backend, spec, { ANTHROPIC_API_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-only' })
    daemons.push(d)
    writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  }
  const [a, b] = daemons, [leadMachine, memberMachine] = specs
  const project = join(b.projectsDir, 'contributed'); mkdirSync(project, { recursive: true })
  const agents: Array<Record<string, any>> = [], starts = new Map<string, Record<string, any>>()
  let generation = 'grant-1', observations = 0
  const pool = { machineId: memberMachine.machineId, generation,
    cwd: scope === 'swarm' ? join(b.env.HOME!, 'harnesses', 'swarms', 'pool-tab') : project,
    ...(scope === 'swarm' ? { scope } : {}), engines: ['codex'], maxAgents: 2, paused: false }
  const projects = scope === 'swarm' ? [{ id: 'lead', conversationIds: ['lead'],
    repository: { machineId: memberMachine.machineId, cwd: project, repositoryUrl: null } }] : undefined
  const id = (machine: string, harness: string) => createHash('sha256').update(JSON.stringify([machine, harness])).digest('hex').slice(0, 24)
  backend.superTabs = overOldRoutes(async (method, raw, body, caller) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/pools')) {
      expect(path.split('/')[4]).toBe(caller.machineId)
      return { data: caller.machineId === memberMachine.machineId && generation ? [{ tabId: 'pool-tab', machine: pool, projects, starts: [...starts.values()].filter(s => !s.harnessId || !s.poolSettled), harnessIds: agents.filter(a => a.machineId === caller.machineId).map(a => a.harnessId) }] : [] }
    }
    if (path.includes('/hosts/') && path.includes('/starts/')) {
      expect(caller.account).toBe('member')
      const start = starts.get(path.split('/').at(-1)!)!
      if (method === 'GET') return { data: start }
      const c = body.command
      if (c.type === 'agent.startDispatch') { expect(start.dispatched).toBe(false); start.dispatched = true }
      else if (c.type === 'agent.started') {
        start.harnessId = c.harnessId
        if (!agents.some(a => a.harnessId === c.harnessId)) agents.push({ id: id(caller.machineId, c.harnessId), machineId: caller.machineId, harnessId: c.harnessId, configuration: c.configuration })
      } else if (c.type === 'agent.startSettled') start.poolSettled = true
      else throw new Error(`Unexpected host operation ${c.type}`)
      return { data: { result: {} } }
    }
    if (path.includes('/hosts/')) return { data: path.endsWith('/assignments') ? [] : agents.filter(a => a.machineId === caller.machineId).map(agent => ({ tabId: 'pool-tab', agent, observers: [] })) }
    if (path.includes('/machines/')) { expect(caller.account).toBe('member'); expect(body.generation).toBe(generation); observations++; return { data: { revision: observations } } }
    if (path === '/api/super-tabs/pool-tab') return { data: { state: { id: 'pool-tab', agents, projects, project: { machineId: memberMachine.machineId, cwd: project, repositoryUrl: null } }, revision: observations } }
    if (path.includes('/starts/')) return { data: starts.get(path.split('/').at(-1)!) }
    if (path.endsWith('/commands')) {
      const c = body.command
      if (c.type === 'agent.start') {
        expect(caller.account).toBe('lead')
        const startId = `start-${body.operationId}`
        if (!starts.has(startId)) starts.set(startId, { id: startId, poolGeneration: generation, creationId: `super-${startId}`, request: c.request, dispatched: false, harnessId: null })
        return { data: { result: { startId } } }
      }
      if (c.type === 'agent.configuration') return { data: { result: {} } }
      throw new Error(`Unexpected caller operation ${c.type}`)
    }
    if (path.endsWith('/deliveries')) return { data: [] }
    throw new Error(`Unexpected pool request ${path}`)
  })
  onTestFailed(() => daemons.forEach(d => console.log(d.log().split('\n').slice(-75).join('\n'))))
  await Promise.all(daemons.map(d => d.start()))
  await until('both fixture accounts connected', () => backend.nodeUp(leadMachine.machineId) && backend.nodeUp(memberMachine.machineId), 30000)
  const onA = await LocalClient.connect(a, { machineId: leadMachine.machineId }), onB = await LocalClient.connect(b, { machineId: memberMachine.machineId }); clients.push(onA, onB)
  const setup = { action: 'prepareContribution', tabId: 'pool-tab', operationId: 'fixture-setup', ...(scope === 'swarm' ? { scope } : {}) }
  const prepared = await until('one-field machine preparation', async () => {
    const value = await onB.request('super_tabs', setup, 30000)
    expect(value.error, JSON.stringify(value)).toBeUndefined()
    return value.state === 'ready' ? value : null
  }, 45000, 250)
  expect(prepared.cwd).toBe(pool.cwd)
  if (scope === 'swarm') expect(prepared.scope).toBe('swarm')
  expect(prepared.engines).toEqual(expect.arrayContaining(['claude', 'codex']))
  expect(prepared.maxAgents).toBeGreaterThan(0)
  expect((await onB.request('agents_list')).agents).toHaveLength(0)
  const { requestId: _requestId, ...receipt } = prepared
  expect(await onB.request('super_tabs', setup)).toMatchObject(receipt)
  const lead = await onA.request('agent_create', { engine: 'claude', cwd: a.projectsDir }, 90000)
  expect(lead.error, JSON.stringify(lead)).toBeUndefined()
  const leadId = id(leadMachine.machineId, lead.agent.id)
  agents.push({ id: leadId, machineId: leadMachine.machineId, harnessId: lead.agent.id })
  await onB.request('super_tabs', { action: 'wake' }, 30000)
  await until('owner reports contributed capacity', () => observations > 0, 45000)
  async function run(args: string[]) {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', 'pool-tab', '--agent', leadId, ...args], { where: () => ({ port: a.port, dataDir: a.dataDir, machineId: leadMachine.machineId, harnessPane: true }), print: line => { answer = JSON.parse(line) } })
    return { code, answer }
  }
  const request = { conversationId: 'lead', machineId: memberMachine.machineId, engine: 'codex', name: 'Pool builder', cwd: project, worktree: false,
    requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
  const queued = await run(['start', 'pool-builder', JSON.stringify(request)])
  expect(queued.answer, JSON.stringify(queued)).toMatchObject({ ok: true, queued: true })
  const joined = await until('owner completes the queued native receipt', async () => {
    const answer = (await run(['resume', queued.answer.startId])).answer
    return answer.harnessId ? answer : null
  }, 90000, 500)
  expect((await onB.request('agents_list')).agents).toHaveLength(1)
  expect((await onA.request('agents_list')).agents).toHaveLength(1)
  expect((await run(['start', 'pool-builder', JSON.stringify(request)])).answer.harnessId).toBe(joined.harnessId)
  expect((await onB.request('shared_machines', { action: 'get' })).emails).not.toContain(leadMachine.email)
  generation = ''
})
