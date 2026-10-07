/**
 * An agent is never named after the machine, whatever the machine is called by then.
 *
 * tmux titles each new pane with the machine's name of that moment (`gethostname`); an engine that sets
 * no title of its own keeps it, and the daemon refuses it as the agent's name. A laptop's name follows
 * its network, and the daemon read it once, at start: after a change, an agent whose pane was made under
 * the new name was named after the machine (found comparing with v0.3.58, e2e/compat.e2e.ts). The name
 * is now read on every title sweep, and every name the machine has had counts (lib/machineNames.ts).
 *
 * A test cannot change the computer's name, and must not. HARNESSD_TEST_HOSTNAME_FILE stands in for it:
 * the daemon reads that file where it would ask the operating system. The agent's pane is titled as
 * tmux titles a pane made under the name, with `select-pane -T`: the daemon reads a pane's title the
 * same way however it was set. That a pane the daemon makes reads the name as tmux titles it is proved
 * in lib/tmuxBackend.spec.ts: no test here can make the name change between two sweeps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

describe('an agent is never named after the machine', () => {
  let scratch = ''
  let hostFile = ''
  let daemon: IsolatedDaemon | undefined

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'harnessd-hostname-'))
    // Not written yet: until it is, the machine's name is the computer's own, as at any start.
    hostFile = join(scratch, 'hostname')
    daemon = await IsolatedDaemon.create({ env: { HARNESSD_TEST_HOSTNAME_FILE: hostFile } })
    await daemon.start()
  })

  afterAll(async () => {
    await daemon?.close()
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('when the machine\'s name changes, and after it changes again', async () => {
    const d = daemon!
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'roaming')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const row = async () => (await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)).agents
      .find((one) => one.id === created.agent.id)
    const agent = await until('codex to bind', async () => {
      const now = await row()
      return now?.sessionId && now.status === 'active' && now.tmuxPane ? now : null
    }, 60_000, 500)
    // Its own name: the fake Codex sets no title, so its pane has tmux's, the machine's name at start.
    const own = agent.name as string
    expect(agent.title).toBeNull()

    const title = (text: string) => d.tmux.run('select-pane', '-t', agent.tmuxPane, '-T', text)
    /** A title about the conversation becomes the agent's name: a sweep has run since it was set. */
    const named = async (text: string) => {
      await title(text)
      await until(`the agent to be named "${text}"`, async () => (await row())?.name === text || null, 30_000, 250)
    }
    /** A title that is the machine's name: the agent goes back to its own name, never the machine's. */
    const refused = async (text: string) => {
      await title(text)
      const now = await until(`a sweep to read "${text}"`, async () => {
        const current = await row()
        return current?.name === text || (current?.name === own && current.title === null) ? current : null
      }, 30_000, 250)
      expect(now.name, `the agent was named after the machine: ${text}`).toBe(own)
      expect(now.title).toBeNull()
    }

    // The machine joins a network that calls it laptop-one.lan, and a pane is made under that name.
    writeFileSync(hostFile, 'laptop-one.lan')
    await named('Fix the login page')
    await refused('laptop-one.lan')

    // Then one that calls it laptop-two.local. The pane made under laptop-one.lan keeps that title.
    writeFileSync(hostFile, 'laptop-two.local')
    await named('Fix the login page')
    await refused('laptop-one.lan')
    // The first part of a name, in any case, is the same machine.
    await named('Ship the settings page')
    await refused('LAPTOP-TWO')
    client.close()
  }, 180_000)
})
