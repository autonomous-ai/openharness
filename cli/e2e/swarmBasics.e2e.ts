/** What a PM and an agent are told at launch and at every relaunch (the Swarm's basics, Swarm v4), as each engine's own command
 *  line carries it: real native launch path, private tmux, throwaway home and fake engines. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { launchContract } from '../src/engines/launches.js'
import { swarmBasics } from '../src/lib/swarmSkills.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

/** The instructions a launch gives the engine, as it reads them: Claude Code's appended system prompt; Codex's
 *  developer_instructions, a JSON string that TOML reads as the same string. */
function told(engine: string, args: string[]): string | undefined {
  if (engine === 'claude') return args[args.indexOf('--append-system-prompt') + 1]
  const value = args.find(arg => arg.startsWith('developer_instructions='))
  return value === undefined ? undefined : JSON.parse(value.slice('developer_instructions='.length)) as string
}

it.each(['claude', 'codex'])('tells a PM and an agent the team\'s basics byte for byte on the %s command line, the PM its part, and again at a restart', async engine => {
  const d = await IsolatedDaemon.create({ env: { ANTHROPIC_API_KEY: 'fixture-not-a-credential', OPENAI_API_KEY: 'fixture-not-a-credential' } })
  daemon = d
  writeFileSync(join(d.engineConfig.codexHome, 'models_cache.json'), readFileSync(join(CLI_ROOT, 'src/lib/__fixtures__/codex-home-0.160/models_cache.json')))
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  await d.start()
  const c = await LocalClient.connect(d); client = c
  const cwd = join(d.projectsDir, 'shared'); mkdirSync(cwd)
  const launches = (): Array<{ engine: string; args: string[] }> => {
    try { return readFileSync(join(d.root, 'launch-argv'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) }
    catch { return [] }
  }
  // Codex is also told how its sandbox reaches Harness, in the same value (engines/codex/launch.ts).
  const also = engine === 'codex' ? ` ${launchContract('codex')!.harnessInstructions!.also}` : ''
  const expected = (role: string) => `${swarmBasics(role === 'lead').text}${also}`
  const ids: Record<string, string> = {}
  for (const role of ['lead', 'dev']) {
    const before = launches().length
    const created = await c.request('agent_create', { engine, cwd, swarmRole: role, prompt: 'You are Rex.' }, 90_000)
    // The daemon answers "held" while it waits for the engine's native hooks, which a busy computer delays: the engine has
    // launched all the same, and its command line is what this looks at.
    expect(['NATIVE_LAUNCH_HELD', undefined], JSON.stringify(created)).toContain(created.error)
    const row = await until(`the ${role}'s ${engine} to launch`, () => launches().slice(before).find(row => row.engine === engine) ?? null, 90_000)
    expect(told(engine, row.args), role).toBe(expected(role))
    // The next launch goes behind this one's native hooks: it is made once this engine has bound its session.
    const bound = await until(`the ${role}'s ${engine} to bind its session`, async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.length && listed.agents.every((agent: Record<string, any>) => agent.sessionId) ? listed.agents : null
    }, 90_000)
    ids[role] = bound.find((agent: Record<string, any>) => !Object.values(ids).includes(agent.id)).id
  }
  // The PM's part names the hand-off as a channel post that opens with @Name (#3868); an agent is not told to announce one.
  expect(expected('lead')).toContain('announce that hand-off once in your project\'s channel, as "@Pip #12 is yours"')
  expect(expected('dev')).not.toContain('#12 is yours')
  // Restarted, each is told again what it was told at its start.
  for (const role of ['lead', 'dev']) {
    const before = launches().length
    const restarted = await c.request('agent_restart', { agentId: ids[role] }, 90_000)
    expect(restarted.error, JSON.stringify(restarted)).toBeUndefined()
    const row = await until(`the ${role}'s ${engine} to launch again`, () => launches().slice(before).find(row => row.engine === engine) ?? null, 90_000)
    expect(told(engine, row.args), `${role} restarted`).toBe(expected(role))
  }
}, 360_000)
