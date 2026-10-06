/**
 * Sub-agents as the real CLIs record them, on the real daemon (found auditing the daemon's readers against
 * real transcripts, docs/research/2026-10-06-real-cli-record-audit.md).
 *
 * - Codex 0.160 runs its sub-agents as "multi-agent v2": the spawn's output names the child only by its
 *   path, a SubAgentActivity record names its thread, and its completion is another SubAgentActivity, with
 *   the child's report in an agent_message before it. Read with the older vocabulary's rules, every
 *   sub-agent Codex started showed as a Task that failed at once, `{"task_name":"/root/…"}` for its output,
 *   live and in the history.
 * - Claude Code hands a background sub-agent that finishes while its parent still works back into that
 *   turn as a queued_command attachment. Only the user record it writes for an idle parent was read, so
 *   that sub-agent never finished.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)
const forAgent = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

describe('sub-agents', () => {
  let daemon: IsolatedDaemon | undefined
  afterEach(async () => { await daemon?.close(); daemon = undefined })

  it('codex: a sub-agent Codex 0.160 starts runs as a Task and closes with what it reported, live and in the history', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'spawn-codex')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'codex', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind its conversation', async () => {
      const found = await row(client, created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 60_000, 500)

    const since = client.frames.length
    const ended = client.next(forAgent('turn_ended', agent.id), 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: '!spawn scout' })
    await ended
    const live = client.frames.slice(since).filter((frame) => frame.agentId === agent.id)
    const taskEnds = live.filter((frame) => frame.type === 'tool_end' && frame.payload?.tool === 'Task')
    expect(live.some((frame) => frame.type === 'tool_start' && frame.payload?.tool === 'Task'), 'a Task card opened').toBe(true)
    expect(taskEnds, 'the Task closed once').toHaveLength(1)
    expect(taskEnds[0].payload).toMatchObject({ isError: false, output: 'scout found 3 files', subagent: { agentType: 'Goodall', totalToolUseCount: 1 } })
    // The child's own work, read from its rollout by the thread its start named, sits under the Task.
    const spawnId = taskEnds[0].payload?.id
    expect(live.some((frame) => frame.type === 'tool_start' && frame.payload?.tool === 'Bash' && frame.payload?.parentToolUseId === spawnId)).toBe(true)

    const page = await client.request<{ events?: Array<{ type: string; payload: Record<string, any> }>; error?: string }>(
      'session_get', { sessionId: agent.sessionId, limit: 200 }, 30_000)
    expect(page.error).toBeUndefined()
    const history = (page.events ?? []).filter((event) => event.type === 'tool_end' && event.payload.tool === 'Task')
    expect(history).toHaveLength(1)
    expect(history[0].payload).toMatchObject({ isError: false, output: 'scout found 3 files' })
    client.close()
  })

  it('claude: a background sub-agent handed back while its parent still works is finished', async () => {
    const d = await IsolatedDaemon.create()
    daemon = d
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-120).join('\n')}`) })
    await d.start()
    const client = await LocalClient.connect(d)
    const cwd = join(d.projectsDir, 'bgagent-claude')
    mkdirSync(cwd, { recursive: true })
    const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agent = await until('the agent to bind its conversation', async () => {
      const found = await row(client, created.agent.id)
      return found?.sessionId && found.status === 'active' ? found : null
    }, 60_000, 500)

    const since = client.frames.length
    const ended = client.next(forAgent('turn_ended', agent.id), 45_000, 'turn_ended')
    client.send('message', { agentId: agent.id, content: '!bgagent scout' })
    await ended
    const live = client.frames.slice(since).filter((frame) => frame.agentId === agent.id)
    const spawn = live.find((frame) => frame.type === 'tool_start' && frame.payload?.tool === 'Agent')
    expect(spawn, 'the Agent card opened').toBeDefined()
    // Claude Code 2.1.287 hands a sub-agent that finishes mid-turn back as a queued_command attachment. Only
    // the user-record delivery was read, so this sub-agent never finished: the dial kept it running and held
    // the parent's recap until its backstop gave up.
    const finished = live.filter((frame) => frame.type === 'subagent_finished')
    expect(finished, 'the sub-agent finished once').toHaveLength(1)
    expect(finished[0].payload).toMatchObject({ id: spawn?.payload?.id, status: 'completed', summary: 'Agent "Count for scout" finished' })
    expect(live.filter((frame) => frame.type === 'turn_started'), 'the hand-back opened no turn').toHaveLength(1)
    client.close()
  })
})
