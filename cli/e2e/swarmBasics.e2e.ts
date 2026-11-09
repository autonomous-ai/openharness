/** What a PM and an agent are told at launch (the Swarm's basics, Swarm v4), as each engine's own command line carries it: real
 *  native launch path, private tmux, throwaway home and fake engines. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it.each(['claude', 'codex'])('tells a PM to say each hand-off in the project\'s channel, and an agent not to, on the %s command line', async engine => {
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
  const told: Record<string, string> = {}
  for (const role of ['lead', 'dev']) {
    const before = launches().length
    const created = await c.request('agent_create', { engine, cwd, swarmRole: role, prompt: 'You are Pip.' }, 90_000)
    // The daemon answers "held" while it waits for the engine's native hooks, which a busy computer delays: the engine has
    // launched all the same, and its command line is what this looks at.
    expect(['NATIVE_LAUNCH_HELD', undefined], JSON.stringify(created)).toContain(created.error)
    const row = await until(`the ${role}'s ${engine} to launch`, () => launches().slice(before).find(row => row.engine === engine) ?? null, 90_000)
    told[role] = row.args.join('\n')
    // The next launch goes behind this one's native hooks: it is made once this engine has bound its session.
    await until(`the ${role}'s ${engine} to bind its session`, async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.length && listed.agents.every((agent: Record<string, any>) => agent.sessionId) || null
    }, 90_000)
  }
  // Both are told how the team works; only the PM is told to say each hand-off where people read the team talk.
  for (const text of Object.values(told)) expect(text).toContain('You are a Swarm agent')
  // Codex takes its instructions as a TOML string, which escapes the quotes: the line is looked for in the parts around them.
  for (const part of ['Say each hand-off in your project\'s channel, as ', 'Pip, you have #12', ', so people can read the team talk.']) expect(told.lead).toContain(part)
  expect(told.dev).not.toContain('you have #12')
}, 360_000)
