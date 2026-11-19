// Which app a session the open scan found runs in, from its parents' executables alone. Every process here is made up:
// no test reads this machine's processes, and none reads any process's environment.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { ObservedSource, type ObservedDeps } from './observed.js'
import {
  appRoots, learnApps, parseProcessNames, ptyOwner, readBundleId, readProcessNames, scannedApps, WALK_PARENTS, type ProcessName,
  type ScannedAppDeps,
} from './scannedApp.js'

// The patient exec, as the scan's default reads get it: each call is kept, and a command a test gives an answer for is
// answered with it; any other runs for real.
const patient = vi.hoisted(() => ({ calls: [] as unknown[][], answers: {} as Record<string, string> }))
vi.mock('../../lib/patientExec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/patientExec.js')>()
  return {
    ...real,
    patientExec: (wrapped: Parameters<typeof real.patientExec>[0]) => {
      const through = real.patientExec(wrapped)
      return (...call: Parameters<ReturnType<typeof real.patientExec>>) => {
        const [file, args, options, done] = call
        patient.calls.push([wrapped, file, args, options])
        if (Object.hasOwn(patient.answers, file)) done(null, patient.answers[file], '')
        else through(...call)
      }
    },
  }
})
afterEach(() => {
  patient.calls.length = 0
  patient.answers = {}
})

const HOME = '/Users/someone'
const ROOTS = appRoots(HOME)
const GHOSTTY = '/Applications/Ghostty.app/Contents/MacOS/ghostty'

/** A made-up process table, each row `[pid, ppid, executable]`, and its tty after when it runs on one. */
const table = (rows: Array<[number, number, string, string?]>): ProcessName[] =>
  rows.map(([pid, ppid, executable, tty]) => ({ pid, ppid, executable, ...(tty === undefined ? {} : { tty }) }))

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

  // The Codex app's bundle is named ChatGPT.app, and its CLI runs inside a .app of its own within it.
  const CODEX_ROWS: Array<[number, number, string]> = [
    [500, 499, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
    [499, 1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'],
  ]

  it('a Codex session under the Codex app is in codex: the outermost .app of its path', async () => {
    const d = deps(CODEX_ROWS, { '/Applications/ChatGPT.app': 'com.openai.codex' })
    expect(await scannedApps([500], d)).toEqual(new Map([[500, 'codex']]))
    expect(d.bundleId.mock.calls).toEqual([['/Applications/ChatGPT.app']])
  })

  it('a session under cmux is in cmux', async () => {
    const d = deps([[500, 499, '/bin/zsh'], [499, 1, '/Applications/cmux.app/Contents/MacOS/cmux']],
      { '/Applications/cmux.app': 'com.cmuxterm.app' })
    expect(await scannedApps([500], d)).toEqual(new Map([[500, 'cmux']]))
  })

  it("OpenAI's chat app at that path names nothing", async () => {
    const d = deps(CODEX_ROWS, { '/Applications/ChatGPT.app': 'com.openai.chat' })
    expect(await scannedApps([500], d)).toEqual(new Map())
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

  it('a bundle id that could not be read ends the walk with no answer: an outer app would be a guess', async () => {
    const d = deps([
      [9500, 9501, 'claude'], [9501, 9503, '/Applications/A.app/Contents/MacOS/a'],
      [9600, 9601, 'claude'], [9601, 9503, '/Applications/B.app/Contents/MacOS/b'], [9503, 1, GHOSTTY],
    ], { '/Applications/A.app': undefined, '/Applications/B.app': new Error('unreadable'), '/Applications/Ghostty.app': 'com.mitchellh.ghostty' })
    expect(await scannedApps([9500, 9600], d)).toEqual(new Map())
  })

  it('a bundle past the 16 a pass ends its walk with no answer, though an outer one was read', async () => {
    // Fifteen sessions in apps of their own and one in Ghostty fill the pass; kitty, under Ghostty, is the 17th.
    const pids = Array.from({ length: 15 }, (_, i) => 9700 + i)
    const d = deps([
      ...pids.flatMap((pid, i) => [[pid, pid + 100, 'claude'], [pid + 100, 1, `/Applications/App ${i}.app/Contents/MacOS/app`]] as Array<[number, number, string]>),
      [9900, 9999, 'claude'],
      [9950, 9951, 'claude'], [9951, 9999, '/Applications/kitty.app/Contents/MacOS/kitty'], [9999, 1, GHOSTTY],
    ], {
      ...Object.fromEntries(pids.map((_, i) => [`/Applications/App ${i}.app`, 'com.example.app'])),
      '/Applications/kitty.app': 'net.kovidgoyal.kitty', '/Applications/Ghostty.app': 'com.mitchellh.ghostty',
    })
    expect(await scannedApps([...pids, 9900, 9950], d)).toEqual(new Map([[9900, 'ghostty']]))
    expect(d.bundleId).not.toHaveBeenCalledWith('/Applications/kitty.app')
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

  it('on Linux a session under a process named harness is in Harness', async () => {
    const d = deps([[10, 9, 'claude'], [9, 8, 'bash'], [8, 1, 'harness']], {}, 'linux')
    expect(await scannedApps([10], d)).toEqual(new Map([[10, 'harness']]))
  })

  it('a process named codex names no app', async () => {
    // The Codex CLI's own name: off macOS an exe name decides, and the CLI is no app.
    const d = deps([[500, 499, 'codex'], [499, 498, 'bash'], [498, 1, 'codex']], {}, 'linux')
    expect(await scannedApps([500], d)).toEqual(new Map())
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

// A terminal or an editor started from another host's pane keeps that pane's variables: only the process that made the
// agent's terminal says whose pane it is (docs/plans/2026-11-19-dial-linux-plan.md, Review Focus 1).
describe('the host that owns a process\'s terminal', () => {
  it('is the first of its parents on another terminal or on none: a terminal\'s or a multiplexer\'s server', () => {
    // An agent in Zellij's pane, whose server has no terminal; Zellij's client runs in kitty's window.
    const zellij = table([[100, 50, 'claude', 'pts/2'], [50, 29, 'bash', 'pts/2'], [29, 1, 'zellij'],
      [103, 21, 'zellij', 'pts/1'], [21, 20, 'bash', 'pts/1'], [20, 1, 'kitty']])
    expect(ptyOwner(100, zellij)).toBe('zellij')
    // kitty started from a Zellij pane: its window's terminal is kitty's, kitty itself on the pane's.
    const kitty = table([[400, 399, 'claude', 'pts/7'], [399, 398, 'zsh', 'pts/7'], [398, 50, 'kitty', 'pts/2'],
      [50, 29, 'bash', 'pts/2'], [29, 1, 'zellij']])
    expect(ptyOwner(400, kitty)).toBe('kitty')
    // tmux inside a Zellij pane: tmux's server, which has no terminal, made the agent's.
    const tmux = table([[500, 499, 'claude', 'pts/4'], [499, 498, 'bash', 'pts/4'], [498, 1, 'tmux: server'],
      [497, 50, 'tmux: client', 'pts/2'], [50, 29, 'bash', 'pts/2'], [29, 1, 'zellij']])
    expect(ptyOwner(500, tmux)).toBe('tmux')
  })

  it('names WezTerm\'s GUI and mux server, kitty, Zellij and tmux, by Linux\'s names and by macOS\'s paths', () => {
    const owned = (owner: string) => ptyOwner(10, table([[10, 9, 'claude', 'pts/3'], [9, 8, '-zsh', 'pts/3'], [8, 1, owner]]))
    expect(['wezterm-gui', 'wezterm-mux-ser', 'wezterm-mux-server', '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui',
      'kitty', '/Applications/kitty.app/Contents/MacOS/kitty', 'zellij', '/opt/homebrew/bin/zellij',
      'tmux: server', '/opt/homebrew/bin/tmux'].map(owned))
      .toEqual(['wezterm', 'wezterm', 'wezterm', 'wezterm', 'kitty', 'kitty', 'zellij', 'zellij', 'tmux', 'tmux'])
    // Any other terminal or editor owns no pane the dial types into.
    for (const other of ['code', 'cursor', 'ghostty', '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', 'orca', 'login']) {
      expect(owned(other), other).toBeUndefined()
    }
  })

  // VS Code started from WezTerm's pane 7 keeps WEZTERM_PANE=7 in its terminals: its own pty host made the agent's.
  it('a terminal started from a host\'s pane is not that host\'s', () => {
    const rows = table([[900, 899, 'codex', 'pts/9'], [899, 800, 'bash', 'pts/9'], [800, 700, 'code'],
      [700, 600, 'code', 'pts/5'], [600, 590, 'zsh', 'pts/5'], [590, 1, 'wezterm-gui']])
    expect(ptyOwner(900, rows)).toBeUndefined()
  })

  it('none for a process on no terminal, one the table does not hold, or a walk that ends on its terminal', () => {
    expect(ptyOwner(29, table([[29, 1, 'zellij']]))).toBeUndefined()
    expect(ptyOwner(100, table([[29, 1, 'zellij']]))).toBeUndefined()
    // Its terminal's maker is not in the table, or is init: the walk ends with no owner.
    expect(ptyOwner(100, table([[100, 50, 'claude', 'pts/2'], [50, 29, 'bash', 'pts/2']]))).toBeUndefined()
    expect(ptyOwner(100, table([[100, 1, 'claude', 'pts/2']]))).toBeUndefined()
  })

  it('walks no further than the scan does', () => {
    // The agent under WALK_PARENTS shells on its own terminal: kitty is one past the walk's end.
    const shells = Array.from({ length: WALK_PARENTS }, (_, i): [number, number, string, string] => [101 + i, 102 + i, 'sh', 'pts/1'])
    const rows = table([[100, 101, 'claude', 'pts/1'], ...shells, [101 + WALK_PARENTS, 1, 'kitty']])
    expect(ptyOwner(100, rows)).toBeUndefined()
    expect(ptyOwner(101, rows)).toBe('kitty')
  })
})

describe('the process table the scan reads', () => {
  // Recorded as `ps -axo pid=,ppid=,tty=,comm=` prints it on macOS, the names made up: `comm` last is the whole path, and
  // a process on no terminal has `??`. With a column after it (`comm=,lstart=,args=`), the first rows' names came cut
  // to `/Users/someone/A` and `/Applications/Vi`.
  const MACOS = [
    '    1     0 ??       /sbin/launchd',
    '  612     1 ??       /Users/someone/Applications/Ghostty.app/Contents/MacOS/ghostty',
    '  640   612 ttys004  /usr/bin/login',
    '  641   640 ttys004  -zsh',
    '  700   641 ttys004  claude',
    '  810     1 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
    '  820   810 ttys005  /bin/zsh',
    '  830   820 ttys005  claude',
    '',
  ].join('\n')
  // As procps prints it: `comm` is the task name, cut to 15 characters either way, and a process on no terminal has `?`.
  const LINUX = ['      1       0 ?        systemd', '   2201       1 ?        ghostty', '   2230    2201 pts/1    bash',
    '   2300    2230 pts/1    claude', '   2400       1 ?        Visual Studio C', ''].join('\n')

  it('parses macOS rows, each name whole however long, spaces and all, and each one\'s terminal', () => {
    expect(parseProcessNames(MACOS)).toEqual(table([
      [1, 0, '/sbin/launchd'],
      [612, 1, '/Users/someone/Applications/Ghostty.app/Contents/MacOS/ghostty'],
      [640, 612, '/usr/bin/login', 'ttys004'], [641, 640, '-zsh', 'ttys004'], [700, 641, 'claude', 'ttys004'],
      [810, 1, '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)'],
      [820, 810, '/bin/zsh', 'ttys005'], [830, 820, 'claude', 'ttys005'],
    ]))
  })

  it('parses Linux rows, each name the task\'s, and each one\'s terminal', () => {
    expect(parseProcessNames(LINUX)).toEqual(table([
      [1, 0, 'systemd'], [2201, 1, 'ghostty'], [2230, 2201, 'bash', 'pts/1'], [2300, 2230, 'claude', 'pts/1'],
      [2400, 1, 'Visual Studio C'],
    ]))
  })

  it('a line that is no row is passed over', () => {
    expect(parseProcessNames(['', '   ', 'PID PPID TTY COMM', '  12', '  12   1', '  12   1 ?', '  x   1 ? claude',
      '  13   1 claude', '  14   1 ?  claude  '].join('\n'))).toEqual(table([[14, 1, 'claude']]))
  })

  it('an app\'s path longer than 16 characters names its app, as the read that cut it never did', async () => {
    const d = deps([], { [`${HOME}/Applications/Ghostty.app`]: 'com.mitchellh.ghostty', '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' })
    d.processes.mockResolvedValue(parseProcessNames(MACOS))
    expect(await scannedApps([700, 830], d)).toEqual(new Map([[700, 'ghostty'], [830, 'vscode']]))
  })

  it.skipIf(process.platform === 'win32')('runs one ps with comm last: no command line, no environment, under 3 s and 1 MiB', async () => {
    const exec = vi.fn(async (): Promise<string | null> => '  100     1 ?  claude\n')
    await learnApps([100], exec)
    expect(exec.mock.calls).toEqual([['ps', ['-axo', 'pid=,ppid=,tty=,comm='], { timeout: 3_000, maxBuffer: 1024 * 1024 }]])
  })

  it.skipIf(process.platform === 'win32')('runs ps through the patient exec: a held loop never reads as an empty table', async () => {
    patient.answers = { ps: '  100     1 ?  claude\n' }
    expect(await learnApps([100])).toEqual(new Map())
    expect(patient.calls).toEqual([[execFile, 'ps', ['-axo', 'pid=,ppid=,tty=,comm='], { timeout: 3_000, maxBuffer: 1024 * 1024 }]])
  })

  it('a ps that failed or listed nobody is an error that says nothing of what it printed', async () => {
    const MARK = 'SECRET-TOKEN'
    for (const out of [null, '', `${MARK} rotate the key\n`]) {
      const error = await readProcessNames(async () => out).catch((e: unknown) => e)
      expect(error).toEqual(new Error('process table not read'))
    }
  })
})

describe.skipIf(process.platform === 'win32')('the scan\'s process read', () => {
  it('runs once for a scan of several new sessions, never on a tick, nor at a scan with no new session', async () => {
    const owners = new Map<string, { pid: number; engine: string; record: string }>()
    const exec = vi.fn(async (): Promise<string | null> => [...owners.values()].map(({ pid }) => `  ${pid}     1 ?  claude`).join('\n'))
    const src = new ObservedSource({
      now: () => 0,
      processes: async () => [...owners.values()].map(({ pid }) => ({ pid, generation: `g${pid}` })),
      alive: () => true,
      openSessions: { owners: async () => new Map(owners), busy: async () => false } as unknown as ObservedDeps['openSessions'],
      sessionRows: {
        find: async (wanted: ReadonlyMap<string, string>) => new Map([...wanted.keys()].map((id) => [id, { cwd: `/x/${id}`, transcriptPath: null }])),
      } as unknown as ObservedDeps['sessionRows'],
      lastAnswer: async () => undefined,
      fileStamp: async () => null,
      excluded: [],
      log: () => {},
      apps: (pids) => learnApps(pids, exec),
    })
    const open = (...ids: string[]): void => { for (const id of ids) owners.set(id, { pid: 100 + owners.size, engine: 'claude', record: id }) }
    await src.tick()
    await src.scanOpen()
    expect(exec).not.toHaveBeenCalled()
    open('a', 'b', 'c')
    await src.scanOpen()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(src.list().map((a) => [a.sessionId, a.appPending])).toEqual([['a', true], ['b', true], ['c', true]])
    // The three are listed: a tick, and a scan that finds no other, have nothing to learn.
    await src.tick()
    await src.scanOpen()
    expect(exec).toHaveBeenCalledTimes(1)
    open('d')
    await src.scanOpen()
    expect(exec).toHaveBeenCalledTimes(2)
  })
})

describe('readBundleId', () => {
  it('asks plutil for CFBundleIdentifier alone, under 1 s and 1 KiB', async () => {
    const exec = vi.fn(async (): Promise<string | null> => 'com.mitchellh.ghostty\n')
    expect(await readBundleId('/Applications/Ghostty.app', exec)).toBe('com.mitchellh.ghostty')
    expect(exec.mock.calls).toEqual([['plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/Ghostty.app/Contents/Info.plist'],
      { timeout: 1_000, maxBuffer: 1024 }]])
  })

  it('runs plutil through the patient exec: a held loop never reads as a bundle with no id', async () => {
    patient.answers = { plutil: 'com.mitchellh.ghostty\n' }
    expect(await readBundleId('/Applications/Ghostty.app')).toBe('com.mitchellh.ghostty')
    expect(patient.calls).toEqual([[execFile, 'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/Ghostty.app/Contents/Info.plist'],
      { timeout: 1_000, maxBuffer: 1024 }]])
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

  it('read the processes with one ps, its tty, then comm last: no command line, and no read that cuts the name', () => {
    const source = readFileSync(fileURLToPath(new URL('./scannedApp.ts', import.meta.url)), 'utf8')
    for (const reader of [/listProcesses/, /processTable/, /processRows/, /\bargs=/, /\bcommand=/, /lstart/, /\/proc\//]) {
      expect(source).not.toMatch(reader)
    }
    expect(source.match(/'ps'/g)).toEqual(["'ps'"])
    expect(source).toContain("'ps', ['-axo', 'pid=,ppid=,tty=,comm=']")
  })
})
