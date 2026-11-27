import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIAL_FILE_METRICS, DIAL_FLAG_METRICS, DIAL_USAGE_AGENTS_MAX, type DialFileMetric, type DialSkillEngine,
  type DialUsageSink,
} from '../lib/dialUsageContract.js'
import { createDialUsage, dialEngine, dialHost, type DialAgent, type DialUsage, type HookedAgent } from './dialUsage.js'

const T0 = Date.parse('2026-11-23T10:00:00Z')
const DAY_MS = 86_400_000
const FLAGS = new Set<string>(DIAL_FLAG_METRICS)

const tmuxClaude: DialAgent = { engine: 'claude', host: 'tmux', page: 'tmux', held: false }
const orcaCodex: DialAgent = { engine: 'codex', host: 'orca', page: 'orca', held: false }

// A sink as the devices' file keeps it: it records every add, holds a flag at 1 a UTC day and says whether an add
// changed it, and spends each first-ever mark once. It outlives the devices' process: a rig handed it is the next run.
function fileSink() {
  const added: DialFileMetric[] = []
  const values = new Map<string, number>()
  const spent = new Set<string>()
  const sink: DialUsageSink = {
    add: (metric, n = 1) => {
      for (let i = 0; i < n; i++) added.push(metric)
      const key = `${Math.floor(Date.now() / DAY_MS)}:${metric}`
      const was = values.get(key) ?? 0
      values.set(key, FLAGS.has(metric) ? 1 : was + n)
      return values.get(key) !== was
    },
    unreached: mark => !spent.has(mark),
    firstEver: mark => !spent.has(mark) && !!spent.add(mark),
  }
  return { sink, added }
}

function rig(agents: Record<string, DialAgent> = { a: tmuxClaude, b: orcaCodex }, { sink, added } = fileSink()) {
  const logs: string[] = []
  // The agents at work, and those whose own app is not in front: none unless a test says so.
  const working = new Set<string>()
  const away = new Set<string>()
  // The engines whose skills folder holds Harness's skill file now.
  const installed = new Set<DialSkillEngine>()
  const usage = createDialUsage({
    sink,
    now: Date.now,
    after: (ms, run) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer) },
    describe: id => agents[id],
    working: id => working.has(id),
    away: id => away.has(id),
    log: line => logs.push(line),
    skills: () => [...installed],
  })
  const count = (metric: string) => added.filter(m => m === metric).length
  const prefixed = (prefix: string) => added.filter(m => m.startsWith(prefix))
  return { usage, added, count, prefixed, agents, logs, working, away, installed }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0) })
afterEach(() => { vi.useRealTimers() })

describe('createDialUsage', () => {
  it('connected on attach, and again past UTC midnight while attached', () => {
    const { usage, count } = rig()
    usage.attached(true)
    expect(count('dial_connected_installation_days')).toBe(1)
    const toMidnight = DAY_MS - T0 % DAY_MS
    vi.advanceTimersByTime(toMidnight - 1)
    expect(count('dial_connected_installation_days')).toBe(1)
    vi.advanceTimersByTime(1)
    expect(count('dial_connected_installation_days')).toBe(2)
    vi.advanceTimersByTime(DAY_MS)
    expect(count('dial_connected_installation_days')).toBe(3)
    usage.attached(false)
    vi.advanceTimersByTime(2 * DAY_MS)
    expect(count('dial_connected_installation_days')).toBe(3)
  })

  it('a day used is a day connected, though a sleep kept the midnight timer from running', () => {
    const { usage, count } = rig()
    usage.attached(true)
    vi.setSystemTime(T0 + DAY_MS)
    usage.used()
    expect(count('dial_connected_installation_days')).toBe(2)
  })

  // A Wi-Fi device's stroke comes through the same wiring as the dial's.
  it('use with no dial attached is none, and spends no first use', () => {
    const { usage, prefixed } = rig()
    usage.used()
    usage.attached(true)
    usage.attached(false)
    usage.used()
    expect(prefixed('dial_used_')).toEqual([])
    expect(prefixed('dial_first_use_')).toEqual([])
    usage.attached(true)
    usage.used()
    expect(prefixed('dial_first_use_')).toEqual(['dial_first_use_installations'])
  })

  it('a stop cancels the midnight and the hour\'s timers', () => {
    const { usage, added } = rig()
    usage.agentsPresent(true)
    usage.attached(true)
    const before = [...added]
    usage.stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2 * DAY_MS)
    expect(added).toEqual(before)
  })

  it('an attach alone is no use', () => {
    const { usage, prefixed } = rig()
    usage.agentsPresent(true)
    usage.attached(true)
    usage.shown('a')
    usage.attached(false)
    expect(prefixed('dial_used_')).toEqual([])
    expect(prefixed('dial_first_use_')).toEqual([])
  })

  it('each input is use; the first use ever once', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.used()
    expect(count('dial_used_installation_days')).toBe(1)
    expect(count('dial_first_use_installations')).toBe(1)
    usage.voiceEnded({ outcome: 'other' })
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    usage.opened('a', { outcome: 'ok' })
    usage.used()
    expect(count('dial_used_installation_days')).toBe(5)
    expect(count('dial_first_use_installations')).toBe(1)
  })

  it('first agent buckets at 59 999, 60 000, 180 000, 600 000 ms and none_1h', () => {
    const cases: Array<[number, string]> = [
      [59_999, 'under_1m'], [60_000, '1m_to_3m'], [180_000, '3m_to_10m'], [600_000, 'over_10m']]
    for (const [elapsed, bucket] of cases) {
      const { usage, prefixed } = rig()
      usage.agentsPresent(true)
      usage.attached(true)
      vi.advanceTimersByTime(elapsed)
      usage.shown('a')
      expect(prefixed('dial_first_agent_')).toEqual([
        `dial_first_agent_first_${bucket}_installations`, `dial_first_agent_day_${bucket}_installations`])
      usage.stop()
    }
    const none = rig()
    none.usage.agentsPresent(true)
    none.usage.attached(true)
    vi.advanceTimersByTime(3_599_999)
    expect(none.prefixed('dial_first_agent_')).toEqual([])
    vi.advanceTimersByTime(1)
    expect(none.prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_none_1h_installations', 'dial_first_agent_day_none_1h_installations'])
    none.usage.shown('a')
    expect(none.prefixed('dial_first_agent_')).toHaveLength(2)
    none.usage.stop()

    // No agent at the attach: the clock starts when one runs, whichever comes last.
    const late = rig()
    late.usage.attached(true)
    vi.advanceTimersByTime(3_600_000)
    late.usage.agentsPresent(true)
    vi.advanceTimersByTime(59_999)
    late.usage.shown('a')
    expect(late.prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_under_1m_installations', 'dial_first_agent_day_under_1m_installations'])
  })

  it('the first connection ever counts in both families, a later day\'s first in day only, a second attach in neither', () => {
    const { usage, prefixed } = rig()
    usage.agentsPresent(true)
    usage.attached(true)
    vi.advanceTimersByTime(30_000)
    usage.shown('a')
    usage.attached(false)
    usage.attached(true)
    vi.advanceTimersByTime(120_000)
    usage.shown('a')
    expect(prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_under_1m_installations', 'dial_first_agent_day_under_1m_installations'])
    usage.attached(false)

    vi.advanceTimersByTime(DAY_MS)
    usage.attached(true)
    vi.advanceTimersByTime(120_000)
    usage.shown('a')
    expect(prefixed('dial_first_agent_').slice(2)).toEqual(['dial_first_agent_day_1m_to_3m_installations'])
    usage.attached(false)

    // A measurement under way survives a detach: the next day's clock runs from its first attach.
    vi.advanceTimersByTime(DAY_MS)
    usage.attached(true)
    usage.attached(false)
    vi.advanceTimersByTime(240_000)
    usage.attached(true)
    usage.shown('a')
    expect(prefixed('dial_first_agent_').slice(3)).toEqual(['dial_first_agent_day_3m_to_10m_installations'])
  })

  // A sleep stops the timers but not the clock; a clock set back reads as no time at all.
  it('an agent shown past the hour after a sleep is none_1h; a clock set back is under 1m', () => {
    const slept = rig()
    slept.usage.agentsPresent(true)
    slept.usage.attached(true)
    vi.setSystemTime(T0 + 2 * 3_600_000)
    slept.usage.shown('a')
    expect(slept.prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_none_1h_installations', 'dial_first_agent_day_none_1h_installations'])
    slept.usage.stop()

    vi.setSystemTime(T0)
    const back = rig()
    back.usage.agentsPresent(true)
    back.usage.attached(true)
    back.usage.waitOpened('k', 'a')
    vi.setSystemTime(T0 - 3 * 3_600_000)
    back.usage.shown('a')
    back.usage.waitEnded('k', 'answered')
    expect(back.prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_under_1m_installations', 'dial_first_agent_day_under_1m_installations'])
    expect(back.prefixed('dial_wait_')).toEqual(['dial_wait_elsewhere_under_30s'])
  })

  it('a restart of the devices takes no second first connection of the day', () => {
    const file = fileSink()
    const before = rig(undefined, file)
    before.usage.agentsPresent(true)
    before.usage.attached(true)
    vi.advanceTimersByTime(30_000)
    before.usage.shown('a')
    before.usage.stop()
    const after = rig(undefined, file)
    after.usage.agentsPresent(true)
    after.usage.attached(true)
    vi.advanceTimersByTime(120_000)
    after.usage.shown('a')
    expect(after.prefixed('dial_first_agent_')).toEqual([
      'dial_first_agent_first_under_1m_installations', 'dial_first_agent_day_under_1m_installations'])
  })

  it('a restart before the first agent measures the first connection again', () => {
    const file = fileSink()
    const before = rig(undefined, file)
    before.usage.agentsPresent(true)
    before.usage.attached(true)
    vi.advanceTimersByTime(30_000)
    before.usage.stop()
    const after = rig(undefined, file)
    after.usage.agentsPresent(true)
    after.usage.attached(true)
    vi.advanceTimersByTime(120_000)
    after.usage.shown('a')
    expect(after.prefixed('dial_first_agent_')).toEqual(['dial_first_agent_first_1m_to_3m_installations'])
  })

  it('engine and host of each agent shown, an agent once a day, at most 16', () => {
    const agents: Record<string, DialAgent> = {}
    for (let i = 0; i < DIAL_USAGE_AGENTS_MAX + 4; i++) agents[`a${i}`] = tmuxClaude
    const { usage, count } = rig(agents)
    usage.attached(true)
    usage.shown(null)
    expect(count('dial_engine_claude_installation_days')).toBe(0)
    for (const id of Object.keys(agents)) { usage.shown(id); usage.shown(id) }
    expect(count('dial_engine_claude_installation_days')).toBeGreaterThan(0)
    expect(count('dial_host_tmux_installation_days')).toBeGreaterThan(0)
    expect(count('dial_engine_claude_agents')).toBe(DIAL_USAGE_AGENTS_MAX)
    expect(count('dial_host_tmux_agents')).toBe(DIAL_USAGE_AGENTS_MAX)
    vi.advanceTimersByTime(DAY_MS)
    usage.shown('a0')
    usage.shown('a0')
    expect(count('dial_engine_claude_agents')).toBe(DIAL_USAGE_AGENTS_MAX + 1)
    expect(count('dial_host_tmux_agents')).toBe(DIAL_USAGE_AGENTS_MAX + 1)
  })

  it('an agent counted today is not described again at each move of the dial', () => {
    let described = 0
    const { usage } = rig({ get a() { described++; return tmuxClaude } })
    usage.attached(true)
    usage.shown('a')
    usage.shown('a')
    usage.shown('a')
    expect(described).toBe(1)
  })

  it('an unknown engine and host are other; terminal-app is terminal_app', () => {
    expect(dialEngine('claude')).toBe('claude')
    expect(dialEngine('a-new-engine')).toBe('other')
    expect(dialHost('tmux')).toBe('tmux')
    expect(dialHost('terminal-app')).toBe('terminal_app')
    expect(dialHost('terminal')).toBe('other')
    expect(dialHost('zed')).toBe('other')
    const { usage, count } = rig({ x: { engine: 'a-new-engine', host: 'terminal', page: 'terminal', held: false } })
    usage.attached(true)
    usage.shown('x')
    expect(count('dial_engine_other_agents')).toBe(1)
    expect(count('dial_host_other_agents')).toBe(1)
  })

  it('delivered within 10 s, else no_turn; at most 16 wait', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    expect(count('dial_voice_installation_days')).toBe(1)
    expect(count('dial_voice_host_tmux_installation_days')).toBe(1)
    vi.advanceTimersByTime(9_999)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(1)
    expect(count('dial_voice_host_tmux_delivered')).toBe(1)

    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    vi.advanceTimersByTime(10_000)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(1)
    expect(count('dial_voice_failed')).toBe(1)
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    expect(count('dial_voice_host_tmux_failed')).toBe(1)

    // The voices below begin after that turn started, so it is none of theirs.
    vi.advanceTimersByTime(1)
    for (let i = 0; i < 16; i++) usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    expect(count('dial_voice_failed_no_turn')).toBe(2)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(2)

    // A stop drops what waits uncounted.
    usage.stop()
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_failed_no_turn')).toBe(2)
  })

  // A working agent holds typed words until its turn ends (Claude Code) or takes them into the running turn (Codex 0.106+):
  // no turn starts within 10 s, though the words reached it.
  it('sent to a working agent with no turn in 10 s is queued; to an idle one, no_turn; a turn in 10 s, delivered', () => {
    const { usage, count, working } = rig()
    usage.attached(true)
    working.add('a')
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    // Read at the send: the agent idle by the time the 10 s run out was still working when the words went in.
    working.delete('a')
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_queued')).toBe(1)
    expect(count('dial_voice_host_tmux_queued')).toBe(1)
    expect(count('dial_voice_failed')).toBe(0)
    expect(count('dial_voice_failed_no_turn')).toBe(0)

    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    expect(count('dial_voice_host_orca_failed')).toBe(1)
    expect(count('dial_voice_queued')).toBe(1)

    working.add('a')
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    vi.advanceTimersByTime(9_999)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_queued')).toBe(1)
  })

  // `codex queue` exits only after an idle Codex started the queued turn: its start comes before the sent end is told.
  it('a turn that starts while the words are on their way is delivered; one that started before them is not', () => {
    const { usage, count, working } = rig()
    usage.attached(true)
    usage.turnStarted('a')
    vi.advanceTimersByTime(1)
    const since = Date.now()
    vi.advanceTimersByTime(500)
    // A newer start replaces the older.
    usage.turnStarted('a')
    // By the sent end the agent works on these very words.
    working.add('a')
    vi.advanceTimersByTime(500)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since })
    expect(count('dial_voice_delivered')).toBe(1)
    expect(count('dial_voice_host_tmux_delivered')).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_queued')).toBe(0)
    expect(count('dial_voice_failed_no_turn')).toBe(0)

    // That start is spent: another voice begun as early waits, and reads queued as before.
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since })
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_queued')).toBe(1)
    expect(count('dial_voice_delivered')).toBe(1)

    usage.turnStarted('b')
    vi.advanceTimersByTime(1)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    expect(count('dial_voice_delivered')).toBe(1)
  })

  // The window's send begins before a person picks the agent, up to a minute: a turn more than 10 s before the words
  // went in is another input's.
  it('a turn that started more than 10 s before the sent end is not the voice\'s', () => {
    const { usage, count } = rig()
    usage.attached(true)
    const since = Date.now()
    vi.advanceTimersByTime(20_000)
    usage.turnStarted('a')
    vi.advanceTimersByTime(10_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since })
    expect(count('dial_voice_delivered')).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_failed_no_turn')).toBe(1)

    const bSince = Date.now()
    usage.turnStarted('b')
    vi.advanceTimersByTime(9_999)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: bSince })
    expect(count('dial_voice_delivered')).toBe(1)
  })

  it('a voice delivered as it was sent is interrupted within 10 s of its turn\'s start, and redirected', () => {
    const { usage, count } = rig()
    usage.attached(true)
    const since = Date.now()
    usage.turnStarted('a')
    vi.advanceTimersByTime(5_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since })
    vi.advanceTimersByTime(4_999)
    usage.turnAborted('a')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
    expect(count('dial_voice_host_tmux_interrupted_10s')).toBe(1)

    const bSince = Date.now()
    usage.turnStarted('b')
    vi.advanceTimersByTime(5_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: bSince })
    expect(count('dial_voice_redirected_30s')).toBe(1)
    expect(count('dial_voice_host_tmux_redirected_30s')).toBe(1)
    // 10 s from its turn's start, though 5 s from its sent end.
    vi.advanceTimersByTime(5_000)
    usage.turnAborted('b')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
  })

  it('at most 16 turns no voice waited for are kept, the oldest dropped first; a stop drops them', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `d${i}`)
    const { usage, count } = rig(Object.fromEntries(ids.map(id => [id, tmuxClaude])))
    usage.attached(true)
    const since = Date.now()
    for (const id of ids) usage.turnStarted(id)
    usage.voiceEnded({ outcome: 'sent', agentId: 'd0', since })
    expect(count('dial_voice_delivered')).toBe(0)
    usage.voiceEnded({ outcome: 'sent', agentId: 'd1', since })
    expect(count('dial_voice_delivered')).toBe(1)
    usage.stop()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'd2', since })
    expect(count('dial_voice_delivered')).toBe(1)
  })

  it('the oldest of 16 waiting, ended by a 17th, is queued if its agent was working', () => {
    const { usage, count, working } = rig()
    usage.attached(true)
    working.add('a')
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    working.delete('a')
    for (let i = 0; i < 16; i++) usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    expect(count('dial_voice_queued')).toBe(1)
    expect(count('dial_voice_failed_no_turn')).toBe(0)
  })

  it('refused to a held agent is held', () => {
    const { usage, count } = rig({ a: tmuxClaude, h: { ...orcaCodex, held: true } })
    usage.attached(true)
    usage.voiceEnded({ outcome: 'failed', code: 'refused', agentId: 'h' })
    expect(count('dial_voice_held')).toBe(1)
    expect(count('dial_voice_host_orca_held')).toBe(1)
    expect(count('dial_voice_failed_refused')).toBe(0)
    usage.voiceEnded({ outcome: 'failed', code: 'refused', agentId: 'a' })
    expect(count('dial_voice_held')).toBe(1)
    expect(count('dial_voice_failed_refused')).toBe(1)
    expect(count('dial_voice_host_tmux_failed')).toBe(1)
  })

  it('cancelled, failed by code, other', () => {
    const { usage, count, prefixed } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'cancelled', agentId: 'a' })
    usage.voiceEnded({ outcome: 'cancelled' })
    expect(count('dial_voice_cancelled')).toBe(2)
    expect(count('dial_voice_host_tmux_cancelled')).toBe(1)
    usage.voiceEnded({ outcome: 'failed', code: 'no_speech' })
    expect(count('dial_voice_failed')).toBe(1)
    expect(count('dial_voice_failed_no_speech')).toBe(1)
    expect(count('dial_voice_installation_days')).toBe(3)
    const before = prefixed('dial_voice_').length
    usage.voiceEnded({ outcome: 'other' })
    expect(prefixed('dial_voice_')).toHaveLength(before)
    expect(count('dial_used_installation_days')).toBe(4)
  })

  it('redirected within 30 s on the first voice\'s host', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    vi.advanceTimersByTime(29_999)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    expect(count('dial_voice_redirected_30s')).toBe(1)
    expect(count('dial_voice_host_tmux_redirected_30s')).toBe(1)
    expect(count('dial_voice_host_orca_redirected_30s')).toBe(0)
    vi.advanceTimersByTime(1_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    vi.advanceTimersByTime(30_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    expect(count('dial_voice_redirected_30s')).toBe(1)
  })

  it('interrupted within 10 s of a delivered turn', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    usage.turnStarted('a')
    vi.advanceTimersByTime(9_999)
    usage.turnAborted('a')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
    expect(count('dial_voice_host_tmux_interrupted_10s')).toBe(1)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    usage.turnStarted('a')
    vi.advanceTimersByTime(10_000)
    usage.turnAborted('a')
    usage.turnStarted('b')
    usage.turnAborted('b')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
  })

  it('at most 16 delivered turns are kept, the oldest dropped first', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `d${i}`)
    const { usage, count } = rig(Object.fromEntries(ids.map(id => [id, tmuxClaude])))
    usage.attached(true)
    for (const id of ids) {
      usage.voiceEnded({ outcome: 'sent', agentId: id, since: Date.now() })
      usage.turnStarted(id)
    }
    usage.turnAborted('d0')
    expect(count('dial_voice_interrupted_10s')).toBe(0)
    usage.turnAborted('d1')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
  })

  it('a turn no voice started, stopped, is no voice interrupted', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    usage.turnStarted('a')
    vi.advanceTimersByTime(2_000)
    usage.turnStarted('a')
    vi.advanceTimersByTime(3_000)
    usage.turnAborted('a')
    expect(count('dial_voice_interrupted_10s')).toBe(0)
  })

  it('opened ok and failed by code, by host', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.opened('a', { outcome: 'ok' })
    expect(count('dial_open_installation_days')).toBe(1)
    expect(count('dial_open_ok')).toBe(1)
    expect(count('dial_open_host_tmux_installation_days')).toBe(1)
    expect(count('dial_open_host_tmux_ok')).toBe(1)
    usage.opened('b', { outcome: 'failed', code: 'desktop_not_started' })
    expect(count('dial_open_failed')).toBe(1)
    expect(count('dial_open_failed_desktop_not_started')).toBe(1)
    expect(count('dial_open_host_orca_installation_days')).toBe(1)
    expect(count('dial_open_host_orca_failed')).toBe(1)
    expect(count('dial_used_installation_days')).toBe(2)
  })

  it('a hooked agent once a day at its state, Other by app, only while attached', () => {
    const { usage, count, prefixed } = rig()
    const placed: HookedAgent = { ...tmuxClaude, listed: true }
    usage.hooked('p', placed)
    expect(prefixed('dial_hooked_')).toEqual([])
    usage.attached(true)
    usage.hooked('p', placed)
    usage.hooked('p', { ...placed, listed: false })
    expect(count('dial_hooked_claude_installation_days')).toBeGreaterThan(0)
    expect(count('dial_hooked_claude_placed')).toBe(1)
    expect(count('dial_hooked_claude_not_shown')).toBe(0)
    usage.hooked('n', { ...placed, listed: false })
    usage.hooked('h', { ...placed, held: true })
    expect(count('dial_hooked_claude_not_shown')).toBe(1)
    expect(count('dial_hooked_claude_held')).toBe(1)
    usage.hooked('z', { engine: 'codex', host: 'terminal', page: 'terminal', held: false, listed: true, otherApp: 'zed' })
    usage.hooked('u', { engine: 'codex', host: 'terminal', page: 'terminal', held: false, listed: true })
    expect(count('dial_hooked_codex_other')).toBe(2)
    expect(count('dial_other_app_zed_installation_days')).toBe(1)
    expect(count('dial_other_app_zed_agents')).toBe(1)
    expect(count('dial_other_app_unknown_agents')).toBe(1)
    vi.advanceTimersByTime(DAY_MS)
    usage.hooked('p', placed)
    expect(count('dial_hooked_claude_placed')).toBe(2)
  })

  it('hooked agents by state and by app, at most 16 a name a day', () => {
    const { usage, count } = rig()
    usage.attached(true)
    for (let i = 0; i < DIAL_USAGE_AGENTS_MAX + 4; i++) {
      usage.hooked(`p${i}`, { ...tmuxClaude, listed: true })
      usage.hooked(`z${i}`, { engine: 'codex', host: 'terminal', page: 'terminal', held: false, listed: true, otherApp: 'zed' })
    }
    expect(count('dial_hooked_claude_placed')).toBe(DIAL_USAGE_AGENTS_MAX)
    expect(count('dial_hooked_codex_other')).toBe(DIAL_USAGE_AGENTS_MAX)
    expect(count('dial_other_app_zed_agents')).toBe(DIAL_USAGE_AGENTS_MAX)
  })

  it('past 256 agents hooked a day, the day\'s later ones are not looked at', () => {
    const { usage, count } = rig()
    usage.attached(true)
    for (let i = 0; i < 260; i++) usage.hooked(`h${i}`, { ...tmuxClaude, listed: true })
    expect(count('dial_hooked_claude_installation_days')).toBe(256)
    vi.advanceTimersByTime(DAY_MS)
    usage.hooked('h259', { ...tmuxClaude, listed: true })
    expect(count('dial_hooked_claude_installation_days')).toBe(257)
  })

  it('wait buckets at 29 999, 30 000, 120 000, 600 000 ms', () => {
    const { usage, prefixed } = rig()
    usage.attached(true)
    for (const elapsed of [29_999, 30_000, 120_000, 600_000]) {
      usage.waitOpened('k', 'a')
      vi.advanceTimersByTime(elapsed)
      usage.waitEnded('k', 'answered')
    }
    expect(prefixed('dial_wait_')).toEqual(['dial_wait_elsewhere_under_30s', 'dial_wait_elsewhere_30s_to_2m',
      'dial_wait_elsewhere_2m_to_10m', 'dial_wait_elsewhere_over_10m'])
  })

  it('answered on the dial or after a tap is dial, else elsewhere; gone is none', () => {
    const { usage, prefixed } = rig()
    usage.waitOpened('before', 'a')
    usage.waitEnded('before', 'answered')
    expect(prefixed('dial_wait_')).toEqual([])
    usage.attached(true)
    usage.tapped('a')
    usage.waitOpened('k1', 'a')
    usage.waitEnded('k1', 'answered')
    usage.waitOpened('k2', 'a')
    usage.answeredOnDial('k2')
    usage.waitEnded('k2', 'answered')
    usage.waitOpened('k3', 'a')
    usage.waitOpened('k4', 'b')
    usage.tapped('a')
    usage.waitEnded('k3', 'answered')
    usage.waitEnded('k4', 'answered')
    usage.waitOpened('k5', 'a')
    usage.waitEnded('k5', 'gone')
    usage.waitEnded('k5', 'gone')
    expect(prefixed('dial_wait_')).toEqual(['dial_wait_elsewhere_under_30s', 'dial_wait_dial_under_30s',
      'dial_wait_dial_under_30s', 'dial_wait_elsewhere_under_30s', 'dial_wait_none'])

    // At most 64 open at once.
    for (let i = 0; i < 65; i++) usage.waitOpened(`m${i}`, 'a')
    for (let i = 0; i < 65; i++) usage.waitEnded(`m${i}`, 'gone')
    expect(prefixed('dial_wait_none')).toHaveLength(1 + 64)
  })

  it('past 64 open waits the oldest is dropped, said once', () => {
    const { usage, prefixed, logs } = rig()
    usage.attached(true)
    for (let i = 0; i < 66; i++) usage.waitOpened(`m${i}`, 'a')
    usage.waitEnded('m0', 'answered')
    usage.waitEnded('m1', 'answered')
    expect(prefixed('dial_wait_')).toEqual([])
    usage.waitEnded('m65', 'answered')
    expect(prefixed('dial_wait_')).toEqual(['dial_wait_elsewhere_under_30s'])
    expect(logs).toEqual(['[device] usage · wait dropped · over 64 open'])
  })

  it('a detach drops open waits', () => {
    const { usage, prefixed } = rig()
    usage.attached(true)
    usage.attached(true)
    usage.waitOpened('k', 'a')
    usage.attached(false)
    usage.waitEnded('k', 'answered')
    expect(prefixed('dial_wait_')).toEqual(['dial_wait_elsewhere_under_30s'])
    usage.waitOpened('k', 'a')
    usage.attached(false)
    usage.waitEnded('k', 'answered')
    expect(prefixed('dial_wait_')).toHaveLength(1)
  })

  it('every name it adds is in DIAL_FILE_METRICS', () => {
    const { usage, added, away } = rig({
      a: tmuxClaude, b: orcaCodex,
      'secret-agent-id': { engine: 'unheard', host: 'some-new-host', page: 'terminal', held: true },
    })
    for (const id of ['a', 'b', 'secret-agent-id', 'missing']) away.add(id)
    usage.agentsPresent(true)
    usage.attached(true)
    usage.used()
    for (const id of ['a', 'b', 'secret-agent-id', 'missing']) {
      usage.shown(id)
      usage.voiceEnded({ outcome: 'sent', agentId: id, since: Date.now() })
      usage.turnStarted(id)
      usage.turnAborted(id)
      usage.voiceEnded({ outcome: 'failed', code: 'refused', agentId: id })
      usage.voiceEnded({ outcome: 'cancelled', agentId: id })
      usage.opened(id, { outcome: 'failed', code: 'unknown_agent' })
      usage.opened(id, { outcome: 'ok' })
      usage.hooked(id, { engine: 'unheard', host: 'x', page: 'terminal', held: false, listed: true, otherApp: 'unlisted' })
      usage.waitOpened(id, id)
      usage.tapped(id)
      usage.waitEnded(id, 'answered')
      usage.turnEnded(id)
      usage.turnAnnounced(id)
      usage.turnStarted(id, true)
    }
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    vi.advanceTimersByTime(DAY_MS)
    const known = new Set<string>(DIAL_FILE_METRICS)
    expect(added.length).toBeGreaterThan(30)
    expect(added.filter(m => !known.has(m))).toEqual([])
    expect(added.filter(m => m.includes('secret'))).toEqual([])
  })
})

describe('the value from the dial', () => {
  /** The value names added, each once: a flag is added at every count beside it, which the sink holds at 1 a day. */
  const named = (added: DialFileMetric[]) => [...new Set(added.filter(m => m.startsWith('dial_value_')))].sort()
  /** Its end's card came, then the dial rang or listed it. */
  const announce = (usage: DialUsage, agentId: string) => {
    usage.turnEnded(agentId)
    usage.turnAnnounced(agentId)
  }

  it('a ring answered within 2 min counts in both, within 10 min in 10m, past it in neither, each with its flags', () => {
    const { usage, count, added } = rig()
    usage.attached(true)
    for (const elapsed of [119_999, 120_000, 599_999, 600_000]) {
      usage.waitOpened('k', 'a')
      vi.advanceTimersByTime(elapsed)
      usage.waitEnded('k', 'answered')
    }
    // An agent that goes answered nothing.
    usage.waitOpened('k', 'a')
    usage.waitEnded('k', 'gone')
    expect(count('dial_value_ring_answered_2m')).toBe(1)
    expect(count('dial_value_ring_answered_10m')).toBe(3)
    expect(named(added)).toEqual(['dial_value_installation_days', 'dial_value_ring_answered_10m',
      'dial_value_ring_answered_10m_installation_days', 'dial_value_ring_answered_2m',
      'dial_value_ring_answered_2m_installation_days'])
  })

  it('away is read at the ring: its app in front by the answer still counts away, and the other way round', () => {
    const { usage, count, away } = rig()
    usage.attached(true)
    away.add('a')
    usage.waitOpened('k1', 'a')
    away.delete('a')
    vi.advanceTimersByTime(300_000)
    usage.waitEnded('k1', 'answered')
    usage.waitOpened('k2', 'a')
    away.add('a')
    usage.waitEnded('k2', 'answered')
    expect(count('dial_value_ring_away_answered_2m')).toBe(0)
    expect(count('dial_value_ring_away_answered_10m')).toBe(1)
    expect(count('dial_value_ring_away_answered_10m_installation_days')).toBe(1)
    expect(count('dial_value_ring_answered_10m')).toBe(2)
    usage.waitOpened('k3', 'a')
    usage.waitEnded('k3', 'answered')
    expect(count('dial_value_ring_away_answered_2m')).toBe(1)
    expect(count('dial_value_ring_away_answered_2m_installation_days')).toBe(1)
  })

  it('with no dial attached nothing rings and nothing is announced', () => {
    const { usage, prefixed, away } = rig()
    away.add('a')
    usage.waitOpened('k', 'a')
    usage.waitEnded('k', 'answered')
    announce(usage, 'a')
    usage.turnStarted('a', true)
    usage.attached(true)
    usage.turnStarted('a', true)
    expect(prefixed('dial_value_')).toEqual([])
  })

  it('a turn end announced away, then the person\'s prompt within 10 min', () => {
    const { usage, count, away, added } = rig()
    usage.attached(true)
    away.add('a')
    announce(usage, 'a')
    vi.advanceTimersByTime(599_999)
    usage.turnStarted('a', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
    expect(named(added)).toEqual(['dial_value_done_away_prompted_10m', 'dial_value_done_away_prompted_10m_installation_days',
      'dial_value_installation_days'])
    // That turn spent it.
    usage.turnStarted('a', true)
    announce(usage, 'a')
    vi.advanceTimersByTime(600_000)
    usage.turnStarted('a', true)
    // Its app in front at the announcement.
    away.delete('a')
    announce(usage, 'a')
    away.add('a')
    usage.turnStarted('a', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
  })

  it('a turn whose source cannot be told counts nothing, and ends the announcement', () => {
    const { usage, prefixed, away } = rig()
    usage.attached(true)
    away.add('a')
    announce(usage, 'a')
    usage.turnStarted('a')
    usage.turnStarted('a', true)
    expect(prefixed('dial_value_')).toEqual([])
  })

  it('an end announced after the agent\'s next turn started was that start\'s: no later prompt counts', () => {
    const { usage, prefixed, away } = rig()
    usage.attached(true)
    away.add('a')
    usage.turnEnded('a')
    // A message queued while it worked starts the next turn as the summary waits behind its done.
    usage.turnStarted('a', true)
    usage.turnAnnounced('a')
    usage.turnStarted('a', true)
    expect(prefixed('dial_value_')).toEqual([])
  })

  it('at most 16 ends wait for their announcement, the oldest dropped first; a stop drops them', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `d${i}`)
    const { usage, count, away } = rig(Object.fromEntries(ids.map(id => [id, tmuxClaude])))
    usage.attached(true)
    for (const id of ids) { away.add(id); usage.turnEnded(id) }
    for (const id of ids) usage.turnAnnounced(id)
    usage.turnStarted('d0', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(0)
    usage.turnStarted('d1', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
    usage.turnEnded('d2')
    usage.stop()
    usage.attached(true)
    usage.turnAnnounced('d2')
    usage.turnStarted('d2', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
  })

  it('the dial\'s voice is the person\'s prompt, waiting as its turn starts or begun before a turn it started', () => {
    const { usage, count, away } = rig()
    usage.attached(true)
    away.add('a')
    away.add('b')
    announce(usage, 'a')
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    usage.turnStarted('a')
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)

    // The turn starts before the send returns: it is the voice's, and so is the announcement's prompt.
    announce(usage, 'b')
    const since = Date.now()
    usage.turnStarted('b')
    vi.advanceTimersByTime(500)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since })
    expect(count('dial_voice_delivered')).toBe(2)
    expect(count('dial_value_done_away_prompted_10m')).toBe(2)

    // A turn the hook says the dial's words started counts once, though the voice's send returns after it.
    announce(usage, 'a')
    const later = Date.now()
    usage.turnStarted('a', true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: later })
    expect(count('dial_voice_delivered')).toBe(3)
    expect(count('dial_value_done_away_prompted_10m')).toBe(3)

    // A voice whose turn never starts prompted nothing.
    announce(usage, 'a')
    usage.voiceEnded({ outcome: 'sent', agentId: 'a', since: Date.now() })
    vi.advanceTimersByTime(10_000)
    expect(count('dial_value_done_away_prompted_10m')).toBe(3)
  })

  it('at most 16 announcements are kept, the oldest dropped first; a stop drops them', () => {
    const ids = Array.from({ length: 17 }, (_, i) => `d${i}`)
    const { usage, count, away } = rig(Object.fromEntries(ids.map(id => [id, tmuxClaude])))
    usage.attached(true)
    for (const id of ids) { away.add(id); announce(usage, id) }
    usage.turnStarted('d0', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(0)
    usage.turnStarted('d1', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
    usage.stop()
    usage.attached(true)
    usage.turnStarted('d2', true)
    expect(count('dial_value_done_away_prompted_10m')).toBe(1)
  })
})

describe('the dial skill\'s use', () => {
  const ANSWERED = 'dial_notice_answered_10m'

  it('counts each notice by the engine it names, its answer and its kind, with the day\'s flags, dial or no dial', () => {
    const { usage, count } = rig()
    usage.noticed('claude', 'shown', 'waiting')
    usage.noticed('claude', 'limited', 'waiting')
    usage.attached(true)
    usage.noticed('codex', 'shown', 'proceeding')
    usage.attached(false)
    usage.noticed('agent', 'no dial', 'plain')
    expect(count('dial_notice_claude')).toBe(2)
    expect(count('dial_notice_codex')).toBe(1)
    expect(count('dial_notice_other')).toBe(1)
    expect(count('dial_notice_shown')).toBe(2)
    expect(count('dial_notice_limited')).toBe(1)
    expect(count('dial_notice_no_dial')).toBe(1)
    expect(count('dial_notice_waiting')).toBe(2)
    expect(count('dial_notice_proceeding')).toBe(1)
    expect(count('dial_notice_plain')).toBe(1)
    // A flag is added at each notice; the sink holds it at 1 a day.
    expect(count('dial_notice_installation_days')).toBe(4)
    expect(count('dial_notice_claude_installation_days')).toBe(2)
    expect(count('dial_notice_codex_installation_days')).toBe(1)
    expect(count('dial_notice_other_installation_days')).toBe(1)
    expect(count(ANSWERED)).toBe(0)
  })

  // Each notice under its wait's key (services/devices.ts noticeWait): here its agent's id, so a turn start of that agent
  // would find it.
  it('a notice its agent closed within 10 minutes is answered, once', () => {
    const { usage, count } = rig()
    usage.noticeShown('a', false)
    vi.advanceTimersByTime(599_999)
    usage.noticeEnded('a', true)
    expect(count(ANSWERED)).toBe(1)
    usage.noticeEnded('a', true)
    expect(count(ANSWERED)).toBe(1)
  })

  it('a notice its agent closed at 10 minutes is not', () => {
    const { usage, count } = rig()
    usage.noticeShown('a', false)
    vi.advanceTimersByTime(600_000)
    usage.noticeEnded('a', true)
    expect(count(ANSWERED)).toBe(0)
  })

  it('a notice that went otherwise counts nothing, and is forgotten', () => {
    const { usage, count } = rig()
    usage.noticeShown('a', false)
    usage.noticeEnded('a', false)
    usage.noticeEnded('a', true)
    expect(count(ANSWERED)).toBe(0)
  })

  // 2026-11-27: another agent's message started the turn, and the card counted as answered went unseen. Only its agent
  // can tell an answer: no turn start, the person's prompt or the dial's voice, answers or spends a notice.
  it('the person\'s prompt answers no notice, nor does the dial\'s voice', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.noticeShown('a', false)
    usage.turnStarted('a', true)
    // The voice waiting as the turn starts, and the turn started before the send returns.
    usage.noticeShown('b', true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since: Date.now() })
    usage.turnStarted('b')
    vi.advanceTimersByTime(61_000)
    usage.noticeShown('b', true)
    const since = Date.now()
    usage.turnStarted('b')
    usage.voiceEnded({ outcome: 'sent', agentId: 'b', since })
    expect(count('dial_voice_delivered')).toBe(2)
    expect(count(ANSWERED)).toBe(0)
    usage.noticeEnded('a', true)
    usage.noticeEnded('b', true)
    expect(count(ANSWERED)).toBe(2)
  })

  it('a notice shown again under its key replaces the older, which ends uncounted', () => {
    const { usage, count } = rig()
    usage.noticeShown('a', false)
    vi.advanceTimersByTime(540_000)
    usage.noticeShown('a', false)
    vi.advanceTimersByTime(540_000)
    usage.noticeEnded('a', true)
    expect(count(ANSWERED)).toBe(1)
  })

  describe('held quiet', () => {
    const PRESENT = 'dial_notice_present'
    const PRESENT_ANSWERED = 'dial_notice_present_answered_10m'

    it('a quiet one counts both', () => {
      const { usage, count } = rig()
      usage.noticeShown('a', true)
      expect(count(PRESENT)).toBe(1)
      vi.advanceTimersByTime(599_999)
      usage.noticeEnded('a', true)
      expect(count(ANSWERED)).toBe(1)
      expect(count(PRESENT_ANSWERED)).toBe(1)
    })

    it('a quiet notice asked at its turn\'s end is counted as roused', () => {
      const { usage, count } = rig()
      usage.noticeShown('a', true)
      usage.noticeRoused()
      expect(count('dial_notice_present_roused')).toBe(1)
      expect(count(PRESENT)).toBe(1)
      vi.advanceTimersByTime(599_999)
      usage.noticeEnded('a', true)
      expect(count(ANSWERED)).toBe(1)
      expect(count(PRESENT_ANSWERED)).toBe(1)
    })

    it('a rung notice counts neither', () => {
      const { usage, count } = rig()
      usage.noticeShown('b', false)
      usage.noticeEnded('b', true)
      expect(count(ANSWERED)).toBe(1)
      expect(count(PRESENT)).toBe(0)
      expect(count(PRESENT_ANSWERED)).toBe(0)
    })

    it('a newer rung notice replaces a quiet one', () => {
      const { usage, count } = rig()
      usage.noticeShown('a', true)
      usage.noticeShown('a', false)
      usage.noticeEnded('a', true)
      expect(count(PRESENT)).toBe(1)
      expect(count(PRESENT_ANSWERED)).toBe(0)
      expect(count(ANSWERED)).toBe(1)
    })

    it('past 10 minutes a quiet notice is not answered', () => {
      const { usage, count } = rig()
      usage.noticeShown('a', true)
      vi.advanceTimersByTime(600_000)
      usage.noticeEnded('a', true)
      expect(count(ANSWERED)).toBe(0)
      expect(count(PRESENT_ANSWERED)).toBe(0)
    })
  })

  it('at most 20 open, the oldest dropped first; an unplug keeps them; a stop drops them', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `d${i}`)
    const { usage, count } = rig(Object.fromEntries(ids.map(id => [id, tmuxClaude])))
    for (const id of ids) usage.noticeShown(id, false)
    usage.noticeEnded('d0', true)
    expect(count(ANSWERED)).toBe(0)
    usage.noticeEnded('d1', true)
    expect(count(ANSWERED)).toBe(1)
    usage.attached(true)
    usage.attached(false)
    usage.noticeEnded('d2', true)
    expect(count(ANSWERED)).toBe(2)
    usage.stop()
    usage.noticeEnded('d3', true)
    expect(count(ANSWERED)).toBe(2)
  })

  it('the skill counts after each setup pass and at each UTC midnight from the first, by one timer', () => {
    const { usage, prefixed, count, installed } = rig()
    vi.advanceTimersByTime(2 * DAY_MS)
    expect(prefixed('dial_skill_')).toEqual([])
    installed.add('codex')
    usage.setupPassed()
    usage.setupPassed()
    expect(vi.getTimerCount()).toBe(1)
    expect(prefixed('dial_skill_')).toEqual(['dial_skill_codex_installation_days', 'dial_skill_codex_installation_days'])
    installed.add('claude')
    const toMidnight = DAY_MS - Date.now() % DAY_MS
    vi.advanceTimersByTime(toMidnight - 1)
    expect(count('dial_skill_claude_installation_days')).toBe(0)
    vi.advanceTimersByTime(1)
    expect(count('dial_skill_claude_installation_days')).toBe(1)
    expect(count('dial_skill_codex_installation_days')).toBe(3)
    vi.advanceTimersByTime(DAY_MS)
    expect(count('dial_skill_claude_installation_days')).toBe(2)
    expect(count('dial_skill_codex_installation_days')).toBe(4)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('counts a second look\'s yes and its ring by engine', () => {
    const { usage, added } = rig()
    usage.nudgeYes('claude')
    usage.nudgeYes('claude')
    usage.nudgeYes('codex')
    usage.nudgeRang('claude')
    expect(added).toEqual(['dial_nudge_claude', 'dial_nudge_claude', 'dial_nudge_codex', 'dial_nudge_claude_rang'])
  })

  // A pass can settle after the devices stopped: a `claude` run it waited on was still going.
  it('nothing is armed after stop', () => {
    const { usage, prefixed, installed } = rig()
    installed.add('claude')
    usage.setupPassed()
    usage.stop()
    usage.setupPassed()
    vi.advanceTimersByTime(2 * DAY_MS)
    expect(prefixed('dial_skill_')).toEqual(['dial_skill_claude_installation_days'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
