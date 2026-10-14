import { expect, it, vi } from 'vitest'
import { creationFingerprint } from './agentCreationReceipt.js'
import { NATIVE_CREATE_REQUEST_BYTES, nativeCreateFingerprint, parseNativeCreateRequest } from './nativeCreateRequest.js'

const request = () => ({ kind: 'native-create-v2', creationId: 'original-creation-request', agentId: 'fixture-agent',
  launchToken: 'original-launch-token', label: 'harness-cursor-original', local: true,
  input: { engine: 'cursor', cwd: '/fixture/project', prompt: 'Fixture', grid: { model: 'fixture', options: ['one'] } }, selection: null,
})

it('retains the complete immutable initial request without inventing a predecessor', () => {
  const input = request(), parsed = parseNativeCreateRequest(input)!
  expect(parsed).toEqual(input); expect(parsed).not.toBe(input)
  expect(parsed).not.toHaveProperty('sourceProcess'); expect(parsed).not.toHaveProperty('control')
  expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.input)).toBe(true)
  expect(Object.isFrozen(parsed.input.grid)).toBe(true)
  expect(Object.isFrozen((parsed.input.grid as any).options)).toBe(true)
  input.input.grid.options[0] = 'changed'
  expect((parsed.input.grid as any).options).toEqual(['one'])
  expect(nativeCreateFingerprint(parsed)).toBe(creationFingerprint(request().input))
})

it('keeps user semantics while generated identities change and includes model/project choices', () => {
  const first = parseNativeCreateRequest(request())!
  const second = parseNativeCreateRequest({ ...request(), creationId: 'different-request-id', agentId: 'other-agent',
    launchToken: 'different-launch-token', label: 'harness-cursor-later', local: false })!
  expect(nativeCreateFingerprint(second)).toBe(nativeCreateFingerprint(first))
  const selection = { grid: 'fixture-grid', model: 'fixture-model' }, projectFolder = { source: 'new', name: 'fixture' }
  const selected = parseNativeCreateRequest({ ...request(), selection, projectFolder })!
  expect(nativeCreateFingerprint(selected)).toBe(creationFingerprint({ ...request().input, modelSelection: selection, projectFolder }))
  expect(nativeCreateFingerprint(selected)).not.toBe(nativeCreateFingerprint(first))
})

it.each([
  { kind: 'native-create-v1' }, { kind: 'native-rearm' }, { creationId: 'short' }, { launchToken: 'short' },
  { agentId: '../agent' }, { agentId: 'a'.repeat(129) }, { label: 'harness-codex-fixture' }, { label: 'harness-cursor-' + 'a'.repeat(200) },
  { local: 'true' }, { extra: true }, { sourceProcess: { processKey: null } }, { control: {} },
  { selection: {} }, { selection: { grid: 'g', model: 'm', extra: true } },
  { selection: { grid: ' g ', model: 'm' } }, { selection: { grid: 'g', model: '\0' } },
  { projectFolder: undefined }, { projectFolder: null }, { projectFolder: { source: 'unsupported' } },
])('refuses unsupported initial metadata %#', change => {
  expect(parseNativeCreateRequest({ ...request(), ...change })).toBeNull()
})

it.each([
  { engine: 'codex' }, { cwd: 'relative' }, { cwd: '/fixture/\0' }, { cwd: '/fixture/\n' }, { cwd: '/' + 'a'.repeat(4096) },
  { resumeSessionId: 'former-conversation' }, { takeOver: true }, { extra: Infinity }, { extra: () => {} },
  { extra: BigInt(1) }, { extra: new Date() }, { extra: Array(129).fill('x') },
  { extra: 'x'.repeat(NATIVE_CREATE_REQUEST_BYTES) },
])('refuses incomplete or unbounded initial choices before dispatch %#', change => {
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, ...change } })).toBeNull()
})

it('accepts a project reservation with no folder yet and retains the full bounded body', () => {
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, cwd: '', extra: 'x'.repeat(16 * 1024) },
    projectFolder: { source: 'new' } })).not.toBeNull()
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, extra: '\0'.repeat(5000) } })).toBeNull()
})

it('bounds cyclic, deeply nested and expansive caller data before copying it', () => {
  const cyclic: any = request(); cyclic.input.extra = cyclic
  expect(parseNativeCreateRequest(cyclic)).toBeNull()
  let nested: unknown = 'value'
  for (let i = 0; i < 18; i++) nested = { nested }
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, nested } })).toBeNull()
  const wide = Array.from({ length: 128 }, () => Array.from({ length: 128 }, () => 'x'))
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, wide } })).toBeNull()
})

it('rejects sparse array length before JSON serialization can expand it', () => {
  const sparse = new Array(1_000_000), stringify = JSON.stringify, traversed = vi.fn()
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(value => {
    if (value && typeof value === 'object') { traversed(); throw Error('unbounded JSON walk') }
    return stringify(value)
  })
  try {
    let parsed: unknown
    expect(() => { parsed = parseNativeCreateRequest({ ...request(), input: { ...request().input, sparse } }) }).not.toThrow()
    expect(parsed).toBeNull(); expect(traversed).not.toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it.each(['object method', 'object getter', 'array method', 'array getter'])('rejects hidden JSON serialization before invoking it: %s', kind => {
  const value = kind.startsWith('array') ? ['small'] : { bounded: 'small' }
  const invoked = vi.fn(() => 'x'.repeat(NATIVE_CREATE_REQUEST_BYTES * 2))
  Object.defineProperty(value, 'toJSON', kind.endsWith('getter') ? { get: invoked } : { value: invoked })
  expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, value } })).toBeNull()
  expect(invoked).not.toHaveBeenCalled()
})

it('refuses enumerable accessors before reading or serializing caller fields', () => {
  const value = request(), input = value.input, invoked = vi.fn(() => input)
  Object.defineProperty(value, 'input', { get: invoked, enumerable: true })
  expect(parseNativeCreateRequest(value)).toBeNull()
  expect(invoked).not.toHaveBeenCalled()
})

it.each(['engine', 'cwd'])('checks only the durable copy of the required input.%s field', field => {
  for (const accessor of [false, true]) {
    const value = request(), original = value.input[field as 'engine' | 'cwd'], invoked = vi.fn(() => original)
    Object.defineProperty(value.input, field, { enumerable: false, ...(accessor ? { get: invoked } : { value: original }) })
    let parsed: unknown
    expect(() => { parsed = parseNativeCreateRequest(value) }).not.toThrow()
    expect(parsed).toBeNull(); expect(invoked).not.toHaveBeenCalled()
  }
})

it('refuses array holes and non-index properties instead of silently changing the JSON shape', () => {
  const sparse = ['a', 'b']; delete sparse[0]
  const extra = Object.assign(['a'], { extra: 'unretained' })
  for (const value of [sparse, extra]) expect(parseNativeCreateRequest({ ...request(), input: { ...request().input, value } })).toBeNull()
})
