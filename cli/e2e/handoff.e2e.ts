/** Change agent prepares its file in the edge host. A failure there costs no agent its turn. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

const CHANGE = '0123456789abcdef0123456789abcdef'

describe('change agent in the edge host', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  async function start(env: Record<string, string> = {}, engine = 'claude') {
    daemon = await IsolatedDaemon.create({ env })
    const d = daemon
    onTestFailed(() => console.log(`---- daemon log\n${d.log().split('\n').slice(-160).join('\n')}`))
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'handoff-project')
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init', '-q', cwd])
    execFileSync('git', ['-C', cwd, '-c', 'user.name=QA', '-c', 'user.email=qa@fixture.invalid', 'commit', '-qm', 'fixture', '--allow-empty'])
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the handoff agent to bind', async () => {
      const { agents } = await client.request('agents_list')
      return agents.find((row: Record<string, any>) => row.id === agentId)?.sessionId || null
    }, 45_000, 250)
    return { d, client, cwd, agentId }
  }

  async function turn(client: LocalClient, agentId: string, content: string) {
    const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 30_000, content)
    client.send('message', { agentId, content })
    await ended
  }

  for (const mode of ['edge', 'inline']) {
    it(`a handoff that cannot start is unavailable, while the agent keeps working (${mode})`, async () => {
      const { d, client, agentId } = await start({ HARNESSD_TEST_FAULTS: 'handoff', ...(mode === 'inline' ? { HARNESSD_SERVICES: 'none' } : {}) })
      await turn(client, agentId, 'keep this agent working')
      expect(await client.request('agent_handoff_prepare', { agentId, changeId: CHANGE, targetEngine: 'codex' }))
        .toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'handoff', retryable: mode === 'edge' })
      await turn(client, agentId, 'still working after the unavailable handoff')
      expect(d.coresStarted()).toBe(1)
      client.close()
    })
  }

  it.each(['claude', 'codex'])('keeps the same handoff and conversation for a stopped %s agent', async (engine) => {
    const { d, client, cwd, agentId } = await start({}, engine)
    await turn(client, agentId, 'remember the handoff request')
    const prepared = await client.request('agent_handoff_prepare', { agentId, changeId: CHANGE, targetEngine: 'codex' })
    expect(prepared).toMatchObject({ agentId, gitRepo: true, cwd, degraded: [] })
    expect(prepared.file).toBe(`.harness/handoff/${agentId}-${CHANGE}.md`)
    expect(readFileSync(join(cwd, prepared.file), 'utf8')).toContain('remember the handoff request')
    const deleted = await client.request('agent_delete', { agentId }, 30_000)
    expect(deleted.error, JSON.stringify(deleted)).toBeUndefined()
    await until('the handoff agent to stop', async () => {
      const { agents } = await client.request('agents_list', { includeStopped: true })
      return agents.find((row: Record<string, any>) => row.id === agentId)?.status === 'stopped' || null
    }, 30_000, 250)
    const stopped = await client.request('agent_handoff_prepare', { agentId, changeId: 'fedcba9876543210fedcba9876543210', targetEngine: 'codex' })
    expect(stopped).toMatchObject({ agentId, gitRepo: true, cwd, degraded: [] })
    expect(readFileSync(join(cwd, stopped.file), 'utf8')).toContain('remember the handoff request')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })

  it.each(['claude', 'codex'])('a stopped %s fork that never bound inherits only the conversation before the fork from its stopped parent', async (engine) => {
    const { d, client, cwd, agentId } = await start({}, engine)
    await turn(client, agentId, 'the request before the fork')
    // The next process is slow to start, while the parent's already running process keeps going.
    // Stop this fork before its first hook: the retained record must still name its parent.
    const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    const wrapper = join(d.root, 'bin', engine)
    const config = { ...d.engineConfig, startDelayMs: 60_000 }
    writeFileSync(`${wrapper}.new`, `#!${process.execPath}\nimport(${JSON.stringify(module)}).then(m => m.run(${JSON.stringify(engine)}, ${JSON.stringify(config)}))\n`, { mode: 0o755 })
    renameSync(`${wrapper}.new`, wrapper)
    const forked = await client.request('agent_fork', { agentId, name: 'handoff fork' }, 60_000)
    expect(forked.error, JSON.stringify(forked)).toBeUndefined()
    const forkId: string = forked.agent.id
    const pending = JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')).find((row: Record<string, any>) => row.agentId === forkId)
    expect(pending.forkedFrom.agentId).toBe(agentId)
    expect(pending.sessionId).toBe('')
    await turn(client, agentId, 'the request after the fork must stay with its parent')
    expect((await client.request('agent_delete', { agentId }, 30_000)).error).toBeUndefined()
    expect((await client.request('agent_delete', { agentId: forkId }, 30_000)).error).toBeUndefined()
    client.close()
    await d.stop()
    // Exercise the handoff reader against the exact pending row observed above. Stop's separate
    // resume-identity capture can find the source named on a fork's argv; it is not the state this
    // case covers. With the daemon off, seed the retained unbound record as the store would save it.
    const savedPath = join(d.dataDir, 'stopped-agents', `${forkId}.json`)
    writeFileSync(savedPath, JSON.stringify({ version: 1, session: { ...pending, active: false, launch: { state: 'ready' } } }))
    await d.start()
    await until('handoff to reconnect after the restart', () => d.log().split('[services] handoff connected').length >= 3 || null, 30_000, 200)
    const restarted = await LocalClient.connect(d)
    const inherited = await restarted.request('agent_handoff_prepare', { agentId: forkId, changeId: CHANGE, targetEngine: 'codex' })
    expect(inherited).toMatchObject({ agentId: forkId, gitRepo: true, cwd, degraded: [] })
    const summary = readFileSync(join(cwd, inherited.file), 'utf8')
    expect(summary).toContain('the request before the fork')
    expect(summary).not.toContain('the request after the fork')
    // Found by QA on a quiet machine: these reads must still resolve a stopped parent through the
    // core after handoff rendering moves to the edge host, without borrowing later parent turns.
    expect(summary).toContain('History: inherited from')
    expect(d.coresStarted()).toBe(2)
    restarted.close()
  })

  it('the edge host can die without an agent losing its turn, then prepare another handoff after recovery', async () => {
    const { d, client, cwd, agentId } = await start({ HARNESSD_SERVICE_INITIAL_BACKOFF_MS: '5000' })
    await until('handoff to connect', () => d.log().includes('[services] handoff connected') || null, 30_000, 200)
    const match = [...d.log().matchAll(/\[harnessd\] service edge started \(pid (\d+)\)/g)].at(-1)
    expect(match).toBeDefined()
    const pid = Number(match![1])
    expect(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()).toBe('harnessd-edge')
    process.kill(pid, 'SIGKILL')
    await until('handoff to disconnect', () => d.log().includes('[services] handoff disconnected') || null, 15_000, 100)
    expect(await client.request('agent_handoff_prepare', { agentId, changeId: CHANGE, targetEngine: 'codex' }))
      .toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'handoff', retryable: true })
    await turn(client, agentId, 'a turn while the handoff host is gone')
    await until('handoff to reconnect', () => d.log().split('[services] handoff connected').length >= 3 || null, 30_000, 200)
    const prepared = await client.request('agent_handoff_prepare', { agentId, changeId: CHANGE, targetEngine: 'codex' })
    expect(prepared).toMatchObject({ agentId, gitRepo: true, cwd, degraded: [] })
    expect(readFileSync(join(cwd, prepared.file), 'utf8')).toContain('a turn while the handoff host is gone')
    expect(d.coresStarted()).toBe(1)
    client.close()
  })
})
