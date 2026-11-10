/** A Swarm agent's launch, as each engine's own command line carries it: no hook of Harness's runs before its tools (the shell
 *  guard is gone, anh Dee 2026-11-09), and the command an older launch named still answers. Real native launch path, private
 *  tmux, throwaway home and fake engines. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it.each(['claude', 'codex'])('launches a %s Swarm agent with no shell guard hook, and the old hook still allows a call', async engine => {
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
  const created = await c.request('agent_create', { engine, cwd, swarmRole: 'dev', prompt: 'You are Rex.' }, 90_000)
  // "Held" while the daemon waits for the engine's native hooks on a busy computer: the engine launched all the same.
  expect(['NATIVE_LAUNCH_HELD', undefined], JSON.stringify(created)).toContain(created.error)
  const row = await until(`the ${engine} agent to launch`, () => launches().find(row => row.engine === engine) ?? null, 90_000)
  const args = row.args.join('\n')
  // A Swarm agent all the same: it is told the team's basics.
  expect(args).toContain('You are a Swarm agent')
  expect(args).not.toMatch(/__swarm-shell-guard|PreToolUse/)
  // What an agent a release before still runs before each tool, here from the sources the daemon runs (leanEntry.spec.ts runs
  // it from the shipped cli.js): it answers with no decision.
  const run = spawnSync(process.execPath, ['--import', join(CLI_ROOT, 'node_modules/tsx/dist/loader.mjs'), join(CLI_ROOT, 'src/entry.ts'), '__swarm-shell-guard'],
    { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'sudo npm ci' }, cwd }), encoding: 'utf8', timeout: 30_000, windowsHide: true, env: d.env })
  expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
}, 240_000)
