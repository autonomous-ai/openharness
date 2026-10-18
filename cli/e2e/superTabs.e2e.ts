/** Super Tab on the actual native protocol: real master/services, private tmux,
 * fake engines and loopback coordination. Database authorization/transactions
 * are covered separately by backend's replica-set integration tests. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { object } from '../src/superTabs/wire.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

const ME: FakeMachine = { machineId: 'b8'.repeat(16), computerId: 'e2e-super-tab-computer', name: 'Fixture', token: 'e2e-super-tab-token' }
const TAB = 'fixture-tab'
let daemon: IsolatedDaemon | undefined, backend: FakeBackend | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.close())
  await daemon?.close(); daemon = undefined
  await backend?.close(); backend = undefined
})

it('starts either engine once, posts to its captured group and delivers shared input through the native core', async () => {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
  } }); daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-160).join('\n')))
  const agents: Array<Record<string, any>> = []
  const starts = new Map<string, Record<string, any>>()
  const posts: Array<Record<string, any>> = []
  const pending = new Map<string, Record<string, any>>()
  const assignments: Array<Record<string, string>> = []
  const stopReceipts: Array<Record<string, any>> = []
  let revision = 0, allowed = true, deliveryReads = 0
  const idFor = (harnessId: string) => createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)
  relay.superTabs = async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: assignments }
    if (path.endsWith('/stopped')) { stopReceipts.push(body); assignments.length = 0; return { data: { confirmed: true } } }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: allowed ? agents.map(agent => ({ tabId: TAB, agent, observers: [] })) : [] }
    if (!allowed) return { status: 403, error: { code: 'FORBIDDEN', message: 'The contribution was withdrawn.' } }
    if (path === `/api/super-tabs/${TAB}`) return { data: { revision, state: { id: TAB, agents } } }
    if (path.startsWith(`/api/super-tabs/${TAB}/starts/`)) return { data: starts.get(path.split('/').at(-1)!) }
    if (path.endsWith('/commands')) {
      const command = object(body.command)
      if (command.type === 'agent.start') {
        const startId = `start-${body.operationId}`
        if (!starts.has(startId)) starts.set(startId, { id: startId, creationId: `super-${startId}`, request: command.request, dispatched: false, harnessId: null })
        return { data: { result: { startId } } }
      }
      const start = starts.get(String(command.startId))
      if (command.type === 'agent.startDispatch') {
        if (start!.dispatched) throw new Error('Duplicate dispatch')
        start!.dispatched = true
      } else if (command.type === 'agent.started') {
        start!.harnessId = command.harnessId
        const id = idFor(String(command.harnessId))
        if (!agents.some(a => a.id === id)) agents.push({ id, harnessId: command.harnessId, machineId: ME.machineId, configuration: command.configuration })
        return { data: { result: { agentId: id } } }
      } else if (command.type === 'message.send') posts.push(command)
      else if (command.type === 'agent.startFailed') start!.error = command.error
      else throw new Error(`Unexpected command ${command.type}`)
      revision++
      return { data: { result: {} } }
    }
    const delivery = /\/agents\/([^/]+)\/deliveries(?:\/([^/]+))?$/.exec(path)
    if (delivery) {
      const value = pending.get(delivery[1])
      if (method === 'GET') {
        deliveryReads++
        return { data: delivery[2] ? value : value && value.status !== 'delivered' ? [value] : [] }
      }
      if (!value || value.id !== delivery[2]) throw new Error('Unknown delivery')
      if (value.claimId && value.claimId !== body.claimId) throw new Error('Claim changed')
      if (body.type === 'claim') {
        value.claimId = body.claimId
        return { data: { message: value.message } }
      }
      value.status = body.uncertain ? 'uncertain' : 'delivered'
      value.receipt = body.receipt
      return { data: {} }
    }
    throw new Error(`Unexpected request ${method} ${raw}`)
  }
  await d.start()
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'project'); mkdirSync(cwd, { recursive: true })
  const lead = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
  expect(lead.error, JSON.stringify(lead)).toBeUndefined()
  const leadId = idFor(lead.agent.id)
  agents.push({ id: leadId, machineId: ME.machineId, harnessId: lead.agent.id })
  const where = { port: d.port, dataDir: d.dataDir, machineId: ME.machineId, harnessPane: true }
  async function run(args: string[], agent = leadId) {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', TAB, '--agent', agent, ...args], { where: () => where,
      print: text => { answer = JSON.parse(text) } })
    return { code, answer }
  }
  for (const engine of ['claude', 'codex']) {
    const request = { conversationId: 'feature', machineId: ME.machineId, engine, name: `Builder ${engine}`,
      cwd, worktree: false, permissionMode: 'auto', requirements: { memoryBytes: 0, diskBytes: 1,
        maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false } }
    let started = await run(['start', engine, JSON.stringify(request)])
    if (started.answer.error === 'START_PENDING') started = await until('native creation to finish', async () => {
      const result = await run(['resume', `start-${engine}`])
      return result.answer.error === 'START_PENDING' ? null : result
    }, 60_000, 500)
    expect(started.code, JSON.stringify(started.answer)).toBe(0)
    expect(started.answer.harnessId).toBeTruthy()
    const same = await run(['start', engine, JSON.stringify(request)])
    expect(same.answer.harnessId).toBe(started.answer.harnessId)
    const target = idFor(started.answer.harnessId)
    const posted = await run(['post', 'feature', `${engine} ready`, `hello-${engine}`], target)
    expect(posted.code, JSON.stringify(posted.answer)).toBe(0)
    expect(posts.at(-1)).toMatchObject({ conversationId: 'feature', text: `${engine} ready` })
    pending.set(target, { id: `delivery-${engine}`, status: 'queued', claimId: null,
      message: { id: `message-${engine}`, conversationId: 'feature', author: { name: 'Fixture human' }, text: `verify-super-tab-${engine}` } })
    await until('native input acknowledgement', () => pending.get(target)?.status === 'delivered' || null, 60_000, 250)
    const submitted = readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string)
    expect(submitted.filter(prompt => prompt.includes(`verify-super-tab-${engine}`))).toHaveLength(1)
  }
  // The backend survived, but this host has no local intent/receipt. It must
  // surface the missing evidence without creating a new claim or typing again.
  const orphan = { id: 'delivery-without-journal', status: 'claimed', claimId: 'original-claim', receipt: '',
    message: { id: 'message-without-journal', conversationId: 'lead', author: { name: 'Fixture human' }, text: 'do-not-replay-without-journal' } }
  pending.set(leadId, orphan)
  await until('missing journal to become visible for recovery', () => orphan.status === 'uncertain' || null, 15_000, 250)
  expect(orphan.claimId).toBe('original-claim')
  expect(orphan.receipt).toContain('no local receipt')
  const reads = deliveryReads
  await until('further host polls without replay', () => deliveryReads > reads + 3 || null, 10_000, 250)
  expect(readFileSync(join(d.root, 'submitted-prompts'), 'utf8')).not.toContain('do-not-replay-without-journal')
  const refused = await run(['start', 'refused-mode', JSON.stringify({
    conversationId: 'feature', machineId: ME.machineId, engine: 'claude', name: 'Refused builder',
    cwd, worktree: false, permissionMode: 'not-a-mode', requirements: { memoryBytes: 0, diskBytes: 1,
      maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
  })])
  expect(refused.code, JSON.stringify(refused.answer)).toBe(1)
  expect(refused.answer).toMatchObject({ error: 'START_FAILED', detail: expect.stringContaining('permission mode') })
  expect(starts.get('start-refused-mode')!.error).toContain('before starting an agent')
  const creationId = starts.get('start-refused-mode')!.creationId
  expect(await client.request('agent_create_status', { creationId })).toMatchObject({ creationId, state: 'cancelled' })
  // Even a delayed valid create cannot revive the cancelled request.
  expect(await client.request('agent_create', { engine: 'claude', cwd, creationId }, 30_000)).toMatchObject({ creationId, state: 'cancelled' })
  expect((await run(['resume', 'start-refused-mode'])).answer).toMatchObject({ error: 'START_FAILED' })
  const listed = await client.request('agents_list')
  expect(listed.agents).toHaveLength(3)
  const worker = listed.agents.find((a: Record<string, any>) => a.id === starts.get('start-claude')!.harnessId)
  assignments.push({ tabId: TAB, assignmentId: 'worker-attempt', harnessId: worker.id })
  const closed = await client.request('agent_close', { agentId: worker.id, sessionId: worker.sessionId, createdAt: worker.createdAt, mode: 'now' }, 60_000)
  expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true })
  await until('execution host to confirm the stop', () => stopReceipts.length === 1 || null, 15_000, 250)
  expect(stopReceipts[0]).toMatchObject({ assignmentId: 'worker-attempt', receipt: expect.stringContaining('native-stopped:') })
  allowed = false
  const denied = await run(['post', 'feature', 'not allowed', 'after-removal'])
  expect(denied.code).toBe(1)
  expect(posts.some(p => p.text === 'not allowed')).toBe(false)
}, 300_000)
