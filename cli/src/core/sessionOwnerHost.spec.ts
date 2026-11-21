import { expect, it, vi } from 'vitest'
import { emptyPorts, OWNER_FALLBACKS, type CoreApi, type CorePorts, type PortFallbacks } from './api.js'
import { createSessionOwners } from './agents/sessionOwners.js'
import { createQuestionPresentations } from './questions.js'
import { createServiceHost } from '../services/inlineHost.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SESSION_FACTS_FORMAT, encodeSessionFacts, type SessionFacts } from '../lib/sessionPresentation.js'
import { SESSION_OWNER_LIMITS, emptySessionFingerprint, sessionImageHash, type SessionOwnerCore, type SessionOwnerPort } from '../lib/sessionOwnerWire.js'

const facts: SessionFacts = { id: 'owner', engine: 'fixture', name: 'Owner', createdAt: '0', updatedAt: '0' }
const after = sessionImageHash().update(encodeSessionFacts(facts)).update(']').digest('hex')
const begin = { format: SESSION_FACTS_FORMAT, transfer: 'transfer', factory: 'fixture', before: emptySessionFingerprint(), after, count: 1 }
function fixture() {
  const ports = emptyPorts(), captured: SessionOwnerCore[] = [], stopEffects: unknown[] = []
  const owners = createSessionOwners({ factoryOwner: value => value === 'fixture' ? { kind: 'service', service: 'cloud' } : undefined,
    native: () => false, port: () => ports.cloud, whenStarting: () => null, questions: createQuestionPresentations(), limits: SESSION_OWNER_LIMITS,
    clients: { send: vi.fn(), sendCommander: vi.fn(), sendLocal: vi.fn() }, log: () => {} })
  const host = createServiceHost(ports, { maxFailures: 1, log: () => {}, bindOwners: (service, identity, current) => owners.bound({ service, identity, current }) })
  const fallback = { ...OWNER_FALLBACKS, stop: undefined } as PortFallbacks<SessionOwnerPort>
  const start = (core: CoreApi, staging: CorePorts) => {
    const door = core.owners!; captured.push(door)
    expect(door.checkpoint('fixture')).toEqual({ fingerprint: emptySessionFingerprint() })
    staging.cloud = { create: async () => ({ error: 'UNUSED' }), rename: async () => ({ error: 'UNUSED' }),
      deliver: async () => { throw new Error('synthetic failed provider') }, answer: async () => ({ ok: true }),
      stopHarness: async () => ({ deleted: true }), stop() { stopEffects.push(door.end('transfer')) } } as SessionOwnerPort
  }
  return { ports, captured, stopEffects, owners, host, fallback, start }
}

it('binds before construction and revokes before stop, without reviving an old stage for a replacement', () => {
  const f = fixture()
  try {
    f.host.start('cloud', f.start, fakeCore(), f.fallback)
    const old = f.captured[0], oldPort = f.ports.cloud as SessionOwnerPort & { stop(): void }
    expect(old.begin(begin)).toEqual({ ok: true })
    expect(old.append({ transfer: 'transfer', index: 0, rows: [{ facts }] })).toEqual({ ok: true })
    oldPort.stop()
    expect(f.stopEffects).toEqual([{ ok: false, error: 'SERVICE_UNAVAILABLE' }]); expect(f.owners.frames()).toEqual([])
    f.host.start('cloud', f.start, fakeCore(), f.fallback)
    const replacement = f.captured[1]
    expect(replacement.begin(begin)).toEqual({ ok: true })
    oldPort.stop()
    expect(old.end('transfer')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(replacement.append({ transfer: 'transfer', index: 0, rows: [{ facts }] })).toEqual({ ok: true })
    expect(replacement.end('transfer')).toEqual({ ok: true })
    expect(f.owners.frames()).toMatchObject([{ id: 'owner' }])
  } finally { f.owners.stop() }
})

it('revokes a door leaked by a failed constructor before any staged commit', () => {
  const f = fixture()
  try {
    let leaked!: SessionOwnerCore
    f.host.start('cloud', core => { leaked = core.owners!; expect(leaked.begin(begin)).toEqual({ ok: true }); throw new Error('synthetic constructor') }, fakeCore(), f.fallback)
    expect(leaked.append({ transfer: 'transfer', index: 0, rows: [{ facts }] })).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(leaked.end('transfer')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(f.ports.cloud).toBeNull(); expect(f.owners.frames()).toEqual([])
  } finally { f.owners.stop() }
})

it('uses the existing circuit-breaker stop owner to refuse a retained door after a provider failure', async () => {
  const f = fixture()
  try {
    f.host.start('cloud', f.start, fakeCore(), f.fallback)
    expect(f.captured[0].begin(begin)).toEqual({ ok: true })
    await f.ports.cloud!.deliver('owner', 'fixture')
    expect(f.host.isOff('cloud')).toBe(true)
    expect(f.captured[0].end('transfer')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(f.stopEffects).toEqual([{ ok: false, error: 'SERVICE_UNAVAILABLE' }]); expect(f.owners.frames()).toEqual([])
  } finally { f.owners.stop() }
})
