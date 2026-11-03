/** Diego, 10-30: removing an agent, or deleting its project, left its Swarm worktree to the weekly sweep, up to a week later.
 * On a real daemon under a throwaway home: this machine launches two Swarm starts in worktrees of a local repository, the
 * Swarm then ends both sessions, and once each close is acknowledged the clean worktree is gone while the one with
 * uncommitted work stays, with its record (superTabs/host.ts endSession, superTabs/machines.ts removeStoppedWorktree). */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { swarmWorktreesFile } from '../src/superTabs/machines.js'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until, type IsolatedDaemon } from './harness/daemon.js'
import { FakeBackend } from './harness/fakeBackend.js'
import { signedInDaemon } from './harness/fleet.js'
import { overOldRoutes } from './harness/swarmReads.js'

const TAB = 'removal-tab'
let relay: FakeBackend | undefined, daemon: IsolatedDaemon | undefined
const clients: LocalClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(c => c.close())
  await daemon?.close(); daemon = undefined
  await relay?.close(); relay = undefined
})

it('removes an ended agent\'s clean Swarm worktree once its close is acknowledged, and keeps one with uncommitted work', async () => {
  const backend = await FakeBackend.start(); relay = backend
  const spec = { machineId: 'e7'.repeat(16), computerId: 'worktree-removal-fixture', name: 'Removal fixture', token: 'fixture-removal-token', account: 'owner', email: 'owner@example.com' }
  backend.addMachine(spec)
  const d = await signedInDaemon(backend, spec, { ANTHROPIC_API_KEY: 'fixture-only', OPENAI_API_KEY: 'fixture-only' }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  // A local repository with one commit and no remote: the Swarm's worktrees start from its HEAD.
  const project = join(d.projectsDir, 'app'); mkdirSync(project, { recursive: true })
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, stdio: 'pipe', env: { ...process.env, HOME: d.env.HOME } }).toString()
  git(project, 'init', '-q'); writeFileSync(join(project, 'README.md'), 'fixture\n'); git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'init')

  const agents: Array<Record<string, any>> = [], starts = new Map<string, Record<string, any>>()
  const ended = new Set<string>(), closedAcks: string[] = []
  const pool = { machineId: spec.machineId, generation: 'grant-1', cwd: project, engines: ['codex'], maxAgents: 2, paused: false }
  const request = (name: string) => ({ conversationId: 'lead', machineId: spec.machineId, engine: 'codex', name, cwd: project, worktree: true,
    requirements: { memoryBytes: 0, diskBytes: 1, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
  backend.superTabs = overOldRoutes(async (method, raw, body) => {
    const path = new URL(raw, backend.httpUrl).pathname
    if (path.endsWith('/pools')) return { data: [{ tabId: TAB, machine: pool, starts: [...starts.values()].filter(s => !s.harnessId || !s.settled), harnessIds: agents.map(a => a.harnessId) }] }
    if (path.includes('/hosts/') && path.includes('/starts/')) {
      const start = starts.get(path.split('/').at(-1)!)!
      if (method === 'GET') return { data: start }
      const c = body.command
      if (c.type === 'agent.startDispatch') start.dispatched = true
      else if (c.type === 'agent.started') {
        start.harnessId = c.harnessId
        if (!agents.some(a => a.harnessId === c.harnessId)) agents.push({ id: `agent-${start.id}`, machineId: spec.machineId, harnessId: c.harnessId, configuration: c.configuration })
      } else if (c.type === 'agent.startSettled') start.settled = true
      else throw new Error(`Unexpected host operation ${c.type}`)
      return { data: { result: {} } }
    }
    // The Swarm ends a session by marking its row; the row goes once its close is acknowledged.
    if (path.includes('/hosts/')) return { data: path.endsWith('/assignments') ? [] : agents.map(agent => ({ tabId: TAB, agent, observers: [], ...(ended.has(agent.harnessId) ? { closeSession: true } : {}) })) }
    if (path.includes('/machines/')) return { data: { revision: 1 } }
    if (path === `/api/super-tabs/${TAB}`) return { data: { state: { id: TAB, agents, project: { machineId: spec.machineId, cwd: project, repositoryUrl: null } }, revision: 1 } }
    if (path.endsWith('/commands')) {
      const c = body.command
      if (c.type === 'agent.sessionClosed') {
        closedAcks.push(c.harnessId)
        agents.splice(agents.findIndex(a => a.harnessId === c.harnessId), 1)
        return { data: { result: {} } }
      }
      if (c.type === 'agent.configuration') return { data: { result: {} } }
      throw new Error(`Unexpected command ${c.type}`)
    }
    if (path.endsWith('/deliveries')) return { data: [] }
    throw new Error(`Unexpected request ${method} ${path}`)
  })
  onTestFailed(() => console.log(d.log().split('\n').slice(-120).join('\n')))
  await d.start()
  await until('the fixture account connected', () => backend.nodeUp(spec.machineId), 30_000)
  const client = await LocalClient.connect(d, { machineId: spec.machineId }); clients.push(client)
  const setup = { action: 'prepareContribution', tabId: TAB, operationId: 'fixture-setup' }
  await until('machine preparation', async () => (await client.request('super_tabs', setup, 30_000)).state === 'ready' || null, 45_000, 250)

  for (const id of ['start-clean', 'start-dirty']) starts.set(id, { id, poolGeneration: 'grant-1', creationId: `super-${id}-fixture`, request: request(id), dispatched: false, harnessId: null })
  await client.request('super_tabs', { action: 'wake' }, 30_000)
  const file = swarmWorktreesFile(d.dataDir, spec.machineId)
  const records = () => existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).worktrees as Array<{ startId: string; harnessId: string; path: string }>) : []
  await until('both starts launched in recorded worktrees', () => records().length === 2 && [...starts.values()].every(s => s.settled) || null, 120_000, 500)
  const worktree = (startId: string) => records().find(r => r.startId === startId)!
  const clean = worktree('start-clean'), dirty = worktree('start-dirty')
  for (const r of [clean, dirty]) {
    expect(r.path).toContain(join(d.env.HOME!, 'harnesses', 'worktrees'))
    expect(existsSync(r.path)).toBe(true)
  }
  await until('both sessions running in their worktrees', async () => {
    const rows = (await client.request('agents_list')).agents as Array<Record<string, any>>
    return [clean, dirty].every(r => rows.some(a => a.id === r.harnessId && a.status === 'active')) || null
  }, 60_000, 250)
  writeFileSync(join(dirty.path, 'unpushed.txt'), 'work in progress')

  // The agent is removed, or its project deleted: the Swarm ends both sessions.
  ended.add(clean.harnessId); ended.add(dirty.harnessId)
  await until('both closes acknowledged', () => closedAcks.length === 2 || null, 60_000, 250)
  // The record goes last, once git has removed the worktree and checked its branch.
  await until('the clean worktree removed and its record dropped', () => !existsSync(clean.path) && records().length === 1 || null, 30_000, 250)
  expect(git(project, 'worktree', 'list', '--porcelain')).not.toContain(`${clean.path}\n`)
  expect(readFileSync(join(dirty.path, 'unpushed.txt'), 'utf8')).toBe('work in progress')
  expect(records().map(r => r.startId)).toEqual(['start-dirty'])
  const rows = (await client.request('agents_list')).agents as Array<Record<string, any>>
  expect(rows.some(a => a.id === clean.harnessId || a.id === dirty.harnessId)).toBe(false)
}, 300_000)
