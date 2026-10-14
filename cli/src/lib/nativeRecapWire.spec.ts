import { describe, expect, it } from 'vitest'
import { copyNativeRecapCompletion, nativeRecapDigest, nativeRecapId, nativeRecapWaiting, readNativeRecapResult, NATIVE_RECAP_VERSION } from './nativeRecapWire.js'

const owner = { agentId: 'agent', sessionId: 'session', processKey: ['boot', 'cursor', '42', 'birth'].join('\0') }
const input = () => ({ owner: { ...owner }, generationId: 'A', id: nativeRecapId(owner, 'A'), responseText: 'Original answer.' })
const ready = () => ({ state: 'ready', id: input().id, sourceDigest: nativeRecapDigest(input()), version: NATIVE_RECAP_VERSION, summary: 'Original recap.' })

describe('native recap wire', () => {
  it('copies and freezes the original native answer before a service wait', () => {
    const value = input(), original = copyNativeRecapCompletion(value)
    expect(original).toEqual(value)
    expect(original).not.toBe(value)
    expect(original.owner).not.toBe(value.owner)
    value.owner.processKey = 'replacement'
    value.responseText = 'Replacement answer.'
    expect(original).toEqual(input())
    expect(Object.isFrozen(original)).toBe(true)
    expect(Object.isFrozen(original.owner)).toBe(true)
    expect(copyNativeRecapCompletion({ ...input(), responseText: '' }).responseText).toBe('')
  })

  it.each(['agentId', 'sessionId', 'processKey'] as const)('separates recap identity by original %s', key => {
    const changed = { ...owner, [key]: 'replacement' }
    expect(nativeRecapId(changed, 'A')).not.toBe(input().id)
  })

  it('separates identical answers by generation and binds each digest to its input bytes', () => {
    expect(nativeRecapId(owner, 'B')).not.toBe(input().id)
    const value = input(), digest = nativeRecapDigest(value)
    for (const altered of [
      { ...value, responseText: 'New answer.' }, { ...value, id: 'other' }, { ...value, generationId: 'B' },
      ...(['agentId', 'sessionId', 'processKey'] as const).map(key => ({ ...value, owner: { ...owner, [key]: 'other' } })),
    ]) expect(nativeRecapDigest(altered)).not.toBe(digest)
  })

  it.each([
    undefined, null, [], 1, {}, { ...input(), extra: true }, { ...input(), owner: [] },
    { ...input(), owner: { ...owner, extra: true } },
    ...[undefined, '', 'x'.repeat(201), 'a\nb', 'a\u007fb'].flatMap(invalid => [
      { ...input(), owner: { ...owner, agentId: invalid } },
      { ...input(), owner: { ...owner, sessionId: invalid } },
      { ...input(), generationId: invalid },
    ]),
    ...[undefined, '', 'x'.repeat(513)].map(processKey => ({ ...input(), owner: { ...owner, processKey } })),
    ...[undefined, null, 3, 'é'.repeat(65537)].map(responseText => ({ ...input(), responseText })),
    { ...input(), id: 'foreign' },
  ])('holds missing, foreign or unbounded original input %#', value => {
    expect(() => copyNativeRecapCompletion(value)).toThrow('Waiting for the original native')
  })

  it('accepts bounded inputs at their exact limits and retains native process separators', () => {
    const maxOwner = { agentId: 'a'.repeat(200), sessionId: 's'.repeat(200), processKey: '\0'.repeat(512) }
    const generationId = 'g'.repeat(200)
    const value = { owner: maxOwner, generationId, id: nativeRecapId(maxOwner, generationId), responseText: 'é'.repeat(65536) }
    expect(copyNativeRecapCompletion(value)).toEqual(value)
  })

  it('accepts only the original answer and derivation version, with null as a valid empty recap', () => {
    const value = ready(), result = readNativeRecapResult(value, input())
    expect(result).toEqual(value)
    expect(result).not.toBe(value)
    expect(Object.isFrozen(result)).toBe(true)
    expect(readNativeRecapResult({ ...value, summary: null }, input())).toEqual({ ...value, summary: null })
    expect(readNativeRecapResult({ ...value, summary: 'é'.repeat(4096) }, input())).toMatchObject({ state: 'ready' })
    expect(nativeRecapWaiting()).toEqual({ state: 'held', reason: 'Waiting for the recaps service.' })
    const held = { state: 'held', reason: 'Waiting for the original source.' }
    expect(readNativeRecapResult(held, input())).toEqual(held)
    expect(Object.isFrozen(readNativeRecapResult(held, input()))).toBe(true)
    expect(readNativeRecapResult({ ...held, reason: 'r'.repeat(1024) }, input())).toMatchObject({ reason: 'r'.repeat(1024) })
  })

  it.each([
    null, undefined, [], {},
    { state: 'held', reason: '' }, { state: 'held', reason: 3 }, { state: 'held', reason: 'r'.repeat(1025) }, { state: 'held', reason: 'Wait.', extra: true },
    { ...ready(), extra: true }, { ...ready(), state: 'saved' }, { ...ready(), id: nativeRecapId(owner, 'B') },
    { ...ready(), sourceDigest: nativeRecapDigest({ ...input(), responseText: 'Replacement answer.' }) },
    { ...ready(), version: 2 }, { ...ready(), summary: undefined }, { ...ready(), summary: 'é'.repeat(4097) },
  ])('holds malformed or mismatched service replies %#', value => {
    expect(readNativeRecapResult(value, input())).toEqual({ state: 'held', reason: 'Waiting for the original native recap result.' })
  })
})
