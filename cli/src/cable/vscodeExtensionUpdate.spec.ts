/**
 * The extension brought current against fake deps: a status, a build version and an enable the test sets. VS Code's own
 * `code` and ~/.vscode are never touched.
 */
import { describe, expect, it } from 'vitest'
import type { VscodeChange, VscodeStatus } from '../devices/vscodeExtension.js'
import { startVscodeExtensionUpdate, UPDATE_RETRY_MS, type VscodeExtensionUpdateDeps } from './vscodeExtensionUpdate.js'

/** Deps whose `enable` answers each of [changes] in turn, every call, count and timer kept for the test. */
function fake({ platform = 'darwin', status = { vscode: 'on', version: '0.1.0' }, version = '0.2.0', changes = [] }: {
  platform?: NodeJS.Platform; status?: VscodeStatus; version?: string | null; changes?: Array<() => Promise<VscodeChange>>
} = {}) {
  const counted: string[][] = []
  const timers: Array<{ ms: number; run: () => void }> = []
  let enables = 0
  const deps: VscodeExtensionUpdateDeps = {
    platform,
    status: () => status,
    version: () => version,
    enable: () => changes[enables++](),
    after: (ms, run) => { timers.push({ ms, run }); return () => {} },
    count: (kind, reason) => { counted.push(reason === undefined ? [kind] : [kind, reason]) },
  }
  return { deps, counted, timers, enables: () => enables }
}

const updated = async (): Promise<VscodeChange> => ({ vscode: 'on', version: '0.2.0' })
/** Lets an enable's answer be taken. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

describe('the VS Code extension brought current', () => {
  it('on at another version runs enable once and counts updated', async () => {
    const run = fake({ changes: [updated] })
    startVscodeExtensionUpdate(run.deps)
    await settled()
    expect(run.enables()).toBe(1)
    expect(run.counted).toEqual([['updated']])
    expect(run.timers).toEqual([])
  })

  it.each<[string, Parameters<typeof fake>[0]]>([
    ['on at this version', { status: { vscode: 'on', version: '0.2.0' } }],
    ['absent', { status: { vscode: 'absent' } }],
    ['Windows', { platform: 'win32' }],
    ['no built extension', { version: null, status: { vscode: 'off' } }],
  ])('%s: nothing runs and nothing is counted', async (_, given) => {
    const run = fake({ ...given, changes: [updated] })
    startVscodeExtensionUpdate(run.deps)
    await settled()
    expect(run.enables()).toBe(0)
    expect(run.counted).toEqual([])
    expect(run.timers).toEqual([])
  })

  it('off stays off: enable never runs, and off is counted', async () => {
    const run = fake({ status: { vscode: 'off' }, changes: [updated] })
    startVscodeExtensionUpdate(run.deps)
    await settled()
    expect(run.enables()).toBe(0)
    expect(run.counted).toEqual([['off']])
    expect(run.timers).toEqual([])
  })

  it('a failed update counts its word and looks again after an hour, once', async () => {
    const run = fake({ changes: [async () => ({ vscode: 'off', error: 'timeout' }), updated] })
    startVscodeExtensionUpdate(run.deps)
    await settled()
    expect(run.counted).toEqual([['failed', 'timeout']])
    expect(run.timers.map(({ ms }) => ms)).toEqual([UPDATE_RETRY_MS])
    expect(UPDATE_RETRY_MS).toBe(3_600_000)

    run.timers[0].run()
    await settled()
    expect(run.enables()).toBe(2)
    expect(run.counted).toEqual([['failed', 'timeout'], ['updated']])
    expect(run.timers).toHaveLength(1)
  })

  it.each<[string, () => Promise<VscodeChange>]>([
    ['throws', () => { throw new Error('spawn code ENOENT /Users/someone') }],
    ['rejects', async () => { throw new Error('spawn code ENOENT /Users/someone') }],
  ])('an enable that %s is a failed update, never a throw', async (_, enable) => {
    const run = fake({ changes: [enable] })
    expect(() => startVscodeExtensionUpdate(run.deps)).not.toThrow()
    await settled()
    expect(run.counted).toEqual([['failed', 'failed']])
    expect(run.timers.map(({ ms }) => ms)).toEqual([UPDATE_RETRY_MS])
  })
})
