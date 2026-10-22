/**
 * New Harness's two project paths, investigated after the 2026-10-21 launch failure spike:
 * the phone asks the computer to make a project; Desktop on that computer makes the folder first.
 * Use the real daemon and private tmux server, with fake engines and homes owned by this test.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

let daemon: IsolatedDaemon | undefined
afterEach(async () => { await daemon?.close(); daemon = undefined })

for (const surface of ['phone', 'Desktop'] as const) {
  it.each(['claude', 'codex'] as const)(`${surface}: a new %s harness starts in its project and takes its first message`, async engine => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(d.log().split('\n').slice(-150).join('\n')) })
    await d.start()
    const client = await LocalClient.connect(d)
    try {
      const folder = join(d.env.HOME!, 'harnesses', `${surface.toLowerCase()}-${engine}`)
      if (surface === 'Desktop') mkdirSync(folder, { recursive: true })
      const creationId = `creation-${surface}-${engine}-0001`
      const payload = {
        engine, creationId, bypassPermission: true,
        ...(surface === 'phone'
          ? { projectSource: 'new', projectName: `phone-${engine}`, usageSurface: 'phone' }
          : { cwd: folder }),
      }
      // Loopback carries the phone's request shape here; relay/auth are covered by relay.e2e.ts.
      let created = await client.request('agent_create', payload, 90_000)
      if (created.state === 'pending') created = await until('the saved creation to finish', async () => {
        const status = await client.request('agent_create_status', { creationId }, 30_000)
        return status.state !== 'pending' ? status : null
      }, 60_000, 250)
      expect(created, JSON.stringify(created)).toMatchObject({ state: 'created', agent: { engine } })
      const id = created.agent.id
      const agent = await until('the new harness to bind its conversation', async () => {
        const listed = await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)
        return listed.agents.find(row => row.id === id && row.sessionId && row.status === 'active') ?? null
      }, 60_000, 250)
      expect(agent.project?.cwd ?? agent.cwd).toBe(folder)
      const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === id, 45_000, 'the first message to finish')
      client.send('message', { agentId: id, content: 'Reply with pong' })
      await ended
      expect(d.coresStarted()).toBe(1)
    } finally { client.close() }
  })
}
