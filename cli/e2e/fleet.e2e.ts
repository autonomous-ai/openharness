/**
 * Two machines on one account, end to end (harness/fleet.ts): real daemons for A and B, signed in to a
 * fake backend whose relay is blind, A linked to B, and a dial on A. What A's fleet does reaches B's
 * agents for real: ⌘K picks an agent on B and delivers to it; the dial on A stops, answers and forks
 * there; B going away is refused rather than lost, and B coming back is used again; and A's fleet
 * service failing costs A its routing and nothing else.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient, type Frame } from './harness/client.js'
import { until, type IsolatedDaemon } from './harness/daemon.js'
import { startFleet, type Fleet } from './harness/fleet.js'

const row = async (client: LocalClient, agentId: string) =>
  ((await client.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents)
    .find((agent) => agent.id === agentId)

/** Start a Claude Code agent and wait for it to bind its conversation. */
async function boundAgent(daemon: IsolatedDaemon, client: LocalClient, name: string): Promise<string> {
  const cwd = join(daemon.projectsDir, name)
  mkdirSync(cwd, { recursive: true })
  const created = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  await until('the agent to bind its conversation', async () => (await row(client, agentId))?.sessionId || null, 45_000, 500)
  return agentId
}

const isTurn = (type: string, agentId: string) => (frame: Frame) => frame.type === type && frame.agentId === agentId

/** ⌘K's pick for a typed task: `route_task` answers as `route_result`, under the asker's request id. */
async function routeTask(client: LocalClient, text: string): Promise<Record<string, any>> {
  const requestId = randomUUID()
  const answered = client.next((frame) => frame.type === 'route_result' && frame.payload?.requestId === requestId, 30_000, 'route_result')
  client.send('route_task', { requestId, text })
  return (await answered).payload as Record<string, any>
}

const routeSend = (client: LocalClient, agentId: string, text: string) =>
  client.request('route_send', { agentId, text }, 30_000)

const notWorking = (client: LocalClient, agentId: string) =>
  until('the agent to read as not working', async () => {
    const agent = await row(client, agentId)
    return agent && agent.activity?.state !== 'working' ? agent : null
  }, 30_000, 250)

/** Both machines up, an agent on B, A's dial plugged in, and A's fleet listing that agent. */
async function linked(fleet: Fleet): Promise<{ onA: LocalClient; onB: LocalClient; agentId: string }> {
  const { a, b, backend, dial } = fleet
  await until('both machines connected to the backend', () => backend.nodeUp(a.machineId) && backend.nodeUp(b.machineId), 30_000)
  const onB = await LocalClient.connect(b.daemon, { machineId: b.machineId })
  const onA = await LocalClient.connect(a.daemon, { machineId: a.machineId })
  const agentId = await boundAgent(b.daemon, onB, 'lives-on-b')
  // The dial on A is what opens A's lane to the other machines: a daemon holds it on a dial's behalf.
  await dial!.greet()
  await until('A to list the agent on B', async () => (await routeTask(onA, 'anything')).agentId === agentId || null, 60_000, 1_000)
  return { onA, onB, agentId }
}

describe('two machines in one fleet', () => {
  let fleet: Fleet | undefined
  afterEach(async () => { await fleet?.close(); fleet = undefined })

  const fresh = async (options: Parameters<typeof startFleet>[0] = {}): Promise<Fleet> => {
    const f = await startFleet(options)
    fleet = f
    onTestFailed(() => {
      for (const [name, machine] of [['A', f.a], ['B', f.b]] as const) {
        console.log(`---- daemon ${name} log\n${machine.daemon.log().split('\n').slice(-120).join('\n')}`)
      }
      console.log(`---- fake backend saw\n${f.backend.seen.slice(-60).join('\n')}`)
      console.log(`---- the dial heard\n${f.dial?.messages.map((m) => m.t).join(' ') ?? '(no dial)'}`)
    })
    return f
  }

  it('⌘K on A picks the agent on B, and its send is the turn B runs', async () => {
    const f = await fresh({ dialOnA: true })
    const { a, b, backend } = f
    const { onA, onB, agentId } = await linked(f)
    expect(backend.devicesOpen()).toBe(1)
    // Through an end-to-end encrypted session with B, which the relay could not read.
    expect(a.daemon.log()).toContain(`[device] device: e2e session ready ${b.machineId}`)
    // A has no agent of its own: the one agent ⌘K can weigh is B's, on B's machine id.
    const picked = await routeTask(onA, 'fix the parser')
    expect(picked).toMatchObject({ agentId, machineId: b.machineId, weighed: 1, machines: 1 })
    expect(picked.candidates[0]).toMatchObject({ agentId, machineId: b.machineId, machine: 'machine-b' })

    const started = onB.next(isTurn('turn_started', agentId), 30_000, 'turn_started on B')
    const ended = onB.next(isTurn('turn_ended', agentId), 30_000, 'turn_ended on B')
    expect(await routeSend(onA, agentId, 'sent from machine a')).toMatchObject({ ok: true })
    expect((await started).payload?.userMessage).toBe('sent from machine a')
    await ended
    // Sealed by A's gateway, which holds A's identity: the relay never read the turn.
    expect(backend.deviceSent.some((frame) => frame.machineId === b.machineId && (frame.payload as Record<string, unknown> | undefined)?.__e2e)).toBe(true)
    expect(JSON.stringify(backend.deviceSent)).not.toContain('sent from machine a')
    // Nothing tried to reach anywhere but the fake backend, and both daemons are the cores they started as.
    for (const machine of [a, b]) {
      expect(machine.daemon.log()).not.toMatch(/getaddrinfo|ENOTFOUND|autonomous\.ai/)
      expect(machine.daemon.coresStarted()).toBe(1)
    }
    onA.close()
    onB.close()
  })

  it('the dial on A stops a turn, answers a question and forks an agent, each on B', async () => {
    const f = await fresh({ dialOnA: true })
    const { b } = f
    const dial = f.dial!
    const { onA, onB, agentId } = await linked(f)

    // Stop: a turn held open on B ends when the dial on A says stop.
    const started = onB.next(isTurn('turn_started', agentId), 30_000, 'turn_started on B')
    expect(await routeSend(onA, agentId, '!hold')).toMatchObject({ ok: true })
    await started
    await until('the agent on B to read as working', async () => (await row(onB, agentId))?.activity?.state === 'working' || null, 15_000, 250)
    dial.send({ t: 'turn.stop', agentId })
    await notWorking(onB, agentId)

    // Answer: B's agent asks; the question reaches the dial on A, and the dial's answer is the one B's agent gets.
    const asked = onB.next((frame) => frame.type === 'commander_question' && frame.agentId === agentId, 30_000, 'commander_question on B')
    const since = dial.messages.length
    expect(await routeSend(onA, agentId, '!ask')).toMatchObject({ ok: true })
    const question = await asked
    const shaped = question.payload?.questions?.[0]
    expect(shaped?.options).toEqual(expect.arrayContaining(['Tea', 'Coffee']))
    await dial.next((m) => m.t === 'question' && m.agentId === agentId, 30_000, 'the question from B', since)
    const ended = onB.next(isTurn('turn_ended', agentId), 45_000, 'turn_ended on B')
    dial.send({ t: 'answer', agentId, requestId: question.payload.requestId, answers: { [shaped.q]: 'Coffee' } })
    await ended
    const pane = String((await row(onB, agentId))?.tmuxPane)
    expect(await b.daemon.capture(pane)).toContain('you chose Coffee')

    // Fork: the dial forks B's agent on B, and the window on A is told where the fork is.
    const forked = onA.next((frame) => frame.type === 'dial_forked' && frame.payload?.sourceAgentId === agentId, 60_000, 'dial_forked on A')
    dial.send({ t: 'agent.fork', agentId })
    const fork = (await forked).payload as { machineId: string; agentId: string }
    expect(fork.machineId).toBe(b.machineId)
    expect(fork.agentId).not.toBe(agentId)
    await until('the fork to be an agent on B', async () => (await row(onB, fork.agentId)) ?? null, 30_000, 500)
    onA.close()
    onB.close()
  })

  it('B going away is refused, not lost, and B coming back is used again', async () => {
    const f = await fresh({ dialOnA: true })
    const { a, b, backend } = f
    const { onA, onB, agentId } = await linked(f)
    onB.close()
    // B's daemon dies. The backend still lists B as running, as the real one does until B's presence
    // runs out, so A goes on asking B for its agents — and those requests never come back.
    await b.daemon.kill()
    await until('B to be gone from the backend', () => !backend.nodeUp(b.machineId), 15_000)
    const refused = await until('A to refuse a turn for B', async () => {
      const sent = await routeSend(onA, agentId, 'while machine b is away')
      return sent.ok === false ? sent : null
    }, 45_000, 500)
    expect(refused).toMatchObject({ ok: false, machine: 'machine-b', reason: 'the last request to it did not come back' })
    expect(a.daemon.log()).toContain(`cable: refused a turn for ${agentId.slice(0, 8)} — machine-b last failed`)

    // B comes back with its agent, which lived on in its terminal. A asks again, opens a new session with
    // the new process, lists the agent again, and delivers to it.
    await b.daemon.start()
    const again = await LocalClient.connect(b.daemon, { machineId: b.machineId })
    await until('the agent on B to be back', async () => (await row(again, agentId))?.sessionId || null, 45_000, 500)
    const delivered = await until('A to deliver to B again', async () => {
      if ((await routeTask(onA, 'anything')).agentId !== agentId) return null
      const started = again.next(isTurn('turn_started', agentId), 10_000, 'turn_started on B')
      const sent = await routeSend(onA, agentId, 'machine b is back')
      if (!sent.ok) { started.catch(() => {}); return null }
      return (await started.catch(() => null))?.payload?.userMessage === 'machine b is back' ? sent : null
    }, 120_000, 1_000)
    expect(delivered).toMatchObject({ ok: true })
    again.close()
    onA.close()
  })

  it('the dial\'s routing failing through the port leaves the dial serving A, and ⌘K serving both machines', async () => {
    const f = await fresh({ dialOnA: true, envA: { HARNESSD_TEST_FAULTS: 'fleet.sendTurn' } })
    const { a, b } = f
    const dial = f.dial!
    const { onA, onB, agentId } = await linked(f)
    // The dial's send fails at the port, and the dial routes this computer by itself: its own agent's turn runs.
    const onlyA = await boundAgent(a.daemon, onA, 'on-a')
    const started = onA.next(isTurn('turn_started', onlyA), 30_000, 'turn_started on A')
    dial.send({ t: 'turn.send', agentId: onlyA, text: 'from the dial on a' })
    expect((await started).payload?.userMessage).toBe('from the dial on a')
    expect(a.daemon.log()).toContain('[devices] fleet.sendTurn failed · injected fault: fleet.sendTurn')
    // ⌘K's own send is another member, and B is still reached through it.
    const startedB = onB.next(isTurn('turn_started', agentId), 30_000, 'turn_started on B')
    expect(await routeSend(onA, agentId, 'cmd-k still reaches b')).toMatchObject({ ok: true })
    expect((await startedB).payload?.userMessage).toBe('cmd-k still reaches b')
    expect(b.daemon.coresStarted()).toBe(1)
    onA.close()
    onB.close()
  })

  it('A\'s fleet service failing costs A its routing to B and nothing else', async () => {
    for (const [faults, reason] of [['fleet', 'no agent list yet'], ['fleet.routeTask,fleet.routeSend', 'the fleet service is unavailable']]) {
      const f = await startFleet({ dialOnA: true, envA: { HARNESSD_TEST_FAULTS: faults } })
      fleet = f
      onTestFailed(() => { console.log(`---- daemon A log (${faults})\n${f.a.daemon.log().split('\n').slice(-80).join('\n')}`) })
      const { a, b, backend } = f
      const dial = f.dial!
      await until('both machines connected to the backend', () => backend.nodeUp(a.machineId) && backend.nodeUp(b.machineId), 30_000)
      const onA = await LocalClient.connect(a.daemon, { machineId: a.machineId })
      const onB = await LocalClient.connect(b.daemon, { machineId: b.machineId })
      const onlyB = await boundAgent(b.daemon, onB, 'on-b')
      await dial.greet()
      // ⌘K on A says it cannot route, and sends nothing.
      expect(await routeTask(onA, 'anything')).toMatchObject({ agentId: '', reason, candidates: [] })
      expect(await routeSend(onA, onlyB, 'not delivered')).toMatchObject({ ok: false, machine: '', reason })
      // Everything else on A goes on: its own agents' turns, its link to the backend, its dial.
      const onlyA = await boundAgent(a.daemon, onA, 'on-a')
      const started = onA.next(isTurn('turn_started', onlyA), 30_000, 'turn_started on A')
      const ended = onA.next(isTurn('turn_ended', onlyA), 30_000, 'turn_ended on A')
      dial.send({ t: 'turn.send', agentId: onlyA, text: 'from the dial on a' })
      expect((await started).payload?.userMessage).toBe('from the dial on a')
      await ended
      expect(backend.nodeUp(a.machineId)).toBe(true)
      // And B is untouched.
      const startedB = onB.next(isTurn('turn_started', onlyB), 30_000, 'turn_started on B')
      onB.send('message', { agentId: onlyB, content: 'b runs on' })
      expect((await startedB).payload?.userMessage).toBe('b runs on')
      expect(a.daemon.log()).toContain(faults === 'fleet' ? '[devices] fleet did not start · injected fault: fleet' : '[devices] fleet.routeSend failed · injected fault: fleet.routeSend')
      expect(a.daemon.coresStarted()).toBe(1)
      onA.close()
      onB.close()
      await f.close()
      fleet = undefined
    }
  })
})
