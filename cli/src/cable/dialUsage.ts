// What the devices count of the dial (docs/plans/2026-11-23-dial-usage-counts-design.md): the devices' hooks say what
// happened, and this writes fixed names to the sink. An agent id lives only in the bounded maps and sets here, never in
// a name: the sink's file is read and sent by the gateway.

import {
  DIAL_FIRST_AGENT_BUCKETS, DIAL_USAGE_AGENTS_MAX, DIAL_USAGE_ENGINES, DIAL_USAGE_HOSTS, DIAL_WAIT_BUCKETS,
  type DialFileMetric, type DialOpenEnd, type DialOtherApp, type DialRecognition, type DialUsageEngine,
  type DialUsageHost, type DialUsageSink, type DialVoiceEnd, type DialVoiceFailure,
} from '../lib/dialUsageContract.js'
import { UNKNOWN_APP } from './hosts/hostDetect.js'

/** An agent as the dial sees it, by raw ids; held: every pane of it is held. */
export interface DialAgent { engine: string; host: string; page: string; held: boolean }
/** An agent the daemon knows from its hooks; listed: the dial's list has it. */
export interface HookedAgent extends DialAgent { listed: boolean; otherApp?: DialOtherApp }

export interface DialUsageDeps {
  sink: DialUsageSink
  now(): number // wall-clock ms
  after(ms: number, run: () => void): () => void
  describe(agentId: string): DialAgent | undefined
}

export interface DialUsage {
  attached(on: boolean): void
  agentsPresent(present: boolean): void
  shown(agentId: string | null): void
  used(): void
  voiceEnded(end: DialVoiceEnd): void
  opened(agentId: string, end: DialOpenEnd): void
  turnStarted(agentId: string): void
  turnAborted(agentId: string): void
  hooked(agentId: string, agent: HookedAgent): void
  waitOpened(key: string, agentId: string): void
  answeredOnDial(key: string): void
  tapped(agentId: string): void
  waitEnded(key: string, end: 'answered' | 'gone'): void
  stop(): void
}

type FirstAgentBucket = typeof DIAL_FIRST_AGENT_BUCKETS[number]
type VoiceOutcome = 'delivered' | 'failed' | 'held' | 'cancelled'

const DAY_MS = 86_400_000
// The spec's measures: delivered is a turn within 10 s, the wrong-agent proxies are 30 s and 10 s.
const DELIVERED_MS = 10_000
const REDIRECT_MS = 30_000
const INTERRUPT_MS = 10_000
const FIRST_AGENT_NONE_MS = 3_600_000
const FIRST_AGENT_EDGES = [60_000, 180_000, 600_000]
const WAIT_EDGES = [30_000, 120_000, 600_000]
const VOICES_WAITING_MAX = 16
const DELIVERED_TURNS_MAX = 16
const WAITS_MAX = 64
// Far above the agents one person runs in a day; past it a day's later agents go uncounted, never twice.
const HOOKED_MAX = 256

export function dialEngine(engine: string): DialUsageEngine {
  return (DIAL_USAGE_ENGINES as readonly string[]).includes(engine) ? engine as DialUsageEngine : 'other'
}

/** The dial's host id as a name: the unknown app is `other`, `terminal-app` is `terminal_app`, any other id `other`. */
export function dialHost(id: string): DialUsageHost {
  if (id === UNKNOWN_APP) return 'other'
  const host = id.replaceAll('-', '_')
  return (DIAL_USAGE_HOSTS as readonly string[]).includes(host) ? host as DialUsageHost : 'other'
}

function bucket<B extends string>(ms: number, edges: readonly number[], buckets: readonly B[]): B {
  const i = edges.findIndex(edge => ms < edge)
  return buckets[i < 0 ? edges.length : i]
}

const utcDay = (ms: number) => Math.floor(ms / DAY_MS)

export function createDialUsage(deps: DialUsageDeps): DialUsage {
  const { sink, now, after } = deps
  const add = (metric: DialFileMetric) => sink.add(metric)
  const hostOf = (agentId: string | undefined) => {
    const agent = agentId === undefined ? undefined : deps.describe(agentId)
    return agent && dialHost(agent.host)
  }

  let attaches = 0
  let stopMidnight: (() => void) | undefined
  let present = false

  // A UTC day's agents, so each counts once a day; cleared at the day's turn. shownToday holds only agents that
  // counted under a name below its cap, so at most DIAL_USAGE_AGENTS_MAX for each engine and host name.
  let day = utcDay(now())
  const shownToday = new Set<string>()
  const agentCounts = new Map<DialFileMetric, number>()
  const hookedToday = new Set<string>()
  const today = () => {
    const current = utcDay(now())
    if (current === day) return
    day = current
    shownToday.clear()
    agentCounts.clear()
    hookedToday.clear()
  }

  const midnight = () => {
    stopMidnight = after(DAY_MS - now() % DAY_MS, () => {
      add('dial_connected_installation_days')
      midnight()
    })
  }

  // Time to the first agent on the dial, from the attach or from the first agent running, whichever comes last.
  interface Measure { first: boolean; day: boolean; start?: number; stopHour?: () => void }
  let measure: Measure | undefined
  const startClock = (m: Measure) => {
    m.start = now()
    m.stopHour = after(FIRST_AGENT_NONE_MS, () => endMeasure('none_1h'))
  }
  const endMeasure = (b: FirstAgentBucket) => {
    if (!measure) return
    measure.stopHour?.()
    if (measure.first) add(`dial_first_agent_first_${b}_installations`)
    if (measure.day) add(`dial_first_agent_day_${b}_installations`)
    measure = undefined
  }

  const used = () => {
    add('dial_used_installation_days')
    if (sink.firstEver('used')) add('dial_first_use_installations')
  }

  const countAgent = (metric: DialFileMetric) => {
    const n = agentCounts.get(metric) ?? 0
    if (n >= DIAL_USAGE_AGENTS_MAX) return false
    agentCounts.set(metric, n + 1)
    add(metric)
    return true
  }

  interface Voice { agentId: string; host?: DialUsageHost; stop: () => void }
  const voices: Voice[] = [] // sent and waiting for their turn, oldest first
  let lastSent: { agentId: string; host?: DialUsageHost; at: number } | undefined
  const delivered = new Map<string, { host?: DialUsageHost; at: number }>() // agent → its delivered turn's start
  const outcome = (o: VoiceOutcome, host: DialUsageHost | undefined) => {
    add(`dial_voice_${o}`)
    if (host) add(`dial_voice_host_${host}_${o}`)
  }
  const failed = (code: DialVoiceFailure, host: DialUsageHost | undefined) => {
    outcome('failed', host)
    add(`dial_voice_failed_${code}`)
  }
  const noTurn = (voice: Voice) => {
    voices.splice(voices.indexOf(voice), 1)
    voice.stop()
    failed('no_turn', voice.host)
  }

  interface Wait { agentId: string; at: number; onDial: boolean }
  const waits = new Map<string, Wait>()

  return {
    attached(on) {
      today()
      if (!on) {
        if (attaches === 0 || --attaches > 0) return
        stopMidnight?.()
        stopMidnight = undefined
        // With no dial no answer can be told apart, so an open wait would end in the wrong bucket.
        waits.clear()
        return
      }
      attaches++
      // The day's first connection is the one that sets the day's flag, which the sink keeps: a restart of the devices
      // is no new first.
      const dayFirst = add('dial_connected_installation_days')
      if (attaches === 1) midnight()
      const first = sink.firstEver('connected')
      if (!first && !dayFirst) return
      // A measurement under way keeps its clock: a dial plugged in again is still the same wait for an agent.
      if (measure) {
        measure.first ||= first
        measure.day ||= dayFirst
        return
      }
      measure = { first, day: dayFirst }
      if (present) startClock(measure)
    },

    agentsPresent(on) {
      present = on
      if (on && measure && measure.start === undefined) startClock(measure)
    },

    shown(agentId) {
      today()
      if (agentId === null) return
      if (measure) endMeasure(bucket(now() - (measure.start ?? now()), FIRST_AGENT_EDGES, DIAL_FIRST_AGENT_BUCKETS))
      const agent = deps.describe(agentId)
      if (!agent || shownToday.has(agentId)) return
      const engine = dialEngine(agent.engine)
      const host = dialHost(agent.host)
      add(`dial_engine_${engine}_installation_days`)
      add(`dial_host_${host}_installation_days`)
      const engineCounted = countAgent(`dial_engine_${engine}_agents`)
      const hostCounted = countAgent(`dial_host_${host}_agents`)
      if (engineCounted || hostCounted) shownToday.add(agentId)
    },

    used,

    voiceEnded(end) {
      used()
      if (end.outcome === 'other') return
      const host = hostOf(end.agentId)
      add('dial_voice_installation_days')
      if (host) add(`dial_voice_host_${host}_installation_days`)
      if (end.outcome === 'cancelled') {
        outcome('cancelled', host)
      } else if (end.outcome === 'failed') {
        const agent = end.agentId === undefined ? undefined : deps.describe(end.agentId)
        if (end.code === 'refused' && agent?.held) outcome('held', host)
        else failed(end.code, host)
      } else {
        const at = now()
        if (lastSent && lastSent.agentId !== end.agentId && at - lastSent.at < REDIRECT_MS) {
          add('dial_voice_redirected_30s')
          if (lastSent.host) add(`dial_voice_host_${lastSent.host}_redirected_30s`)
        }
        lastSent = { agentId: end.agentId, host, at }
        if (voices.length >= VOICES_WAITING_MAX) noTurn(voices[0])
        const voice: Voice = { agentId: end.agentId, host, stop: () => {} }
        voice.stop = after(DELIVERED_MS, () => noTurn(voice))
        voices.push(voice)
      }
    },

    opened(agentId, end) {
      used()
      const host = hostOf(agentId)
      add('dial_open_installation_days')
      add(`dial_open_${end.outcome}`)
      if (end.outcome === 'failed') add(`dial_open_failed_${end.code}`)
      if (!host) return
      add(`dial_open_host_${host}_installation_days`)
      add(`dial_open_host_${host}_${end.outcome}`)
    },

    turnStarted(agentId) {
      const voice = voices.find(v => v.agentId === agentId)
      if (!voice) return
      voices.splice(voices.indexOf(voice), 1)
      voice.stop()
      outcome('delivered', voice.host)
      delivered.delete(agentId) // set again below, so the map stays oldest first
      delivered.set(agentId, { host: voice.host, at: now() })
      if (delivered.size > DELIVERED_TURNS_MAX) delivered.delete(delivered.keys().next().value as string)
    },

    turnAborted(agentId) {
      const turn = delivered.get(agentId)
      if (!turn) return
      delivered.delete(agentId)
      if (now() - turn.at >= INTERRUPT_MS) return
      add('dial_voice_interrupted_10s')
      if (turn.host) add(`dial_voice_host_${turn.host}_interrupted_10s`)
    },

    hooked(agentId, agent) {
      today()
      if (attaches === 0 || hookedToday.has(agentId) || hookedToday.size >= HOOKED_MAX) return
      hookedToday.add(agentId)
      const engine = dialEngine(agent.engine)
      const state: DialRecognition = !agent.listed ? 'not_shown'
        : agent.held ? 'held'
          : agent.page === UNKNOWN_APP ? 'other'
            : 'placed'
      add(`dial_hooked_${engine}_installation_days`)
      add(`dial_hooked_${engine}_${state}`)
      if (state !== 'other') return
      const app = agent.otherApp ?? 'unknown'
      add(`dial_other_app_${app}_installation_days`)
      add(`dial_other_app_${app}_agents`)
    },

    waitOpened(key, agentId) {
      if (attaches === 0 || waits.has(key) || waits.size >= WAITS_MAX) return
      waits.set(key, { agentId, at: now(), onDial: false })
    },

    answeredOnDial(key) {
      const wait = waits.get(key)
      if (wait) wait.onDial = true
    },

    tapped(agentId) {
      for (const wait of waits.values()) if (wait.agentId === agentId) wait.onDial = true
    },

    waitEnded(key, end) {
      const wait = waits.get(key)
      if (!wait) return
      waits.delete(key)
      if (end === 'gone') return add('dial_wait_none')
      const b = bucket(now() - wait.at, WAIT_EDGES, DIAL_WAIT_BUCKETS)
      add(wait.onDial ? `dial_wait_dial_${b}` : `dial_wait_elsewhere_${b}`)
    },

    stop() {
      stopMidnight?.()
      stopMidnight = undefined
      measure?.stopHour?.()
      measure = undefined
      for (const voice of voices.splice(0)) voice.stop()
      attaches = 0
      lastSent = undefined
      delivered.clear()
      waits.clear()
      shownToday.clear()
      agentCounts.clear()
      hookedToday.clear()
    },
  }
}
