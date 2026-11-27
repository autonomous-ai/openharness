// What the devices count of the dial (docs/plans/2026-11-23-dial-usage-counts-design.md): the devices' hooks say what
// happened, and this writes fixed names to the sink. An agent id lives only in the bounded maps and sets here, never in
// a name: the sink's file is read and sent by the gateway.

import {
  DIAL_FIRST_AGENT_BUCKETS, DIAL_USAGE_AGENTS_MAX, DIAL_USAGE_ENGINES, DIAL_USAGE_HOSTS, DIAL_VOICE_OUTCOMES,
  DIAL_WAIT_BUCKETS,
  type DialFileMetric, type DialOpenEnd, type DialOtherApp, type DialRecognition, type DialSkillEngine,
  type DialUsageEngine, type DialUsageHost, type DialUsageSink, type DialValueCount, type DialVoiceEnd,
  type DialVoiceFailure,
} from '../lib/dialUsageContract.js'
import type { NoticeKind, NoticeResult } from '../lib/dialNotice.js'
import { UNKNOWN_APP } from './hosts/hostDetect.js'
import { NOTICES_PENDING_MAX } from './notices.js'

/** An agent as the dial sees it, by raw ids; held: every pane of it is held. */
export interface DialAgent { engine: string; host: string; page: string; held: boolean }
/** An agent the daemon knows from its hooks; listed: the dial's list has it. */
export interface HookedAgent extends DialAgent { listed: boolean; otherApp?: DialOtherApp }

export interface DialUsageDeps {
  sink: DialUsageSink
  now(): number // wall-clock ms
  after(ms: number, run: () => void): () => void
  describe(agentId: string): DialAgent | undefined
  /** Whether the agent is at work or waits on the person now: words sent to it then wait for its turn's end. */
  working(agentId: string): boolean
  /** Whether the agent's own app is known and another app is known to be in front: read at a ring and at a turn end the
   *  dial announced. Anything unknown is not away. */
  away(agentId: string): boolean
  /** Fixed lines only, never an id. */
  log(line: string): void
  /** The engines whose skill Harness's file is in now (devices/dialSkill.ts installedSkills). */
  skills(): readonly DialSkillEngine[]
}

export interface DialUsage {
  attached(on: boolean): void
  agentsPresent(present: boolean): void
  shown(agentId: string | null): void
  used(): void
  voiceEnded(end: DialVoiceEnd): void
  opened(agentId: string, end: DialOpenEnd): void
  /** [byPerson]: its hook says the person, or the dial's words, started it; a turn whose source can't be told is not. */
  turnStarted(agentId: string, byPerson?: boolean): void
  /** A finished or failed turn's card came: only an end whose card came since the agent's last turn start is announced. */
  turnEnded(agentId: string): void
  /** A finished turn the dial rang or listed, or a failed one. */
  turnAnnounced(agentId: string): void
  turnAborted(agentId: string): void
  hooked(agentId: string, agent: HookedAgent): void
  waitOpened(key: string, agentId: string): void
  answeredOnDial(key: string): void
  tapped(agentId: string): void
  waitEnded(key: string, end: 'answered' | 'gone'): void
  /** Each notice the devices answer (cable/notices.ts `count`): `agent` is a notice naming no engine, counted `other`. */
  noticed(engine: 'claude' | 'codex' | 'agent', result: NoticeResult, kind: NoticeKind): void
  /** That agent's notice was shown now: its person's next prompt within 10 min answers it. [present]: held quiet, as the
   *  person was with that agent. */
  noticeShown(agentId: string, present: boolean): void
  /** A notice held quiet was asked at its turn's end, the person gone (cable/notices.ts `rouse`). */
  noticeRoused(): void
  /** The devices said yes to a stop of that engine's agent: it is asked to ring or end (Part 5's second look). */
  nudgeYes(engine: DialSkillEngine): void
  /** A notice of that agent rang in the continuation a yes started, at most once a yes. */
  nudgeRang(engine: DialSkillEngine): void
  /** A dial setup pass ended: the skill is looked for now, and at each UTC midnight from the first; nothing after stop(). */
  setupPassed(): void
  stop(): void
}

type FirstAgentBucket = typeof DIAL_FIRST_AGENT_BUCKETS[number]
type VoiceOutcome = typeof DIAL_VOICE_OUTCOMES[number]

const DAY_MS = 86_400_000
// The spec's measures: delivered is a turn within 10 s, the wrong-agent proxies are 30 s and 10 s.
const DELIVERED_MS = 10_000
const REDIRECT_MS = 30_000
const INTERRUPT_MS = 10_000
const FIRST_AGENT_NONE_MS = 3_600_000
// The hour is an edge too, not only a timer: a sleep stops the timer but not the clock.
const FIRST_AGENT_EDGES = [60_000, 180_000, 600_000, FIRST_AGENT_NONE_MS]
const WAIT_EDGES = [30_000, 120_000, 600_000]
// The value counts' windows: a ring answered within 2 or 10 min, a prompt within 10 min of an announced turn end.
const VALUE_SHORT_MS = 120_000
const VALUE_MS = 600_000
const VOICES_WAITING_MAX = 16
const DELIVERED_TURNS_MAX = 16
const UNWAITED_TURNS_MAX = 16
const ANNOUNCED_MAX = 16
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

/** A clock set back gives a time below 0, which lands under the first edge. */
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

  // A setup pass can settle after the devices stopped (a `claude` run it waited on was still going): it arms nothing.
  let stopped = false
  let stopSkillMidnight: (() => void) | undefined
  const skillChecked = () => {
    for (const engine of deps.skills()) add(`dial_skill_${engine}_installation_days`)
  }
  // Apart from the connected midnight: the skill is there with or without a dial plugged in.
  const skillMidnight = () => {
    stopSkillMidnight = after(DAY_MS - now() % DAY_MS, () => {
      skillChecked()
      skillMidnight()
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
    // The first connection is spent as its measure ends, not at the attach: one a restart cut short is taken again.
    if (measure.first && sink.firstEver('connected')) add(`dial_first_agent_first_${b}_installations`)
    if (measure.day) add(`dial_first_agent_day_${b}_installations`)
    measure = undefined
  }

  const used = () => {
    // A Wi-Fi device's input comes through the same wiring, and is no use of a dial.
    if (attaches === 0) return
    // A sleep can hold the midnight timer past the day's turn: a day the dial was used is a day it was connected.
    add('dial_connected_installation_days')
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

  interface ShownNotice { at: number; present: boolean }
  interface Voice { agentId: string; host?: DialUsageHost; working: boolean; stop: () => void }
  const voices: Voice[] = [] // sent and waiting for their turn, oldest first
  let lastSent: { agentId: string; host?: DialUsageHost; at: number } | undefined
  const delivered = new Map<string, { host?: DialUsageHost; at: number }>() // agent → its delivered turn's start
  // agent → when its last turn started with no voice waiting, oldest first. A send can return only after its words
  // started the turn: `codex queue` exits after an idle Codex started the queued turn, the window answers after it
  // delivered, a typing adapter finishes late. That turn belongs to the voice whose send began at or before it, and so
  // does the announced turn end before it, whose prompt the voice then was.
  const unwaited = new Map<string, { at: number; announced?: number; notice?: ShownNotice }>()
  // agent → when its notice was shown and whether it was held quiet, oldest first: one an agent, as the dial keeps one
  // card an agent. Its next turn start spends it; an unplug keeps it, since the person's prompt is told by its hook with
  // or without a dial.
  const notices = new Map<string, ShownNotice>()
  const noticeAnswered = (notice: ShownNotice | undefined, at: number) => {
    if (notice === undefined || at - notice.at >= VALUE_MS) return
    add('dial_notice_answered_10m')
    if (notice.present) add('dial_notice_present_answered_10m')
  }
  // agent → when the dial announced its turn end with its app not in front, oldest first; its next turn start spends it.
  const announced = new Map<string, number>()
  // The agents whose turn end's card came and whose next turn has not started, oldest first. A summary waits in its
  // agent's queue behind the done, up to 2 s for the turn's tokens, and a message the person queued while the agent
  // worked starts the next turn meanwhile: announced after that start, the end would wait for a prompt already made.
  const ending = new Set<string>()
  const valued = (count: DialValueCount) => {
    add('dial_value_installation_days')
    add(`dial_value_${count}_installation_days`)
    add(`dial_value_${count}`)
  }
  const prompted = (announcedAt: number | undefined, at: number) => {
    if (announcedAt !== undefined && at - announcedAt < VALUE_MS) valued('done_away_prompted_10m')
  }
  const outcome = (o: VoiceOutcome, host: DialUsageHost | undefined) => {
    add(`dial_voice_${o}`)
    if (host) add(`dial_voice_host_${host}_${o}`)
  }
  const deliver = (agentId: string, host: DialUsageHost | undefined, at: number) => {
    outcome('delivered', host)
    delivered.set(agentId, { host, at })
    if (delivered.size > DELIVERED_TURNS_MAX) delivered.delete(delivered.keys().next().value as string)
  }
  const failed = (code: DialVoiceFailure, host: DialUsageHost | undefined) => {
    outcome('failed', host)
    add(`dial_voice_failed_${code}`)
  }
  // A working agent starts no turn for the words within 10 s, though they reached it: Claude Code holds them until its
  // turn ends, Codex 0.106+ steers them into the running turn (2026-11-25: such a voice was counted no_turn, then ran
  // 15 s later as its own turn).
  const noTurn = (voice: Voice) => {
    voices.splice(voices.indexOf(voice), 1)
    voice.stop()
    if (voice.working) outcome('queued', voice.host)
    else failed('no_turn', voice.host)
  }

  // away: read at the ring, as the person saw it then.
  interface Wait { agentId: string; at: number; onDial: boolean; away: boolean }
  const waits = new Map<string, Wait>() // oldest first
  let waitDropped = false

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
      const first = sink.unreached('connected')
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
      // Asked before the agent is described: every move of the dial comes here.
      if (shownToday.has(agentId)) return
      const agent = deps.describe(agentId)
      if (!agent) return
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
        const started = unwaited.get(end.agentId)
        // Within 10 s of the end too: the window's send begins before a person picks the agent, up to a minute before
        // it delivers, and a turn begun meanwhile is another input's.
        if (started !== undefined && started.at >= end.since && at - started.at < DELIVERED_MS) {
          unwaited.delete(end.agentId)
          prompted(started.announced, started.at)
          noticeAnswered(started.notice, started.at)
          return deliver(end.agentId, host, started.at)
        }
        if (voices.length >= VOICES_WAITING_MAX) noTurn(voices[0])
        // Read at the send: by the 10 s end the turn the words waited behind may be over.
        const voice: Voice = { agentId: end.agentId, host, working: deps.working(end.agentId), stop: () => {} }
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

    turnStarted(agentId, byPerson = false) {
      // A newer turn ends the agent's last: a stop now stops this one, which a voice delivers or not. Any start spends
      // the announced turn end and the shown notice, the person's prompt or not.
      delivered.delete(agentId)
      unwaited.delete(agentId)
      ending.delete(agentId)
      const announcedAt = announced.get(agentId)
      announced.delete(agentId)
      const notice = notices.get(agentId)
      notices.delete(agentId)
      const voice = voices.find(v => v.agentId === agentId)
      if (!voice) {
        if (byPerson) {
          prompted(announcedAt, now())
          noticeAnswered(notice, now())
        }
        // Set after the delete above, so the map stays oldest first. Counted already, the announcement and the notice
        // are not kept.
        unwaited.set(agentId, byPerson ? { at: now() } : { at: now(), announced: announcedAt, notice })
        if (unwaited.size > UNWAITED_TURNS_MAX) unwaited.delete(unwaited.keys().next().value as string)
        return
      }
      voices.splice(voices.indexOf(voice), 1)
      voice.stop()
      prompted(announcedAt, now())
      noticeAnswered(notice, now())
      // Set after the delete above, so the map stays oldest first.
      deliver(agentId, voice.host, now())
    },

    turnEnded(agentId) {
      // Set after the delete, so the set stays oldest first.
      ending.delete(agentId)
      ending.add(agentId)
      if (ending.size > ANNOUNCED_MAX) ending.delete(ending.values().next().value as string)
    },

    turnAnnounced(agentId) {
      // Read now: by the next prompt the person may have brought its app up.
      if (attaches === 0 || !ending.has(agentId) || !deps.away(agentId)) return
      // Set after the delete, so the map stays oldest first.
      announced.delete(agentId)
      announced.set(agentId, now())
      if (announced.size > ANNOUNCED_MAX) announced.delete(announced.keys().next().value as string)
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
      countAgent(`dial_hooked_${engine}_${state}`)
      if (state !== 'other') return
      const app = agent.otherApp ?? 'unknown'
      add(`dial_other_app_${app}_installation_days`)
      countAgent(`dial_other_app_${app}_agents`)
    },

    waitOpened(key, agentId) {
      if (attaches === 0 || waits.has(key)) return
      // The newest is the one the person is likeliest to answer: the oldest goes, and the first time is said.
      if (waits.size >= WAITS_MAX) {
        waits.delete(waits.keys().next().value as string)
        if (!waitDropped) deps.log(`[device] usage · wait dropped · over ${WAITS_MAX} open`)
        waitDropped = true
      }
      waits.set(key, { agentId, at: now(), onDial: false, away: deps.away(agentId) })
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
      const elapsed = now() - wait.at
      const b = bucket(elapsed, WAIT_EDGES, DIAL_WAIT_BUCKETS)
      add(wait.onDial ? `dial_wait_dial_${b}` : `dial_wait_elsewhere_${b}`)
      if (elapsed >= VALUE_MS) return
      const answered = (ring: 'ring' | 'ring_away') => {
        if (elapsed < VALUE_SHORT_MS) valued(`${ring}_answered_2m`)
        valued(`${ring}_answered_10m`)
      }
      answered('ring')
      if (wait.away) answered('ring_away')
    },

    noticed(engine, result, kind) {
      const e = engine === 'agent' ? 'other' : engine
      add('dial_notice_installation_days')
      add(`dial_notice_${e}`)
      add(`dial_notice_${e}_installation_days`)
      add(`dial_notice_${result === 'no dial' ? 'no_dial' : result}`)
      add(`dial_notice_${kind}`)
    },

    noticeShown(agentId, present) {
      if (present) add('dial_notice_present')
      // A newer notice replaces the agent's older one, which ends uncounted. Set after the delete, so the map stays
      // oldest first.
      notices.delete(agentId)
      notices.set(agentId, { at: now(), present })
      if (notices.size > NOTICES_PENDING_MAX) notices.delete(notices.keys().next().value as string)
    },

    noticeRoused() {
      add('dial_notice_present_roused')
    },

    nudgeYes(engine) {
      add(`dial_nudge_${engine}`)
    },

    nudgeRang(engine) {
      add(`dial_nudge_${engine}_rang`)
    },

    setupPassed() {
      if (stopped) return
      skillChecked()
      if (!stopSkillMidnight) skillMidnight()
    },

    stop() {
      stopped = true
      stopSkillMidnight?.()
      stopSkillMidnight = undefined
      stopMidnight?.()
      stopMidnight = undefined
      measure?.stopHour?.()
      measure = undefined
      for (const voice of voices.splice(0)) voice.stop()
      attaches = 0
      lastSent = undefined
      delivered.clear()
      unwaited.clear()
      announced.clear()
      notices.clear()
      ending.clear()
      waits.clear()
      shownToday.clear()
      agentCounts.clear()
      hookedToday.clear()
    },
  }
}
