/** A person's one Buddy started on their own machine in the Swarm, on the real native protocol: a private daemon, tmux and
 * data dir, a fake Claude engine and the fake backend. It has no project, so nothing is cloned and no GitHub token is asked
 * for, and the folder its start names is never made: 2026-11-02, each of those failed every such start while unit tests,
 * which faked the steps either side, passed. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { overOldRoutes } from './harness/swarmReads.js'

const TAB = 'buddy-tab'
const ME = { machineId: 'd3'.repeat(16), computerId: 'one-buddy-fixture', name: 'Buddy fixture', token: 'fixture-buddy-token', account: 'person', email: 'person@example.com' }
let relay: FakeBackend | undefined, daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => {
  client?.close(); client = undefined
  await daemon?.close(); daemon = undefined
  await relay?.close(); relay = undefined
})

it('starts and switches its engine in the same folder and private chat, with one Buddy and no app token', async () => {
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
  const agents: Array<Record<string, any>> = [], asked: string[] = []
  const outcomes: Record<string, any>[] = []
  let rebinds = 0, claims = 0
  backend.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/github-token')) { asked.push(path); throw Object.assign(new Error('This start has no project folder to prepare.'), { status: 404, code: 'NOT_FOUND' }) }
    if (path.endsWith('/pools')) return { data: [{ tabId: TAB, machine: pool, projects: [], starts: [], buddyStarts: start.harnessId && start.poolSettled ? [] : [start], githubApp: true, harnessIds: agents.map(a => a.harnessId) }] }
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
        buddy.harnessId = command.harnessId; buddy.configuration = command.configuration; delete buddy.switchRequest; rebinds++
      } else if (command.type === 'agent.switchResult') {
        outcomes.push(command); delete buddy.switchRequest
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
  expect(asked).toEqual([])
  expect((await client.request('agents_list')).agents.map((a: Record<string, any>) => a.id)).toContain(start.harnessId)
  const homes = join(d.env.HOME!, 'harnesses', 'worktrees', 'buddy-home'), folders = readdirSync(homes)
  expect(folders).toHaveLength(1)
  expect(existsSync(join(homes, folders[0]!, 'projects', 'API', 'README.md'))).toBe(true)
  expect(existsSync(start.request.cwd)).toBe(false)
  const original = agents[0].harnessId
  const before = (await client.request('agents_list')).agents.find((agent: Record<string, any>) => agent.id === original)
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
  expect(live[0]).toMatchObject({ id: agents[0].harnessId, engine: 'codex', cwd: before.cwd })
  expect(live[0].id).not.toBe(original)
  const saved = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((agent: Record<string, any>) => agent.agentId === live[0].id)
  expect(saved.swarmSkill).toMatchObject({ role: 'buddy' })
  expect(saved.swarmSkill.github).not.toBe(true)
  const prompts = readFileSync(join(d.root, 'submitted-prompts'), 'utf8')
  expect(prompts).toContain('Your chat with your owner is conversation buddy-chat')
  expect(agents[0]).toMatchObject({ id: 'buddy', buddyOf: { personId: 'person', generation: 'g' } })
  expect(asked).toEqual([])
})
