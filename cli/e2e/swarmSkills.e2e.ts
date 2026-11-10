/**
 * Swarm v4 (anh Dee, 2026-11-08): a Swarm agent starts as plain Claude Code or Codex, told only the team's basics (a PM the
 * PM's part too), never a skill file. Real native launch path, with private tmux, throwaway homes and fake engines.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { PM_BASICS, swarmBasics } from '../src/lib/swarmSkills.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

/** What a launch tells a Swarm agent: the team's basics, and a PM its own part. Their first line and sentence, which reach
 *  either engine as they are (Codex's TOML escapes the quotes and line breaks after them). */
const BASICS = swarmBasics(false).text.split('\n')[0]!, PM_PART = `${PM_BASICS.split('.')[0]!}.`

it('starts a Swarm agent of either engine with the team\'s basics alone, and tells it again at a restart, writing no skill file', async () => {
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
  const originals: Array<{ id: string; engine: string; role: string; key: string }> = []
  for (const engine of ['claude', 'codex']) for (const role of ['lead', 'dev']) {
    const before = launches().length
    const created = await c.request('agent_create', { engine, cwd, swarmRole: role, permissionMode: 'full', bypassPermission: true, prompt: 'hello' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const row = await until('engine to be told the team\'s basics', () => launches().slice(before).find(row => row.engine === engine) ?? null, 30_000)
    const args = row.args.join(' ')
    expect(row.args).toContain(engine === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox')
    expect(args).toContain(BASICS)
    expect(args.includes(PM_PART), `${engine} ${role}`).toBe(role === 'lead')
    expect(args).not.toContain('SKILL.md')
    const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Array<Record<string, any>>
    const saved = registry.find(row => row.agentId === created.agent.id)!
    expect(saved.permissionMode).toBe('full')
    // Saved as the kind it is (project instructions, phase 4); the wire and the file keep their older names.
    const kind = role === 'lead' ? 'coordinator' : 'agent'
    expect(saved.swarmSkill).toMatchObject({ role: kind, key: expect.any(String) })
    originals.push({ id: created.agent.id, engine, role: kind, key: saved.swarmSkill.key })
    await until('engine to bind its conversation', async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.some((row: Record<string, any>) => row.id === created.agent.id && row.sessionId) || null
    }, 30_000)
  }
  // A Claude Code PM and a Codex agent, restarted: each told again what it was told at its start, and nothing more.
  for (const restarted of [originals[0]!, originals[3]!]) {
    const before = launches().length
    const answer = await c.request('agent_restart', { agentId: restarted.id }, 90_000)
    expect(answer.error, JSON.stringify(answer)).toBeUndefined()
    const row = await until('restart to tell it again', () => launches().slice(before).find(row => row.engine === restarted.engine) ?? null, 30_000)
    const args = row.args.join(' ')
    expect(args).toContain(BASICS)
    expect(args.includes(PM_PART), restarted.engine).toBe(restarted.role === 'coordinator')
    expect(args).not.toContain('SKILL.md')
  }
  expect(existsSync(join(cwd, '.harness'))).toBe(false)
  expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('Shared project rules\n')
  const registry = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Array<Record<string, any>>
  for (const original of originals) expect(registry.find(row => row.agentId === original.id)?.swarmSkill).toEqual({ role: original.role, key: original.key })
  // No skill of the Swarm's is written in the engines' own homes either.
  for (const home of [d.engineConfig.codexHome, join(d.root, 'home', '.claude')]) {
    const files = readdirSync(home, { recursive: true }).map(String)
    expect(files.filter(file => /(^|\/)(swarm-[^/]*|SKILL\.md)$/.test(file))).toEqual([])
  }
})
