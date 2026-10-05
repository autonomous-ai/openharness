/**
 * What a client sees while the daemon starts. The desktop app connects the moment the daemon's port
 * answers, so everything the daemon says from then on is something a person sees.
 *
 * Each of these was a defect of the daemon before harnessd, found by this suite and pinned with
 * `it.fails` until the request gate (BackendSocket.openRequests) fixed it.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

describe('starting up', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  // The port answers long before every request handler is wired (the restore and the first full
  // reconcile come in between). Before the gate a request in that window was refused with
  // UNSUPPORTED_ON_REMOTE, which no client expects from its own machine.
  it('answers every request with its real handler from the instant its port answers', async () => {
    daemon = await IsolatedDaemon.create()
    await daemon.start()
    const setup = await LocalClient.connect(daemon)
    for (const name of ['a', 'b', 'c']) {
      const cwd = join(daemon.projectsDir, name)
      mkdirSync(cwd, { recursive: true })
      await setup.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    }
    setup.close()
    await daemon.stop()
    await daemon.start({ ready: 'port' })
    const client = await LocalClient.connect(daemon)
    const errors: string[] = []
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      errors.push((await client.request('agent_fork', { agentId: 'no-such-agent' })).error)
    }
    expect(errors).not.toContain('UNSUPPORTED_ON_REMOTE')
  })

  // Worse than a refusal: `message` has no reply, so before the gate a message that landed before
  // `onMessage` was wired was dropped with only a log line. Found by master.e2e.ts, whose client
  // reconnects the moment a restarted daemon's port answers.
  it('delivers a message sent the instant its port answers', async () => {
    daemon = await IsolatedDaemon.create()
    await daemon.start()
    const setup = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, 'message')
    mkdirSync(cwd, { recursive: true })
    const agentId: string = (await setup.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)).agent.id
    await until('the conversation to bind', async () => ((await setup.request('agents_list', {})).agents as Array<Record<string, any>>)
      .find((agent) => agent.id === agentId)?.sessionId, 45_000, 200)
    setup.close()
    await daemon.stop()
    await daemon.start({ ready: 'port' })
    const client = await LocalClient.connect(daemon)
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 20_000, 'the turn the message started')
    client.send('message', { agentId, content: 'sent the moment the port answered' })
    await ended
  })

  // Before the gate the registry was served before the restore confirmed the panes: a running agent
  // listed as `stopped` (when it had a conversation) or not at all, and the app showed it paused or gone.
  it('never shows a running agent as stopped or missing across a restart', async () => {
    daemon = await IsolatedDaemon.create()
    await daemon.start()
    let client = await LocalClient.connect(daemon)
    const cwd = join(daemon.projectsDir, 'restart')
    mkdirSync(cwd, { recursive: true })
    const agentId: string = (await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)).agent.id
    const row = async () => ((await client.request('agents_list', { includeStopped: true })).agents as Array<Record<string, any>>)
      .find((agent) => agent.id === agentId)
    await until('the conversation to bind', async () => (await row())?.sessionId, 45_000, 200)
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === agentId)
    client.send('message', { agentId, content: 'hello' })
    await ended

    await daemon.stop()
    await daemon.start({ ready: 'port' })
    client = await LocalClient.connect(daemon)
    const seen: string[] = []
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      seen.push((await row())?.status ?? 'absent')
      await new Promise((done) => setTimeout(done, 50))
    }
    expect(seen.filter((status) => status === 'stopped' || status === 'absent')).toEqual([])
  })
})
