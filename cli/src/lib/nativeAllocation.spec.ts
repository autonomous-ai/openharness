import { expect, it } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { appendNativeAllocation, nativeAllocationCanReserve, parseNativeAllocation } from './nativeAllocation.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'

function allocationReceipt(n = 0, agentId = 'agent') {
  const choice = { kind: 'native-rearm', agentId, operation: 'resume', source: 'live', permissionMode: 'full' }
  return { fingerprint: creationFingerprint(choice), request: { ...choice, creationId: `original-request-${n}`,
    launchToken: `original-launch-token-${n}`, target: String(n).repeat(64), sourceProcess: { processKey: null } } }
}
const allocation = () => ({ version: 1 as const, receipts: [allocationReceipt()] })

it('retains exact original requests as immutable ordered references through successive admission', () => {
  const original = allocation(), parsed = parseNativeAllocation(original)!
  expect(parsed).toEqual(original); expect(parsed).not.toBe(original)
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.receipts)).toBe(true)
  expect(Object.isFrozen(parsed.receipts[0])).toBe(true); expect(Object.isFrozen(parsed.receipts[0].request)).toBe(true)
  expect(Object.isFrozen(parsed.receipts[0].request.sourceProcess)).toBe(true)
  const next = appendNativeAllocation(parsed, allocationReceipt(1))
  expect(next.receipts).toEqual([allocationReceipt(), allocationReceipt(1)])
  expect(parsed).toEqual(original)
  expect(appendNativeAllocation(next, allocationReceipt())).toEqual(next)
})

it.each([
  null, undefined, [], {}, { version: 2, receipts: [] }, { version: 1, receipts: [] },
  { ...allocation(), extra: true }, { ...allocation(), receipts: [null] },
  { ...allocation(), receipts: Array.from({ length: 5 }, (_, n) => allocationReceipt(n)) },
  { ...allocation(), receipts: [allocationReceipt(), allocationReceipt()] },
  { ...allocation(), receipts: [allocationReceipt(), { ...allocationReceipt(1), request: { ...allocationReceipt(1).request, launchToken: allocationReceipt().request.launchToken } }] },
  { ...allocation(), receipts: [allocationReceipt(), allocationReceipt(1, 'different-agent')] },
])('rejects incomplete, duplicated or unbounded allocation history %#', value => {
  expect(parseNativeAllocation(value)).toBeNull()
})

it.each([
  { fingerprint: 'f'.repeat(64) }, { fingerprint: undefined }, { extra: true }, { request: null },
])('rejects an unsupported reference %#', change => {
  expect(parseNativeAllocation({ version: 1, receipts: [{ ...allocationReceipt(), ...change }] })).toBeNull()
})

it.each([
  { extra: true }, { kind: 'initial-create' }, { creationId: 'short' }, { launchToken: 'short' },
  { agentId: '../agent' }, { agentId: 'a'.repeat(129) }, { target: 'not-a-digest' },
  { operation: 'close' }, { source: 'other' }, { source: 'saved', operation: 'restart' },
  { permissionMode: undefined }, { permissionMode: 'other' }, { operation: 'restart' },
  { sourceProcess: undefined }, { sourceProcess: { processKey: null, extra: true } },
])('rejects a changed original request even with the former fingerprint %#', change => {
  expect(parseNativeAllocation({ version: 1, receipts: [{ ...allocationReceipt(), request: { ...allocationReceipt().request, ...change } }] })).toBeNull()
})

it('preserves omitted legacy provenance without inventing known process authority', () => {
  const { sourceProcess: _process, permissionMode: _permission, ...request } = allocationReceipt().request
  const original = { request, fingerprint: creationFingerprint({ kind: request.kind, agentId: request.agentId,
    source: request.source, operation: request.operation }) }
  expect(appendNativeAllocation(undefined, original).receipts[0]).toEqual(original)
  expect(parseNativeAllocation({ version: 1, receipts: [original] })!.receipts[0].request).not.toHaveProperty('sourceProcess')
})

it('reserves capacity before the fourth launch, holds the fifth and never prunes', () => {
  let saved = appendNativeAllocation(undefined, allocationReceipt())
  for (let n = 1; n < 4; n++) {
    expect(nativeAllocationCanReserve(saved, allocationReceipt(n).request.creationId)).toBe(true)
    saved = appendNativeAllocation(saved, allocationReceipt(n))
  }
  expect(nativeAllocationCanReserve(saved, allocationReceipt(4).request.creationId)).toBe(false)
  expect(() => appendNativeAllocation(saved, allocationReceipt(4))).toThrow('unavailable or full')
  expect(appendNativeAllocation(saved, allocationReceipt(3))).toEqual(saved)
  expect(saved.receipts).toHaveLength(4)
  expect(nativeAllocationCanReserve(undefined, 'fresh-request-id')).toBe(true)
  expect(nativeAllocationCanReserve(appendNativeAllocation(undefined, allocationReceipt()), allocationReceipt().request.creationId)).toBe(false)
  expect(nativeAllocationCanReserve({ version: 1, receipts: [] }, 'fresh-request-id')).toBe(false)
})

it('refuses same-ID conflicts, reused pane tokens and malformed prior authority', () => {
  const saved = appendNativeAllocation(undefined, allocationReceipt())
  expect(() => appendNativeAllocation(saved, { ...allocationReceipt(), request: { ...allocationReceipt().request, target: 'a'.repeat(64) } })).toThrow()
  expect(() => appendNativeAllocation(saved, { ...allocationReceipt(1), request: { ...allocationReceipt(1).request, launchToken: allocationReceipt().request.launchToken } })).toThrow()
  expect(() => appendNativeAllocation({ version: 1, receipts: [] }, allocationReceipt())).toThrow()
  expect(() => appendNativeAllocation(undefined, { ...allocationReceipt(), fingerprint: 'f'.repeat(64) })).toThrow()
})

function initialReceipt(agentId = 'agent') {
  const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: 'initial-creation-request', agentId,
    launchToken: 'initial-launch-token', label: 'harness-cursor-original', local: true,
    input: { engine: 'cursor', cwd: '/fixture/project', prompt: 'Fixture prompt' }, selection: null })!
  return { request, fingerprint: nativeCreateFingerprint(request) }
}

it('retains first creation without a predecessor and appends later rearm in order', () => {
  const initial = initialReceipt(), saved = appendNativeAllocation(undefined, initial)
  expect(saved).toEqual({ version: 2, receipts: [initial] })
  expect(saved.receipts[0].request).not.toHaveProperty('sourceProcess')
  expect(Object.isFrozen(saved.receipts[0].request.input)).toBe(true)
  expect(appendNativeAllocation(saved, initial)).toEqual(saved)
  let later = saved
  for (let n = 0; n < 3; n++) later = appendNativeAllocation(later, allocationReceipt(n))
  expect(later).toEqual({ version: 2, receipts: [initial, allocationReceipt(0), allocationReceipt(1), allocationReceipt(2)] })
  expect(nativeAllocationCanReserve(later, 'fifth-launch-request')).toBe(false)
  expect(() => appendNativeAllocation(later, allocationReceipt(3))).toThrow()
  expect(later.receipts[0]).toEqual(initial)
})

it('refuses initial admission in older or reordered allocation history', () => {
  const initial = initialReceipt()
  for (const value of [
    { version: 1, receipts: [initial] }, { version: 2, receipts: [allocationReceipt()] },
    { version: 2, receipts: [allocationReceipt(), initial] }, { version: 2, receipts: [initial, initial] },
    { version: 2, receipts: [initial, initialReceipt('foreign-agent')] },
    { version: 2, receipts: [{ ...initial, fingerprint: 'f'.repeat(64) }] },
    { version: 2, receipts: [{ ...initial, request: { ...initial.request, sourceProcess: { processKey: null } } }] },
    { version: 2, receipts: new Array(1) }, { version: 1, receipts: new Array(1) },
  ]) expect(parseNativeAllocation(value)).toBeNull()
  expect(() => appendNativeAllocation(appendNativeAllocation(undefined, allocationReceipt()), initial)).toThrow()
  const saved = appendNativeAllocation(undefined, initial)
  expect(() => appendNativeAllocation(saved, { ...initial, request: { ...initial.request, label: 'harness-cursor-replacement' } })).toThrow()
  expect(() => appendNativeAllocation(saved, { ...allocationReceipt(), request: { ...allocationReceipt().request,
    launchToken: initial.request.launchToken } })).toThrow()
})
