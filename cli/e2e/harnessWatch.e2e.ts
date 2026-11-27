/**
 * A harness on another of the person's machines, followed by push (docs/design/2026-11-12-hachi.md, "Across machines"):
 * two real daemons on one account, A linked to B, signed in to a fake backend that counts apps and offers the viewer gate
 * as the real one does (backend lib/hub.ts), and that hears a tool's relay as a background relay, never an app
 * (`relayIsolation`, backend lib/registry.ts). Nobody views B. A tool on A asks B for `harness_watch` over that relay; B
 * answers with what each harness is doing, then seals each change of state to that one connection as a `harness_event`,
 * while it keeps every live event, transcript text included, off the relay.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startFleet, type Fleet } from './harness/fleet.js'

const harnessEvent = (agentId: string, state: string) => (frame: Frame) =>
  frame.type === 'harness_event' && frame.payload?.agentId === agentId && frame.payload?.state === state
/** One round as the tool is told it: `working` from `since` on, an index into its frames, then the `idle` after that
 *  event. By index, because both can come in one socket read: an `idle` that came before anyone waited for it was
 *  never seen (nightly run 43247147594), and the `idle` of the round before must not count. */
async function workedThenIdle(client: LocalClient, agentId: string, since: number): Promise<void> {
  const working = await client.waitFor(harnessEvent(agentId, 'working'), 45_000, 'harness_event working', since)
  await client.waitFor(harnessEvent(agentId, 'idle'), 45_000, 'harness_event idle', client.frames.indexOf(working))
}

describe('harness_watch across machines', () => {
  let fleet: Fleet | undefined
  afterEach(async () => { await fleet?.close(); fleet = undefined })

  it('B tells a tool on A what its harness does, sealed to that one connection, and keeps its transcript off the relay', async () => {
    fleet = await startFleet()
    const { a, b, backend } = fleet
    backend.uiGate = true
    onTestFailed(() => { console.log(`---- B's log\n${b.daemon.log().split('\n').slice(-150).join('\n')}`) })
    await until('both machines connected to the backend', () => backend.nodeUp(a.machineId) && backend.nodeUp(b.machineId), 30_000)

    // A harness on B, started by B's own window: the only app on B, and it is local, so the backend counts none.
    const onB = await LocalClient.connect(b.daemon, { machineId: b.machineId })
    const cwd = join(b.daemon.projectsDir, 'on-b')
    mkdirSync(cwd, { recursive: true })
    const created = await onB.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the harness to bind its conversation', async () => {
      const listed = await onB.request<{ agents: Array<Record<string, any>> }>('agents_list', {}, 30_000)
      return listed.agents.find((agent) => agent.id === agentId)?.sessionId || null
    }, 45_000, 500)

    // A tool on A follows it, as `harness wait --machine` would: A's daemon relays it to B as a background relay.
    const tool = await LocalClient.connect(a.daemon, { tool: true, machineId: b.machineId })
    const watched = await tool.request('harness_watch', { agentIds: [agentId] }, 30_000)
    expect(watched.error, JSON.stringify(watched)).toBeUndefined()
    expect(watched).toMatchObject({ leaseMs: 300_000, renewMs: 240_000, agents: [{ agentId, state: 'idle' }] })
    const [relay] = backend.webConnections(b.machineId)
    expect(relay).toBeDefined()

    const since = tool.frames.length
    onB.send('message', { agentId, content: 'harness watch across machines' })
    await workedThenIdle(tool, agentId, since)

    // What B sent A's relay: its harness_events, sealed to that connection.
    expect((backend.webReceived.get(relay) ?? []).map((frame) => frame.type)).toContain('harness_event')

    // A second tool is told nothing of the first one's harness: each lease is its connection's own.
    const other = await LocalClient.connect(a.daemon, { tool: true, machineId: b.machineId })
    expect(await other.request('agents_list', {}, 30_000)).toHaveProperty('agents')
    const otherRelay = backend.webConnections(b.machineId).find((connId) => connId !== relay)!
    const again = tool.frames.length
    onB.send('message', { agentId, content: 'once more' })
    await workedThenIdle(tool, agentId, again)
    expect((backend.webReceived.get(otherRelay) ?? []).map((frame) => frame.type)).not.toContain('harness_event')

    // A tool that leaves takes its watch with it: the next tool on A is told nothing it did not ask for, though A's
    // daemon keeps a background relay warm for it (lib/remoteRelay.ts). A turn on B while the next tool asks nothing;
    // then it asks a watch of its own, whose answer B sends after anything it sent that connection before.
    tool.close()
    const next = await LocalClient.connect(a.daemon, { tool: true, machineId: b.machineId })
    expect(await next.request('agents_list', {}, 30_000)).toHaveProperty('agents')
    const ended = onB.next((frame: Frame) => frame.type === 'turn_ended' && frame.agentId === agentId, 45_000, 'turn_ended on B')
    onB.send('message', { agentId, content: 'after the watcher left' })
    await ended
    await next.request('harness_watch', { agentIds: [agentId] }, 30_000)
    expect(next.frames.filter((frame) => frame.type === 'harness_event')).toEqual([])

    // Too many harnesses in one watch is refused by name.
    const tooMany = await other.request('harness_watch', { agentIds: Array.from({ length: 9 }, (_, i) => `agent-${i}`) }, 30_000)
    expect(tooMany.error).toBe('TOO_MANY')
    for (const client of [next, other, onB]) client.close()
  }, 240_000)
})
