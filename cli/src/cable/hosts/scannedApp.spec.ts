// Which app a session the open scan found runs in, from its parents' executables alone. Every process here is made up:
// no test reads this machine's processes, and none reads any process's environment.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { ObservedSource, type ObservedDeps } from './observed.js'
import { appRoots, readBundleId, scannedApps, type ProcessName, type ScannedAppDeps } from './scannedApp.js'

const HOME = '/Users/someone'
const ROOTS = appRoots(HOME)
const GHOSTTY = '/Applications/Ghostty.app/Contents/MacOS/ghostty'

/** A made-up process table, each row `[pid, ppid, executable]`. */
const table = (rows: Array<[number, number, string]>): ProcessName[] => rows.map(([pid, ppid, executable]) => ({ pid, ppid, executable }))

function deps(rows: Array<[number, number, string]>, bundles: Record<string, string | undefined | Error> = {},
  platform: NodeJS.Platform = 'darwin') {
  const processes = vi.fn(async (): Promise<readonly ProcessName[]> => table(rows))
  const bundleId = vi.fn(async (bundle: string): Promise<string | undefined> => {
    const id = bundles[bundle]
    if (id instanceof Error) throw id
    return id
  })
  return { platform, roots: ROOTS, processes, bundleId } satisfies ScannedAppDeps
}

/** A session under `parents` processes, the outermost of them `top`. */
function chain(session: number, parents: number, top: string): Array<[number, number, string]> {
  const rows: Array<[number, number, string]> = [[session, session + 1, 'claude']]
  for (let i = 1; i < parents; i++) rows.push([session + i, session + i + 1, '/bin/sh'])
  rows.push([session + parents, 1, top])
  return rows
}

describe('scannedApps on macOS', () => {
  it('Claude Code under bash, bash and login under Orca\'s terminal host is in Orca', async () => {
    const host = `${HOME}/Library/Application Support/orca/daemon-host/macos/terminal-host-ab12/app.noindex/Orca Terminal Host.app`
    const d = deps([
      [500, 499, 'claude'], [499, 498, '/bin/bash'], [498, 497, '-bash'], [497, 496, 'login'],
      [496, 1, `${host}/Contents/MacOS/orca-terminal-host`], [1, 0, '/sbin/launchd'],
    ], { [host]: 'com.stablyai.orca' })
    expect(await scannedApps([500], d)).toEqual(new Map([[500, 'orca']]))
  })

  it('the outermost .app of a helper\'s path is the app', async () => {
    const d = deps([
      [700, 690, 'claude'], [690, 680, '/bin/zsh'],
      [680, 670, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'],
      [670, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
    ], { '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' })
    expect(await scannedApps([700], d)).toEqual(new Map([[700, 'vscode']]))
    expect(d.bundleId.mock.calls).toEqual([['/Applications/Visual Studio Code.app']])
  })

  it('a bundle no table lists is passed over, and the nearest listed app decides', async () => {
    const engine = `${HOME}/Library/Application Support/Claude/claude-code/1/x/claude.app`
    const d = deps([
      [800, 790, `${engine}/Contents/MacOS/claude`], [790, 1, '/Applications/Claude.app/Contents/MacOS/Claude'],
      [900, 890, 'claude'], [890, 880, '/bin/zsh'], [880, 870, '/Applications/kitty.app/Contents/MacOS/kitty'],
      [870, 860, '-zsh'], [860, 1, GHOSTTY],
    ], {
      [engine]: 'com.example.engine',
      '/Applications/Claude.app': 'com.anthropic.claudefordesktop',
      '/Applications/kitty.app': 'net.kovidgoyal.kitty',
      '/Applications/Ghostty.app': 'com.mitchellh.ghostty',
    })
    expect(await scannedApps([800, 900], d)).toEqual(new Map([[800, 'claude'], [900, 'kitty']]))
  })

  it('an app no table lists names nothing: never the unknown app', async () => {
    const d = deps([[1000, 990, 'claude'], [990, 1, '/Applications/Alacritty.app/Contents/MacOS/alacritty']],
      { '/Applications/Alacritty.app': 'org.alacritty' })
    expect(await scannedApps([1000], d)).toEqual(new Map())
  })

  it('tmux, launchd and a parent the table does not hold name nothing', async () => {
    // pid 1 is never read, whatever it is named.
    const d = deps([
      [1100, 1090, 'claude'], [1090, 1080, '-bash'], [1080, 1, 'tmux'], [1, 0, GHOSTTY],
      [1200, 1190, 'claude'],
    ], { '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps([1100, 1200], d)).toEqual(new Map())
    expect(d.bundleId).not.toHaveBeenCalled()
  })

  it('a walk stops after 16 parents, and at a loop', async () => {
    const d = deps([
      ...chain(2000, 16, GHOSTTY), ...chain(3000, 17, GHOSTTY), ...chain(4000, 40, GHOSTTY),
      [5000, 5001, 'claude'], [5001, 5000, '/bin/sh'],
    ], { '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps([2000, 3000, 4000, 5000], d)).toEqual(new Map([[2000, 'ghostty']]))
  })

  it('a bundle outside the four folders is not read', async () => {
    const paths = [
      `${HOME}/Downloads/Ghostty.app/Contents/MacOS/ghostty`,
      '/Volumes/USB/Ghostty.app/Contents/MacOS/ghostty',
      `/Applications/..${HOME}/Documents/Ghostty.app/Contents/MacOS/ghostty`,
      '/Applications/./Ghostty.app/Contents/MacOS/ghostty',
      '/Applications/Ghost\nty.app/Contents/MacOS/ghostty',
      `/Applications/${'a'.repeat(2000)}/Ghostty.app/Contents/MacOS/ghostty`,
      // An app's own folder is not a folder of apps.
      `${HOME}/Library/Containers/Ghostty.app/Contents/MacOS/ghostty`,
    ]
    const d = deps(paths.map((path, i) => [6000 + i, 1, path] as [number, number, string]))
    expect(await scannedApps(paths.map((_, i) => 6000 + i), d)).toEqual(new Map())
    expect(d.bundleId).not.toHaveBeenCalled()
  })

  it('a process name that is not a path is passed over', async () => {
    const d = deps([
      [7000, 1, 'claude'], [7100, 1, '-bash'], [7200, 1, `fix the bug in ${GHOSTTY}`],
    ], { '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps([7000, 7100, 7200], d)).toEqual(new Map())
    expect(d.bundleId).not.toHaveBeenCalled()
  })

  it('one bundle is read once a pass, however many sessions', async () => {
    const pids = Array.from({ length: 50 }, (_, i) => 8000 + i)
    const d = deps([...pids.map((pid) => [pid, 8999, 'claude'] as [number, number, string]), [8999, 1, GHOSTTY]],
      { '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps(pids, d)).toEqual(new Map(pids.map((pid) => [pid, 'ghostty'])))
    expect(d.bundleId).toHaveBeenCalledTimes(1)
  })

  it('at most 16 bundles a pass, read together: the sessions past them are left out', async () => {
    const pids = Array.from({ length: 20 }, (_, i) => 9000 + i)
    const d = deps(pids.flatMap((pid, i) => [[pid, pid + 100, 'claude'], [pid + 100, 1, `/Applications/App ${i}.app/Contents/MacOS/app`]] as Array<[number, number, string]>))
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    d.bundleId.mockImplementation(async () => { await gate; return 'com.mitchellh.ghostty' })
    const answer = scannedApps(pids, d)
    // Every read is asked before any answers.
    await vi.waitFor(() => expect(d.bundleId).toHaveBeenCalledTimes(16))
    release()
    expect(await answer).toEqual(new Map(pids.slice(0, 16).map((pid) => [pid, 'ghostty'])))
    expect(d.bundleId.mock.calls).toEqual(pids.slice(0, 16).map((_, i) => [`/Applications/App ${i}.app`]))
  })

  it('a bundle id that could not be read names nothing, and the walk goes on', async () => {
    const d = deps([
      [9500, 9501, 'claude'], [9501, 9502, '/Applications/A.app/Contents/MacOS/a'],
      [9502, 9503, '/Applications/B.app/Contents/MacOS/b'], [9503, 1, GHOSTTY],
    ], { '/Applications/A.app': undefined, '/Applications/B.app': new Error('unreadable'), '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps([9500], d)).toEqual(new Map([[9500, 'ghostty']]))
  })

  it('a table that could not be read names nothing', async () => {
    const d = deps([])
    expect(await scannedApps([100], d)).toEqual(new Map())
    expect(d.bundleId).not.toHaveBeenCalled()
  })

  it('the table is read once a pass, however many pids', async () => {
    const d = deps([[10, 1, 'claude'], [11, 1, 'claude'], [12, 1, 'claude']])
    await scannedApps([10, 11, 12], d)
    expect(d.processes).toHaveBeenCalledTimes(1)
  })

  it('with no pid nothing is read', async () => {
    const d = deps([[10, 1, GHOSTTY]])
    expect(await scannedApps([], d)).toEqual(new Map())
    expect(d.processes).not.toHaveBeenCalled()
  })

  it('nothing of a process is kept or said', async () => {
    const MARK = 'SECRET-TOKEN'
    // Its command line is never touched.
    const row = (pid: number, ppid: number, executable: string): RunningProcess => ({
      pid, ppid, executable, get args(): string { throw new Error('a command line was read') },
    })
    const d = deps([])
    d.processes.mockResolvedValue([row(100, 90, `${MARK} deploy to prod with this key`), row(90, 1, GHOSTTY), row(200, 1, `${MARK}`)])
    d.bundleId.mockResolvedValue('com.mitchellh.ghostty')
    const answer = await scannedApps([100, 200], d)
    expect(JSON.stringify([...answer])).toBe('[[100,"ghostty"]]')
  })
})

describe('scannedApps elsewhere', () => {
  it('on Linux the executable\'s name names the app', async () => {
    const d = deps([
      [10, 9, 'claude'], [9, 8, 'bash'], [8, 1, 'code'],
      [20, 1, 'cursor'], [30, 1, 'kitty'], [40, 1, 'ghostty'], [50, 1, 'wezterm-gui'],
    ], {}, 'linux')
    expect(await scannedApps([10, 20, 30, 40, 50], d)).toEqual(new Map([[10, 'vscode'], [20, 'cursor'], [30, 'kitty'], [40, 'ghostty'], [50, 'wezterm']]))
    expect(d.bundleId).not.toHaveBeenCalled()
  })

  it('on Linux windowsterminal and a name no table lists name nothing', async () => {
    const d = deps([[10, 1, 'windowsterminal'], [20, 1, 'alacritty']], {}, 'linux')
    expect(await scannedApps([10, 20], d)).toEqual(new Map())
  })

  it('on Windows nothing is learned and nothing is read', async () => {
    const d = deps([[10, 1, 'code']], {}, 'win32')
    expect(await scannedApps([10], d)).toEqual(new Map())
    expect(d.processes).not.toHaveBeenCalled()
    expect(d.bundleId).not.toHaveBeenCalled()
  })
})

describe('readBundleId', () => {
  it('asks plutil for CFBundleIdentifier alone, under 1 s', async () => {
    const exec = vi.fn(async () => 'com.mitchellh.ghostty\n')
    expect(await readBundleId('/Applications/Ghostty.app', exec)).toBe('com.mitchellh.ghostty')
    expect(exec.mock.calls).toEqual([['plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/Ghostty.app/Contents/Info.plist'], 1000]])
  })

  it('an answer that is no bundle id is none', async () => {
    for (const out of ['', '\n', 'a'.repeat(500), 'com.example bad', 'com/example', null]) {
      expect(await readBundleId('/Applications/X.app', async () => out)).toBeUndefined()
    }
    expect(await readBundleId('/Applications/X.app', async () => { throw new Error('spawn failed') })).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'darwin')('readBundleId with the real plutil', () => {
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
    + '<key>CFBundleIdentifier</key><string>com.mitchellh.ghostty</string></dict></plist>\n'

  it('reads an XML and a binary Info.plist, and nothing from a bundle with none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    try {
      for (const name of ['Xml.app', 'Binary.app', 'Empty.app']) mkdirSync(join(dir, name, 'Contents'), { recursive: true })
      writeFileSync(join(dir, 'Xml.app', 'Contents', 'Info.plist'), plist)
      const binary = join(dir, 'Binary.app', 'Contents', 'Info.plist')
      writeFileSync(binary, plist)
      execFileSync('plutil', ['-convert', 'binary1', binary])
      expect(readFileSync(binary).subarray(0, 6).toString()).toBe('bplist')
      expect(await readBundleId(join(dir, 'Xml.app'))).toBe('com.mitchellh.ghostty')
      expect(await readBundleId(join(dir, 'Binary.app'))).toBe('com.mitchellh.ghostty')
      expect(await readBundleId(join(dir, 'Empty.app'))).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('appRoots', () => {
  it('gives the four folders, each ending in a slash', () => {
    expect(appRoots(HOME)).toEqual(['/Applications/', '/System/Applications/', `${HOME}/Applications/`, `${HOME}/Library/Application Support/`])
  })
})

describe('the scan and a process name', () => {
  it('a process name that holds a prompt is never logged, kept or listed', async () => {
    const MARK = 'SECRET-TOKEN'
    const logs: string[] = []
    const procs = table([
      [100, 90, `${MARK} please rotate the key`], [90, 1, GHOSTTY],
      [200, 1, `/Applications/${MARK}.app/Contents/MacOS/x`],
    ])
    const src = new ObservedSource({
      now: () => 0,
      processes: async () => [],
      alive: () => true,
      openSessions: {
        owners: async () => new Map([['s1', { pid: 100, engine: 'claude', record: 's1' }], ['s2', { pid: 200, engine: 'claude', record: 's2' }]]),
        busy: async () => false,
      } as unknown as ObservedDeps['openSessions'],
      sessionRows: {
        find: async (wanted: ReadonlyMap<string, string>) => new Map([...wanted.keys()].map((id) => [id, { cwd: `/x/${id}`, transcriptPath: null }])),
      } as unknown as ObservedDeps['sessionRows'],
      lastAnswer: async () => undefined,
      fileStamp: async () => null,
      excluded: [],
      log: (line) => { logs.push(line) },
      // A reader whose error says what it was asked.
      apps: (pids) => scannedApps(pids, {
        platform: 'darwin', roots: ROOTS, processes: async () => procs,
        bundleId: async (bundle) => { if (bundle.includes(MARK)) throw new Error(`${bundle} unreadable`); return 'com.mitchellh.ghostty' },
      }),
    })
    await src.scanOpen()
    expect(src.list().map((a) => [a.sessionId, a.app, a.appPending])).toEqual([['s1', 'ghostty', undefined], ['s2', 'terminal', true]])
    const entries = [...(src as unknown as { entries: Map<string, unknown> }).entries.values()]
    expect(JSON.stringify([src.list(), entries, logs])).not.toContain(MARK)
  })
})

describe('the scan\'s files', () => {
  it('name no environment reader', () => {
    for (const file of ['./scannedApp.ts', './observed.ts']) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      for (const reader of [/processEnv\.js/, /\benviron\b/, /\beww\b/, /'-E'/, /process\.env/]) expect(source).not.toMatch(reader)
    }
  })
})
