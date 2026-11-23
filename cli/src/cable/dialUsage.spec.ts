import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DIAL_FILE_METRICS, DIAL_FLAG_METRICS, DIAL_USAGE_AGENTS_MAX, type DialFileMetric, type DialUsageSink,
} from '../lib/dialUsageContract.js'
import { createDialUsage, dialEngine, dialHost, type DialAgent, type HookedAgent } from './dialUsage.js'

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
  const usage = createDialUsage({
    sink,
    now: Date.now,
    after: (ms, run) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer) },
    describe: id => agents[id],
  })
  const count = (metric: string) => added.filter(m => m === metric).length
  const prefixed = (prefix: string) => added.filter(m => m.startsWith(prefix))
  return { usage, added, count, prefixed, agents }
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
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
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
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    expect(count('dial_voice_installation_days')).toBe(1)
    expect(count('dial_voice_host_tmux_installation_days')).toBe(1)
    vi.advanceTimersByTime(9_999)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(1)
    expect(count('dial_voice_host_tmux_delivered')).toBe(1)

    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    vi.advanceTimersByTime(10_000)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(1)
    expect(count('dial_voice_failed')).toBe(1)
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    expect(count('dial_voice_host_tmux_failed')).toBe(1)

    for (let i = 0; i < 16; i++) usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    expect(count('dial_voice_failed_no_turn')).toBe(1)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    expect(count('dial_voice_failed_no_turn')).toBe(2)
    usage.turnStarted('a')
    expect(count('dial_voice_delivered')).toBe(2)

    // A stop drops what waits uncounted.
    usage.stop()
    vi.advanceTimersByTime(10_000)
    expect(count('dial_voice_failed_no_turn')).toBe(2)
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
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    vi.advanceTimersByTime(29_999)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b' })
    expect(count('dial_voice_redirected_30s')).toBe(1)
    expect(count('dial_voice_host_tmux_redirected_30s')).toBe(1)
    expect(count('dial_voice_host_orca_redirected_30s')).toBe(0)
    vi.advanceTimersByTime(1_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'b' })
    vi.advanceTimersByTime(30_000)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    expect(count('dial_voice_redirected_30s')).toBe(1)
  })

  it('interrupted within 10 s of a delivered turn', () => {
    const { usage, count } = rig()
    usage.attached(true)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    usage.turnStarted('a')
    vi.advanceTimersByTime(9_999)
    usage.turnAborted('a')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
    expect(count('dial_voice_host_tmux_interrupted_10s')).toBe(1)
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    usage.turnStarted('a')
    vi.advanceTimersByTime(10_000)
    usage.turnAborted('a')
    usage.turnStarted('b')
    usage.turnAborted('b')
    expect(count('dial_voice_interrupted_10s')).toBe(1)
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
    const { usage, added } = rig({
      a: tmuxClaude, b: orcaCodex,
      'secret-agent-id': { engine: 'unheard', host: 'some-new-host', page: 'terminal', held: true },
    })
    usage.agentsPresent(true)
    usage.attached(true)
    usage.used()
    for (const id of ['a', 'b', 'secret-agent-id', 'missing']) {
      usage.shown(id)
      usage.voiceEnded({ outcome: 'sent', agentId: id })
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
    }
    usage.voiceEnded({ outcome: 'sent', agentId: 'a' })
    vi.advanceTimersByTime(DAY_MS)
    const known = new Set<string>(DIAL_FILE_METRICS)
    expect(added.length).toBeGreaterThan(30)
    expect(added.filter(m => !known.has(m))).toEqual([])
    expect(added.filter(m => m.includes('secret'))).toEqual([])
  })
})
