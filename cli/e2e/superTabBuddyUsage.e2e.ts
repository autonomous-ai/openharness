/** A Buddy's usage line, from its own pane, through the real daemon: private tmux, throwaway homes and fake engines. Its guard
 *  refuses a post read from stdin (#2358), so it is not offered the stdin form; a Builder's keeps it. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { superTabCommand } from '../src/superTabs/command.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined, client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

it("words a refused post for the Buddy in the pane, without stdin, and for a Builder with it", async () => {
  const d = await IsolatedDaemon.create({ env: { ANTHROPIC_API_KEY: 'fixture-not-a-credential' } })
  daemon = d
  onTestFailed(() => console.log(d.log().split('\n').slice(-100).join('\n')))
  await d.start()
  const c = await LocalClient.connect(d); client = c
  const cwd = join(d.projectsDir, 'chat'); mkdirSync(cwd)
  const panes: Record<string, string> = {}
  for (const role of ['buddy', 'dev']) {
    const created = await c.request('agent_create', { engine: 'claude', cwd, swarmRole: role, prompt: 'hello' }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    panes[role] = await until(`${role} pane`, async () => {
      const listed = await c.request('agents_list', {})
      return listed.agents?.find((row: Record<string, any>) => row.id === created.agent.id && row.tmuxPane)?.tmuxPane ?? null
    }, 30_000)
  }
  // Not signed in, the daemon is this computer's own id, as whereFor reads it.
  const where = { port: d.port, dataDir: d.dataDir, machineId: d.computerId }
  const refused = async (role: string, args: string[]) => {
    let error = ''
    const code = await superTabCommand(['--tab', 'tab', ...args], { where: () => where, pane: panes[role], print: text => { error = JSON.parse(text).error } })
    expect(code).toBe(1)
    return error
  }
  expect(await refused('buddy', ['post', 'chat', 'Ready'])).toContain('post GROUP TEXT OPERATION_ID [--to AGENT]... [--answers MESSAGE_ID | --reply-to')
  expect(await refused('buddy', ['post', 'chat', 'Ready'])).not.toMatch(/stdin|TEXT\|-|<</)
  expect(await refused('dev', ['post', 'chat', 'Ready'])).toContain('post GROUP TEXT|- OPERATION_ID')
})
