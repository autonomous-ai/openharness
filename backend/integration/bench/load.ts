import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import type { MachineObservation } from '../../src/superTabs/machines.js'
import type { AttemptCounter } from './attempts.js'
import type { BenchConfig } from './config.js'
import type { CommandResult, Reader, Reply, SwarmDriver } from './driver.js'
import { machineId } from './fixtures.js'
import { Recorder } from './metrics.js'
import type { Plan } from './plan.js'
import { random, words } from './random.js'
import type { Swarm } from './seed.js'

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
export function observation(generation: string, runningHarnessIds: string[], cpuPercent = 10): MachineObservation {
  return { generation, quotas: [], tools: {}, runningHarnessIds, stoppedHarnessIds: [],
    resources: { cpuPercent, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
      projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Bench', os: 'macOS', gpuPercent: null } }
}

/** Runs the plan against the driver: every actor on its own timeline, all at once, each call measured. */
export async function runLoad(driver: SwarmDriver, counter: AttemptCounter, config: BenchConfig, p: Plan, swarm: Swarm): Promise<LoadResult> {
  const recorder = new Recorder(), skipped: Record<string, number> = {}
  const { tabId, people, agents, generations } = swarm
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
  const send = (writer: string, i: number, conversationId: string, recipientIds: string[], asAgent: boolean, text: string) =>
    measure<CommandResult>('message.send', writer, () => driver.execute(tabId, people[agents[i]!.machine]!, op(),
      { type: 'message.send', conversationId, text, replyTo: null, recipientIds }, asAgent ? agents[i]!.id : undefined))

  /** An agent's posts in its project's channel: a Member's name its PM, which waits as a delivery. */
  function channelPosts(i: number) {
    const rng = random(config.seed, `agent-text-${i}`), a = agents[i]!
    return timeline('channel posts', p.agents[i]!.posts, async () => {
      await send(`agent-${pad(i)}`, i, a.channel, a.pmId === a.id ? [] : [a.pmId], true, words(rng, config.text.messageChars))
    })
  }
  /** Its person writes in their 1:1 chat with the agent; the agent answers there. A post that failed (counted as its error)
   *  gets no answer. */
  function chatTurns(i: number) {
    const rng = random(config.seed, `chat-text-${i}`), a = agents[i]!
    return timeline('chat turns', p.agents[i]!.turns, async () => {
      if (await send(`person-${pad(a.machine)}`, i, a.chat, [], false, words(rng, config.text.messageChars))) {
        await send(`agent-${pad(i)}`, i, a.chat, [], true, words(rng, config.text.messageChars))
      }
    })
  }
  /** Cross-chat lane: the agent posts only in its own chat, at both its cadences in one sequence, so its chat has one writer. */
  function ownChatPosts(i: number) {
    const rng = random(config.seed, `agent-text-${i}`), a = agents[i]!, { posts, turns } = p.agents[i]!
    return timeline('own chat posts', [...posts, ...turns].sort((x, y) => x - y), async () => {
      await send(`agent-${pad(i)}`, i, a.chat, [], true, words(rng, config.text.messageChars))
    })
  }
  const on = (m: number) => agents.filter(a => a.machine === m)
  function machineReports(m: number) {
    const running = on(m).map(a => a.harnessId)
    return timeline('machine reports', p.machines[m]!.observations, async () => {
      await measure('observeMachine', `machine-${m}`, () => driver.observeMachine(tabId, people[m]!, machineId(m), observation(generations[m]!, running)))
    })
  }
  function deliveryPasses(m: number) {
    const host = people[m]!, writer = `delivery-${m}`
    return timeline('delivery passes', p.machines[m]!.deliveryPasses, async () => {
      for (const { id: agentId } of on(m)) {
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
    ...agents.flatMap((_, i) => config.lane === 'cross-chat' ? [ownChatPosts(i)] : [channelPosts(i), chatTurns(i)]),
    ...p.machines.flatMap(m => [machineReports(m.index), deliveryPasses(m.index)]), ...polls,
  ])
  return { recorder, skipped, actualMs: performance.now() - start, readers: readers.map(r => r.reader) }
}
