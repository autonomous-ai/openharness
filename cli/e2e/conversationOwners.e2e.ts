/**
 * One owner per conversation, stopped harnesses included (core/agents/conversationOwners.ts), on the real
 * daemon with the fake Claude Code.
 *
 * How the duplicates formed on a real Mac (2026-10-10, docs/research/2026-10-10-harness-data-audit.md): a
 * harness is stopped with its conversation, then the person picks that conversation up somewhere else, here
 * `claude --resume <id>` typed into a terminal tile. The registry gave the conversation to the tile, as it
 * does between running harnesses, but the stopped harness's record still claimed it, and Cmd-P listed both.
 *
 * What must happen: the stopped record is set aside (moved under `superseded/`, never deleted) the moment
 * the tile binds, the apps are told with the tile as its successor, and the conversation has one row, still
 * one after the tile is stopped too. A duplicate an older daemon left on disk is set aside as the core starts.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

type Row = Record<string, any>
const rows = async (client: LocalClient): Promise<Row[]> =>
  (await client.request<{ agents: Row[] }>('agents_list', { includeStopped: true }, 30_000)).agents
const row = async (client: LocalClient, agentId: string) => (await rows(client)).find((agent) => agent.id === agentId)
const holders = async (client: LocalClient, sessionId: string) =>
  (await rows(client)).filter((agent) => agent.sessionId === sessionId).map((agent) => agent.id)

describe('one owner per conversation, stopped harnesses included', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('a conversation resumed in a terminal leaves the stopped harness it came from: now, after a stop, and at start', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    const cwd = join(d.projectsDir, 'owners')
    mkdirSync(cwd, { recursive: true })
    await d.start()
    let client = await LocalClient.connect(d)

    // A Claude Code harness with a conversation, stopped: its record keeps the conversation.
    const created = await client.request('agent_create', { engine: 'claude', cwd }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const first = await until('the first harness to bind its conversation', async () => {
      const now = await row(client, created.agent.id)
      return now?.status === 'active' && now.sessionId ? now : null
    }, 60_000, 250)
    const conversation: string = first.sessionId
    // A turn, as a person has before stopping: what the conversation's identity is confirmed from.
    const ended = client.next((frame) => frame.type === 'turn_ended' && frame.agentId === first.id, 45_000, 'the first turn to end')
    client.send('message', { agentId: first.id, content: 'remember this conversation' })
    await ended
    expect((await client.request('agent_delete', { agentId: first.id }, 60_000)).error).toBeUndefined()
    await until('the first harness listed as stopped with its conversation', async () => {
      const now = await row(client, first.id)
      return now?.status === 'stopped' && now.sessionId === conversation ? now : null
    }, 60_000, 250)

    // The person picks the conversation up in a terminal tile.
    const opened = await client.request('agent_create', { engine: 'terminal', cwd }, 60_000)
    expect(opened.error, JSON.stringify(opened)).toBeUndefined()
    const tile = await until('the terminal tile to be up', async () => {
      const now = await row(client, opened.agent.id)
      return now?.status === 'active' && now.tmuxPane ? now : null
    }, 60_000, 250)
    // Only what is said from here on: the stop above announced its own agent_deleted (retained).
    const told = client.next((frame) => frame.type === 'agent_deleted' && frame.payload?.agentId === first.id, 60_000, 'the stopped harness set aside')
    await d.tmux.run('send-keys', '-t', tile.tmuxPane, '-l', `claude --resume ${conversation}`)
    await d.tmux.run('send-keys', '-t', tile.tmuxPane, 'Enter')
    await until('the tile to bind the conversation', async () => (await row(client, tile.id))?.sessionId === conversation || null, 45_000, 500)
    expect((await told).payload).toMatchObject({ agentId: first.id, retained: false, successor: tile.id })
    expect(await holders(client, conversation)).toEqual([tile.id])
    const aside = join(d.env.ADAPTER_DATA_DIR!, 'stopped-agents', 'superseded', `${first.id}.json`)
    expect(existsSync(aside), 'set aside, not deleted').toBe(true)
    expect(existsSync(join(d.env.ADAPTER_DATA_DIR!, 'stopped-agents', `${first.id}.json`))).toBe(false)

    // Stopped too, the tile is the conversation's one row.
    expect((await client.request('agent_delete', { agentId: tile.id }, 60_000)).error).toBeUndefined()
    await until('the tile listed as stopped with the conversation', async () => {
      const now = await row(client, tile.id)
      return now?.status === 'stopped' && now.sessionId === conversation ? now : null
    }, 60_000, 250)
    expect(await holders(client, conversation)).toEqual([tile.id])

    // The duplicate as an older daemon left it: put the first record back, and start again.
    client.close()
    await d.stop()
    copyFileSync(aside, join(d.env.ADAPTER_DATA_DIR!, 'stopped-agents', `${first.id}.json`))
    rmSync(aside)
    await d.start()
    client = await LocalClient.connect(d)
    expect(await holders(client, conversation)).toEqual([tile.id])
    expect(existsSync(aside), 'set aside again as the core started').toBe(true)
    expect(d.log()).toMatch(new RegExp(`${first.id.slice(0, 8)} set aside: ${tile.id.slice(0, 8)} owns conversation`))
    client.close()
  }, 300_000)
})
