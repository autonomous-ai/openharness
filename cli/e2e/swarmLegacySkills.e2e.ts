/** Old sessions adopt skills only through current Swarm membership, on their execution machine. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'
import { retainContributions } from '../src/superTabs/retention.js'
import { overOldRoutes } from './harness/swarmReads.js'

const ME: FakeMachine = { machineId: 'c9'.repeat(16), computerId: 'legacy-sw-test', name: 'Fixture', token: 'legacy-sw-token' }
let daemon: IsolatedDaemon | undefined, relay: FakeBackend | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); await relay?.close(); client = undefined; daemon = undefined; relay = undefined })

it('old Lead and worker restarts and stopped resume gain only their skill; personal and removed sessions gain none', async () => {
  const b = await FakeBackend.start(); relay = b; b.addMachine(ME)
  const d = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: b.wsUrl, WEB_URL: b.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId,
    ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' } }); daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({ version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
    machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e' }), { mode: 0o600 })
  onTestFailed(() => console.log(d.log().split('\n').slice(-120).join('\n')))
  const agents: Array<Record<string, any>> = [], groups: Array<Record<string, any>> = []
  b.superTabs = overOldRoutes(async (_method, raw) => {
    const path = new URL(raw, b.httpUrl).pathname
    if (path === `/api/super-tabs/hosts/${ME.machineId}`) return { data: agents.map(agent => ({ tabId: 'tab', agent, observers: [] })) }
    if (path === '/api/super-tabs/tab') return { data: { state: { agents: agents.filter(a => a.id !== 'removed'), conversations: groups } } }
    return { data: [] }
  })
  await d.start(); const c = await LocalClient.connect(d, { machineId: ME.machineId }); client = c
  const cwd = join(d.projectsDir, 'legacy'); mkdirSync(cwd)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Project rules stay here\n')
  const argv = (): Array<{ engine: string; args: string[] }> => {
    try { return readFileSync(join(d.root, 'launch-argv'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) } catch { return [] }
  }
  const saved = (id: string) => JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: Record<string, any>) => row.agentId === id)
  const ids: Record<string, string> = {}, modes: Record<string, unknown> = {}
  for (const [name, engine] of [['lead', 'claude'], ['worker', 'codex'], ['personal', 'claude'], ['removed', 'codex'], ['resumed', 'claude']]) {
    const created = await c.request('agent_create', { engine, cwd, bypassPermission: true, prompt: 'hello' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined(); ids[name!] = created.agent.id
    await until('old engine to bind', async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.some((row: Record<string, any>) => row.id === created.agent.id && row.sessionId) || null
    }, 30_000)
    expect(saved(created.agent.id).swarmSkill).toBeUndefined()
    modes[name!] = saved(created.agent.id).permissionMode
    if (name !== 'personal') agents.push({ id: name, harnessId: created.agent.id, machineId: ME.machineId })
  }
  groups.push({ leadId: 'lead', agentIds: ['lead', 'worker', 'removed', 'resumed'], archived: false })
  retainContributions(d.dataDir, ME.machineId, agents.map(agent => ({ tabId: 'tab', agent })))
  for (const [name, engine, role] of [['lead', 'claude', 'lead'], ['worker', 'codex', 'dev'], ['personal', 'claude', null], ['removed', 'codex', null]] as const) {
    const before = argv().length
    const reply = await c.request('agent_restart', { agentId: ids[name] }, 90_000)
    expect(reply.error, JSON.stringify(reply)).toBeUndefined()
    expect(saved(ids[name]!).permissionMode).toBe(modes[name])
    const launch = await until('restarted engine argv', () => argv().slice(before).find(row => row.engine === engine) ?? null, 30_000)
    if (role) {
      expect(launch.args.join(' ')).toContain(`swarm-${role}/SKILL.md`)
      expect(saved(ids[name]!).swarmSkill).toEqual({ role: role === 'lead' ? 'coordinator' : 'agent', key: ids[name], mode: 'orchestration' })
    } else {
      expect(launch.args.join(' ')).not.toContain('/swarm/skills/')
      expect(saved(ids[name]!).swarmSkill).toBeUndefined()
    }
  }
  expect((await c.request('agent_delete', { agentId: ids.resumed }, 90_000)).error).toBeUndefined()
  const before = argv().length
  const resumed = await c.request('agent_resume', { agentId: ids.resumed }, 90_000)
  expect(resumed.error, JSON.stringify(resumed)).toBeUndefined()
  const launch = await until('resumed worker argv', () => argv().slice(before).find(row => row.engine === 'claude') ?? null, 30_000)
  expect(launch.args.join(' ')).toContain('swarm-dev/SKILL.md')
  expect(saved(ids.resumed!).swarmSkill).toEqual({ role: 'agent', key: ids.resumed, mode: 'orchestration' })
  expect(readFileSync(join(cwd, '.harness', '.gitignore'), 'utf8')).toContain('runtime/')
  expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('Project rules stay here\n')
  expect(readdirSync(join(cwd, '.harness', 'runtime'))).toHaveLength(3)
  for (const home of [d.engineConfig.codexHome, join(d.root, 'home', '.claude')]) {
    expect(readdirSync(home, { recursive: true }).map(String).some(file => file.includes('swarm-lead') || file.includes('swarm-dev'))).toBe(false)
  }
})
