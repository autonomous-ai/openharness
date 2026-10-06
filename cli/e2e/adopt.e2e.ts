/**
 * Opening a conversation Harness did not start, found on this computer (Cmd-P, `agent_create` with a
 * `resumeSessionId`): a Codex conversation a person had in a terminal opens as a harness on it. One Codex
 * archived does not: Codex refuses to resume it until `codex unarchive <id>` puts it back, and opening it
 * started a pane that only printed Codex's error. The daemon now says so, and opens nothing.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>

const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)

describe('opening a Codex conversation Harness did not start', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('one from a terminal opens as a harness on it; one Codex archived is refused, saying how to put it back', async () => {
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
    client.close()
  }, 240_000)
})
