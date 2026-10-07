/** The TUI picker exit/resume incident: a verified conversation was erased when its engine exited
 *  during a pending startup attach. It then reopened as a new conversation under the old title. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, id: string) => (await rows(client)).find(agent => agent.id === id)

describe('a native exit during the pending startup attach', () => {
  let daemon: IsolatedDaemon | undefined
  let gate: string | undefined
  afterEach(async () => {
    if (gate) writeFileSync(`${gate}.release`, '')
    await daemon?.close()
    daemon = undefined
    gate = undefined
  })

  it.each(['claude', 'codex'] as const)('%s keeps its verified conversation for retirement and resumes that same conversation', async engine => {
    const d = await IsolatedDaemon.create()
    daemon = d
    gate = join(d.root, 'startup-attach')
    d.env.NODE_OPTIONS = `--import ${join(CLI_ROOT, 'e2e/harness/pendingStartupAttach.mjs')}`
    d.env.E2E_STARTUP_ATTACH_GATE = gate
    writeFileSync(`${gate}.armed`, engine === 'claude' ? d.engineConfig.claudeProjectsDir : d.engineConfig.codexHome)
    onTestFailed(() => console.log(`---- daemon log\n${d.log()}`))
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, `pending-startup-${engine}`)
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    await until('the startup attach to wait on its real transcript read', async () => existsSync(`${gate}.pending`) || null, 30_000, 25)
    const bound = await until('the verified conversation to be registered', async () => {
      const agent = await row(client, created.agent.id)
      return agent?.sessionId ? agent : null
    }, 30_000, 100)
    const sessionId = bound.sessionId
    const registered = (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Row[]).find(agent => agent.agentId === bound.id)!
    expect(registered.processIdentity?.startMarker).toBeTruthy()
    const pid = registered.processIdentity.pid as number
    // The native process leaves; no stop/restart RPC owns this transition. Retirement belongs to
    // discovery as before, after the pending attach resumes and observes the engine really gone.
    process.kill(pid, 'SIGTERM')
    await until('the engine process to exit', async () => {
      try { process.kill(pid, 0); return null } catch { return true }
    }, 15_000, 25)
    writeFileSync(`${gate}.release`, '')
    await until('the metadata read to resume', async () => existsSync(`${gate}.released`) || null, 5_000, 25)
    const retired = await until('existing discovery to retire the exited engine', async () => {
      const agent = await row(client, bound.id)
      return agent?.status === 'stopped' ? agent : null
    }, 45_000, 250)
    expect(retired.sessionId, 'retirement must retain the verified conversation').toBe(sessionId)
    expect((await client.request('agent_resume', { agentId: bound.id }, 90_000)).error).toBeUndefined()
    const resumed = await until('the same agent and conversation to resume', async () => {
      const agent = await row(client, bound.id)
      return agent?.status === 'active' && agent.sessionId === sessionId ? agent : null
    }, 60_000, 250)
    expect(resumed.id).toBe(bound.id)
    // Native exit leaves the original shell available as a terminal; only one engine may resume.
    const active = (await rows(client)).filter(agent => agent.status === 'active')
    expect(active.filter(agent => agent.engine === engine).map(agent => agent.id)).toEqual([bound.id])
    expect(active.filter(agent => agent.id !== bound.id).every(agent => agent.engine === 'terminal')).toBe(true)
    const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === bound.id, 45_000, 'a turn after reopening')
    client.send('message', { agentId: bound.id, content: 'continue the same conversation after native exit' })
    await ended
    expect((await row(client, bound.id))?.sessionId).toBe(sessionId)
    client.close()
  })
})
