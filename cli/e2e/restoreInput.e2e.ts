/** Messages sent as restored agents become visible must reach the engines after shell startup. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, onTestFailed } from 'vitest'
import { shellSingleQuote } from '../src/lib/engineLaunch.js'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

describe('input during agent restore', () => {
  it.each(['claude', 'codex'] as const)('%s accepts a message before its restored engine starts', async (engine) => {
    const d = await IsolatedDaemon.create({ env: { SHELL: '/bin/bash' } })
    const entered = join(d.root, 'shell-started')
    const release = join(d.root, 'start-engine')
    let client: LocalClient | undefined
    onTestFailed(() => { console.log(`---- daemon log\n${d.log()}`) })
    try {
      await d.start()
      client = await LocalClient.connect(d)
      const cwd = join(d.projectsDir, engine)
      mkdirSync(cwd, { recursive: true })
      const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
      expect(created.error).toBeUndefined()
      const agentId = created.agent.id
      const original = await until('the original conversation to bind', async () => {
        const { agents } = await client!.request('agents_list')
        return agents.find((agent: any) => agent.id === agentId && agent.sessionId) ?? null
      }, 30_000)
      const before = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agentId)
      client.send('message', { agentId, content: 'before the restart' })
      await before
      client.close()
      await d.stop()
      await d.tmux.run('kill-server')

      // Found by QA on a quiet machine: restore exposed an active Codex agent before its process existed.
      // Hold the interactive shell before exec, so the test needs no scheduling race or fake-engine change.
      writeFileSync(join(d.env.HOME!, '.bashrc'), `if [ -n "\${TMUX_PANE:-}" ]; then
  : > ${shellSingleQuote(entered)}
  while [ ! -e ${shellSingleQuote(release)} ]; do sleep 0.05; done
fi
`)
      await d.start()
      await until('the restored shell to reach the startup gate', async () => existsSync(entered), 15_000)
      client = await LocalClient.connect(d)
      const { agents } = await client.request('agents_list')
      expect(agents.find((agent: any) => agent.id === agentId)).toMatchObject({
        status: 'active', sessionId: original.sessionId,
      })
      const outcome = client.next((frame) => frame.agentId === agentId
        && (frame.type === 'turn_ended' || frame.type === 'error'), 30_000, 'the message sent during restore')
      client.send('message', { agentId, content: 'sent while the restored shell was starting' })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      writeFileSync(release, '')
      expect(await outcome).toMatchObject({ type: 'turn_ended', agentId })
      expect(client.frames.filter((frame) => frame.type === 'turn_started' && frame.agentId === agentId))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ userMessage: 'sent while the restored shell was starting' }) })])
    } finally {
      writeFileSync(release, '')
      client?.close()
      await d.close()
    }
  })
})
