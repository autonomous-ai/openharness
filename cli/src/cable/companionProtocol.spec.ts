import { expect, it } from 'vitest'
import { COMPANION_SPECIES, readCompanionIdentity } from './companionProtocol.js'

const valid = { id: 'tim', uid: 'tim-1', seed: 1, name: 'Tim', version: '0.1', colour: -1, mark: 0 }

it.each(COMPANION_SPECIES)('retains valid existing %s wire identities without companion services', id => {
  expect(readCompanionIdentity({ ...valid, id, unrelated: 'ignored' })).toEqual({ ...valid, id })
})

it.each([null, undefined, false, 1, 'tim', [], {}])('refuses a malformed identity %j', value => {
  expect(readCompanionIdentity(value)).toBeNull()
})

it.each([
  ['id', 1], ['id', 'unknown'], ['uid', 1], ['uid', ''], ['uid', 'x'.repeat(65)], ['uid', '../outside'],
  ['name', 1], ['name', ''], ['name', 'x'.repeat(25)], ['name', 'Tim\n'],
  ['version', '9.0'], ['version', null], ['seed', 0.5], ['seed', -1], ['seed', 0x100000000],
  ['colour', 0.5], ['colour', -2], ['colour', 6], ['mark', 0.5], ['mark', -1], ['mark', 5],
] as const)('refuses invalid %s = %j', (field, value) => {
  expect(readCompanionIdentity({ ...valid, [field]: value })).toBeNull()
})

it('accepts the complete existing numeric and text boundary ranges', () => {
  for (const identity of [
    { ...valid, seed: 0, version: '1.0', colour: 0 },
    { ...valid, seed: 0xffffffff, version: '2.0', colour: 5, mark: 4, uid: 'x'.repeat(64), name: 'x'.repeat(24) },
  ]) expect(readCompanionIdentity(identity)).toEqual(identity)
})
