/**
 * Opening a conversation Harness did not start, found on this computer (Cmd-P, `agent_create` with a
 * `resumeSessionId`): a Codex conversation a person had in a terminal opens as a harness on it. One Codex
 * archived does not: Codex refuses to resume it until `codex unarchive <id>` puts it back, and opening it
 * started a pane that only printed Codex's error. The daemon now says so, and opens nothing.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)

describe('opening a Codex conversation Harness did not start', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('opens a terminal conversation, refuses archives, and never replaces an adopted conversation when restart loses resume support', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-150).join('\n')}`) })
    const cwd = join(d.projectsDir, 'by-hand')
    mkdirSync(cwd, { recursive: true })
    // Two conversations Codex wrote in a terminal, as it leaves them: one where it keeps them, and one it
    // archived (`archived_sessions/`).
    const rollout = (dir: string, id: string): void => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `rollout-2026-10-03T00-00-00-${id}.jsonl`),
        `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id, cli_version: '0.159.0', cwd, source: 'cli' } })}\n`)
    }
    const kept = '019a0c0d-0000-7000-8000-0000000000a1'
    const archived = '019a0c0d-0000-7000-8000-0000000000a2'
    rollout(join(d.engineConfig.codexHome, 'sessions', '2026', '10', '03'), kept)
    rollout(join(d.engineConfig.codexHome, 'archived_sessions'), archived)
    await d.start()
    const client = await LocalClient.connect(d)
    await until('search to connect before checking known refusals', () => d.log().includes('[services] search connected') || null, 30_000, 100)

    // As the apps open a search hit: its engine, its folder and its id (desktop `resumeConversation`).
    const refused = await client.request('agent_create', { engine: 'codex', cwd, resumeSessionId: archived, bypassPermission: true }, 90_000)
    expect(refused.error, JSON.stringify(refused)).toBe('SESSION_ARCHIVED')
    expect(String(refused.detail)).toContain(`codex unarchive ${archived}`)
    expect(await rows(client)).toEqual([])

    const opened = await client.request('agent_create', { engine: 'codex', cwd, resumeSessionId: kept, bypassPermission: true }, 90_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    await until('the harness on the conversation from the terminal', async () => {
      const now = await row(client, opened.agent.id)
      return now?.sessionId === kept && now.status === 'active' ? now : null
    }, 60_000, 500)
    // Binding is announced while held restore is still committing its route. Finish a real turn
    // before asking for a second pane operation, as the already-running restart tests do.
    const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === opened.agent.id, 45_000)
    client.send('message', { agentId: opened.agent.id, content: 'Adopted conversation before the update' })
    await ended
    // An engine update can remove resume. The coordinator must carry the adoption's strict
    // resume requirement into the real pane swap instead of falling back to a new conversation.
    const wrapper = join(d.root, 'bin', 'codex')
    const module = pathToFileURL(join(CLI_ROOT, 'e2e', 'harness', 'fakeEngine.mjs')).href
    writeFileSync(wrapper + '.new', `#!${process.execPath}\nimport(${JSON.stringify(module)}).then(m => m.run('codex', ${JSON.stringify({ ...d.engineConfig, version: '0.161.0', without: ['resume'] })}))\n`, { mode: 0o755 })
    renameSync(wrapper + '.new', wrapper)
    expect(await client.request('agent_restart', { agentId: opened.agent.id }, 90_000)).toMatchObject({ error: 'RESTART_FAILED' })
    const conversations = (await rows(client)).filter(agent => agent.engine === 'codex' && agent.sessionId)
    expect(conversations.length).toBeGreaterThan(0)
    expect(conversations.every(agent => agent.sessionId === kept)).toBe(true)
    client.close()
  }, 240_000)

  it('holds through a search outage and tmux loss, cancels without archiving, then resumes entirely in core once admitted', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    const gate = join(d.root, 'hold-search')
    writeFileSync(gate, '')
    d.env.HARNESSD_TEST_HOLD_CONNECT = `search:${gate}`
    const cwd = join(d.projectsDir, 'external-held'); mkdirSync(cwd, { recursive: true })
    const dir = join(d.engineConfig.codexHome, 'sessions', '2026', '10', '09'); mkdirSync(dir, { recursive: true })
    const ids = ['019a0c0d-0000-7000-8000-0000000000b1', '019a0c0d-0000-7000-8000-0000000000b2']
    const paths = ids.map(id => join(dir, `rollout-2026-10-09T00-00-00-${id}.jsonl`))
    for (const [i, path] of paths.entries()) writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta',
      payload: { id: ids[i], cli_version: '0.159.0', cwd, source: 'cli' } }) + '\n')
    const untouched = readFileSync(paths[1], 'utf8')
    const started = Date.now(); await d.start()
    expect(Date.now() - started).toBeLessThan(15_000)
    let client = await LocalClient.connect(d)
    const held = []
    for (const id of ids) {
      const answer = await client.request('agent_create', { engine: 'codex', cwd, resumeSessionId: id, bypassPermission: true }, 15_000)
      expect(answer.error, JSON.stringify(answer)).toBeUndefined()
      held.push(answer.agent.id as string)
      expect(await row(client, answer.agent.id)).toMatchObject({ sessionId: '', launch: { state: 'held', service: 'search' } })
    }
    expect(await client.request('agent_create', { engine: 'codex', cwd, resumeSessionId: ids[0], bypassPermission: true }, 15_000))
      .toMatchObject({ error: 'SESSION_IN_HARNESS' })
    expect((await client.request('agent_delete', { agentId: held[1] }, 10_000)).error).toBeUndefined()
    await until('cancelled adoption removed without an archive', async () => !await row(client, held[1]) || null, 10_000, 100)
    expect(existsSync(join(d.dataDir, 'stopped-agents', `${held[1]}.json`))).toBe(false)
    expect(readFileSync(paths[1], 'utf8')).toBe(untouched)

    // Session control is independent of the catalog: a plain harness starts and closes a turn here.
    const own = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 30_000)
    expect(own.error, JSON.stringify(own)).toBeUndefined()
    await until('plain harness binds while search is unavailable', async () => (await row(client, own.agent.id))?.sessionId || null, 45_000, 100)
    const turn = async (agentId: string, content: string) => {
      const ended = client.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000)
      client.send('message', { agentId, content }); await ended
    }
    await turn(own.agent.id, 'Core control while search waits')
    client.close(); await d.stop(); await d.tmux.run('kill-server'); await d.start()
    client = await LocalClient.connect(d)
    expect(await row(client, held[0])).toMatchObject({ sessionId: '', launch: { state: 'held', service: 'search' } })
    expect(await row(client, held[1])).toBeUndefined()
    expect(readFileSync(paths[1], 'utf8')).toBe(untouched)

    unlinkSync(gate)
    await until('the held adoption resumes after search returns', async () => {
      const resumed = await row(client, held[0])
      return resumed?.sessionId === ids[0] && resumed.status === 'active' ? resumed : null
    }, 60_000, 250)
    await turn(held[0], 'Admitted conversation continues')

    // Once admitted, both crash restore and Stop/Open use the owned row while search is absent.
    client.close(); await d.stop(); writeFileSync(gate, ''); await d.tmux.run('kill-server'); await d.start()
    client = await LocalClient.connect(d)
    await until('admitted conversation returns without search', async () => {
      const resumed = await row(client, held[0])
      return resumed?.sessionId === ids[0] && resumed.status === 'active' ? resumed : null
    }, 60_000, 250)
    expect((await client.request('agent_delete', { agentId: held[0] }, 30_000)).error).toBeUndefined()
    await until('admitted conversation is stopped', async () => (await row(client, held[0]))?.status === 'stopped' || null, 30_000, 100)
    expect((await client.request('agent_resume', { agentId: held[0] }, 60_000)).error).toBeUndefined()
    await until('admitted conversation opens without search', async () => {
      const resumed = await row(client, held[0])
      return resumed?.sessionId === ids[0] && resumed.status === 'active' ? resumed : null
    }, 60_000, 250)
    await turn(held[0], 'Open remained in core')
    client.close()
  }, 240_000)
})
