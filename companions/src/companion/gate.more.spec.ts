/**
 * More of what the person has said yes to (pair/gate.ts): the summary a rules request shows, repeated and
 * replaced requests, a lowering from a confirmed level, a file confirmed before coming back while another
 * waits, and a confirmation store that cannot be written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configSummary, hashConfig, PairGate, type GateEvent } from './gate.js'
import { EMPTY_PAIR_CONFIG, parsePairConfig, type PairConfig } from './rules.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-gate-more-')) })
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

function gate(file: string | null = join(dir, 'confirmed.json'), initial: 'watch' | 'act-within-rules' = 'watch') {
  const events: GateEvent[] = []
  let n = 0
  const g = new PairGate({ file, onEvent: (e) => events.push(e), newNonce: () => `n${++n}`, now: () => 5 }, initial)
  return { g, events }
}

const RULE = { question: 'npm test', choice: 'Yes' }
const text = (value: object) => JSON.stringify(value)
const load = (value: object) => ({ config: parsePairConfig(text(value), '/home/me'), text: text(value) })

describe('configSummary', () => {
  it('says what a pair.jsonc turns on, in a few words', () => {
    expect(configSummary(EMPTY_PAIR_CONFIG)).toBe('0 rules, model off')
    const one: PairConfig = { ...parsePairConfig(text({ rules: [RULE], model: true }), '/h') }
    expect(configSummary(one)).toBe('1 rule, model on')
    const learn = parsePairConfig(text({ learn: { borrow: true, export: ['agents', 'claude'], agentsMd: ['/a', '/b'] } }), '/h')
    expect(configSummary(learn)).toBe('0 rules, model off, learn borrow + export agents+claude + AGENTS.md in 2 projects')
    expect(configSummary(parsePairConfig(text({ learn: { agentsMd: ['/a'] } }), '/h'))).toBe('0 rules, model off, learn AGENTS.md in 1 project')
    expect(configSummary({ ...EMPTY_PAIR_CONFIG, learn: undefined as unknown as PairConfig['learn'] })).toBe('0 rules, model off')
  })
})

describe('autonomy', () => {
  it('asks once for a level that is already waiting, and not again', () => {
    const { g, events } = gate()
    g.setRequested('act-on-key')
    g.setRequested('act-on-key')
    expect(events.filter((e) => e.type === 'asked')).toHaveLength(1)
    expect(g.requests()).toEqual([expect.objectContaining({ kind: 'autonomy', level: 'act-on-key', nonce: 'n1', at: 5 })])
    expect(g.requests()[0]).not.toHaveProperty('config')
  })

  it('a request past suggest shows exactly what a yes turns on, and the floor', () => {
    const { g, events } = gate()
    g.setRequested('act-within-rules')
    const asked = events[0] as Extract<GateEvent, { type: 'asked' }>
    expect(asked.request.line).toBe('[y/n] let your daemon act at act-within-rules? it stays at watch until you say yes')
    expect(asked.request.detail).toContain('autonomy watch -> act-within-rules')
    expect(asked.request.detail).toContain('pair.jsonc rules')
    expect(asked.request.detail).toMatch(/never approved/)
    expect(asked.request.actions.map((a) => a.key)).toEqual(['y', 'n'])
  })

  it('reading the same level again announces nothing', () => {
    const { g, events } = gate()
    g.setRequested('suggest')
    g.setRequested('suggest')
    g.setRequested('watch')
    g.setRequested('watch')
    expect(events.map((e) => e.type === 'changed' ? e.line.split(':')[0] : e.type)).toEqual(['autonomy watch -> suggest', 'autonomy suggest -> watch'])
  })

  it('lowering from a confirmed act-within-rules to act-on-key keeps act-on-key confirmed, not the higher level', () => {
    const file = join(dir, 'confirmed.json')
    const { g } = gate(file)
    g.setRequested('act-within-rules')
    g.confirm('autonomy', 'n1', true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ autonomy: 'act-within-rules' })
    g.setRequested('act-on-key')
    expect(g.autonomy()).toBe('act-on-key')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ autonomy: 'act-on-key' })
    // Back up to act-within-rules: asks again.
    g.setRequested('act-within-rules')
    expect(g.autonomy()).toBe('act-on-key')
    expect(g.requests()).toHaveLength(1)
    // A hold-down (no consent yet) is not the person lowering it: what they confirmed stands.
    g.setRequested('watch', { keepConfirmed: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ autonomy: 'act-on-key' })
    g.setRequested('act-on-key')
    expect(g.autonomy()).toBe('act-on-key')
  })

  it('a daemon started at a level applies it at once, and a nonce is random by default', () => {
    const events: GateEvent[] = []
    const g = new PairGate({ file: null, onEvent: (e) => events.push(e) }, 'act-within-rules')
    expect(g.autonomy()).toBe('act-within-rules')
    g.setRequested('watch')
    g.setRequested('act-on-key')
    const request = g.requests()[0]!
    expect(request.nonce).toMatch(/^[A-Za-z0-9_-]{12}$/)
    expect(request.at).toBeGreaterThan(0)
    expect(g.confirm('autonomy', 'guess', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
  })
})

describe('the answer', () => {
  it('names only the two kinds, and only the nonce that is waiting', () => {
    const { g } = gate()
    expect(g.confirm('everything', 'n1', true)).toEqual({ ok: false, error: 'UNKNOWN_KIND' })
    expect(g.confirm('rules', 'n1', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
    g.setRequested('act-on-key')
    expect(g.confirm('rules', 'n1', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
    expect(g.confirm('autonomy', 'n1', true)).toEqual({ ok: true, kind: 'autonomy' })
    expect(g.confirm('autonomy', 'n1', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
  })
})

describe('pair.jsonc', () => {
  it('a second file that asks for more replaces the first request', () => {
    const { g, events } = gate()
    g.rules(load({ rules: [RULE] }))
    g.rules(load({ model: true }))
    expect(events.map((e) => e.type)).toEqual(['asked', 'dropped', 'asked'])
    expect((events[1] as Extract<GateEvent, { type: 'dropped' }>).reason).toBe('replaced')
    expect(g.requests()).toEqual([expect.objectContaining({ kind: 'rules', nonce: 'n2' })])
    expect(g.requests()[0]!.line).toContain('until you say yes, none of it')
  })

  it('while a new file waits, the one confirmed before applies — and says so', () => {
    const { g } = gate()
    const first = load({ rules: [RULE] })
    g.rules(first)
    g.confirm('rules', 'n1', true)
    expect(g.rules(load({ rules: [RULE, RULE] }))).toBe(first.config)
    expect(g.requests()[0]!.line).toContain('until you say yes, what you confirmed before')
  })

  it('the confirmed file coming back while another waits drops the request and keeps the rules without a second announcement', () => {
    const { g, events } = gate()
    const confirmed = load({ rules: [RULE] })
    g.rules(confirmed)
    g.confirm('rules', 'n1', true)
    events.length = 0
    g.rules(load({ model: true }))
    expect(g.rules({ config: parsePairConfig(confirmed.text, '/home/me'), text: confirmed.text })).toEqual(confirmed.config)
    expect(events.map((e) => e.type)).toEqual(['asked', 'dropped'])
    expect(g.requests()).toEqual([])
  })

  it('a file with no text but rules in its config still asks, showing no text', () => {
    const { g, events } = gate()
    const config = parsePairConfig(text({ rules: [RULE] }), '/h')
    g.rules({ config, text: null })
    const asked = events[0] as Extract<GateEvent, { type: 'asked' }>
    expect(asked.request.detail).toBe('pair.jsonc (1 rule, model off):\n')
  })

  it('a hash kept in the store must look like one to count', () => {
    const file = join(dir, 'confirmed.json')
    writeFileSync(file, JSON.stringify({ autonomy: 'root', rules: 'not-a-hash' }))
    const { g, events } = gate(file)
    g.setRequested('act-on-key')
    expect(events[0]!.type).toBe('asked')
    g.rules(load({ rules: [RULE] }))
    expect(events[1]!.type).toBe('asked')
    writeFileSync(file, JSON.stringify({ rules: hashConfig(text({ rules: [RULE] })) }))
    const again = gate(file)
    again.g.rules(load({ rules: [RULE] }))
    expect(again.events.map((e) => e.type)).toEqual(['changed'])
  })
})

describe('the confirmation store', () => {
  it('is created with its folder, and a store that cannot be written warns and keeps the level', () => {
    const nested = join(dir, 'a', 'b', 'confirmed.json')
    const { g } = gate(nested)
    g.setRequested('act-on-key')
    g.confirm('autonomy', 'n1', true)
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ autonomy: 'act-on-key', rules: null, epoch: null })

    const blocker = join(dir, 'file')
    writeFileSync(blocker, 'x')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = gate(join(blocker, 'confirmed.json'))
    broken.g.setRequested('act-on-key')
    expect(broken.g.confirm('autonomy', 'n1', true)).toEqual({ ok: true, kind: 'autonomy' })
    expect(broken.g.autonomy()).toBe('act-on-key')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[pair\] could not keep what was confirmed: /))
  })
})

describe('consent: a yes holds only under the consent it was given in', () => {
  // The zoo's dial is a request, and anything local can move it. A yes to a level was given under one
  // answer to the consent question (the zoo's `consent.at`, the epoch). Once the person has answered it
  // again — taken it back and given it again, maybe while this daemon was not reading, and the dial raised
  // after — the old yes must not carry the daemon back up: it steps down to suggest and asks again.
  it('the same consent read again keeps the yes; a new one voids it, steps down and asks again', () => {
    const file = join(dir, 'confirmed.json')
    const { g, events } = gate(file)
    g.setRequested('act-on-key', { epoch: 'A' })
    g.confirm('autonomy', 'n1', true)
    expect(g.autonomy()).toBe('act-on-key')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autonomy: 'act-on-key', rules: null, epoch: 'A' })
    g.setRequested('act-on-key', { epoch: 'A' })
    // Revoked and given again (a new `at`), the dial raised again by something: not the old yes.
    events.length = 0
    g.setRequested('act-on-key', { epoch: 'B' })
    expect(g.autonomy()).toBe('suggest')
    expect(g.requests()).toEqual([expect.objectContaining({ kind: 'autonomy', level: 'act-on-key', nonce: 'n2' })])
    expect(events.map((e) => e.type)).toEqual(['changed', 'asked'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ autonomy: null, rules: null, epoch: 'B' })
    // The person says yes again, under B: that one holds, across a restart too.
    g.confirm('autonomy', 'n2', true)
    const again = gate(file)
    again.g.setRequested('act-on-key', { epoch: 'B' })
    expect(again.g.autonomy()).toBe('act-on-key')
    expect(again.g.requests()).toEqual([])
    // Answered again with the dial back at watch (a yes starts there): one step, straight down.
    again.events.length = 0
    again.g.setRequested('watch', { epoch: 'C' })
    expect(again.g.autonomy()).toBe('watch')
    expect(again.events.map((e) => e.type === 'changed' ? e.line.split(':')[0] : e.type)).toEqual(['autonomy act-on-key -> watch'])
  })

  it('a hold-down (no consent yet, the zoo unreadable) is not a new answer; a request waiting under the old one goes', () => {
    const { g, events } = gate()
    g.setRequested('act-on-key', { epoch: 'A' })
    g.confirm('autonomy', 'n1', true)
    g.setRequested('watch', { keepConfirmed: true, epoch: null })
    g.setRequested('act-on-key', { epoch: 'A' })
    expect(g.autonomy()).toBe('act-on-key')
    g.setRequested('suggest', { epoch: 'A' })
    g.setRequested('act-within-rules', { epoch: 'A' })
    expect(g.requests().map((r) => r.nonce)).toEqual(['n2'])
    events.length = 0
    g.setRequested('act-within-rules', { epoch: 'B' })
    expect(events.map((e) => e.type)).toEqual(['dropped', 'asked'])
    expect(g.confirm('autonomy', 'n2', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
    expect(g.autonomy()).toBe('suggest')
  })

  it('a yes kept before epochs were kept counts under no consent: asked once more', () => {
    const file = join(dir, 'confirmed.json')
    writeFileSync(file, JSON.stringify({ autonomy: 'act-on-key', rules: null }))
    const { g } = gate(file)
    g.setRequested('act-on-key')
    expect(g.autonomy()).toBe('act-on-key')           // no epoch said: as before
    const fresh = gate(file)
    fresh.g.setRequested('act-on-key', { epoch: 'A' })
    expect(fresh.g.autonomy()).toBe('watch')
    expect(fresh.g.requests()).toHaveLength(1)
    // An epoch in the store that is not one (too long) is none: the yes it came with is asked again.
    writeFileSync(file, JSON.stringify({ autonomy: 'act-on-key', rules: null, epoch: 'x'.repeat(65) }))
    const odd = gate(file)
    odd.g.setRequested('act-on-key', { epoch: 'x'.repeat(65) })
    expect(odd.g.autonomy()).toBe('watch')
    expect(odd.g.requests()).toHaveLength(1)
  })

  // Every order of up to four of these, on a fresh gate: reads of the zoo under two consents (A, then B:
  // answered again), a hold-down, and the person's yes or no to whatever waits.
  type Step = 'A:suggest' | 'A:act-on-key' | 'B:act-on-key' | 'hold' | 'yes' | 'no'
  const STEPS: Step[] = ['A:suggest', 'A:act-on-key', 'B:act-on-key', 'hold', 'yes', 'no']
  const orders = (n: number): Step[][] => n === 0 ? [[]] : orders(n - 1).flatMap((o) => STEPS.map((s) => [...o, s]))
  const ALL = [1, 2, 3, 4].flatMap(orders)

  it(`every order of up to four steps: above suggest only by a yes under the consent read last, and a read again moves nothing (${ALL.length})`, () => {
    for (const steps of ALL) {
      const { g, events } = gate(null)
      let epoch: string | null = null        // the consent of the last read that was not a hold-down
      let yesSince = false                   // a yes to a level since that consent was first read
      let last: (() => void) | null = null
      for (const step of steps) {
        if (step === 'yes' || step === 'no') {
          const waiting = g.requests().find((r) => r.kind === 'autonomy')
          if (waiting) {
            g.confirm('autonomy', waiting.nonce, step === 'yes')
            if (step === 'yes') yesSince = true
          }
          last = null
          continue
        }
        const read = step === 'hold'
          ? () => g.setRequested('watch', { keepConfirmed: true, epoch: null })
          : () => g.setRequested(step.slice(2) as 'suggest' | 'act-on-key', { epoch: step.slice(0, 1) })
        if (step !== 'hold' && step.slice(0, 1) !== epoch) { epoch = step.slice(0, 1); yesSince = false }
        read()
        last = read
      }
      const why = steps.join(', ')
      if (g.autonomy() === 'act-on-key') expect(yesSince, why).toBe(true)
      expect(['watch', 'suggest', 'act-on-key'], why).toContain(g.autonomy())
      // What was asked for last caps the level (a hold-down holds it at watch).
      const lastRead = [...steps].reverse().find((s) => s !== 'yes' && s !== 'no')
      if (lastRead === 'hold') expect(g.autonomy(), why).toBe('watch')
      if (lastRead === 'A:suggest') expect(g.autonomy(), why).toBe('suggest')
      // The last read delivered again: nothing is announced, nothing moves.
      if (last) {
        const before = { level: g.autonomy(), requests: g.requests() }
        const count = events.length
        last()
        expect({ level: g.autonomy(), requests: g.requests() }, why).toEqual(before)
        expect(events.length, why).toBe(count)
      }
    }
  })
})
