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
import { isTeamDaemon } from '../src/superTabs/teamDaemon.js'

const TAB = 'buddy-tab'
const ME = { machineId: 'd3'.repeat(16), computerId: 'one-buddy-fixture', name: 'Buddy fixture', token: 'fixture-buddy-token', account: 'person', email: 'person@example.com' }
let relay: FakeBackend | undefined, daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => {
  client?.close(); client = undefined
  await daemon?.close(); daemon = undefined
  await relay?.close(); relay = undefined
})

// A Buddy is forbidden on a Team OS account even in an isolated daemon; this native flow needs an owner's account.
it.skipIf(isTeamDaemon())('starts in its own folder, then sleeps and resumes the same Buddy conversation', async () => {
  const backend = await FakeBackend.start(); relay = backend
  backend.addMachine(ME)
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
  const agents: Array<Record<string, any>> = [], asked: string[] = [], idleReports: string[][] = []
  let managed = false
  backend.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/github-token')) { asked.push(path); throw Object.assign(new Error('This start has no project folder to prepare.'), { status: 404, code: 'NOT_FOUND' }) }
    if (path.endsWith('/pools')) return { data: [{ tabId: TAB, machine: pool, projects: [], starts: [], buddyStarts: start.harnessId && start.poolSettled ? [] : [start], githubApp: true, buddySleepWanted: managed, harnessIds: agents.map(a => a.harnessId) }] }
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
  const row = async () => (await client!.request('agents_list', { includeStopped: true })).agents.find((a: Record<string, any>) => a.id === start.harnessId)
  const original = await until('the Buddy to bind its engine conversation', async () => {
    const agent = await row()
    return agent?.sessionId && agent.status === 'active' ? agent : null
  }, 60_000, 250)
  const marker = join(homes, folders[0]!, 'kept.txt')
  writeFileSync(marker, 'Buddy memory stays here')
  managed = true
  await until('fresh positive engine idle proof', () => idleReports.some(ids => ids.includes(start.harnessId)), 60_000, 250)
  agents[0]!.asleep = { since: Date.now() }
  await until('the sleeping Buddy to release its session', async () => (await row())?.status !== 'active' || null, 60_000, 250)
  expect(readFileSync(marker, 'utf8')).toBe('Buddy memory stays here')
  delete agents[0]!.asleep
  const resumed = await until('the awake Buddy to resume through the host', async () => {
    const agent = await row()
    return agent?.status === 'active' ? agent : null
  }, 90_000, 250)
  expect(resumed.sessionId).toBe(original.sessionId)
  expect(resumed.cwd).toBe(original.cwd)
  expect(readFileSync(marker, 'utf8')).toBe('Buddy memory stays here')
}, 240_000)
