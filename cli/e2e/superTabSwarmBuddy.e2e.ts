/** A person's one Buddy started on their own machine in the Swarm, on the real native protocol: a private daemon, tmux and
 * data dir, a fake Claude engine and the fake backend. It has no project, so nothing is cloned, and the folder its start
 * names is never made: 2026-11-02, each of those failed every such start while unit tests,
 * which faked the steps either side, passed. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { isTeamAccount } from '../src/team/config.js'
import { isTeamDaemon } from '../src/superTabs/teamDaemon.js'
import { overOldRoutes } from './harness/swarmReads.js'

const TAB = 'buddy-tab'
const ME = { machineId: 'd3'.repeat(16), computerId: 'one-buddy-fixture', name: 'Buddy fixture', token: 'fixture-buddy-token', account: 'person', email: 'person@example.com' }
let relay: FakeBackend | undefined, daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => {
  client?.close(); client = undefined
  await daemon?.close(); daemon = undefined
  await relay?.close(); relay = undefined
})

// A Team OS account must refuse every real Buddy launch; approved CI runs this flow on an isolated runner account.
it.skipIf(isTeamAccount())('starts and switches its engine in the same folder and private chat, with one Buddy and no app token', async () => {
  const backend = await FakeBackend.start(); relay = backend
  backend.addMachine(ME)
  backend.me = { id: 'person', email: ME.email }
  // As a real engine does: it asks about a folder it has no answer for, in a terminal no Swarm view shows.
  const d = await signedInDaemon(backend, ME, { ANTHROPIC_API_KEY: 'fixture-only' }, undefined, true); daemon = d
  writeFileSync(join(d.env.HOME!, '.claude.json'), '{}')
  mkdirSync(d.env.CODEX_HOME!, { recursive: true })
  writeFileSync(join(d.env.CODEX_HOME!, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-only' }), { mode: 0o600 })
  const project = join(d.projectsDir, 'api'); mkdirSync(project, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: project, stdio: 'ignore' })
  git('init', '-q'); writeFileSync(join(project, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture')
  const cwd = join(d.env.HOME!, 'harnesses', 'swarms', TAB)
  const pool = { machineId: ME.machineId, generation: 'grant-1', cwd, scope: 'swarm', engines: ['claude'], maxAgents: 2, paused: false }
  const start: Record<string, any> = { id: 'start-buddy', machineOwnerId: 'person', contributorId: 'person', poolGeneration: 'grant-1', creationId: 'super-start-buddy', dispatched: false, harnessId: null, error: null,
    request: { conversationId: 'buddy-chat', machineId: ME.machineId, engine: 'claude', name: "person's Buddy", cwd: `${cwd}/.buddy-person`, worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false },
      buddyOf: { personId: 'person', generation: 'g' }, buddyScope: 'swarm', buddyProjects: [{ id: 'p1', name: 'API', cwd: project }] } }
  const agents: Array<Record<string, any>> = []
  const outcomes: Record<string, any>[] = []
  let rebinds = 0, claims = 0
  backend.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/pools')) return { data: [{ tabId: TAB, machine: pool, projects: [], starts: [], buddyStarts: start.harnessId && start.poolSettled ? [] : [start], harnessIds: agents.map(a => a.harnessId) }] }
    if (path.includes('/hosts/') && path.includes('/starts/')) {
      if (method === 'GET') return { data: start }
      const c = body.command
      if (c.type === 'agent.startDispatch') start.dispatched = true
      else if (c.type === 'agent.started') { start.harnessId = c.harnessId; agents.push({ id: 'buddy', machineId: ME.machineId, harnessId: c.harnessId, buddyScope: 'swarm', buddyOf: { personId: 'person', generation: 'g' }, configuration: c.configuration }) }
      else if (c.type === 'agent.startSettled') start.poolSettled = true
      else if (c.type === 'agent.startFailed') start.error = c.error
      return { data: { result: {} } }
    }
    if (path.endsWith('/assignments')) return { data: [] }
    if (path.includes('/hosts/')) return { data: agents.map(agent => ({ tabId: TAB, active: true, buddyConversationId: 'buddy-chat', agent })) }
    if (path.endsWith('/commands')) {
      const command = body.command, buddy = agents[0]
      if (command.type === 'agent.switchClaim') { expect(body.asAgentId).toBe('buddy'); claims++ }
      else if (command.type === 'agent.rebind') {
        expect(command).toMatchObject({ agentId: 'buddy', previousHarnessId: buddy.harnessId, configuration: { engine: 'codex' } })
        expect(command).not.toHaveProperty('projectId')
        // Like the real backend, retain the completed request until the host reports its outcome.
        buddy.switchLanded = { id: buddy.switchRequest.id, requestedBy: buddy.switchRequest.requestedBy }
        buddy.harnessId = command.harnessId; buddy.configuration = command.configuration; delete buddy.switchRequest; rebinds++
      } else if (command.type === 'agent.switchResult') {
        outcomes.push(command); delete buddy.switchRequest; delete buddy.switchLanded
      } else if (command.type === 'agent.configuration') buddy.configuration = command.configuration
      else throw new Error(`Unexpected command ${command.type}`)
      return { data: { result: {} } }
    }
    if (path.includes('/machines/')) return { data: { revision: 1 } }
    if (path === `/api/super-tabs/${TAB}`) return { data: { state: { id: TAB, agents, projects: [], conversations: [] }, revision: 1 } }
    if (path.endsWith('/deliveries') || path.endsWith('/grids')) return { data: [] }
    throw new Error(`Unexpected request ${path}`)
  })
  onTestFailed(() => console.log(d.log().split('\n').slice(-80).join('\n')))
  await d.start()
  await until('the machine connected', () => backend.nodeUp(ME.machineId), 30000)
  client = await LocalClient.connect(d, { machineId: ME.machineId })
  await client.request('super_tabs', { action: 'wake' }, 30000)
  await until('its Buddy started', () => {
    expect(start.error).toBeNull()
    return start.harnessId
  }, 90000, 250)
  expect((await client.request('agents_list')).agents.map((a: Record<string, any>) => a.id)).toContain(start.harnessId)
  const homes = join(d.env.HOME!, 'harnesses', 'worktrees', 'buddy-home'), folders = readdirSync(homes)
  expect(folders).toHaveLength(1)
  expect(existsSync(join(homes, folders[0]!, 'projects', 'API', 'README.md'))).toBe(true)
  expect(existsSync(start.request.cwd)).toBe(false)
  const original = agents[0].harnessId
  const registered = (id: string) => JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8'))
    .find((agent: Record<string, any>) => agent.agentId === id)
  const originalCwd = registered(original).cwd
  expect(originalCwd).toBe(join(homes, folders[0]!))
  const before = await until('the original Buddy to bind its native conversation', async () => {
    const row = (await client!.request('agents_list')).agents.find((agent: Record<string, any>) => agent.id === original)
    return row?.sessionId ? row : null
  }, 30_000, 100)
  const close = { agentId: original, sessionId: before.sessionId, createdAt: before.createdAt }
  await until('the host to retain the Buddy', async () => (await client!.request('agent_close', { ...close, mode: 'inspect' })).keptRunning === true || null, 15_000, 100)
  // Ordinary Close still keeps a Buddy running; the engine switch alone carries its prepared handoff permit.
  expect(await client.request('agent_close', { ...close, mode: 'now' })).toMatchObject({ error: 'BUDDY_PROTECTED' })
  agents[0].switchRequest = { id: 'engine-switch', engine: 'codex', profileId: 'default', requestedBy: 'person' }
  await client.request('super_tabs', { action: 'wake' }, 30_000)
  await until('the Buddy engine switch to settle', () => outcomes.length > 0 || null, 60_000, 100)
  expect(outcomes).toEqual([{ type: 'agent.switchResult', agentId: 'buddy', switchId: 'engine-switch', ok: true }])
  expect(claims).toBe(1)
  expect(rebinds).toBe(1)
  const live = (await client.request('agents_list')).agents
  expect(live).toHaveLength(1)
  expect(live[0]).toMatchObject({ id: agents[0].harnessId, engine: 'codex' })
  expect(live[0].id).not.toBe(original)
  const saved = registered(live[0].id)
  expect(saved.cwd).toBe(originalCwd)
  expect(saved.swarmSkill).toMatchObject({ role: 'buddy' })
  expect(saved.swarmSkill.github).not.toBe(true)
  // Codex receives its first prompt on launch, before the switch reports success.
  const launches = readFileSync(join(d.root, 'launch-argv'), 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { engine: string; args: string[] })
  expect(launches.some(({ engine, args }) => engine === 'codex' && args.some(prompt =>
    prompt.includes('Your chat with your owner is conversation buddy-chat') && prompt.includes('Context handoff:')))).toBe(true)
  expect(agents[0]).toMatchObject({ id: 'buddy', buddyOf: { personId: 'person', generation: 'g' } })
})

// A Buddy is forbidden on a Team OS account even in an isolated daemon; this native flow needs an owner's account.
it.skipIf(isTeamDaemon())('releases an idle Buddy session and wakes the same conversation on its person’s message', async () => {
  const backend = await FakeBackend.start(); relay = backend
  backend.addMachine(ME)
  backend.me = { id: ME.account, email: ME.email }
  // As a real engine does: it asks about a folder it has no answer for, in a terminal no Swarm view shows.
  const d = await signedInDaemon(backend, ME, { ANTHROPIC_API_KEY: 'fixture-only' }, undefined, true); daemon = d
  writeFileSync(join(d.env.HOME!, '.claude.json'), '{}')
  const project = join(d.projectsDir, 'api'); mkdirSync(project, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { cwd: project, stdio: 'ignore' })
  git('init', '-q'); writeFileSync(join(project, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture')
  const cwd = join(d.env.HOME!, 'harnesses', 'swarms', TAB)
  const pool = { machineId: ME.machineId, generation: 'grant-1', cwd, scope: 'swarm', engines: ['claude'], maxAgents: 2, paused: false }
  const start: Record<string, any> = { id: 'start-buddy', poolGeneration: 'grant-1', creationId: 'super-start-buddy', machineOwnerId: 'person', contributorId: 'person', hostGrant: null, dispatched: false, harnessId: null, error: null,
    request: { conversationId: 'buddy-chat', machineId: ME.machineId, engine: 'claude', name: "person's Buddy", cwd: `${cwd}/.buddy-person`, worktree: false,
      requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false },
      buddyOf: { personId: 'person', generation: 'g' }, buddyScope: 'swarm', buddyProjects: [{ id: 'p1', name: 'API', cwd: project }] } }
  const agents: Array<Record<string, any>> = [], idleReports: string[][] = []
  let pending: { id: string; conversationId: string; status: string; claimId: string | null; message: Record<string, any> } | undefined
  let managed = false
  backend.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/pools')) return { data: [{ tabId: TAB, machine: pool, projects: [], starts: [], buddyStarts: start.harnessId && start.poolSettled ? [] : [start], buddySleepWanted: managed, harnessIds: agents.map(a => a.harnessId) }] }
    if (path.includes('/hosts/') && path.includes('/starts/')) {
      if (method === 'GET') return { data: start }
      const c = body.command
      if (c.type === 'agent.startDispatch') start.dispatched = true
      else if (c.type === 'agent.started') { start.harnessId = c.harnessId; agents.push({ id: 'buddy', machineId: ME.machineId, harnessId: c.harnessId, buddyOf: start.request.buddyOf, buddyScope: 'swarm', configuration: c.configuration }) }
      else if (c.type === 'agent.startSettled') start.poolSettled = true
      else if (c.type === 'agent.startFailed') start.error = c.error
      return { data: { result: {} } }
    }
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: TAB, agent, active: true, buddySleepManaged: managed, observers: [] })) }
    if (path.endsWith('/readings')) {
      for (const reading of body.readings ?? []) if (reading.observation.idleBuddyHarnessIds) idleReports.push(reading.observation.idleBuddyHarnessIds)
      return { data: { results: (body.readings ?? []).map((r: Record<string, any>) => ({ tabId: r.tabId, ok: true })) } }
    }
    if (path.includes('/hosts/')) return { data: [] }
    if (path.includes('/machines/')) {
      if (body?.idleBuddyHarnessIds) idleReports.push(body.idleBuddyHarnessIds)
      return { data: { revision: 1 } }
    }
    if (path === `/api/super-tabs/${TAB}`) return { data: { state: { id: TAB, agents,
      projects: [{ id: 'p1', name: 'API', cwd: project }],
      conversations: [{ id: 'buddy-chat', kind: 'swarm-buddy', buddyOwnerId: 'person', agentIds: ['buddy'] }] }, revision: 1 } }
    if (path.endsWith('/commands') && body.command?.type === 'message.send') {
      expect(body.asAgentId).toBeUndefined()
      expect(body.command.conversationId).toBe('buddy-chat')
      // Model the server's authorized wake response here; the real store regression covers its transaction and rights.
      delete agents[0]!.asleep
      pending = { id: 'wake-delivery', conversationId: 'buddy-chat', status: 'queued', claimId: null,
        message: { id: 'wake-message', conversationId: 'buddy-chat', text: body.command.text,
          author: { kind: 'person', id: 'person', name: 'Person', membershipGeneration: 'g' } } }
      return { data: { result: { messageId: 'wake-message' } } }
    }
    if (path.endsWith('/conversations/buddy-chat/messages')) return { data: { messages: [] } }
    const delivery = /\/agents\/buddy\/deliveries(?:\/([^/]+))?$/.exec(path)
    if (delivery) {
      if (method === 'GET') return { data: delivery[1] ? pending : pending && pending.status !== 'delivered' ? [pending] : [] }
      expect(pending?.id).toBe(delivery[1])
      expect(body.claimId).toBe(pending!.claimId ?? body.claimId)
      if (body.type === 'claim') { pending!.claimId = body.claimId; return { data: { message: pending!.message } } }
      pending!.status = body.uncertain ? 'uncertain' : 'delivered'
      return { data: {} }
    }
    if (path.endsWith('/deliveries') || path.endsWith('/grids')) return { data: [] }
    throw new Error(`Unexpected request ${path}`)
  })
  onTestFailed(() => console.log(d.log().split('\n').slice(-80).join('\n')))
  await d.start()
  await until('the machine connected', () => backend.nodeUp(ME.machineId), 30000)
  client = await LocalClient.connect(d, { machineId: ME.machineId })
  await client.request('super_tabs', { action: 'wake' }, 30000)
  await until('its Buddy started', () => {
    expect(start.error).toBeNull()
    return start.harnessId
  }, 90000, 250)
  expect((await client.request('agents_list')).agents.map((a: Record<string, any>) => a.id)).toContain(start.harnessId)
  const homes = join(d.env.HOME!, 'harnesses', 'worktrees', 'buddy-home'), folders = readdirSync(homes)
  expect(folders).toHaveLength(1)
  expect(existsSync(join(homes, folders[0]!, 'projects', 'API', 'README.md'))).toBe(true)
  expect(existsSync(start.request.cwd)).toBe(false)
  const row = async () => (await client!.request('agents_list', { includeStopped: true })).agents.find((a: Record<string, any>) => a.id === start.harnessId)
  const original = await until('the Buddy to bind its engine conversation', async () => {
    const agent = await row()
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 250)
  const marker = join(homes, folders[0]!, 'kept.txt')
  writeFileSync(marker, 'Buddy memory stays here')
  const processes = join(original.claudeHome ?? dirname(d.engineConfig.claudeProjectsDir), 'sessions')
  const originalPid = await until('the fixture engine process to be identified', () => {
    if (!existsSync(processes)) return null
    const match = readdirSync(processes).filter(file => file.endsWith('.json')).map(file => JSON.parse(readFileSync(join(processes, file), 'utf8')))
      .find(record => record.sessionId === original.sessionId && IsolatedDaemon.alive(record.pid))
    return match?.pid as number | undefined
  }, 15_000, 250)
  expect(original.tmuxPane).toBeTruthy()
  managed = true
  await until('fresh positive engine idle proof', () => idleReports.some(ids => ids.includes(start.harnessId)), 60_000, 250)
  agents[0]!.asleep = { since: Date.now() }
  await until('the sleeping Buddy to release its session', async () => (await row())?.status !== 'active' || null, 60_000, 250)
  await until('the engine process to exit and its terminal pane to be released', async () => {
    const panes = await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}').catch(() => '')
    return !IsolatedDaemon.alive(originalPid) && !panes.trim().split('\n').includes(original.tmuxPane) || null
  }, 30_000, 250)
  expect(readFileSync(marker, 'utf8')).toBe('Buddy memory stays here')
  const text = 'Wake up and keep the same draft memory'
  expect(await client.request('super_tabs', { action: 'backend', method: 'POST', path: `/api/super-tabs/${TAB}/commands`,
    body: { operationId: 'person-wakes-buddy', command: { type: 'message.send', conversationId: 'buddy-chat', text, replyTo: null, recipientIds: [] } } }))
    .toMatchObject({ ok: true, value: { result: { messageId: 'wake-message' } } })
  const resumed = await until('the awake Buddy to resume through the host', async () => {
    const agent = await row()
    return agent?.status === 'active' ? agent : null
  }, 90_000, 250)
  expect(resumed.sessionId).toBe(original.sessionId)
  expect(resumed.cwd).toBe(original.cwd)
  expect(readFileSync(marker, 'utf8')).toBe('Buddy memory stays here')
  await until('the waking message to reach the resumed engine', () => pending?.status === 'delivered' || null, 60_000, 250)
  await until('the same conversation to record the waking message', async () => {
    const page = await client!.request('session_get', { sessionId: original.sessionId, limit: 100 })
    return page.events?.some((event: Record<string, any>) => event.type === 'user_message' && String(event.payload.content).includes(text)) || null
  }, 30_000, 250)
}, 240_000)
