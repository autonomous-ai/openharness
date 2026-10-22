/**
 * New Harness's two project paths, investigated after the 2026-10-21 launch failure spike:
 * the phone asks the computer to make a project; Desktop on that computer makes the folder first.
 * Use the real daemon and private tmux server, with fake engines and homes owned by this test.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { resolveBinaryOnPath } from '../src/lib/binaryOnPath.js'

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

it('starts phone and Desktop harnesses when managed tmux arrives after daemon startup, without a restart', async () => {
  const tmux = resolveBinaryOnPath('tmux')!
  const d = await IsolatedDaemon.create()
  daemon = d
  onTestFailed(() => { console.log(d.log().split('\n').slice(-150).join('\n')) })
  // Neither the daemon, its shell nor its known install locations can find the host's tmux.
  // Linux installs tmux in /usr/bin, so even the system PATH must be a private tools directory.
  const tools = join(d.root, 'tools-without-tmux')
  mkdirSync(tools)
  for (const name of ['ps', 'lsof', 'sleep', 'stty', 'clear', 'rm', 'mkdir', 'mv', 'chmod', 'cat', 'dirname', 'basename',
    'wc', 'dd', 'grep', 'stat', 'date', 'sort', 'head', 'tail', 'awk', 'sed', 'touch', 'uname', 'env', 'find', 'readlink', 'xargs', 'tty', 'id']) {
    const binary = resolveBinaryOnPath(name)
    if (binary) symlinkSync(binary, join(tools, name))
  }
  symlinkSync(process.execPath, join(tools, 'node'))
  d.env.PATH = `${join(d.root, 'bin')}:${tools}`
  d.env.SHELL = '/bin/zsh'
  d.env.HARNESS_HOMEBREW_PREFIXES = join(d.root, 'no-homebrew')
  writeFileSync(join(d.env.HOME!, '.zshrc'), `export PATH=${JSON.stringify(d.env.PATH)}\n`)
  await d.start()
  const client = await LocalClient.connect(d)
  try {
    const absent = await client.request('agent_create', { engine: 'claude', creationId: 'absent-tmux-00000001', cwd: d.projectsDir }, 90_000)
    expect(absent).toMatchObject({ state: 'failed', failure: { code: 'TMUX_UNAVAILABLE' } })
    // The installer's pointer, published only after an executable has been put in the managed runtime.
    const bin = join(d.env.ADAPTER_RUNTIME_DIR!, 'tmux-fixture', 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(tmux, join(bin, 'tmux'))
    writeFileSync(join(d.env.ADAPTER_RUNTIME_DIR!, 'current-tmux'), join(bin, 'tmux'))
    for (const surface of ['phone', 'Desktop']) for (const engine of ['claude', 'codex']) {
      const folder = join(d.env.HOME!, 'harnesses', `recovered-${surface}-${engine}`)
      if (surface === 'Desktop') mkdirSync(folder, { recursive: true })
      const creationId = `recovered-${surface}-${engine}-0001`
      let created = await client.request('agent_create', { engine, creationId, bypassPermission: true,
        ...(surface === 'phone' ? { projectSource: 'new', projectName: `recovered-${surface}-${engine}`, usageSurface: 'phone' } : { cwd: folder }),
      }, 90_000)
      if (created.state === 'pending') created = await until('the recovered creation to finish', async () => {
        const status = await client.request('agent_create_status', { creationId }, 30_000)
        return status.state === 'pending' ? null : status
      }, 60_000, 250)
      expect(created, JSON.stringify(created)).toMatchObject({ state: 'created', agent: { engine } })
      const id = created.agent.id
      await until('the recovered harness to bind', async () => {
        const listed = await client.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)
        return listed.agents.find(row => row.id === id && row.sessionId && row.status === 'active') ?? null
      }, 60_000, 250)
      const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === id, 45_000, 'the recovered harness to answer')
      client.send('message', { agentId: id, content: 'Reply with pong' })
      await ended
    }
    expect(d.coresStarted()).toBe(1)
    expect(d.log()).toContain('[terminal] tmux recovered')
  } finally { client.close() }
})
