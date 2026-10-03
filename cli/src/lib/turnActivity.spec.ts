import { describe, expect, it } from 'vitest'
import { TurnActivity, WORK_EVIDENCE_MS, type ActivityRuntime, type ActivityState } from './turnActivity.js'

function setup() {
  let now = 0
  let runtime: ActivityRuntime | undefined = { key: 'agent:session:pid:start', turnOpen: true }
  let answer: ActivityState = 'unknown'
  let probe = async () => answer
  let drain = async () => {}
  const activity = new TurnActivity({ now: () => now, runtime: () => runtime,
    probe: () => probe(), drain: () => drain() })
  return { activity, frame: () => activity.snapshot('s'),
    advance: (ms = WORK_EVIDENCE_MS) => { now += ms },
    answer: (value: ActivityState) => { answer = value },
    runtime: (value?: ActivityRuntime) => { runtime = value },
    probe: (value: typeof probe) => { probe = value }, drain: (value: typeof drain) => { drain = value } }
}

describe('verified turn activity', () => {
  it('never promotes an unfinished replay to Working, even after thousands of beats', async () => {
    const t = setup()
    t.activity.observe('s', 'turn_started', true)
    for (let i = 0; i < 2000; i++) { t.advance(5000); await t.activity.check('s'); expect(t.frame()?.state).toBe('unknown') }
  })
  it('expires a missing end into unknown without changing the runtime turn or manufacturing completion', () => {
    const t = setup()
    t.activity.observe('s', 'turn_started')
    expect(t.frame()?.state).toBe('working')
    t.advance(WORK_EVIDENCE_MS - 1)
    expect(t.frame()?.validForMs).toBe(1)
    t.advance(1)
    expect(t.frame()?.state).toBe('unknown')
    t.activity.observe('s', 'text_delta')
    expect(t.frame()?.state).toBe('working')
    t.activity.observe('s', 'turn_ended')
    expect(t.frame()?.state).toBe('idle')
  })
  it.each(['turn_started', 'text_delta', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end', 'subagent_finished'])(
    'renews evidence for live %s, but not a replay of it', type => {
      const t = setup(); t.activity.observe('s', type)
      t.advance(20_000); t.activity.observe('s', type, true)
      t.advance(10_000); expect(t.frame()?.state).toBe('unknown')
      t.activity.observe('s', type); expect(t.frame()?.state).toBe('working')
    })
  it('does not renew evidence from metadata, snapshots, or heartbeat generation', () => {
    const t = setup(); t.activity.observe('s', 'turn_started')
    const version = t.frame()?.revision
    for (let i = 0; i < 5; i++) { t.advance(5000); t.activity.observe('s', 'token_count'); expect(t.frame()?.revision).toBe(version) }
    t.advance(5000); expect(t.frame()?.state).toBe('unknown')
  })
  it('keeps quiet tools/thinking Working for hours with fresh positive runtime readings', async () => {
    const t = setup(); t.answer('working')
    for (let i = 0; i < 3000; i++) { t.advance(5000); await t.activity.check('s'); expect(t.frame()?.state).toBe('working') }
  })
  it('treats failed and unavailable probes as unknown, never idle', async () => {
    const t = setup(); t.activity.observe('s', 'turn_started')
    t.probe(async () => { throw new Error('disconnected') })
    await t.activity.check('s'); expect(t.frame()?.state).toBe('working')
    t.advance(); await t.activity.check('s'); expect(t.frame()?.state).toBe('unknown')
  })
  it.each(['progress', 'end', 'replacement', 'removed', 'forget'])(
    'rejects a delayed probe after %s', async change => {
      const t = setup()
      let resolve!: (s: ActivityState) => void
      t.probe(() => new Promise(r => { resolve = r }))
      const pending = t.activity.check('s'); await Promise.resolve()
      if (change === 'progress') t.activity.observe('s', 'text_delta')
      if (change === 'end') t.activity.observe('s', 'turn_ended')
      if (change === 'replacement') t.runtime({ key: 'replacement', turnOpen: true })
      if (change === 'removed') t.runtime()
      if (change === 'forget') t.activity.forget('s')
      resolve(change === 'progress' ? 'idle' : 'working'); await pending
      expect(t.frame()?.state).toBe(change === 'progress' ? 'working' : change === 'end' ? 'idle' : change === 'removed' ? undefined : 'unknown')
    })
  it('drains missed completion writes before and after a live probe', async () => {
    const t = setup(); let calls = 0
    t.drain(async () => { if (++calls === 2) t.activity.observe('s', 'turn_ended') })
    t.answer('working'); await t.activity.check('s')
    expect(calls).toBe(2); expect(t.frame()?.state).toBe('idle')
  })
  it('does not let a probe override recent live engine progress', async () => {
    const t = setup(); t.activity.observe('s', 'text_delta'); t.answer('idle')
    await t.activity.check('s'); expect(t.frame()?.state).toBe('working')
    t.advance(); await t.activity.check('s'); expect(t.frame()?.state).toBe('idle')
  })
  it('coalesces overlapping checks', async () => {
    const t = setup(); let calls = 0; let resolve!: (s: ActivityState) => void
    t.probe(() => { calls++; return new Promise(r => { resolve = r }) })
    const first = t.activity.check('s'); await Promise.resolve()
    const second = t.activity.check('s'); expect(calls).toBe(1)
    resolve('working'); await Promise.all([first, second]); expect(t.frame()?.state).toBe('working')
  })
})
