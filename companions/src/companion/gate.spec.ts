/**
 * What the person has said yes to (pair/gate.ts): a step up the autonomy dial past `suggest`, and pair.jsonc's
 * rules, take effect only after a confirmation at a window; every change is announced; what was confirmed
 * survives a restart and a lowering has to be confirmed again to be undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PairGate, pairingFrom, type GateEvent } from './gate.js'
import { PairConfigFile } from './rules.js'
import { PairBrain } from './brain.js'
import { PairVoice } from './voice.js'
import { ARM_MS, ShownLines } from './shown.js'
import type { PairFleet } from './fleet.js'
import type { PairTriage } from './triage.js'
import type { DaemonSay } from './protocol.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pair-gate-')); vi.useFakeTimers({ now: 1_000_000 }) })
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })

function gate(file: string | null = join(dir, 'confirmed.json')) {
  const events: GateEvent[] = []
  let n = 0
  const g = new PairGate({ file, onEvent: (e) => events.push(e), newNonce: () => `n${++n}` }, 'watch')
  return { g, events }
}

describe('the autonomy dial', () => {
  it('lowers at once, rises to suggest at once, and waits for a yes past suggest', () => {
    const { g, events } = gate()
    g.setRequested('suggest')
    expect(g.autonomy()).toBe('suggest')
    g.setRequested('act-within-rules')
    expect(g.autonomy()).toBe('suggest')
    expect(g.requests()).toEqual([expect.objectContaining({ id: 'confirm:autonomy:n1', kind: 'autonomy', nonce: 'n1', level: 'act-within-rules',
      detail: expect.stringContaining('autonomy suggest -> act-within-rules') })])
    expect(g.confirm('autonomy', 'wrong', true)).toMatchObject({ ok: false, error: 'STALE_CONFIRM' })
    expect(g.confirm('autonomy', 'n1', true)).toEqual({ ok: true, kind: 'autonomy' })
    expect(g.autonomy()).toBe('act-within-rules')
    expect(g.requests()).toEqual([])
    g.setRequested('watch')
    expect(g.autonomy()).toBe('watch')
    expect(events.map((e) => e.type === 'changed' ? e.line.split(':')[0] : e.type)).toEqual([
      'autonomy watch -> suggest', 'asked', 'autonomy suggest -> act-within-rules', 'autonomy act-within-rules -> watch'])
  })

  it('a no keeps the level; a newer request replaces the one waiting', () => {
    const { g, events } = gate()
    g.setRequested('act-on-key')
    g.setRequested('act-within-rules')
    expect(g.requests().map((r) => r.level)).toEqual(['act-within-rules'])
    expect(events.filter((e) => e.type === 'dropped')).toEqual([expect.objectContaining({ reason: 'replaced' })])
    expect(g.confirm('autonomy', 'n2', false)).toEqual({ ok: true, kind: 'autonomy' })
    expect(g.autonomy()).toBe('watch')
    // Back down to suggest takes the request away: nothing waits for a level nobody asks for.
    g.setRequested('act-on-key')
    g.setRequested('suggest')
    expect(g.requests()).toEqual([])
    expect(g.autonomy()).toBe('suggest')
  })

  it('what was confirmed survives a restart (0600); lowering below it has to be confirmed again to go back up', () => {
    const first = gate()
    first.g.setRequested('act-on-key')
    first.g.confirm('autonomy', 'n1', true)
    expect(statSync(join(dir, 'confirmed.json')).mode & 0o777).toBe(0o600)
    const again = gate()
    again.g.setRequested('act-on-key')
    expect(again.g.autonomy()).toBe('act-on-key')
    expect(again.g.requests()).toEqual([])
    // Held down by something that is not the person's dial (no consent yet, the zoo unreadable): kept.
    again.g.setRequested('watch', { keepConfirmed: true })
    expect(again.g.autonomy()).toBe('watch')
    again.g.setRequested('act-on-key')
    expect(again.g.autonomy()).toBe('act-on-key')
    again.g.setRequested('suggest')
    again.g.setRequested('act-on-key')
    expect(again.g.autonomy()).toBe('suggest')
    expect(again.g.requests()).toHaveLength(1)
  })
})

describe('pair.jsonc', () => {
  const RULES = '{ "rules": [{ "name": "tests", "question": "npm test", "choice": "Yes" }] }'

  it('runs a file\'s rules only once that exact text is confirmed; a change asks again; nothing in it applies at once', () => {
    const path = join(dir, 'pair.jsonc')
    const file = new PairConfigFile(path)
    const { g, events } = gate()
    expect(g.rules(file.load())).toEqual({ model: false, rules: [], learn: { borrow: false, export: [], agentsMd: [] } })
    writeFileSync(path, RULES)
    expect(g.rules(file.load()).rules).toEqual([])
    const [request] = g.requests()
    expect(request).toMatchObject({ kind: 'rules', detail: expect.stringContaining('"name": "tests"') })
    expect(g.confirm('rules', request!.nonce, true)).toEqual({ ok: true, kind: 'rules' })
    expect(g.rules(file.load()).rules.map((r) => r.name)).toEqual(['tests'])
    // Written again (a script adding a rule): the confirmed rules stay until the new text is confirmed.
    writeFileSync(path, RULES.replace('"tests"', '"tests", "harness": "*"').replace(']', ', { "question": ".", "choice": "Yes" }]'))
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    expect(g.rules(file.load()).rules.map((r) => r.name)).toEqual(['tests'])
    expect(g.requests()).toHaveLength(1)
    // Emptied: fewer rules is never a question.
    writeFileSync(path, '{}')
    utimesSync(path, new Date(), new Date(Date.now() + 10_000))
    expect(g.rules(file.load()).rules).toEqual([])
    expect(g.requests()).toEqual([])
    expect(events.filter((e) => e.type === 'changed').map((e) => e.type === 'changed' && e.line)).toEqual([
      'pair.jsonc now applies here: 1 rule, model off.', 'pair.jsonc now applies here: 0 rules, model off.'])
  })

  it('learning\'s opt-ins (borrow, export, agentsMd) wait for the same yes', () => {
    const path = join(dir, 'pair.jsonc')
    const file = new PairConfigFile(path)
    const { g } = gate()
    writeFileSync(path, '{ "learn": { "borrow": true, "export": ["claude"] } }')
    expect(g.rules(file.load()).learn).toEqual({ borrow: false, export: [], agentsMd: [] })
    const [request] = g.requests()
    expect(request).toMatchObject({ kind: 'rules', line: expect.stringContaining('learn borrow + export claude') })
    g.confirm('rules', request!.nonce, true)
    expect(g.rules(file.load()).learn).toEqual({ borrow: true, export: ['claude'], agentsMd: [] })
  })

  it('a confirmed file needs no yes after a restart', () => {
    const path = join(dir, 'pair.jsonc')
    writeFileSync(path, RULES)
    const first = gate()
    first.g.rules(new PairConfigFile(path).load())
    first.g.confirm('rules', first.g.requests()[0]!.nonce, true)
    const again = gate()
    expect(again.g.rules(new PairConfigFile(path).load()).rules).toHaveLength(1)
    expect(again.g.requests()).toEqual([])
  })
})

describe('the brain asks, and takes the answer only from a window that showed the request', () => {
  it('says the request whatever the voice\'s limits, lists it in daemon_state with the dial, and confirms on a shown yes', async () => {
    const frames: Array<Record<string, unknown>> = []
    const shown = new ShownLines(Date.now)
    const events: GateEvent[] = []
    let brain: PairBrain | null = null
    const g2 = new PairGate({ file: null, onEvent: (e) => { events.push(e); brain?.onGate(e) }, newNonce: () => 'k1' }, 'suggest')
    const send = shown.sender((f) => frames.push(f), () => brain?.clientIds() ?? [])
    const fleet = { start: () => {}, stop: () => {}, machines: () => [{ machineId: 'machine-a', name: 'desk', status: 'ok', local: true }], harnesses: () => [], find: () => null } as unknown as PairFleet
    brain = new PairBrain({
      pairing: { enabled: () => true, pairedDaemon: () => 'tim' }, fleet, triage: {} as PairTriage, voice: new PairVoice({ sendLocal: send, now: Date.now }),
      sendLocal: send, sendLocalTo: shown.senderTo((_c, f) => { frames.push(f); return true }), shown, gate: g2,
      autonomy: () => g2.autonomy(), answer: async () => ({ ok: true }), now: Date.now,
    })
    brain.clientAttached('local:window')
    g2.setRequested('act-on-key')
    const say = frames.filter((f) => f.type === 'daemon_say').map((f) => f.payload as DaemonSay).at(-1)!
    expect(say).toMatchObject({ id: 'confirm:autonomy:k1', mood: 'ask', confirm: { kind: 'autonomy', nonce: 'k1' }, detail: expect.stringContaining('act-on-key') })
    await vi.advanceTimersByTimeAsync(200)
    const state = frames.filter((f) => f.type === 'daemon_state').at(-1)!.payload as Record<string, unknown>
    expect(state).toMatchObject({ autonomy: 'suggest', autonomyRequested: 'act-on-key', confirms: [expect.objectContaining({ id: 'confirm:autonomy:k1', level: 'act-on-key' })] })
    const replies: Array<Record<string, unknown>> = []
    const answer = (conn: string, accept = true) => brain!.onConfirm(conn, { requestId: 'c', kind: 'autonomy', nonce: 'k1', accept }, (f) => replies.push(f.payload as Record<string, unknown>))
    answer('local:window')
    expect(replies.at(-1)).toMatchObject({ ok: false, error: 'NOT_SHOWN' })
    answer('local:tool')
    expect(replies.at(-1)).toMatchObject({ ok: false, error: 'UI_ONLY' })
    brain.onShown('local:window', { id: 'confirm:autonomy:k1' })
    answer('local:window')
    expect(replies.at(-1)).toMatchObject({ ok: false, error: 'TOO_SOON' })
    expect(g2.autonomy()).toBe('suggest')
    await vi.advanceTimersByTimeAsync(ARM_MS)
    answer('local:window')
    expect(replies.at(-1)).toEqual({ requestId: 'c', kind: 'autonomy', nonce: 'k1', ok: true, accepted: true })
    expect(g2.autonomy()).toBe('act-on-key')
    // Announced, and the badge follows.
    expect(frames.filter((f) => f.type === 'daemon_say').map((f) => (f.payload as DaemonSay).line).at(-1)).toMatch(/^autonomy suggest -> act-on-key/)
    await vi.advanceTimersByTimeAsync(200)
    expect(frames.filter((f) => f.type === 'daemon_state').at(-1)!.payload).toMatchObject({ autonomy: 'act-on-key', confirms: [] })
    expect(events.map((e) => e.type)).toEqual(['asked', 'changed'])
  })
})

describe('a guest window\'s dial', () => {
  it('counts only from a window bound to this machine, and is a request like the zoo\'s', () => {
    const guest: Array<string | null> = []
    const pairs: Array<string | null> = []
    const consent: boolean[] = []
    const fleet = { start: () => {}, stop: () => {}, machines: () => [], harnesses: () => [], find: () => null } as unknown as PairFleet
    const brain = new PairBrain({
      pairing: { enabled: () => false, pairedDaemon: () => null }, fleet, triage: {} as PairTriage, voice: new PairVoice({ sendLocal: () => {}, now: Date.now }),
      sendLocal: () => {}, sendLocalTo: () => true, answer: async () => ({ ok: true }), now: Date.now,
      onGuestAutonomy: (level) => guest.push(level), onGuestPair: (id) => pairs.push(id), onGuestConsent: (watching) => consent.push(watching),
    })
    brain.onPresence('local:relayed', { active: true, pair: 'tim', autonomy: 'act-within-rules', consent: true }, { ui: false })
    expect([guest, pairs, consent]).toEqual([[], [], []])
    brain.onPresence('local:window', { active: true, pair: 'tim', autonomy: 'act-within-rules', consent: true }, { ui: true })
    expect([guest, pairs, consent]).toEqual([['act-within-rules'], ['tim'], [true]])
    brain.onPresence('local:window', { consent: 'yes' }, { ui: true })
    expect(consent).toEqual([true, false])
  })
})

describe('first-day consent', () => {
  it('nothing is paired (the sensor stays off) and the dial asks for watch until the person said yes', () => {
    const guest = { pair: 'tim', autonomy: 'suggest' as const, consent: false }
    expect(pairingFrom({ known: true, pair: 'tim', autonomy: 'act-on-key', consent: false }, guest, 'watch')).toEqual({ pair: null, autonomy: 'watch', consented: false, epoch: null })
    expect(pairingFrom({ known: true, pair: 'tim', autonomy: 'act-on-key', consent: true }, guest, 'watch')).toEqual({ pair: 'tim', autonomy: 'act-on-key', consented: true, epoch: null })
    // The consent a yes belongs to: the zoo's answer's time.
    expect(pairingFrom({ known: true, pair: 'tim', autonomy: 'act-on-key', consent: true, consentAt: 't1' }, guest, 'watch')).toMatchObject({ consented: true, epoch: 't1' })
    // Signed out: the guest window's own answer, pair and dial.
    const unknown = { known: false, pair: null, autonomy: 'watch' as const, consent: false }
    expect(pairingFrom(unknown, guest, 'watch')).toEqual({ pair: null, autonomy: 'watch', consented: false, epoch: null })
    expect(pairingFrom(unknown, { ...guest, consent: true }, 'watch')).toEqual({ pair: 'tim', autonomy: 'suggest', consented: true, epoch: null })
    expect(pairingFrom(unknown, { pair: 'tim', autonomy: null, consent: true }, 'watch')).toEqual({ pair: 'tim', autonomy: 'watch', consented: true, epoch: null })
  })
})
