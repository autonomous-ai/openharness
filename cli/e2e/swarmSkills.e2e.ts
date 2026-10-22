/** Real native launch path, with private tmux, throwaway homes and fake engines. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it('attaches and restores only the selected Swarm skill for both engines, without native-home skill writes', async () => {
  const d = await IsolatedDaemon.create({ env: { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' } })
  daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  await d.start()
  const c = await LocalClient.connect(d); client = c
  const cwd = join(d.projectsDir, 'shared'); mkdirSync(cwd)
  writeFileSync(join(cwd, 'AGENTS.md'), 'Shared project rules\n')
  const launches = (): Array<{ engine: string; args: string[] }> => {
    try { return readFileSync(join(d.root, 'launch-argv'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
    catch { return [] }
  }
  const originals: Array<{ id: string; engine: string; role: string; pointer: string }> = []
  for (const engine of ['claude', 'codex']) for (const role of ['lead', 'dev']) {
    const before = launches().length
    const created = await c.request('agent_create', { engine, cwd, swarmRole: role, permissionMode: 'full', bypassPermission: true, prompt: 'hello' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const row = await until('engine to receive its skill pointer', () => launches().slice(before).find(row => row.engine === engine) ?? null, 30_000)
    const args = row.args.join(' ')
    expect(row.args).toContain(engine === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox')
    expect(args).toContain(`swarm-${role}/SKILL.md`)
    expect(args).not.toContain(`swarm-${role === 'lead' ? 'dev' : 'lead'}/SKILL.md`)
    const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Array<Record<string, any>>
    const saved = registry.find(row => row.agentId === created.agent.id)!
    expect(saved.permissionMode).toBe('full')
    expect(saved.swarmSkill).toMatchObject({ role, key: expect.any(String) })
    originals.push({ id: created.agent.id, engine, role, pointer: saved.swarmSkill.key })
    await until('engine to bind its conversation', async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.some((row: Record<string, any>) => row.id === created.agent.id && row.sessionId) || null
    }, 30_000)
  }
  const restarted = originals[0]!
  const before = launches().length
  const answer = await c.request('agent_restart', { agentId: restarted.id }, 90_000)
  expect(answer.error, JSON.stringify(answer)).toBeUndefined()
  const row = await until('restart to retain the Lead skill', () => launches().slice(before).find(row => row.engine === restarted.engine) ?? null, 30_000)
  expect(row.args.join(' ')).toContain('swarm-lead/SKILL.md')
  expect(readdirSync(join(cwd, '.harness', 'runtime'))).toHaveLength(4)
  expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('Shared project rules\n')
  const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Array<Record<string, any>>
  for (const original of originals) expect(registry.find(row => row.agentId === original.id)?.swarmSkill).toEqual({ role: original.role, key: original.pointer })
  // Only the project runtime carries these skills, including when engines use their own native homes.
  for (const home of [d.engineConfig.codexHome, join(d.root, 'home', '.claude')]) {
    const files = readdirSync(home, { recursive: true }).map(String)
    expect(files.some(file => file.includes('swarm-lead') || file.includes('swarm-dev'))).toBe(false)
  }
})
