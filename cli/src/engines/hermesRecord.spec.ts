/**
 * Which Hermes keeps a terminal record (spec §4). No spec runs a real `hermes` or reads the person's `~/.hermes`: the
 * version comes from injected fakes, and a home is a throwaway folder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HERMES_HOOKS_SAID, HERMES_VERSION } from './hermes/contract.js'
import type { LaunchExecutableResult } from './kit/launchExecutable.js'
import type { nativeVersionProbe } from './kit/nativeVersion.js'
import { forgetHermesRecord, hermesHomeIsTui, hermesKeepsRecord, isRecordHome, rememberRecordHome } from './hermesRecord.js'

const log = vi.spyOn(console, 'log').mockImplementation(() => {})
let home: string
beforeEach(() => { forgetHermesRecord(); log.mockClear(); home = mkdtempSync(join(tmpdir(), 'hermes-record-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

const probeOf = (identity: string | null, said: string | Error) => vi.fn<typeof nativeVersionProbe>(() => ({
  command: () => '/bin/hermes', identity: () => identity,
  read: vi.fn(async () => { if (said instanceof Error) throw said; return said }),
}))
const ready = vi.fn(async (): Promise<LaunchExecutableResult> => ({
  state: 'ready', executable: { command: '/bin/hermes', identity: 'f', current: () => true }, environment: { HOME: '/h', PATH: '/bin' },
}))

it.each([['Hermes Agent v0.21.5 (2026.10.7)', false], ['Hermes Agent v0.21.6 (2026.9.24)', true], ['Hermes Agent v0.23.1 (2026.11.11)', true], ['Hermes Agent v1.0.0', true]])(
  'answers for %s', async (said, keeps) => {
    expect(await hermesKeepsRecord({ command: '/bin/hermes' }, { HOME: '/h' }, { capture: ready, probe: probeOf(said, said) })).toBe(keeps)
    expect(ready).not.toHaveBeenCalled()
  })

it('asks the Hermes a launch would run when none is given', async () => {
  const probe = probeOf('f', 'Hermes Agent v0.23.1 (2026.11.11)')
  expect(await hermesKeepsRecord(undefined, undefined, { capture: ready, probe })).toBe(true)
  expect(probe).toHaveBeenCalledWith(HERMES_VERSION, expect.any(Function), expect.objectContaining({ HOME: '/h', PATH: '/bin' }))
  expect(probe.mock.calls[0]![1]()).toBe('/bin/hermes')
})

it('does not know a Hermes it cannot find, cannot run or cannot read, and says so once', async () => {
  const held = vi.fn(async (): Promise<LaunchExecutableResult> => ({ state: 'held', detail: 'x' }))
  expect(await hermesKeepsRecord(undefined, undefined, { capture: held, probe: probeOf(null, '') })).toBeNull()
  expect(await hermesKeepsRecord(undefined, undefined, { capture: held, probe: probeOf(null, '') })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('g', new Error('timeout')) })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('h', 'Hermes Agent vunknown') })).toBeNull()
  expect(await hermesKeepsRecord({ command: '/bin/h' }, undefined, { capture: ready, probe: probeOf('h', 'Hermes Agent vunknown') })).toBeNull()
  // No file, file g, file h: once each.
  expect(log.mock.calls.filter(([line]) => line === HERMES_HOOKS_SAID.unknown)).toHaveLength(3)
})

it('asks an installed file once', async () => {
  const read = vi.fn(async () => 'Hermes Agent v0.21.6 (2026.9.24)')
  const probe = vi.fn<typeof nativeVersionProbe>(() => ({ command: () => '/bin/hermes', identity: () => 'f', read }))
  expect(await hermesKeepsRecord({ command: '/bin/hermes' }, undefined, { capture: ready, probe })).toBe(true)
  expect(await hermesKeepsRecord({ command: '/bin/hermes' }, undefined, { capture: ready, probe })).toBe(true)
  expect(read).toHaveBeenCalledOnce()
})

it('remembers a home seen keeping a record', () => {
  expect(isRecordHome('/h/.hermes')).toBe(false); expect(rememberRecordHome('/h/.hermes')).toBe(true)
  expect(rememberRecordHome('/h/.hermes')).toBe(false); expect(isRecordHome('/h/.hermes')).toBe(true)
})

it('remembers at most 256 homes, and starts again past them', () => {
  for (let n = 0; n < 256; n++) rememberRecordHome(`/h${n}/.hermes`)
  expect(isRecordHome('/h0/.hermes')).toBe(true)
  expect(rememberRecordHome('/h256/.hermes')).toBe(true)
  expect(isRecordHome('/h0/.hermes')).toBe(false); expect(isRecordHome('/h256/.hermes')).toBe(true)
})

it('answers "older" in this suite when a spec passes no deps, and runs nothing', async () => {
  expect(await hermesKeepsRecord()).toBe(false)
})

it.each([['display:\n  interface: tui\n', true], ['display:\n  interface: " TUI "\n', true], ['display: {interface: Tui}\n', true],
  ['display:\n  interface: cli\n', false], ['model: x\n', false], ['display: tui\n', false], ['display:\n  interface: [tui]\n', false]])(
  'reads whether a home is set to the TUI from %j', async (text, tui) => {
    writeFileSync(join(home, 'config.yaml'), text); expect(await hermesHomeIsTui(home)).toBe(tui)
  })

it('takes a home with no config, or one it cannot read, for the CLI', async () => {
  expect(await hermesHomeIsTui(join(home, 'no-such-home'))).toBe(false)
  mkdirSync(join(home, 'config.yaml')); expect(await hermesHomeIsTui(home)).toBe(false)
})
