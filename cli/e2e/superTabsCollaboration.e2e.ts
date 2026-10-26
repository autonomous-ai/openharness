/** Two accounts, two real daemons and an encrypted remote machine connection.
 * Coordination uses the loopback fixture; database policy is exercised separately
 * by backend/integration/superTabs.test.ts against a disposable replica set. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { b64e, newIdentity } from '../src/lib/e2ee/core.js'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon, writeE2ee } from './harness/fleet.js'
import { overOldRoutes } from './harness/swarmReads.js'

const TAB = 'shared-work', GROUP = 'offline-editing'
let backend: FakeBackend | undefined
const daemons: IsolatedDaemon[] = [], clients: LocalClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await Promise.allSettled(daemons.splice(0).map(daemon => daemon.close()))
  await backend?.close(); backend = undefined
})

it('coordinates an owner-contributed agent while keeping guest machine access separate', async () => {
  const relay = await FakeBackend.start(); backend = relay
  const specs = [
    { machineId: 'a6'.repeat(16), computerId: 'super-tab-starter', name: 'Starter Mac', token: 'fixture-starter-token', account: 'starter', email: 'starter@example.com', identity: newIdentity() },
    { machineId: 'b6'.repeat(16), computerId: 'super-tab-member', name: 'Member Mac', token: 'fixture-member-token', account: 'member', email: 'member@example.com', identity: newIdentity() },
  ]
  for (const spec of specs) {
    relay.addMachine({ ...spec, pub: b64e(spec.identity.pub) })
    const daemon = await signedInDaemon(relay, spec, {
      ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
    })
    daemons.push(daemon)
    await writeE2ee(daemon, { 'identity.json': { priv: b64e(spec.identity.priv), pub: b64e(spec.identity.pub) } })
    writeFileSync(join(daemon.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  }
  const [starter, member] = specs, [a, b] = daemons
  onTestFailed(() => daemons.forEach((daemon, i) => console.log(`Fixture machine ${i}:\n${daemon.log().split('\n').slice(-90).join('\n')}`)))
  const agents: Array<Record<string, any>> = [], messages: Array<Record<string, any>> = []
  const starts = new Map<string, Record<string, any>>(), pending = new Map<string, Record<string, any>>()
  const contexts = new Map<string, Record<string, any>>(), observations: Array<Record<string, any>> = []
  const groups = new Map<string, Set<string>>([[GROUP, new Set()]])
  let revision = 0, contributionAllowed = true
  const agentId = (machine: string, harness: string) => createHash('sha256').update(JSON.stringify([machine, harness])).digest('hex').slice(0, 24)
  const failure = () => ({ status: 403, error: { code: 'FORBIDDEN', message: 'This contribution is no longer shared.' } })
  relay.superTabs = overOldRoutes(async (method, raw, body, caller) => {
    const path = new URL(raw, relay.httpUrl).pathname
    if (path.startsWith('/api/super-tabs/hosts/')) {
      expect(path.split('/')[4]).toBe(caller.machineId)
      return { data: path.endsWith('/assignments') ? [] : contributionAllowed
        ? agents.filter(agent => agent.machineId === caller.machineId).map(agent => ({ tabId: TAB, agent, observers: [] })) : [] }
    }
    if (!contributionAllowed) return failure()
    if (path === `/api/super-tabs/${TAB}/native` && method === 'POST') {
      expect(caller.account).toBe(member.account)
      const target = agents.find(agent => agent.id === body.agentId)!
      contexts.set(body.operationId, { contextId: body.operationId, tabId: TAB, conversationId: body.conversationId,
        harnessId: target.harnessId, machineId: target.machineId, operatorAccount: caller.account, lastEventId: null })
      return { data: { contextId: body.operationId } }
    }
    if (path.startsWith(`/api/super-tabs/${TAB}/native/`)) {
      const context = contexts.get(path.split('/').at(-1)!)!
      expect(caller.machineId).toBe(context.machineId)
      if (method === 'GET') return { data: context }
      const eventId = createHash('sha256').update(JSON.stringify(['native-event', context.contextId, body.turnId, body.kind])).digest('hex').slice(0, 24)
      if (!observations.some(row => row.eventId === eventId)) {
        expect(body.previousEventId).toBe(context.lastEventId)
        observations.push({ ...body, eventId, operatorAccount: context.operatorAccount, executionAccount: caller.account, conversationId: context.conversationId })
        context.lastEventId = eventId
      }
      return { data: { eventId } }
    }
    if (path === `/api/super-tabs/${TAB}`) return { data: { revision, state: { id: TAB, agents } } }
    if (path.includes('/starts/')) return { data: starts.get(path.split('/').at(-1)!) }
    if (path.endsWith('/commands')) {
      const command = body.command, author = body.asAgentId ? agents.find(agent => agent.id === body.asAgentId)! : null
      if (author) expect(author.machineId).toBe(caller.machineId)
      if (command.type === 'agent.add') {
        expect(caller.account).toBe(member.account)
        expect(command.machineId).toBe(member.machineId)
        const id = agentId(command.machineId, command.harnessId)
        agents.push({ id, machineId: command.machineId, harnessId: command.harnessId, configuration: command.configuration })
        groups.get(GROUP)!.add(id)
        return { data: { result: { agentId: id } } }
      }
      if (command.type === 'agent.start') {
        const startId = `start-${body.operationId}`
        if (!starts.has(startId)) starts.set(startId, { id: startId, creationId: `super-${startId}`, request: command.request, dispatched: false, harnessId: null })
        return { data: { result: { startId } } }
      }
      if (command.type === 'agent.startDispatch') {
        const start = starts.get(command.startId)!
        expect(start.dispatched).toBe(false); start.dispatched = true
      } else if (command.type === 'agent.started') {
        const start = starts.get(command.startId)!, id = agentId(start.request.machineId, command.harnessId)
        start.harnessId = command.harnessId
        if (!agents.some(agent => agent.id === id)) agents.push({ id, machineId: start.request.machineId, harnessId: command.harnessId, configuration: command.configuration })
        groups.get(GROUP)!.add(id)
        return { data: { result: { agentId: id } } }
      } else if (command.type === 'agent.configuration') {
        author!.configuration = command.configuration; author!.configurationVersion = body.operationId
      } else if (command.type === 'conversation.agent') {
        (groups.get(command.conversationId) ?? groups.set(command.conversationId, new Set()).get(command.conversationId)!).add(command.agentId)
      } else if (command.type === 'message.send') {
        const message = { id: `message-${++revision}`, conversationId: command.conversationId,
          text: command.text, author: { name: author?.id ?? caller.email, account: caller.account }, recipientIds: command.recipientIds }
        messages.push(message)
        for (const id of command.recipientIds) pending.set(id, { id: `delivery-${revision}-${id}`, status: 'queued', claimId: null, message })
      } else throw new Error(`Unexpected command ${command.type}`)
      return { data: { result: {} } }
    }
    const delivery = /\/agents\/([^/]+)\/deliveries(?:\/([^/]+))?$/.exec(path)
    if (delivery) {
      const target = agents.find(agent => agent.id === delivery[1])!
      expect(target.machineId).toBe(caller.machineId)
      const value = pending.get(target.id)
      if (method === 'GET') return { data: delivery[2] ? value : value && value.status !== 'delivered' ? [value] : [] }
      expect(body.claimId).toBe(value!.claimId ?? body.claimId)
      if (body.type === 'claim') { value!.claimId = body.claimId; return { data: { message: value!.message } } }
      value!.status = body.uncertain ? 'uncertain' : 'delivered'
      return { data: {} }
    }
    throw new Error(`Unexpected route ${method} ${path}`)
  })
  await Promise.all(daemons.map(daemon => daemon.start()))
  await until('both accounts connected', () => relay.nodeUp(starter.machineId) && relay.nodeUp(member.machineId), 30_000)
  const onA = await LocalClient.connect(a, { machineId: starter.machineId }), onB = await LocalClient.connect(b, { machineId: member.machineId })
  clients.push(onA, onB)
  // The gateway connects before all edge services finish starting. Observe
  // readiness with a read; never replay the sharing mutation to warm the host.
  await Promise.all([onA, onB].map(client => until('shared machines service ready', async () => {
    const policy = await client.request('shared_machines', { action: 'get' }, 30_000)
    return policy.error === 'SERVICE_UNAVAILABLE' ? null : policy
  }, 30_000)))
  expect(await onB.request('shared_machines', { action: 'set', emails: [starter.email], sameDomain: false }, 30_000)).toMatchObject({ emails: [starter.email] })
  expect(await onA.request('shared_machines', { action: 'add', machineId: member.machineId }, 30_000)).toMatchObject({ ok: true })
  await until('shared machine pinned', () => {
    try { return JSON.parse(readFileSync(join(a.dataDir, 'e2e', 'machinePeers.json'), 'utf8')).some((peer: any) => peer.machineId === member.machineId && peer.shared) || null } catch { return null }
  }, 30_000)
  const projectA = join(a.projectsDir, 'project'), projectB = join(b.projectsDir, 'project')
  mkdirSync(projectA, { recursive: true }); mkdirSync(projectB, { recursive: true })
  const lead = await onA.request('agent_create', { engine: 'claude', cwd: projectA, bypassPermission: true }, 90_000)
  expect(lead.error, JSON.stringify(lead)).toBeUndefined()
  const leadId = agentId(starter.machineId, lead.agent.id)
  agents.push({ id: leadId, machineId: starter.machineId, harnessId: lead.agent.id }); groups.get(GROUP)!.add(leadId)
  const where = { port: a.port, dataDir: a.dataDir, machineId: starter.machineId, harnessPane: true }
  async function run(args: string[]) {
    let answer: Record<string, any> = {}
    const code = await superTabCommand(['--tab', TAB, '--agent', leadId, ...args], { where: () => where, print: line => { answer = JSON.parse(line) } })
    return { code, answer }
  }
  const request = { conversationId: GROUP, machineId: member.machineId, engine: 'codex', name: 'Member builder', cwd: projectB,
    worktree: false, permissionMode: 'auto', requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false } }
  const attempted = await run(['start', 'remote-builder', JSON.stringify(request)])
  expect(attempted.answer).toMatchObject({ error: 'CONTRIBUTION_REQUIRED', detail: expect.stringContaining('Add machine') })
  expect((await onB.request('agents_list')).agents).toHaveLength(0)
  // Sharing now gives a guest its own OS user, not the owner's Swarm controls.
  // The owner can contribute a running agent; owner-dispatched machine starts
  // are exercised separately in superTabMachines.e2e.ts.
  const owned = await onB.request('agent_create', { engine: 'codex', cwd: projectB }, 90_000)
  expect(owned.error, JSON.stringify(owned)).toBeUndefined()
  const harnessId = owned.agent.id as string
  const workerId = agentId(member.machineId, harnessId)
  expect(await onB.request('super_tabs', { action: 'backend', method: 'POST', path: `/api/super-tabs/${TAB}/commands`,
    body: { operationId: 'contribute-worker', command: { type: 'agent.add', conversationId: GROUP,
      machineId: member.machineId, harnessId, name: 'Member builder', configuration: { engine: 'codex' }, lead: false } } }))
    .toMatchObject({ value: { result: { agentId: workerId } } })
  await onB.request('super_tabs', { action: 'wake' })
  expect((await onB.request('agents_list')).agents).toHaveLength(1)
  expect((await onA.request('agents_list')).agents).toHaveLength(1)
  const viaA = await LocalClient.connect(a, { machineId: member.machineId }); clients.push(viaA)
  // Machine control does not make the member's account a proxy for the starter.
  expect(await viaA.request('super_tabs', { action: 'backend', method: 'GET', path: `/api/super-tabs/${TAB}` }))
    .toMatchObject({ error: 'GUEST_NOT_ALLOWED' })
  expect((await run(['command', 'assign-instruction', JSON.stringify({ type: 'message.send', conversationId: GROUP,
    text: 'Verify offline editing on the member machine', replyTo: null, recipientIds: [workerId] })])).code).toBe(0)
  await until('member host delivers the lead instruction', () => pending.get(workerId)?.status === 'delivered' || null, 45_000)
  expect(messages.at(-1)!.author.account).toBe(starter.account)
  expect(await onB.request('super_tabs', { action: 'command', tabId: TAB, agentId: workerId, operationId: 'member-result',
    command: { type: 'message.send', conversationId: GROUP, text: 'The member machine verified the requested behavior.', replyTo: null, recipientIds: [leadId] } }))
    .toMatchObject({ ok: true })
  await until('starter host delivers the member result', () => pending.get(leadId)?.status === 'delivered' || null, 45_000)
  expect(messages.at(-1)!.author.account).toBe(member.account)
  expect((await run(['command', 'reuse-member', JSON.stringify({ type: 'conversation.agent', conversationId: 'onboarding', agentId: workerId, present: true, lead: false })])).code).toBe(0)
  expect(groups.get('onboarding')!.has(workerId)).toBe(true)
  expect((await onB.request('agents_list')).agents).toHaveLength(1)
  const contextId = 'member-on-own-terminal'
  expect(await onB.request('super_tabs', { action: 'backend', method: 'POST', path: `/api/super-tabs/${TAB}/native`,
    body: { operationId: contextId, conversationId: GROUP, agentId: workerId } })).toMatchObject({ value: { contextId } })
  expect(await viaA.request('super_tabs', { action: 'prepareNative', tabId: TAB, contextId })).toMatchObject({ error: 'GUEST_NOT_ALLOWED' })
  expect(await onB.request('super_tabs', { action: 'prepareNative', tabId: TAB, contextId })).toMatchObject({ inputContext: contextId })
  const ready = onB.next(frame => frame.type === 'terminal_ready' && frame.payload?.requestId === 'member-terminal')
  onB.send('terminal_open', { requestId: 'member-terminal', protocolVersion: 3, agentId: harnessId, cols: 100, rows: 30, inputContext: contextId })
  const streamId = (await ready).payload!.streamId as string
  await onB.waitForBinary(frame => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe)
  onB.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from('Keep this change focused') })
  onB.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: Buffer.from('\r') })
  await until('remote terminal observation', () => observations.length >= 2 || null, 30_000)
  expect(observations.map(row => row.kind)).toEqual(['prompt', 'answer'])
  expect(observations.every(row => row.operatorAccount === member.account && row.executionAccount === member.account && row.conversationId === GROUP)).toBe(true)
  expect([...relay.webSent.values()].flat().filter(frame => ['super_tabs', 'agent_create', 'terminal_open'].includes(String(frame.type)))
    .every(frame => !!(frame.payload as any)?.__e2e)).toBe(true)
  contributionAllowed = false
  expect(await onB.request('shared_machines', { action: 'set', emails: [], sameDomain: false }, 30_000)).toMatchObject({ emails: [] })
  await until('removed machine connection closes', () => viaA.closed || null, 30_000)
  expect((await run(['post', GROUP, 'Cannot post after withdrawal', 'after-withdrawal'])).code).toBe(1)
  expect((await onB.request('agents_list')).agents).toHaveLength(1)
}, 240_000)
