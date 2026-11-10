/** A refused post's usage line, from a Swarm agent's own pane, through the real daemon: private tmux, throwaway homes and fake
 *  engines. A Buddy's own wording (no stdin form, #2358) is the unit specs' (superTabs/command.spec.ts): a Buddy launches only
 *  in its owner's checked folder, which this daemon has none of. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it('words a refused post for a Swarm agent in its pane, with the stdin form', async () => {
  const d = await IsolatedDaemon.create({ env: { ANTHROPIC_API_KEY: 'fixture-not-a-credential' } })
  daemon = d
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  await d.start()
  const c = await LocalClient.connect(d); client = c
  const cwd = join(d.projectsDir, 'chat'); mkdirSync(cwd)
  const created = await c.request('agent_create', { engine: 'claude', cwd, swarmRole: 'dev', prompt: 'hello' }, 90_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const pane = await until('agent pane', async () => {
    const listed = await c.request('agents_list', {})
    return listed.agents?.find((row: Record<string, any>) => row.id === created.agent.id && row.tmuxPane)?.tmuxPane ?? null
  }, 30_000)
  // Not signed in, the daemon is this computer's own id, as whereFor reads it.
  const where = { port: d.port, dataDir: d.dataDir, machineId: d.computerId }
  let error = ''
  const code = await superTabCommand(['--tab', 'tab', 'post', 'chat', 'Ready'], { where: () => where, pane, print: text => { error = JSON.parse(text).error } })
  expect(code).toBe(1)
  expect(error).toContain('post GROUP TEXT|- OPERATION_ID')
})
