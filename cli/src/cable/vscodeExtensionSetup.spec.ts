/**
 * Harness's VS Code extension set up once a computer, against a fake VS Code: its app there or not, its record of
 * extensions in memory, and a `code` that records each run and answers from a list; the two records the setup reads and
 * writes are in memory too. The real `code`, /Applications and ~/.vscode are never touched.
 */
import { describe, expect, it } from 'vitest'
import type { DialRemoved, Read, SetupCount } from '../devices/dialSkillFiles.js'
import { VSCODE_EXTENSION_ID, type VscodeExtensionDeps } from '../devices/vscodeExtension.js'
import { createVscodeExtensionSetup } from './vscodeExtensionSetup.js'

const INSTALL = '--install-extension'
const UNINSTALL = '--uninstall-extension'
const HOUR = 3_600_000
const OK = { code: 0, timedOut: false }
const RECORD = '/Users/someone/.vscode/extensions/extensions.json'

/** Lets a timer's pass finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

/**
 * A computer with VS Code ([app]) and a dial attached here once ([dial]), the extension [installed] at that version or
 * not, and a CLI that carries the extension at [build] (null: none built). A run of `code` that exits 0 leaves the
 * extension at [build] after an install and gone after an uninstall.
 */
function rig({ platform = 'darwin', app = true, dial = true, installed, build = '0.6.60' }: {
  platform?: NodeJS.Platform; app?: boolean; dial?: boolean; installed?: string; build?: string | null
} = {}) {
  const state = {
    app, installed, build,
    removed: {} as Read<DialRemoved>,
    record: { dial } as { dial: boolean; version?: string } | undefined,
    saves: true,
    answers: [] as Array<{ code: number | null; timedOut: boolean }>,
    /** What happens while `code` runs with this flag, before it answers. */
    during: undefined as ((flag: string) => void) | undefined,
    /** Held until the test lets `code` answer. */
    hold: undefined as Promise<void> | undefined,
    /** What a read of dial-setup.json throws. */
    fault: undefined as Error | undefined,
  }
  const runs: string[] = []
  const counted: Array<[SetupCount] | [SetupCount, string]> = []
  const timers: Array<{ ms: number; run: () => void }> = []
  const vscode: VscodeExtensionDeps = {
    editor: 'vscode',
    real: (path) => path,
    platform,
    home: '/Users/someone',
    pathVar: '',
    exists: () => state.app,
    executable: () => state.app,
    read: (path) => path === RECORD && state.installed !== undefined
      ? JSON.stringify([{ identifier: { id: VSCODE_EXTENSION_ID }, version: state.installed }]) : null,
    run: async (_file, args) => {
      runs.push(args[0])
      state.during?.(args[0])
      await state.hold
      const answer = state.answers.shift() ?? OK
      if (answer.code === 0) state.installed = args[0] === INSTALL ? state.build ?? undefined : undefined
      return answer
    },
    files: () => state.build === null ? null : {
      manifest: JSON.stringify({ name: 'harness-device', displayName: 'Harness Device', description: 'The dial.', version: state.build, publisher: 'autonomous-ai', engines: { vscode: '^1.75.0' } }),
      main: '',
    },
    tempDir: () => '/nowhere/vsix',
    write: () => {},
    remove: () => {},
  }
  const setup = createVscodeExtensionSetup({
    vscode,
    removed: () => state.removed,
    recorded: () => {
      if (state.fault) throw state.fault
      return state.record
    },
    record: (version) => {
      if (state.saves && state.record) state.record = { ...state.record, version }
      return state.saves
    },
    after: (ms, run) => { timers.push({ ms, run }) },
    count: (kind, reason) => { counted.push(reason === undefined ? [kind] : [kind, reason]) },
  })
  return { state, runs, counted, timers, setup }
}

describe('Harness\'s VS Code extension, set up once a computer', () => {
  it('a dial attached here and VS Code there: installed once, recorded at this version and counted set up', async () => {
    const r = rig()
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.installed).toBe('0.6.60')
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
    expect(r.counted).toEqual([['set up']])

    // The passes after, at a start or an attach, find it recorded and run nothing.
    await r.setup.pass()
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.counted).toEqual([['set up']])
    expect(r.timers).toEqual([])
  })

  it('uninstalled in VS Code after the setup: never installed again, and left removed is counted once a version', async () => {
    const r = rig()
    await r.setup.pass()
    // The person uninstalls it in VS Code's Extensions view.
    r.state.installed = undefined
    await r.setup.pass()
    expect(r.counted).toEqual([['set up']])

    // A CLI update, then its start and an attach.
    r.state.build = '0.6.61'
    await r.setup.pass()
    await r.setup.pass()

    expect(r.runs).toEqual([INSTALL])
    expect(r.state.installed).toBeUndefined()
    expect(r.state.record).toEqual({ dial: true, version: '0.6.61' })
    expect(r.counted).toEqual([['set up'], ['left removed']])
  })

  it('removed by `harness device vscode disable`: nothing runs, nothing is recorded, off or on at another version', async () => {
    for (const installed of [undefined, '0.6.59']) {
      const r = rig({ installed })
      r.state.removed = { vscode: true }
      await r.setup.pass()
      expect(r.runs, installed).toEqual([])
      expect(r.state.record, installed).toEqual({ dial: true })
      expect(r.counted, installed).toEqual([])
    }
  })

  it.each<[string, (r: ReturnType<typeof rig>) => void]>([
    ['dial-skill.json could not be read', (r) => { r.state.removed = { unread: true } }],
    ['dial-setup.json could not be read', (r) => { r.state.record = undefined }],
  ])('%s: nothing runs and nothing is recorded', async (_, given) => {
    const r = rig({ installed: '0.6.59' })
    given(r)
    await r.setup.pass()
    expect(r.runs).toEqual([])
    expect(r.state.record?.version).toBeUndefined()
    expect(r.counted).toEqual([])
  })

  it('no VS Code: nothing runs and nothing is recorded; one installed since is set up at the next pass', async () => {
    const r = rig({ app: false })
    await r.setup.pass()
    expect(r.runs).toEqual([])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])

    r.state.app = true
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.counted).toEqual([['set up']])
  })

  it('no dial yet: nothing runs and nothing is recorded; the first attach sets it up', async () => {
    const r = rig({ dial: false })
    await r.setup.pass()
    expect(r.runs).toEqual([])
    expect(r.state.record).toEqual({ dial: false })
    expect(r.counted).toEqual([])

    // The attach records the dial before its pass (dialSetup.ts).
    r.state.record = { dial: true }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
  })

  it('on at another version: brought current, recorded and counted updated, a dial here or not', async () => {
    const r = rig({ installed: '0.6.59', dial: false })
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.installed).toBe('0.6.60')
    expect(r.state.record).toEqual({ dial: false, version: '0.6.60' })
    expect(r.counted).toEqual([['updated']])
  })

  it('on at this version already: recorded, with nothing run or counted', async () => {
    const r = rig({ installed: '0.6.60' })
    await r.setup.pass()
    expect(r.runs).toEqual([])
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
    expect(r.counted).toEqual([])
  })

  it.each([
    ['failed', { code: 1, timedOut: false }],
    ['timeout', { code: null, timedOut: true }],
  ])('an install that fails (%s) records nothing and is tried again an hour later, no sooner', async (word, answer) => {
    const r = rig()
    r.state.answers.push(answer)
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', word]])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    // A start or an attach within the hour runs nothing.
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])

    r.timers[0].run()
    await settled()
    expect(r.runs).toEqual([INSTALL, INSTALL])
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
    expect(r.counted).toEqual([['failed', word], ['set up']])
    expect(r.timers).toHaveLength(1)
  })

  it('a disable that lands during the install is honoured: uninstalled, and nothing recorded', async () => {
    const r = rig()
    r.state.during = (flag) => { if (flag === INSTALL) r.state.removed = { vscode: true } }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL, UNINSTALL])
    expect(r.state.installed).toBeUndefined()
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])

    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL, UNINSTALL])
  })

  it('the uninstall a disable during the install owes is tried again an hour later when it fails', async () => {
    const r = rig()
    r.state.during = (flag) => { if (flag === INSTALL) r.state.removed = { vscode: true } }
    r.state.answers.push(OK, { code: 1, timedOut: false })
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL, UNINSTALL])
    expect(r.state.installed).toBe('0.6.60')
    expect(r.counted).toEqual([['failed', 'failed']])

    r.timers[0].run()
    await settled()
    expect(r.runs).toEqual([INSTALL, UNINSTALL, UNINSTALL])
    expect(r.state.installed).toBeUndefined()
    expect(r.state.record).toEqual({ dial: true })

    // Owed no more: the passes after leave it removed.
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL, UNINSTALL, UNINSTALL])
  })

  it('a removal that cannot be read after the install undoes nothing and records nothing; the next pass records it', async () => {
    const r = rig()
    r.state.during = () => { r.state.removed = { unread: true } }
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])

    r.state.removed = {}
    await r.setup.pass()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
  })

  it('a record that cannot be saved counts failed save, and is tried again an hour later', async () => {
    const r = rig()
    r.state.saves = false
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'save']])
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    r.state.saves = true
    r.timers[0].run()
    await settled()
    expect(r.runs).toEqual([INSTALL])
    expect(r.state.record).toEqual({ dial: true, version: '0.6.60' })
  })

  it('a pass that throws counts failed error, never its message, and is tried again an hour later', async () => {
    const r = rig()
    r.state.fault = new Error('EIO /Users/someone/.harness')
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'error']])
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])
  })

  it('one pass at a time: one asked while another installs runs nothing', async () => {
    const r = rig()
    let answer!: () => void
    r.state.hold = new Promise((resolve) => { answer = resolve })
    const first = r.setup.pass()
    await r.setup.pass()
    answer()
    await first
    expect(r.runs).toEqual([INSTALL])
    expect(r.counted).toEqual([['set up']])
  })

  it.each([
    ['Windows', { platform: 'win32' as const }],
    ['no built extension', { build: null }],
  ])('%s: nothing runs and nothing is recorded', async (_, given) => {
    const r = rig({ installed: '0.6.59', ...given })
    await r.setup.pass()
    expect(r.runs).toEqual([])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])
  })
})
