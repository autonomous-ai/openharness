import { expect, it } from 'vitest'
import { boundedHookInput, hookCandidate } from './nativeHookWire.js'

const input = { engine: 'claude' as const, port: 1234, environment: { HOME: '/fixture' },
  files: [{ file: '/fixture/settings.json', directory: '/fixture', content: '{}' }] }
const candidate = (contents: Array<string | null>) => ({ version: 1, files: contents.map((content, index) => ({ index, content })) })

it('accepts only the caller’s complete indexed destination set', () => {
  expect(hookCandidate(candidate(['{}', null]), 2)).toEqual(candidate(['{}', null]))
  for (const value of [null, [], { version: 2, files: [] }, { ...candidate(['{}']), file: '/outside' },
    candidate([]), candidate(['{}', '{}']), { version: 1, files: [{ index: 1, content: '{}' }] },
    { version: 1, files: [{ index: 0, content: '{}', file: '/outside' }] },
    { version: 1, files: [{ index: 0, content: 1 }] }]) expect(hookCandidate(value, 1)).toBeNull()
  expect(hookCandidate(candidate(['{}']), 0)).toBeNull()
  expect(hookCandidate(candidate(Array(5).fill('{}')), 5)).toBeNull()
})

it('bounds UTF-8 bytes per file and in aggregate, then bounds the escaped transport frame', () => {
  expect(hookCandidate(candidate(['é'.repeat(512 * 1024)]), 1)).not.toBeNull()
  expect(hookCandidate(candidate(['é'.repeat(512 * 1024 + 1)]), 1)).toBeNull()
  expect(hookCandidate(candidate(Array(3).fill('a'.repeat(1024 * 1024))), 3)).toBeNull()
  expect(hookCandidate(candidate(['\u0001'.repeat(1024 * 1024)]), 1)).toBeNull()
  expect(hookCandidate(candidate(['{}']), 1, { files: candidate(['{}']), extra: 'a'.repeat(4 * 1024 * 1024) })).toBeNull()
})

it('refuses unbounded or ambiguous native input before setup is asked', () => {
  expect(boundedHookInput(input)).toBe(true)
  for (const change of [{ port: 0 }, { port: 65536 }, { port: 1.1 }, { files: [] }, { files: Array(5).fill(input.files[0]) },
    { files: [input.files[0], input.files[0]] },
    { files: [{ ...input.files[0], file: '/bad\0path' }] },
    { files: [{ ...input.files[0], directory: 'x'.repeat(4097) }] },
    { files: [{ ...input.files[0], content: 'é'.repeat(512 * 1024 + 1) }] },
    { files: [{ ...input.files[0], mode: 0o1000 }] },
    { files: [{ ...input.files[0], content: '\u0001'.repeat(1024 * 1024) }] }]) {
    expect(boundedHookInput({ ...input, ...change })).toBe(false)
  }
})

it('rejects malformed metadata without throwing or carrying extra authority', () => {
  for (const value of [null, [], {}, { ...input, engine: 'unknown' }, { ...input, environment: null },
    { ...input, environment: { HOME: 1 } }, { ...input, environment: { HOME: 'x'.repeat(65_537) } },
    { ...input, major: -1 }, { ...input, keepsRecord: 1 }, { ...input, remove: 'yes' },
    { ...input, createMissing: 'yes' }, { ...input, directories: [null] },
    { ...input, directories: [{ path: '/fixture', mode: '0700' }] },
    { ...input, files: [{ ...input.files[0], execute: 'unexpected' }] }]) {
    expect(() => boundedHookInput(value as typeof input)).not.toThrow()
    expect(boundedHookInput(value as typeof input)).toBe(false)
  }
  expect(hookCandidate(candidate(['{}']), 1.5)).toBeNull()
})
