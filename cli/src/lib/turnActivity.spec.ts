import { describe, expect, it, vi } from 'vitest'
import { TurnActivity, WORK_EVIDENCE_MS, type ActivityRuntime, type ActivityState } from './turnActivity.js'

function setup() {
  let now = 0
  let runtime: ActivityRuntime | undefined = { key: 'agent:session:pid:start', turnOpen: true }
  let answer: ActivityState = 'unknown'
  let probe = async () => answer
  let drain = async () => {}
  const claimed = vi.fn()
  const activity = new TurnActivity({ now: () => now, runtime: () => runtime,
    probe: () => probe(), drain: () => drain(), claimed })
  return { activity, claimed, frame: () => activity.snapshot('s'),
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
  it('settles an expired claim idle when no turn is open, since nothing probes a closed turn', async () => {
    // A cancel closes the turn and reads idle; the aborted tool's output lands after it and reads as work.
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: false })
    t.activity.observe('s', 'turn_ended'); expect(t.frame()?.state).toBe('idle')
    t.activity.observe('s', 'tool_end'); expect(t.frame()?.state).toBe('working')
    t.advance(WORK_EVIDENCE_MS - 1); expect(t.frame()?.state).toBe('working')
    t.advance(1); expect(t.frame()?.state).toBe('idle')
    // Fresh evidence still reads as work, and an open turn still expires into unknown for the probe.
    t.activity.observe('s', 'text_delta'); expect(t.frame()?.state).toBe('working')
    t.runtime({ key: 'agent:session:pid:start', turnOpen: true })
    t.advance(); expect(t.frame()?.state).toBe('unknown')
  })
  it.each(['turn_started', 'text_delta', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end', 'subagent_finished'])(
    'renews evidence for live %s, but not a replay of it', type => {
      const t = setup(); t.activity.observe('s', type)
      t.advance(20_000); t.activity.observe('s', type, true)
      t.advance(10_000); expect(t.frame()?.state).toBe('unknown')
      t.activity.observe('s', type); expect(t.frame()?.state).toBe('working')
    })
  it('withheld: text, a tool or a subagent\'s end read then claims nothing; a turn\'s start still does', () => {
    // A wait on the person: the engine is not working, though its tools' records still land.
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: true, withheld: true })
    for (const type of ['text_delta', 'thinking_delta', 'thinking_title', 'tool_start', 'tool_end', 'subagent_finished']) {
      t.activity.observe('s', type); expect(t.frame()?.state).toBe('unknown')
    }
    t.activity.observe('s', 'turn_started'); expect(t.frame()?.state).toBe('working')
    // Progress does not renew the claim the start made.
    t.advance(WORK_EVIDENCE_MS - 1); t.activity.observe('s', 'text_delta')
    t.advance(1); expect(t.frame()?.state).toBe('unknown')
    t.activity.observe('s', 'turn_ended'); expect(t.frame()?.state).toBe('idle')
    t.activity.observe('s', 'tool_end'); expect(t.frame()?.state).toBe('idle')
  })
  it('withdraw: a Working claim reads unknown at once while its turn is open, idle with none, and an idle one is left', () => {
    const t = setup(); t.activity.observe('s', 'turn_started')
    t.activity.withdraw('s'); expect(t.frame()).toMatchObject({ state: 'unknown', validForMs: 0 })
    const unknown = t.frame()?.revision
    t.activity.withdraw('s'); expect(t.frame()?.revision).toBe(unknown)
    t.runtime({ key: 'agent:session:pid:start', turnOpen: false })
    t.activity.observe('s', 'text_delta'); expect(t.frame()?.state).toBe('working')
    t.activity.withdraw('s'); expect(t.frame()?.state).toBe('idle')
    const idle = t.frame()?.revision
    t.activity.withdraw('s'); expect(t.frame()).toMatchObject({ state: 'idle', revision: idle })
    t.runtime(); t.activity.withdraw('s'); expect(t.frame()).toBeUndefined()
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
  it('checks with a probe it is given in place of its own', async () => {
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: false }); t.answer('idle')
    await t.activity.check('s', async () => 'working'); expect(t.frame()?.state).toBe('working')
  })
  it('lets a turn_ended observed while a given probe runs win over its working', async () => {
    const t = setup(); let resolve!: (s: ActivityState) => void
    const pending = t.activity.check('s', () => new Promise(r => { resolve = r })); await Promise.resolve()
    t.activity.observe('s', 'turn_ended')
    resolve('working'); await pending
    expect(t.frame()?.state).toBe('idle')
  })
  it('lets a turn_ended drained or observed after the revision a given probe\'s evidence was read at win over its working', async () => {
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: false })
    t.activity.observe('s', 'text_delta')
    let ended = false
    t.drain(async () => { if (!ended) { ended = true; t.activity.observe('s', 'turn_ended') } })
    await t.activity.check('s', async () => 'working', t.frame()!.revision)
    expect(t.frame()?.state).toBe('idle')
    const before = t.frame()!.revision
    t.activity.observe('s', 'text_delta'); t.activity.observe('s', 'turn_ended')
    await t.activity.check('s', async () => 'working', before)
    expect(t.frame()?.state).toBe('idle')
  })
  // A claim with no turn open has no heartbeat to tell its end: the heartbeats watch it from its start (core/turns/heartbeats.ts).
  it('tells of a session turning working with no turn open, once a claim: not its renewals, a replay or an open turn', () => {
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: false })
    t.activity.observe('s', 'turn_started', true)
    t.activity.observe('s', 'turn_started')
    expect(t.claimed).toHaveBeenCalledExactlyOnceWith('s')
    t.advance(20_000); t.activity.observe('s', 'text_delta')
    t.advance(20_000); t.activity.observe('s', 'tool_end')
    expect(t.claimed).toHaveBeenCalledOnce()
    // The claim ran out: the next is a claim of its own.
    t.advance(); t.activity.observe('s', 'text_delta')
    expect(t.claimed).toHaveBeenCalledTimes(2)
    t.activity.observe('s', 'turn_ended')
    t.runtime({ key: 'agent:session:pid:start', turnOpen: true })
    t.activity.observe('s', 'turn_started')
    expect(t.claimed).toHaveBeenCalledTimes(2)
  })
  it('tells of a check that reads working with no turn open, and not of one with a turn open or a renewal', async () => {
    const t = setup(); t.runtime({ key: 'agent:session:pid:start', turnOpen: false })
    await t.activity.check('s', async () => 'working')
    expect(t.claimed).toHaveBeenCalledExactlyOnceWith('s')
    t.advance(5000); await t.activity.check('s', async () => 'working')
    expect(t.claimed).toHaveBeenCalledOnce()
    t.runtime({ key: 'agent:session:pid:start', turnOpen: true })
    t.advance(); t.answer('working'); await t.activity.check('s')
    expect(t.frame()?.state).toBe('working')
    expect(t.claimed).toHaveBeenCalledOnce()
  })
  it('coalesces overlapping checks', async () => {
    const t = setup(); let calls = 0; let resolve!: (s: ActivityState) => void
    t.probe(() => { calls++; return new Promise(r => { resolve = r }) })
    const first = t.activity.check('s'); await Promise.resolve()
    const second = t.activity.check('s'); expect(calls).toBe(1)
    resolve('working'); await Promise.all([first, second]); expect(t.frame()?.state).toBe('working')
  })
})
