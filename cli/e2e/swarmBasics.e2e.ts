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
  if (engine === 'claude') { const at = args.indexOf('--append-system-prompt'); return at < 0 ? undefined : args[at + 1] }
  const value = args.find(arg => arg.startsWith('developer_instructions='))
  return value === undefined ? undefined : JSON.parse(value.slice('developer_instructions='.length)) as string
}

it.each(['claude', 'codex'])('tells a PM and an agent the team\'s basics byte for byte on the %s command line, the PM its part, again at a restart and a resume, and a plain agent none', async engine => {
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
  /** The launch [act] makes, once the agent it names is bound and active: the next launch goes behind this one's native hooks.
   *  The daemon may answer "held" while it waits for them, which a busy computer delays: the engine has launched all the same,
   *  and its command line is what this looks at. Launches are made one at a time, so the one after [before] is this one. */
  const seen = new Set<string>()
  async function launched(what: string, act: () => Promise<Record<string, any>>, id?: string): Promise<{ id: string; args: string[] }> {
    const before = launches().length
    const answer = await act()
    expect(['NATIVE_LAUNCH_HELD', undefined], `${what}: ${JSON.stringify(answer)}`).toContain(answer.error)
    const row = await until(`${what}: ${engine} to launch`, () => launches().slice(before).find(row => row.engine === engine) ?? null, 90_000)
    // A held create may answer before it names its agent: then it is the one this test has not seen yet.
    const bound = await until(`${what}: ${engine} to bind its session`, async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.find((agent: Record<string, any>) => (agent.id === (id ?? answer.agent?.id) || (!id && !answer.agent && !seen.has(agent.id)))
        && agent.sessionId && agent.status === 'active') ?? null
    }, 90_000)
    seen.add(bound.id)
    return { id: bound.id, args: row.args }
  }
  const lead = await launched('the PM', () => c.request('agent_create', { engine, cwd, swarmRole: 'lead', prompt: 'You are Faye.' }, 90_000))
  expect(told(engine, lead.args), 'the PM').toBe(expected('lead'))
  const dev = await launched('the agent', () => c.request('agent_create', { engine, cwd, swarmRole: 'dev', prompt: 'You are Pip.' }, 90_000))
  expect(told(engine, dev.args), 'the agent').toBe(expected('dev'))
  // A plain agent, not the Swarm's: no basics at all.
  const plain = await launched('a plain agent', () => c.request('agent_create', { engine, cwd, prompt: 'hello' }, 90_000))
  expect(told(engine, plain.args) ?? '').not.toContain(swarmBasics(false).text.split('\n')[0]!)
  // Restarted, the PM is told again what it was told at its start; closed and resumed, so is the agent, without the PM's part.
  expect(told(engine, (await launched('the PM restarted', () => c.request('agent_restart', { agentId: lead.id }, 90_000), lead.id)).args)).toBe(expected('lead'))
  expect((await c.request('agent_delete', { agentId: dev.id }, 90_000)).error).toBeUndefined()
  await until('the agent to stop', async () => (await c.request('agents_list', { includeStopped: true })).agents
    ?.some((agent: Record<string, any>) => agent.id === dev.id && agent.status === 'stopped') || null, 90_000)
  expect(told(engine, (await launched('the agent resumed', () => c.request('agent_resume', { agentId: dev.id }, 90_000), dev.id)).args)).toBe(expected('dev'))
}, 900_000)
