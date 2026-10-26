/** Super Tab on the actual native protocol: real master/services, private tmux,
 * fake engines and loopback coordination. Database authorization/transactions
 * are covered separately by backend's replica-set integration tests. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { object } from '../src/superTabs/wire.js'
import { retainedHarnesses } from '../src/superTabs/retention.js'
import { screenFor } from '../src/engines/screens.js'
import { TerminalBinaryKind } from '../src/lib/terminalBinary.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { overOldRoutes } from './harness/swarmReads.js'

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
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-160).join('\n')))
  const agents: Array<Record<string, any>> = []
  const starts = new Map<string, Record<string, any>>()
  const posts: Array<Record<string, any>> = []
  const tasks: Array<Record<string, any>> = []
  const pending = new Map<string, Record<string, any>>()
  const assignments: Array<Record<string, string>> = []
  const stopReceipts: Array<Record<string, any>> = []
  const nativeContexts = new Map<string, Record<string, any>>()
  const nativeRecords = new Map<string, Record<string, any>>()
  const nativeSends: Array<Record<string, any>> = []
  let loseNativeReply = true
  let revision = 0, allowed = true, deliveryReads = 0
  const idFor = (harnessId: string) => createHash('sha256').update(JSON.stringify([ME.machineId, harnessId])).digest('hex').slice(0, 24)
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const url = new URL(raw, relay.httpUrl), path = url.pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}/pools`) return { data: [] }
    if (path === `/api/super-tabs/hosts/${ME.machineId}/assignments`) return { data: assignments }
    if (path.endsWith('/stopped')) { stopReceipts.push(body); assignments.length = 0; return { data: { confirmed: true } } }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: allowed ? agents.map(agent => ({ tabId: TAB, agent, stopRequested: agent.workDecision === 'stop', observers: [] })) : [] }
    if (!allowed) return { status: 403, error: { code: 'FORBIDDEN', message: 'The contribution was withdrawn.' } }
    if (path === `/api/super-tabs/${TAB}/native` && method === 'POST') {
      const agent = agents.find(a => a.id === body.agentId)!
      const contextId = body.operationId
      nativeContexts.set(contextId, { contextId, tabId: TAB, conversationId: body.conversationId,
        machineId: ME.machineId, harnessId: agent.harnessId, lastEventId: null })
      return { data: { contextId } }
    }
    if (path.startsWith(`/api/super-tabs/${TAB}/native/`)) {
      const contextId = path.split('/').at(-1)!, context = nativeContexts.get(contextId)!
      if (method === 'GET') return { data: context }
      nativeSends.push({ ...body, contextId })
      const eventId = createHash('sha256').update(JSON.stringify(['native-event', contextId, body.turnId, body.kind])).digest('hex').slice(0, 24)
      if (nativeRecords.has(eventId)) expect(nativeRecords.get(eventId)).toEqual({ ...body, contextId })
      else {
        expect(body.previousEventId).toBe(context.lastEventId)
        nativeRecords.set(eventId, { ...body, contextId }); context.lastEventId = eventId
      }
      if (loseNativeReply) { loseNativeReply = false; return { status: 503, error: { code: 'BACKEND_UNAVAILABLE', message: 'Lost fixture reply' } } }
      return { data: { eventId } }
    }
    if (path === `/api/super-tabs/${TAB}`) return { data: { revision, state: { id: TAB, agents, conversations: [] } } }
    if (path === `/api/super-tabs/${TAB}/conversations/feature/messages`) {
      expect(agents.some(agent => agent.id === url.searchParams.get('asAgentId'))).toBe(true)
      return { data: { messages: [{ id: url.searchParams.get('messageId'), text: 'Should the offline queue survive restart?' }] } }
    }
    if (path.startsWith(`/api/super-tabs/${TAB}/starts/`)) return { data: starts.get(path.split('/').at(-1)!) }
    if (path.endsWith('/commands')) {
      const command = object(body.command)
      if (command.type === 'agent.start') {
        const startId = `start-${body.operationId}`
        if (!starts.has(startId)) starts.set(startId, { id: startId, creationId: `super-${startId}`, request: command.request, dispatched: false, harnessId: null })
        return { data: { result: { startId } } }
      }
      if (command.type === 'agent.stopLease') return { data: { result: { expiresAt: Date.now() + 120_000, durationMs: 120_000 } } }
      const start = starts.get(String(command.startId))
      if (command.type === 'agent.startDispatch') {
        if (start!.dispatched) throw new Error('Duplicate dispatch')
        start!.dispatched = true
      } else if (command.type === 'agent.started') {
        start!.harnessId = command.harnessId
        const id = idFor(String(command.harnessId))
        if (!agents.some(a => a.id === id)) agents.push({ id, harnessId: command.harnessId, machineId: ME.machineId, configuration: command.configuration,
          ...(command.startedSession ? { startedSession: { ...object(command.startedSession), creationId: start!.creationId } } : {}) })
        return { data: { result: { agentId: id } } }
      } else if (command.type === 'conversation.create') {
        tasks.push(body)
        if (command.task) return { status: 400, error: { code: 'VALIDATION_ERROR', message: 'command: Unrecognized key: "task"' } }
      } else if (command.type === 'message.send') posts.push(command)
      else if (command.type === 'agent.configuration') {
        const agent = agents.find(a => a.id === body.asAgentId)!
        if ((agent.configurationVersion ?? null) !== command.previousVersion) throw new Error('Stale configuration')
        agent.configuration = command.configuration
        agent.configurationVersion = body.operationId
      }
      else if (command.type === 'agent.remove') {
        const index = agents.findIndex(a => a.id === command.agentId)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(agents[index]).toMatchObject({ workDecision: 'stop', releaseId: command.releaseId })
        agents.splice(index, 1)
      }
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
  })
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
  const task = { goal: 'Keep drafts', changes: 'Persist edits', constraints: 'No dependencies', owns: ['cli/src/superTabs'] }
  const taskCommand = { type: 'conversation.create', title: 'Drafts', task, checks: [{ description: 'Draft survives restart', independent: false }] }
  expect((await run(['command', 'missing-task', JSON.stringify({ ...taskCommand, task: undefined })])).answer).toMatchObject({ error: 'TASK_REQUIRED' })
  expect(tasks).toHaveLength(0)
  const defined = await run(['command', 'define-task', JSON.stringify(taskCommand)])
  expect(defined.code, JSON.stringify(defined.answer)).toBe(0)
  expect(tasks).toHaveLength(2)
  expect(tasks[0]).toMatchObject({ operationId: 'define-task', command: { task } })
  expect(tasks[1].operationId).toBe('define-task')
  expect(tasks[1].command).not.toHaveProperty('task')
  for (const part of ['Goal:', 'Changes:', 'Constraints:', 'Owns:', 'Keep drafts', 'cli/src/superTabs']) expect(tasks[1].command.brief).toContain(part)
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
    await until('worker startup prompt to finish', async () => {
      const rows = await client.request('agents_list')
      return client.frames.some(frame => frame.type === 'turn_ended' && frame.agentId === started.answer.harnessId && !frame.replay)
        && rows.agents.some((a: Record<string, any>) => a.id === started.answer.harnessId && a.activity?.state === 'idle') || null
    }, 30_000, 250)
    const busyStart = client.next(frame => frame.type === 'turn_started' && frame.agentId === started.answer.harnessId && !frame.replay)
    client.send('message', { agentId: started.answer.harnessId, content: '!slow 20000' })
    await busyStart
    const busyFrom = client.frames.length, queuedAt = performance.now()
    pending.set(target, { id: `delivery-${engine}`, status: 'queued', claimId: null,
      message: { id: `message-${engine}`, conversationId: 'feature', replyTo: `question-${engine}`, author: { name: 'Fixture human' }, text: `verify-super-tab-${engine}` } })
    await until('native input acknowledgement', () => pending.get(target)?.status === 'delivered' || null, 60_000, 250)
    expect(client.frames.slice(busyFrom).filter(frame => frame.type === 'turn_ended' && frame.agentId === started.answer.harnessId && !frame.replay),
      'Swarm input must be typed and acknowledged before the current turn ends').toHaveLength(0)
    console.log(`${engine}: busy Swarm input acknowledged in ${Math.round(performance.now() - queuedAt)} ms`)
    if (engine === 'claude') {
      const rows = await client.request('agents_list')
      const pane = rows.agents.find((agent: Record<string, any>) => agent.id === started.answer.harnessId).tmuxPane
      await d.tmux.run('send-keys', '-t', pane, 'Escape')
      await until('queued Swarm input to run after Esc interrupts the preceding response', () =>
        client.frames.slice(busyFrom).some(frame => frame.type === 'turn_started' && frame.agentId === started.answer.harnessId
          && !frame.replay && String(frame.payload?.userMessage).includes(`verify-super-tab-${engine}`)) || null,
      5_000, 100)
      const afterEscape = await d.tmux.run('capture-pane', '-p', '-e', '-t', pane)
      expect(screenFor('claude').inspect(afterEscape).pane.draft, `Esc must not restore delivered Swarm input as an unsent draft:\n${afterEscape}`).toBe(false)
      expect(pending.get(target)?.status).toBe('delivered')
    }
    const submitted = readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string)
    expect(submitted.filter(prompt => prompt.includes(`verify-super-tab-${engine}`))).toHaveLength(1)
    expect(submitted.find(prompt => prompt.includes(`verify-super-tab-${engine}`))).toContain(`In reply to message question-${engine}.`)
    expect(submitted.find(prompt => prompt.includes(`verify-super-tab-${engine}`))).toContain(`message 'feature' 'question-${engine}'`)
    const original = await run(['message', 'feature', `question-${engine}`], target)
    expect(original.code, JSON.stringify(original.answer)).toBe(0)
    expect(original.answer.value.messages).toEqual([{ id: `question-${engine}`, text: 'Should the offline queue survive restart?' }])
    const model = engine === 'claude' ? 'sonnet' : 'gpt-6-luna'
    // Wait for the native turn to settle before using the app's existing model controls.
    await until('worker idle before its model change', async () => {
      const rows = await client.request('agents_list')
      const ended = client.frames.filter(frame => frame.type === 'turn_ended' && frame.agentId === started.answer.harnessId && !frame.replay)
      return ended.length >= 2 && rows.agents.some((a: Record<string, any>) => a.id === started.answer.harnessId && a.activity?.state === 'idle') || null
    }, 30_000, 250)
    const changed = await client.request('agent_update', { agentId: started.answer.harnessId,
      selectedModel: `runtime-v1:${started.answer.harnessId}:${engine}:${model}@high` }, 45_000)
    expect(changed.error, JSON.stringify(changed)).toBeUndefined()
    await until('shared roster to reflect the observed native runtime', () => {
      const config = agents.find(a => a.id === target)?.configuration
      return config?.model === model && config.effort === 'high' || null
    }, 20_000, 250)
    // The same route as Desktop: authenticated conversation context, host
    // preparation, then bytes typed into the real native terminal stream.
    const contextId = `native-${engine}-context-fixture`
    expect(await client.request('super_tabs', { action: 'backend', method: 'POST', path: `/api/super-tabs/${TAB}/native`,
      body: { operationId: contextId, conversationId: 'feature', agentId: target } })).toMatchObject({ value: { contextId } })
    expect(await client.request('super_tabs', { action: 'prepareNative', tabId: TAB, contextId }))
      .toMatchObject({ ok: true, inputContext: contextId })
    const openId = `terminal-${engine}`, terminal = client.next(frame => frame.type === 'terminal_ready' && frame.payload?.requestId === openId)
    client.send('terminal_open', { requestId: openId, protocolVersion: 3, agentId: started.answer.harnessId,
      cols: 100, rows: 30, inputContext: contextId })
    const streamId = (await terminal).payload!.streamId as string
    await client.waitForBinary(frame => frame.streamId === streamId && frame.kind === TerminalBinaryKind.keyframe)
    const intervention = `native-intervention-${engine}`
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 0, compressed: false, bytes: Buffer.from(intervention) })
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId, seq: 1, compressed: false, bytes: Buffer.from('\r') })
    await until('native prompt and answer in the correct conversation', () => {
      const rows = [...nativeRecords.values()].filter(row => row.contextId === contextId)
      return rows.length >= 2 ? rows : null
    }, 30_000, 100)
    const observed = [...nativeRecords.values()].filter(row => row.contextId === contextId)
    expect(observed.map(row => row.kind)).toEqual(['prompt', 'answer'])
    expect(observed[0]!.text).toBe(intervention)
    expect(observed[1]!.text).toContain(intervention)
    expect(observed[0]!.turnId).toBe(observed[1]!.turnId)
    const composed = `native-composed-intervention-${engine}`
    client.send('message', { agentId: started.answer.harnessId, content: composed, inputContext: contextId })
    await until('composed native input to retain the same conversation context', () => {
      const rows = [...nativeRecords.values()].filter(row => row.contextId === contextId)
      return rows.length >= 4 ? rows : null
    }, 30_000, 100)
    const composedRows = [...nativeRecords.values()].filter(row => row.contextId === contextId).slice(2)
    expect(composedRows.map(row => row.kind)).toEqual(['prompt', 'answer'])
    expect(composedRows[0]!.text).toBe(composed)
    expect(composedRows[1]!.text).toContain(composed)
    client.send('terminal_close', { streamId })
    const unknownId = `unattributed-${engine}`
    const unknownReady = client.next(frame => frame.type === 'terminal_ready' && frame.payload?.requestId === unknownId)
    client.send('terminal_open', { requestId: unknownId, protocolVersion: 3, agentId: started.answer.harnessId, cols: 100, rows: 30 })
    const unknownStream = (await unknownReady).payload!.streamId as string
    await client.waitForBinary(frame => frame.streamId === unknownStream && frame.kind === TerminalBinaryKind.keyframe)
    const privateInput = `unattributed-intervention-${engine}`
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId: unknownStream, seq: 0, compressed: false, bytes: Buffer.from(privateInput) })
    client.sendBinary({ kind: TerminalBinaryKind.input, streamId: unknownStream, seq: 1, compressed: false, bytes: Buffer.from('\r') })
    await until('an explicit gap instead of guessed attribution', () => [...nativeRecords.values()].some(row => row.contextId === contextId && row.kind === 'gap') || null, 20_000, 100)
    expect([...nativeRecords.values()].some(row => String(row.text).includes(privateInput))).toBe(false)
    expect(readFileSync(join(d.dataDir, 'super-tabs', `native-${ME.machineId}.json`), 'utf8')).not.toContain(privateInput)
    client.send('terminal_close', { streamId: unknownStream })
  }
  expect(nativeSends.length).toBeGreaterThan(nativeRecords.size)
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
  const refused = await run(['start', 'refused-config', JSON.stringify({
    conversationId: 'feature', machineId: ME.machineId, engine: 'claude', name: 'Refused builder',
    cwd, worktree: false, codexHome: join(d.root, 'unused-codex-home'), requirements: { memoryBytes: 0, diskBytes: 1,
      maxCpuPercent: 100, tools: ['git'], devices: [], quotaRequired: false },
  })])
  expect(refused.code, JSON.stringify(refused.answer)).toBe(1)
  expect(refused.answer).toMatchObject({ error: 'START_FAILED', detail: expect.stringContaining('codexHome') })
  expect(starts.get('start-refused-config')!.error).toContain('before starting an agent')
  const creationId = starts.get('start-refused-config')!.creationId
  expect(await client.request('agent_create_status', { creationId })).toMatchObject({ creationId, state: 'cancelled' })
  // Even a delayed valid create cannot revive the cancelled request.
  expect(await client.request('agent_create', { engine: 'claude', cwd, creationId }, 30_000)).toMatchObject({ creationId, state: 'cancelled' })
  expect((await run(['resume', 'start-refused-config'])).answer).toMatchObject({ error: 'START_FAILED' })
  const listed = await client.request('agents_list')
  expect(listed.agents).toHaveLength(3)
  const worker = listed.agents.find((a: Record<string, any>) => a.id === starts.get('start-claude')!.harnessId)
  await until('host to retain contributed members independently of open panes', () =>
    agents.every(a => retainedHarnesses(d.dataDir).has(a.harnessId)) || null, 10_000, 100)
  assignments.push({ tabId: TAB, assignmentId: 'worker-attempt', harnessId: worker.id })
  const closed = await client.request('agent_close', { agentId: worker.id, sessionId: worker.sessionId, createdAt: worker.createdAt, mode: 'now' }, 60_000)
  expect(closed, JSON.stringify(closed)).toMatchObject({ closed: true })
  await until('execution host to confirm the stop', () => stopReceipts.length === 1 || null, 15_000, 250)
  expect(stopReceipts[0]).toMatchObject({ assignmentId: 'worker-attempt', receipt: expect.stringContaining('native-stopped:') })
  expect(await client.request('super_tabs', { action: 'observeCapacity', creationId: starts.get('start-claude')!.creationId }))
    .toMatchObject({ ok: true, harnessId: worker.id, released: true })
  // A member may have stopped under an older build. The app resumes the same
  // saved session before preparing a new recording context, never a new worker.
  const reopened = await client.request('agent_resume', { agentId: worker.id, creationId: 'super-tab-resume-worker' }, 90_000)
  expect(reopened.error, JSON.stringify(reopened)).toBeUndefined()
  const resumed = await until('the exact contributed conversation to resume', async () => {
    const rows = (await client.request('agents_list')).agents
    const row = rows.find((a: Record<string, any>) => a.id === worker.id)
    return row?.status === 'active' && row.sessionId === worker.sessionId ? row : null
  }, 60_000, 250)
  expect(resumed.id).toBe(worker.id)
  const reopenContext = 'native-resumed-worker-context'
  expect(await client.request('super_tabs', { action: 'backend', method: 'POST', path: `/api/super-tabs/${TAB}/native`,
    body: { operationId: reopenContext, conversationId: 'feature', agentId: idFor(worker.id) } }))
    .toMatchObject({ ok: true, value: { contextId: reopenContext } })
  expect(await client.request('super_tabs', { action: 'prepareNative', tabId: TAB, contextId: reopenContext }))
    .toMatchObject({ ok: true, inputContext: reopenContext })
  // Two callers see the same free memory. Only one may reserve most of it,
  // even though neither has started its native process yet.
  const capacity = await client.request('super_tabs', { action: 'capacity', cwd })
  const freeMemory = capacity.resources.memoryTotalBytes - capacity.resources.memoryUsedBytes
  expect(Number.isFinite(freeMemory) && freeMemory > 0).toBe(true)
  const memoryBytes = Math.floor(freeMemory * 0.7)
  const reservations = await Promise.all([1, 2].map(n => client.request('super_tabs', {
    action: 'reserveCapacity', creationId: `fixture-capacity-${n}`, cwd,
    requirements: { memoryBytes, diskBytes: 0, maxCpuPercent: 100 },
  })))
  expect(reservations.filter(r => r.ok)).toHaveLength(1)
  expect(reservations.filter(r => r.error)).toEqual([expect.objectContaining({ error: 'CAPACITY_UNAVAILABLE' })])
  const reserved = reservations.find(r => r.ok)!.reservationId
  expect(await client.request('agent_create_cancel', { creationId: reserved })).toMatchObject({ state: 'cancelled' })
  expect(await client.request('super_tabs', { action: 'observeCapacity', creationId: reserved })).toMatchObject({ released: true })
  // A person-created session stays open even if a stale backend asks the Swarm host to stop it.
  const contributed = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true, prompt: 'Report that this personal session is ready.' }, 90_000)
  expect(contributed.error, JSON.stringify(contributed)).toBeUndefined()
  const contributedId = idFor(contributed.agent.id)
  agents.push({ id: contributedId, harnessId: contributed.agent.id, machineId: ME.machineId, workDecision: 'stop', releaseId: 'personal-session-stop' })
  await until('the core to refuse closing a personal session', () => d.log().includes('not the original Swarm launch') || null, 15_000, 100)
  expect((await client.request('agents_list')).agents.some((a: Record<string, any>) => a.id === contributed.agent.id)).toBe(true)
  agents.splice(agents.findIndex(a => a.id === contributedId), 1)
  // Only the recorded original Swarm launch may be closed through the service process.
  const launchedId = String(starts.get('start-codex')!.harnessId)
  const launched = agents.find(a => a.harnessId === launchedId)!
  expect(launched.startedSession).toMatchObject({ creationId: starts.get('start-codex')!.creationId })
  launched.workDecision = 'stop'; launched.releaseId = 'finished-worker-release'
  await until('the host process to close and remove the original Swarm worker', () => !agents.some(a => a.id === launched.id) || null, 60_000, 250)
  expect((await client.request('agents_list')).agents.some((a: Record<string, any>) => a.id === launchedId)).toBe(false)
  await until('removed worker retention to be released', () => !retainedHarnesses(d.dataDir).has(launchedId) || null, 10_000, 100)
  const goneId = idFor('deleted-native-worker')
  agents.push({ id: goneId, harnessId: 'deleted-native-worker', machineId: ME.machineId, workDecision: 'stop', releaseId: 'deleted-worker-release' })
  await until('a deleted session without a stopped record to be withdrawn', () => !agents.some(a => a.id === goneId) || null, 15_000, 100)
  expect((await client.request('agents_list')).agents.some((a: Record<string, any>) => a.id === lead.agent.id)).toBe(true)
  allowed = false
  const denied = await run(['post', 'feature', 'not allowed', 'after-removal'])
  expect(denied.code).toBe(1)
  expect(posts.some(p => p.text === 'not allowed')).toBe(false)
}, 300_000)

it.each(['reported', 'legacy'] as const)('Change agent keeps its member and delivers once after a %s handoff', async mode => {
  const relay = await FakeBackend.start(); backend = relay; relay.addMachine(ME)
  const d = await IsolatedDaemon.create({ submissionGate: true, env: {
    BACKEND_WS_URL: relay.wsUrl, WEB_URL: relay.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential',
  } }); daemon = d
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token,
    autonomousEnv: 'prod', computerId: ME.computerId, machineId: ME.machineId,
    expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
  }), { mode: 0o600 })
  const agents: Array<Record<string, any>> = []
  let rebinds = 0
  const delivery = { id: 'replacement-delivery', status: 'queued', claimId: null as string | null }
  relay.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, relay.httpUrl).pathname
    if (path.endsWith('/pools') || path.endsWith('/assignments')) return { data: [] }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: TAB, agent, observers: [] })) }
    if (path === `/api/super-tabs/${TAB}`) return { data: { state: { agents, conversations: [{ id: 'feature', leadId: 'stable-member', agentIds: ['stable-member'] }] } } }
    if (path.endsWith('/commands')) {
      const command = object(body.command), member = agents[0]
      if (command.type === 'agent.rebind') {
        expect(body.asAgentId).toBe('stable-member')
        expect(command).toMatchObject({ agentId: 'stable-member', previousHarnessId: member.harnessId,
          machineId: ME.machineId, projectId: 'project', configuration: { engine: 'claude' } })
        member.harnessId = command.harnessId; member.configuration = command.configuration; rebinds++
      } else if (command.type === 'agent.configuration') member.configuration = command.configuration
      else throw new Error(`Unexpected command ${command.type}`)
      return { data: { result: {} } }
    }
    if (path.includes('/deliveries')) {
      if (method === 'GET') return { data: path.endsWith('/deliveries') ? rebinds && delivery.status !== 'delivered' ? [delivery] : [] : delivery }
      if (body.type === 'claim') delivery.claimId = body.claimId
      else delivery.status = body.uncertain ? 'uncertain' : 'delivered'
      return { data: { message: { id: 'replacement-message', conversationId: 'feature', author: { name: 'Fixture human' }, text: `verify-switched-${mode}` } } }
    }
    throw new Error(`Unexpected request ${method} ${path}`)
  })
  await d.start()
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  const client = await LocalClient.connect(d, { machineId: ME.machineId }); clients.push(client)
  const cwd = join(d.projectsDir, 'switch-project'); mkdirSync(cwd, { recursive: true })
  const source = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true, prompt: 'Remember this project before the switch.' }, 90_000)
  expect(source.error, JSON.stringify(source)).toBeUndefined()
  await until('source conversation to finish', () => client.frames.some(frame => frame.type === 'turn_ended' && frame.agentId === source.agent.id && !frame.replay) || null, 30_000, 100)
  agents.push({ id: 'stable-member', harnessId: source.agent.id, machineId: ME.machineId, projectId: 'project', name: 'Lead', configuration: { engine: 'codex' } })
  expect(await client.request('super_tabs', { action: 'wake' })).toMatchObject({ ok: true })
  const hostPid = Number([...d.log().matchAll(/service superTabs started \(pid (\d+)\)/g)].at(-1)?.[1])
  expect(hostPid).toBeGreaterThan(0)
  if (mode === 'legacy') process.kill(hostPid, 'SIGSTOP')
  const changeId = randomUUID().replaceAll('-', '')
  const handoff = await client.request('agent_handoff_prepare', { agentId: source.agent.id, changeId, targetEngine: 'claude' }, 10_000)
  expect(handoff.error, JSON.stringify(handoff)).toBeUndefined()
  const current = (await client.request('agents_list')).agents.find((a: Record<string, any>) => a.id === source.agent.id)
  expect(await client.request('agent_close', { agentId: current.id, sessionId: current.sessionId, createdAt: current.createdAt, mode: 'now' }, 60_000)).toMatchObject({ closed: true })
  const target = await client.request('agent_create', { creationId: changeId, engine: 'claude', cwd, bypassPermission: true, prompt: 'Acknowledge the handoff and wait.' }, 90_000)
  expect(target.error, JSON.stringify(target)).toBeUndefined()
  if (mode === 'reported') expect(await client.request('agent_handoff_complete', { agentId: source.agent.id, replacementId: target.agent.id, changeId, targetEngine: 'claude' })).toMatchObject({ ok: true })
  // Restart just the Swarm service: its own saved host receipt wakes it, and legacy recovery has no
  // completion report. Both paths must bind the exact creation receipt rather than guess by folder.
  if (mode === 'legacy') {
    process.kill(hostPid, 'SIGKILL')
    await until('a new Swarm host after the earlier Change agent', () => {
      const current = Number([...d.log().matchAll(/service superTabs started \(pid (\d+)\)/g)].at(-1)?.[1])
      return current > 0 && current !== hostPid || null
    }, 15_000, 100)
  }
  await until('member to follow the replacement terminal', () => agents[0].harnessId === target.agent.id || null, 30_000, 100)
  await until('one native input receipt on the replacement', () => delivery.status === 'delivered' || null, 30_000, 100)
  await until('one execution of the delivered input', () => {
    const prompts = readFileSync(join(d.root, 'submitted-prompts'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string)
    return prompts.filter(prompt => prompt.includes(`verify-switched-${mode}`)).length === 1 || null
  }, 30_000, 100)
  expect(rebinds).toBe(1)
  expect(agents[0]).toMatchObject({ id: 'stable-member', name: 'Lead', configuration: { engine: 'claude' } })
}, 180_000)
