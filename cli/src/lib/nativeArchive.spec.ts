import { expect, it } from 'vitest'
import { parseNativeArchiveLink, parseNativeArchiveTransfer, parseNativeArchiveReturn, parseNativeArchiveRetirement, parseNativeArchiveEnvelope } from './nativeArchive.js'

const link = { version: 1, agentId: 'original-agent', requestId: 'original-resume-request', launchToken: 'original-launch-token', target: 'a'.repeat(64) }
const transfer = { version: 1, link, pendingTarget: 'b'.repeat(64), processKey: 'boot\0cursor\0process\0birth', pane: '%1' }
const returning = { version: 1, phase: 'returning', link, sourceTarget: 'b'.repeat(64), controlFingerprint: 'c'.repeat(64),
  checkpoint: 'd'.repeat(64), savedTarget: 'e'.repeat(64) }
const aborting = { ...returning, pendingAbort: { kind: 'untransferred', priorRole: 'f'.repeat(64), pendingControl: '1'.repeat(64), requestFingerprint: '2'.repeat(64) } }

it('retains explicit abort provenance only on the Registry retirement', () => {
  const parsed = parseNativeArchiveRetirement(aborting)!
  expect(parsed).toEqual(aborting); expect(Object.isFrozen(parsed.pendingAbort)).toBe(true)
  expect(parseNativeArchiveRetirement(returning)).toEqual(returning)
  expect(parseNativeArchiveReturn(aborting)).toBeNull()
  expect(parseNativeArchiveEnvelope({ version: 3, session: {}, nativeReturn: aborting })).toBeNull()
})

it.each([null, [], 'retirement', { ...aborting, phase: 'saved' }, { ...aborting, extra: true },
  ...[null, undefined, [], {}, { ...aborting.pendingAbort, extra: true }, { ...aborting.pendingAbort, kind: 'transferred' },
    ...['priorRole', 'pendingControl', 'requestFingerprint'].flatMap(field => [null, 'bad'].map(value => ({ ...aborting.pendingAbort, [field]: value })))
  ].map(pendingAbort => ({ ...aborting, pendingAbort })),
])('refuses malformed pending retirement provenance: %#', value => {
  expect(parseNativeArchiveRetirement(value)).toBeNull()
})

it.each([{ version: 1, session: {} }, { version: 2, session: {}, nativeTransfer: transfer },
  { version: 3, session: {}, nativeReturn: returning }])('parses the shared envelope without granting session authority: %j', value => {
  expect(parseNativeArchiveEnvelope(value)).toEqual(value)
})

it.each([null, [], {}, 'saved', { version: 0 }, { version: 1, nativeReturn: returning }, { version: 1, nativeTransfer: transfer },
  { version: 2, session: {}, nativeTransfer: transfer, extra: true }, { version: 2, session: {}, nativeTransfer: null },
  { version: 3, session: {}, nativeReturn: returning, extra: true }, { version: 3, session: {}, nativeReturn: null },
])('refuses unrecognized or disguised archive envelopes: %j', value => {
  expect(parseNativeArchiveEnvelope(value)).toBeNull()
})

it.each(['returning', 'saved'])('freezes the exact %s archive return receipt', phase => {
  const input = { ...returning, phase, link: { ...link } }, parsed = parseNativeArchiveReturn(input)!
  input.link.target = 'f'.repeat(64)
  expect(parsed).toEqual({ ...returning, phase })
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.link)).toBe(true)
})

it.each([null, [], 'return', {}, { ...returning, version: 2 }, { ...returning, phase: 'live' }, { ...returning, extra: true },
  { ...returning, link: null }, ...['sourceTarget', 'controlFingerprint', 'checkpoint', 'savedTarget'].flatMap(field =>
    [null, 'bad'].map(value => ({ ...returning, [field]: value }))),
])('refuses malformed archive return roles: %j', value => {
  expect(parseNativeArchiveReturn(value)).toBeNull()
})

it('copies and freezes the original transfer identity without granting admission', () => {
  const input = structuredClone(transfer), parsed = parseNativeArchiveTransfer(input)!
  input.link.launchToken = 'another-launch-token'; input.processKey = 'another-process'
  expect(parsed).toEqual(transfer)
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.link)).toBe(true)
  expect(Object.keys(parsed.link).sort()).toEqual(['agentId', 'launchToken', 'requestId', 'target', 'version'])
})

it.each([null, [], 'link', {}, { ...link, extra: true }, { ...link, version: 2 }, { ...link, agentId: '' },
  { ...link, agentId: '../agent' }, { ...link, agentId: 1 }, { ...link, requestId: 'short' }, { ...link, requestId: null },
  { ...link, launchToken: 'short' }, { ...link, launchToken: null }, { ...link, target: 'bad' }, { ...link, target: null },
])('refuses malformed original links: %j', value => {
  expect(parseNativeArchiveLink(value)).toBeNull()
})

it.each([null, [], 'transfer', {}, { ...transfer, extra: true }, { ...transfer, version: 2 }, { ...transfer, link: null },
  { ...transfer, pendingTarget: null }, { ...transfer, pendingTarget: 'bad' }, { ...transfer, processKey: null },
  { ...transfer, processKey: '' }, { ...transfer, processKey: 'a'.repeat(513) }, { ...transfer, pane: null }, { ...transfer, pane: '1' },
])('refuses malformed transfer roles: %j', value => {
  expect(parseNativeArchiveTransfer(value)).toBeNull()
})
