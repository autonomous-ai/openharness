import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Command } from '../../src/superTabs/commands.js'
import type { MachineObservation } from '../../src/superTabs/machines.js'
import type { AttemptCounter } from './attempts.js'
import type { BenchConfig } from './config.js'
import type { Reader, Reply, SwarmDriver } from './driver.js'
import { machineId } from './fixtures.js'
import { Recorder } from './metrics.js'
import type { Plan } from './plan.js'
import { random, words } from './random.js'
import type { Swarm, Worker } from './seed.js'

export interface LoadResult {
  recorder: Recorder
  /** Planned calls left undone because the run passed its deadline, by activity. */
  skipped: Record<string, number>
  actualMs: number
  /** The readers, after the load: a probe polls each once more, as a client that is already up to date. */
  readers: Reader[]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A machine's report in the shape its host sends (cli/src/superTabs/machines.ts), naming the sessions running there. */
function observation(generation: string, runningHarnessIds: string[]): MachineObservation {
  return { generation, quotas: [], tools: {}, runningHarnessIds, stoppedHarnessIds: [],
    resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
      projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } }
}

/** Runs the plan against the driver: every actor on its own timeline, all at once, each call measured. */
export async function runLoad(driver: SwarmDriver, counter: AttemptCounter, config: BenchConfig, p: Plan, swarm: Swarm): Promise<LoadResult> {
  const recorder = new Recorder(), skipped: Record<string, number> = {}
  const { tabId, people, leadId, workers, generations } = swarm, owner = people[0]!
  // A slow store stretches the run instead of dropping work, up to this point; what is left after it is counted as skipped.
  const start = performance.now(), deadline = start + config.durationMs + Math.max(10_000, config.durationMs / 4)
  let operation = 0
  const op = () => `bench-${config.seed}-load-${operation++}`

  async function measure<T>(name: string, writer: string, call: () => Promise<Reply<T>>, read = false): Promise<Reply<T> | null> {
    const tracked = await counter.track(call)
    const reply = tracked.value ?? null
    recorder.add({ op: name, writer, ms: tracked.ms, failedAttempts: tracked.failedAttempts,
      outcome: tracked.error ? 'EXCEPTION' : reply!.code ?? 'ok', ...(read && reply ? { bytes: reply.bytes } : {}) })
    return reply && !reply.code ? reply : null
  }
  async function timeline(activity: string, times: number[], act: (i: number) => Promise<void>) {
    for (let i = 0; i < times.length; i++) {
      if (performance.now() > deadline) { skipped[activity] = (skipped[activity] ?? 0) + times.length - i; return }
      const wait = start + times[i]! - performance.now()
      if (wait > 0) await sleep(wait)
      await act(i)
    }
  }
  const command = (writer: string, user = owner, asAgentId?: string) => (c: Command) =>
    measure(c.type, writer, () => driver.execute(tabId, user, op(), c, asAgentId))

  /** A worker's post in one of its groups (status and checks in the group whose task it holds). */
  function poster(w: Worker, i: number) {
    const rng = random(config.seed, `worker-text-${i}`), post = command(`worker-${pad(i)}`, people[w.machine]!, w.id)
    return async (n: number) => {
      const { op: kind, group: g } = p.workers[i]!.actions[n]!, group = swarm.groups[g]!
      if (kind === 'message.send') await post({ type: kind, conversationId: group, text: words(rng, config.text.messageChars), replyTo: null, recipientIds: [] })
      if (kind === 'work.status') await post({ type: kind, conversationId: group, assignmentId: w.assignmentId, status: 'working', result: words(rng, config.text.resultChars) })
      if (kind === 'work.check') {
        await post({ type: kind, conversationId: group, assignmentId: w.assignmentId, checkId: rng.pick(w.checkIds), passed: rng.next() < 0.5, evidence: words(rng, 200) })
      }
    }
  }
  /** A worker's terminal turn, recorded by its host: the prompt, then its answer. */
  function turner(w: Worker, i: number) {
    const rng = random(config.seed, `worker-turns-${i}`), host = people[w.machine]!
    let previousEventId: string | null = null
    const append = (turnId: string, kind: 'prompt' | 'answer') => measure('native.append', `terminal-${pad(i)}`, () => driver.appendNative(tabId, host, w.contextId,
      { turnId, kind, previousEventId, text: words(rng, config.text.messageChars), truncated: false, interrupted: false }))
    return async (n: number) => {
      const prompt = await append(`turn-${n}`, 'prompt')
      // An answer to an unrecorded prompt is refused by design; the host records a gap instead, which the bench does not model.
      if (!prompt) { skipped['native answers'] = (skipped['native answers'] ?? 0) + 1; return }
      previousEventId = prompt.data!.eventId
      const answer = await append(`turn-${n}`, 'answer')
      if (answer) previousEventId = answer.data!.eventId
    }
  }
  /** Mixed: posts and terminal side by side, as today. Cross-group lane: one sequence, so the worker's groups have one writer. */
  function worker(w: Worker, i: number): Array<Promise<void>> {
    const post = poster(w, i), turn = turner(w, i), { actions, turns } = p.workers[i]!
    if (config.lane === 'mixed') return [timeline('worker posts', actions.map(a => a.at), post), timeline('native turns', turns, turn)]
    const events = [...actions.map((a, n) => ({ at: a.at, run: () => post(n) })), ...turns.map((at, n) => ({ at, run: () => turn(n) }))]
      .sort((a, b) => a.at - b.at)
    return [timeline('worker posts and turns', events.map(e => e.at), n => events[n]!.run())]
  }
  function leadSends() {
    const rng = random(config.seed, 'lead-text'), send = command('lead', owner, leadId)
    return timeline('lead sends', p.lead.map(s => s.at), async n => {
      const { worker: index, group } = p.lead[n]!, target = workers[index]!
      await send({ type: 'message.send', conversationId: swarm.groups[group]!, text: words(rng, config.text.messageChars), replyTo: null, recipientIds: [target.id] })
    })
  }
  const running = (m: number) => [...(m === 0 ? ['bench-lead'] : []), ...workers.filter(w => w.machine === m).map(w => w.harnessId)]
  const agentsOn = (m: number) => [...(m === 0 ? [leadId] : []), ...workers.filter(w => w.machine === m).map(w => w.id)]
  function machineReports(m: number) {
    return timeline('machine reports', p.machines[m]!.observations, async () => {
      await measure('observeMachine', `machine-${m}`, () => driver.observeMachine(tabId, people[m]!, machineId(m), observation(generations[m]!, running(m))))
    })
  }
  function deliveryPasses(m: number) {
    const host = people[m]!, writer = `delivery-${m}`
    return timeline('delivery passes', p.machines[m]!.deliveryPasses, async () => {
      for (const agentId of agentsOn(m)) {
        const waiting = await measure('deliveries.list', writer, () => driver.deliveries(tabId, host, agentId))
        for (const { id } of waiting?.data ?? []) {
          const claimId = `claim-${id}`
          if (!await measure('delivery.claim', writer, () => driver.delivery(tabId, host, agentId, id, { type: 'claim', claimId }))) continue
          await measure('delivery.ack', writer, () => driver.delivery(tabId, host, agentId, id, { type: 'ack', claimId, receipt: `typed-${id}`, uncertain: false }))
        }
      }
    })
  }
  const readers = p.readers.map(r => ({ plan: r, reader: r.kind === 'desktop' ? driver.desktopReader(tabId, people[r.index]!) : driver.hostReader(people[r.index]!, machineId(r.index)) }))
  const polls = readers.map(({ plan: r, reader }) => timeline(`${r.kind} polls`, r.polls, async () => {
    await measure(`read.${r.kind}`, reader.label, () => reader.poll(), true)
  }))

  await Promise.all([
    ...workers.flatMap(worker), leadSends(),
    ...p.machines.flatMap(m => [machineReports(m.index), deliveryPasses(m.index)]), ...polls,
  ])
  return { recorder, skipped, actualMs: performance.now() - start, readers: readers.map(r => r.reader) }
}
