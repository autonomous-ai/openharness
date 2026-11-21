import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { createComponentStartup, type ComponentStartupOptions } from './componentStartup.js'
import type { StartupFiles } from './componentStartupFiles.js'

let present: Set<string>
let rows: Map<string, unknown[]>
let files: StartupFiles
let want: Mock<(service: string) => void>
let log: Mock<(line: string) => void>
const names = ['devices', 'wifi', 'gateway', 'models', 'viewers', 'orchestrator', 'sharing', 'cloud', 'agentBrowser']
const start = (overrides: Partial<ComponentStartupOptions> = {}) => createComponentStartup({
  dataDir: '/saved', runtimeDir: '/runtime', available: new Set(names), started: new Set(),
  platform: 'darwin', files, want, log, ...overrides,
})
beforeEach(() => {
  vi.useFakeTimers()
  present = new Set(); rows = new Map(); want = vi.fn(); log = vi.fn()
  files = { exists: vi.fn(path => present.has(path)),
    matches: vi.fn((path, prefix, suffix) => [...present].some(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/') && file.slice(path.length + 1).startsWith(prefix) && file.endsWith(suffix))),
    rows: vi.fn(path => rows.get(path) ?? []) }
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([
  ['orchestrator', '/saved/orchestrator/task.json'], ['sharing', '/saved/harness-shares.json'],
  ['sharing', '/saved/harness-collaboration.json'], ['sharing', '/saved/agent-messages/shared-tabs.json'],
  ['cloud', '/saved/cloud/harnesses.json'], ['agentBrowser', '/saved/agent-browser.json'],
  ['models', '/runtime/current-grid'], ['models', '/saved/grid-pictures/picture.json'],
  ['models', '/saved/local-models/model'],
])('starts %s from its retained state %s', (service, path) => {
  present.add(path)
  const active = start({ cableDisabled: true })
  expect(want.mock.calls).toEqual([[service]])
  active.stop()
})

it('reads only available peers that the master has not already started', () => {
  const active = start({ available: new Set(), started: new Set(['unknown']) })
  expect(files.exists).not.toHaveBeenCalled(); expect(files.rows).not.toHaveBeenCalled(); expect(files.matches).not.toHaveBeenCalled()
  active.stop()
  start({ started: new Set(names) }).stop()
  expect(files.exists).not.toHaveBeenCalled(); expect(files.rows).not.toHaveBeenCalled(); expect(files.matches).not.toHaveBeenCalled()
  expect(want).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})

it.each([
  ['autonomous-device-connections.json', [{}], ['gateway', 'wifi']],
  ['e2e/paired.json', [{ role: 'phone' }], ['gateway']],
  ['e2e/paired.json', [null, {}, { role: 'device' }], ['gateway', 'wifi']],
  ['viewers.json', [{}], ['viewers']],
])('starts peers for %s without forwarding its contents', (file, value, expected) => {
  rows.set(`/saved/${file}`, value)
  start({ cableDisabled: true }).stop()
  expect(want.mock.calls.flat()).toEqual(expected)
  expect(log.mock.calls.join()).not.toContain('phone')
})

it('does not ask for an unavailable gateway when only wifi is declared', () => {
  rows.set('/saved/e2e/paired.json', [{ role: 'device' }])
  start({ available: new Set(['wifi']) }).stop()
  expect(want.mock.calls).toEqual([['wifi']])
})

it.each([
  ['darwin', '/dev/cu.usbmodem123'], ['linux', '/dev/ttyACM0'], ['linux', '/dev/ttyUSB0'],
] as const)('discovers a %s dial at %s and removes its timer', (platform, path) => {
  const active = start({ platform })
  expect(want).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1)
  present.add(path); vi.advanceTimersByTime(2000)
  expect(want.mock.calls).toEqual([['devices']]); expect(vi.getTimerCount()).toBe(0)
  active.stop()
})

it.each(['devices', 'wifi'])('stops discovery when the master reports %s started', service => {
  const active = start()
  active.started('unavailable')
  active.started('models')
  expect(vi.getTimerCount()).toBe(1)
  active.started(service)
  expect(vi.getTimerCount()).toBe(0)
  present.add('/dev/cu.usbmodem123'); vi.advanceTimersByTime(4000)
  expect(want).not.toHaveBeenCalled()
  active.stop(); active.started(service)
})

it('stops without leaving a scan scheduled, and cable-off never schedules one', () => {
  const active = start({ platform: 'freebsd' })
  expect(vi.getTimerCount()).toBe(1)
  active.stop(); active.stop(); vi.advanceTimersByTime(4000)
  expect(vi.getTimerCount()).toBe(0)
  start({ cableDisabled: true }).stop()
  expect(want).not.toHaveBeenCalled()
})

it('starts the Windows discovery owner unless cable support is disabled', () => {
  start({ platform: 'win32' }).stop()
  start({ platform: 'win32', cableDisabled: true }).stop()
  expect(want.mock.calls).toEqual([['devices']]); expect(vi.getTimerCount()).toBe(0)
})

it('uses the explicit dial fixture with the same missing-to-present lifecycle', () => {
  const active = start({ testDialPort: '/fixture/ports.json' })
  rows.set('/fixture/ports.json', [null, {}, { path: '/private-port' }])
  vi.advanceTimersByTime(2000)
  expect(want.mock.calls).toEqual([['devices']]); active.stop()
  present.add('/fixture/port')
  start({ testDialPort: '/fixture/port' }).stop()
  expect(want).toHaveBeenCalledTimes(2)
})

it('defaults to the actual platform and filesystem while unavailable peers cost no observations', () => {
  const say = vi.spyOn(console, 'log').mockImplementation(() => {})
  start({ available: new Set(), platform: undefined, files: undefined, log: undefined }).stop()
  start({ available: new Set(['cloud']), log: undefined, files: { ...files, exists: () => true } }).stop()
  expect(say).toHaveBeenCalledWith('[startup] cloud: saved state')
})
