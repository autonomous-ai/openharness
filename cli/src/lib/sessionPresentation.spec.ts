import { expect, it } from 'vitest'
import { cloudAgentFrame, cloudHarnessIn, cloudPresentation } from './cloudAgents.js'
import { copySessionValue, measureSessionValue } from './sessionFactValues.js'
import { readSessionFacts } from './sessionFactsAdmission.js'
import { encodeSessionFacts, hasSessionFact, readSessionFact, retainSessionFacts, retainedSessionFrame, sessionFactsWire,
  sessionFrame, sessionOwnerCreatedAt, sessionOwnerFactory, sessionOwnerId, type SessionFacts } from './sessionPresentation.js'
import { SESSION_OWNER_LIMITS } from './sessionOwnerWire.js'

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({ id: 'session', engine: 'fixture', name: 'Name',
  createdAt: '0', updatedAt: '0', ...over })
const admit = (value: unknown) => readSessionFacts(value, SESSION_OWNER_LIMITS.catalogue, factory => factory === 'fixture')

it.each([undefined, {}, { note: 'opaque', app: { value: 'app-name' }, turn: 'opaque-turn', work: ['opaque-work'] }])
('roundtrips absent, empty and opaque app values without exposing authority or retaining the caller object: %j', app => {
  const input = facts(app === undefined ? {} : { app }), before = structuredClone(input)
  const admitted = admit(input), retained = retainSessionFacts(admitted.facts)
  if (app) (app as Record<string, unknown>).injected = 'after admission'
  input.name = 'Changed'
  expect(sessionFactsWire(retained)).toEqual(before)
  expect(encodeSessionFacts(sessionFactsWire(retained))).toBe(encodeSessionFacts(before))
  expect(retainedSessionFrame(retained)).toEqual(sessionFrame(before))
  expect(sessionOwnerId(retained)).toBe('session'); expect(sessionOwnerFactory(retained)).toBe('fixture')
  expect(sessionOwnerCreatedAt(retained)).toBe('0'); expect(readSessionFact(retained, 'name')).toBe('Name')
  expect(hasSessionFact(retained, 'app')).toBe(app !== undefined)
  expect(Object.keys(retained)).toEqual(Object.keys(before.app ?? {}))
  expect(JSON.stringify(retained)).toBe(JSON.stringify(before.app ?? {}))
  const descriptors = Object.getOwnPropertyDescriptors(retained)
  for (const key of Object.getOwnPropertySymbols(retained)) expect(Object.getOwnPropertyDescriptor(retained, key)?.enumerable).toBe(false)
  expect(descriptors.name).toBeUndefined()
})

it('shares protocol defaults without freezing native values and keeps absent versus null optional fields', () => {
  const noApp = facts(), empty = sessionFrame(noApp), explicit = sessionFrame(facts({ claudeHome: null, workspace: 'workspace' }))
  expect(empty).not.toHaveProperty('claudeHome'); expect(explicit).toHaveProperty('claudeHome', null)
  expect(empty).not.toHaveProperty('workspace'); expect(explicit).toHaveProperty('workspace', 'workspace')
  expect(empty.launch).toBe(sessionFrame(noApp).launch); expect(Object.isFrozen(empty.launch)).toBe(true)
  const launch = { state: 'starting' as const }, native = facts({ launch })
  expect(sessionFrame(native).launch).toBe(launch); expect(Object.isFrozen(launch)).toBe(false)
  const order: string[] = []
  const frame = sessionFrame(native, () => { order.push('last fenced app read'); return { viewerUrl: 'current' } })
  expect(frame.viewerUrl).toBe('current'); expect(order).toEqual(['last fenced app read'])
})

it('retains standard activity in private slots while public readers and inverse encoding preserve all fields', () => {
  const input = facts({ activity: { state: 'working', epoch: 'run', revision: 7, validForMs: 12 },
    turn: { fullText: 'Answer', card: { recap: 'Recap', text: 'Detail' } }, work: { text: 'Doing', processing: {} } })
  const retained = retainSessionFacts(admit(input).facts)
  expect(sessionFactsWire(retained)).toEqual(input)
  expect(readSessionFact(retained, 'activity')).toEqual(input.activity)
  expect(retainedSessionFrame(retained)).toEqual(sessionFrame(input))
  expect(Object.keys(retained)).toEqual([])
  expect(() => sessionOwnerId(Object.create(retained))).toThrow('SESSION_OWNER_INVALID')
  expect(() => sessionOwnerFactory(Object.create(retained))).toThrow('SESSION_OWNER_INVALID')
  expect(() => sessionOwnerCreatedAt(Object.create(retained))).toThrow('SESSION_OWNER_INVALID')
})

it('preserves every standard optional presentation value, including nulls and native-style lifecycle values', () => {
  const all = facts({ sessionId: 'session', title: 'Title', nameChosen: true, status: 'offline',
    activity: { state: 'unknown', epoch: 'run', revision: 0, validForMs: 0 }, closePlan: { state: 'waiting', detail: 'Stopping' },
    closeSupported: true, launch: { state: 'held', service: 'engine', detail: 'Starting' }, identityHold: 'Held', namedState: 'Unavailable',
    lastOpenedAt: null, tokenUsage: { totalTokens: 0 }, outputStats: null, tmuxPane: null,
    terminal: { available: false, primary: '', runtimes: [] }, selectedModel: 'model', workspace: 'workspace', grid: null,
    codexHome: null, claudeHome: 'home', launchArgs: ['--flag'], project: null, gitContext: {},
    dsh: null, dshName: 'Name', viewerUrl: null, viewerName: 'Viewer', verdict: {},
    forkedFrom: { agentId: 'parent', name: 'Parent' }, parentAgentId: null, startedBy: 'agent', forkable: true,
    resumeMode: 'shell', permissionMode: null, bypassPermission: false, namedAgent: null, waitingFor: 'engine',
    turn: { fullText: '', card: null }, work: { snapshot: true, elapsedSeconds: 0, processing: {} },
    app: { project: { label: 'opaque' }, gitContext: null, verdict: null, dsh: null, dshName: 'Override', viewerUrl: 'https://example.test', viewerName: null } })
  for (const input of [all, facts({ activity: null, launch: { state: 'failed', error: 'FAILED' }, closePlan: null,
    forkedFrom: null, resumeMode: 'fresh', startedBy: null, waitingFor: null, bypassPermission: null }),
    facts({ closePlan: { state: 'failed' }, launch: { state: 'ready' }, work: {} })]) {
    const retained = retainSessionFacts(admit(input).facts)
    expect(sessionFactsWire(retained)).toEqual(input)
    expect(retainedSessionFrame(retained)).toEqual(sessionFrame(input))
  }
  const absent = retainSessionFacts(admit(facts()).facts)
  expect(readSessionFact(absent, 'app')).toBeUndefined(); expect(readSessionFact(absent, 'activity')).toBeUndefined()
  expect(readSessionFact(retainSessionFacts(admit(facts({ activity: null })).facts), 'activity')).toBeNull()
})

it.each([
  ['identity', [{ id: '' }, { id: 'i'.repeat(81) }, { engine: 'e'.repeat(81) }, { name: 'n'.repeat(121) }, { createdAt: 'invalid' },
    { updatedAt: 'invalid' }, { extra: true }, { sessionId: 'native-alias' }, { tmuxPane: '%1' }]],
  ['simple fields', [{ workspace: null }, { title: 1 }, { nameChosen: 'true' }, { grid: [] }, { gitContext: null }, { status: null },
    { launchArgs: 'flag' }, { startedBy: 'user' }, { waitingFor: 'other' }, { bypassPermission: 1 }, { resumeMode: 'invalid' }]],
  ['launch', [null, { state: 'other' }, { state: 'failed', error: 3 }, { state: 'held', service: 'engine' },
    { state: 'held', service: 3, detail: 'Wait' }, { state: 'held', service: 'engine', detail: null }].map(launch => ({ launch }))],
  ['activity and turns', [{ activity: { state: 'other', epoch: 'e', revision: 0, validForMs: 0 } }, { activity: { state: 'idle', epoch: 3, revision: 0, validForMs: 0 } },
    { turn: { fullText: 'Text', card: {} } }, { work: { elapsedSeconds: -1 } }]],
  ['close and ancestry', [{ closePlan: 'waiting' }, { closePlan: { state: 'other' } }, { closePlan: { state: 'failed', detail: 3 } },
    { forkedFrom: [] }, { forkedFrom: { agentId: 'parent' } }, { forkedFrom: { agentId: 3, name: 'Parent' } }, { forkedFrom: { agentId: 'parent', name: 3 } }]],
  ['terminal authority', [null, { available: true, primary: '', runtimes: [] }, { available: false, primary: '%1', runtimes: [] },
    { available: false, primary: '', runtimes: null }, { available: false, primary: '', runtimes: ['pane'] }].map(terminal => ({ terminal }))],
  ['opaque overrides', [{ app: null }, { app: { viewerName: 3 } }, { app: { project: 'project' } }]],
] as const)('rejects invalid %s without normalizing away authority or presence', (_group, values) => {
  for (const value of values) expect(() => admit({ ...facts(), ...value })).toThrow('SESSION_OWNER_INVALID')
  expect(() => admit([])).toThrow('SESSION_OWNER_INVALID')
  expect(() => admit(facts({ engine: 'other' }))).toThrow('SESSION_OWNER_INVALID')
})

it.each(['id', 'engine', 'name', 'sessionId', 'createdAt', 'updatedAt', 'terminal', 'userId', '__proto__', 'prototype', 'constructor', 'toJSON'])
('refuses app authority/prototype override %s before assignment', key => {
  const app = JSON.parse(`{${JSON.stringify(key)}:"spoofed"}`)
  expect(() => admit(facts({ app }))).toThrow()
})

it('rejects accessors, custom prototypes, proxies, holes and non-JSON values without invoking their code', () => {
  let invoked = 0
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return 'value' } })
  const toJSON = { toJSON() { invoked++; return {} } }
  const proxy = new Proxy({}, { ownKeys() { invoked++; return [] } })
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  for (const value of [getter, toJSON, proxy, cycle, Object.create({ inherited: true }), new Date(), new Array(1),
    { bad: undefined }, { bad: NaN }, { bad: Infinity }, { bad: 1n }, { bad: Symbol() }, { [Symbol('hidden')]: 'value' },
    Object.defineProperty({}, 'hidden', { value: 'value' })]) {
    expect(() => copySessionValue(value, SESSION_OWNER_LIMITS.catalogue)).toThrow()
  }
  expect(invoked).toBe(0)
  const value = { text: 'escaped\0\ud800😀', values: [null, false, true, -1.2e+20] }
  const detached = copySessionValue(value, SESSION_OWNER_LIMITS.catalogue)
  expect(detached.value).toEqual(value); expect(detached.value).not.toBe(value)
  expect(detached.charge.bytes).toBe(Buffer.byteLength(JSON.stringify(value)))
  expect(measureSessionValue(value, SESSION_OWNER_LIMITS.catalogue)).toEqual(detached.charge)
  const extra = ['valid'] as unknown[] & { extra?: string }; extra.extra = 'not JSON array data'
  const sparse = new Array(3); sparse[2] = 'gap'
  for (const value of [extra, sparse]) expect(() => copySessionValue(value, SESSION_OWNER_LIMITS.catalogue)).toThrow('SESSION_OWNER_INVALID')
  expect(() => copySessionValue({ a: { b: {} } }, { ...SESSION_OWNER_LIMITS.catalogue, depth: 2 })).toThrow('SESSION_OWNER_LIMIT')
})

it.each(['working', 'starting', 'failed', 'needs_input', 'idle', 'stopped'] as const)
('keeps actual %s provider construction inside the reviewed joint shape coefficients and public values', state => {
  const source = cloudHarnessIn({ agentId: 'cloud_a', agent: 'fo', name: '\0'.repeat(120), state,
    activity: '\0'.repeat(200), repository: '\0'.repeat(200), branch: '\0'.repeat(200),
    providerStatus: { status: '\0'.repeat(200), detail: '\0'.repeat(200) },
    links: Array.from({ length: 8 }, () => ({ label: '\0'.repeat(80), url: 'https://' + '\0'.repeat(2040) })),
    messages: 0, said: '\0'.repeat(4000), card: { recap: '\0'.repeat(2000), text: '\0'.repeat(2000) },
    createdAt: '0', updatedAt: '0' })!
  const presentation = cloudPresentation(source)
  const admitted = readSessionFacts(presentation, SESSION_OWNER_LIMITS.catalogue, factory => factory === 'fo')
  const retained = retainSessionFacts(admitted.facts), rawBytes = Buffer.byteLength(JSON.stringify(source))
  expect(retainedSessionFrame(retained)).toEqual(cloudAgentFrame(source))
  expect(encodeSessionFacts(sessionFactsWire(retained))).toBe(encodeSessionFacts(presentation))
  // Analytic old-valid input bounds, not sample-derived heap quotas. The admitted constructor must stay within them.
  expect(admitted.charge.bytes).toBeLessThanOrEqual(Math.ceil(503 * (rawBytes + 1) / 175))
  expect(admitted.charge.objects).toBeLessThanOrEqual(Math.ceil(9 * (rawBytes + 1) / 176) + 2)
  expect(admitted.charge.properties).toBeLessThanOrEqual(Math.ceil(32 * (rawBytes + 1) / 176) + 2)
  expect(admitted.charge.slots).toBeLessThanOrEqual(Math.ceil(8 * (rawBytes + 1) / 419))
})
