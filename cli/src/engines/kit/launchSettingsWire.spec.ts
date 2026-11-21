import { expect, it } from 'vitest'
import { boundedLaunchSettingsInput, launchSettingsCandidate, type LaunchSettingsInput } from './launchSettingsWire.js'
const input = (): LaunchSettingsInput => ({ purpose: 'launchSettings', version: 2, engine: 'claude', environment: { HOME: '/fixture' },
  cwd: null, runtimeNode: '/fixture/node', platform: 'darwin', gitBash: null, owner: null })
const values = { instructions: null, settings: null }

it('accepts bounded selected context and the two declared optional values', () => {
  expect(boundedLaunchSettingsInput(input())).toBe(true)
  expect(boundedLaunchSettingsInput({ ...input(), platform: 'win32', gitBash: 'C:\\Git\\bash.exe', cwd: '/work',
    owner: { machineId: 'm', accountId: 'a', epoch: 'e' } })).toBe(true)
  expect(boundedLaunchSettingsInput({ ...input(), owner: { machineId: 'm' } })).toBe(true)
  expect(launchSettingsCandidate({ version: 2, values: { instructions: 'x'.repeat(65_536), settings: null } }, input()))
    .toEqual({ version: 2, values: { instructions: 'x'.repeat(65_536), settings: null } })
  const settings = JSON.stringify({ statusLine: { type: 'command', command: 'run', padding: { nested: [1, 2] } } })
  expect(launchSettingsCandidate({ version: 2, values: { instructions: null, settings } }, input())).toEqual({ version: 2, values: { instructions: null, settings } })
})
it.each([
  null, [], {}, { ...input(), version: 1 }, { ...input(), sources: [] }, { ...input(), files: [] }, { ...input(), dataDir: '/other' },
  { ...input(), purpose: 'other' }, { ...input(), engine: 'terminal' }, { ...input(), environment: [] },
  { ...input(), environment: { HOME: 1 } }, { ...input(), environment: { HOME: 'x\0' } },
  { ...input(), environment: { UNKNOWN: '/path' } }, { ...input(), environment: { HOME: 'x'.repeat(65_537) } },
  { ...input(), environment: { HOME: 'x'.repeat(40_000), PATH: 'x'.repeat(40_000) } },
  { ...input(), cwd: '' }, { ...input(), runtimeNode: 'x'.repeat(4097) }, { ...input(), platform: 'other' },
  { ...input(), gitBash: 4 }, { ...input(), owner: [] }, { ...input(), owner: { machineId: '' } },
  { ...input(), owner: { machineId: 'm', unknown: 'x' } }, { ...input(), owner: { machineId: 'm', accountId: 3 } },
  { ...input(), owner: { machineId: 'm', epoch: 'x\0' } },
])('refuses unsupported or malformed context %j', given => { expect(boundedLaunchSettingsInput(given)).toBe(false) })
it.each([
  null, [], { version: 1, values }, { version: 2, values, files: [] }, { version: 2, values: [] },
  { version: 2, values: { ...values, argv: [] } }, { version: 2, values: { instructions: undefined, settings: null } },
  { version: 2, values: { ...values, instructions: 'x\0' } }, { version: 2, values: { ...values, instructions: 'x'.repeat(65_537) } },
  ...['{', '[]', '{"permissions":{}}', '{"statusLine":{},"hooks":{}}', '{"statusLine":null}',
    '{"statusLine":{"type":"other","command":"run"}}', '{"statusLine":{"type":"command","command":" "}}',
    '{"statusLine":{"type":"command","command":"bad\\u0000"}}'].map(settings => ({ version: 2, values: { instructions: null, settings } })),
])('rejects arbitrary, incompatible or oversized returned settings %j', reply => { expect(launchSettingsCandidate(reply, input())).toBeNull() })
it('refuses status lines for undeclared engines and oversized transport envelopes', () => {
  const reply = { version: 2, values: { instructions: null, settings: '{"statusLine":{"type":"command","command":"run"}}' } }
  expect(launchSettingsCandidate(reply, { engine: 'codex' })).toBeNull()
  expect(launchSettingsCandidate(reply, input(), { ...reply, extra: 'x'.repeat(4 * 1024 * 1024) })).toBeNull()
})
