// Where a Codex session its own server runs is seen. Every process here is made up: no test reads this machine's
// processes, their terminals or their folders.
import { describe, expect, it, vi } from 'vitest'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { codexServed, type CodexServedDeps, MAX_CLIENTS, servedLookup } from './codexServed.js'
import { appRoots, type ProcessName, scannedApps } from './scannedApp.js'

const HOME = '/Users/someone'
const TERMINAL = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal'
const ITERM = '/Applications/iTerm.app/Contents/MacOS/iTerm2'
const CHATGPT = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'
const CHATGPT_CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'
const BUNDLES: Record<string, string> = {
  '/System/Applications/Utilities/Terminal.app': 'com.apple.Terminal',
  '/Applications/iTerm.app': 'com.googlecode.iterm2',
  '/Applications/ChatGPT.app': 'com.openai.codex',
}
const BREW = '/opt/homebrew/bin/codex'
const DAEMON_BIN = `${HOME}/.codex/packages/app-server-daemon/current/bin/codex`
/** The daemon as Codex 0.172 starts it (rust-v0.172.0): its own options after `app-server`, `-c` among them. */
const DAEMON_ARGS = `${DAEMON_BIN} app-server --remote-control --listen unix:// --analytics-default-enabled -c features.x=true --managed-daemon`

/** A row as externals/support.ts listProcesses gives it on macOS: `executable` cut to 16 bytes, the whole path beside. */
const row = (pid: number, ppid: number, command: string, args: string = command): RunningProcess =>
  ({ pid, ppid, executable: command.slice(0, 16), commandPath: command, args })

/** Terminal, a login shell and the TUI typed in it (500, on ttys005, in /work/app); iTerm2 and one in /work/other (600). */
const TERMINAL_TUI = [row(10, 1, TERMINAL), row(11, 10, 'login'), row(12, 11, '-zsh'), row(500, 12, BREW, 'codex')]
const ITERM_TUI = [row(20, 1, ITERM), row(21, 20, 'login'), row(22, 21, '-zsh'), row(600, 22, BREW, 'codex')]

/** Each made-up process's terminal, as ps names it (`ttys005`), and its folder, as the kernel resolved it. */
function deps(rows: readonly RunningProcess[], places: Record<number, { tty?: string; cwd?: string }> = {}) {
  const processes = vi.fn(async () => rows)
  const tty = vi.fn(async (pid: number) => places[pid]?.tty)
  const cwds = vi.fn(async (pids: readonly number[]) =>
    new Map(pids.flatMap((pid) => (places[pid]?.cwd ? [[pid, places[pid].cwd!] as const] : []))))
  // The scan's own walk, over the rows it is handed, its bundles' ids made up.
  const apps = vi.fn((pids: readonly number[], names: readonly ProcessName[]) => scannedApps(pids, {
    platform: 'darwin', roots: appRoots(HOME), processes: async () => names, bundleId: async (bundle) => BUNDLES[bundle], home: HOME,
  }))
  // macOS's /tmp is /private/tmp, as lsof reports a folder.
  const folder = vi.fn(async (path: string) => path.replace(/^\/tmp\//, '/private/tmp/'))
  return { platform: 'darwin' as const, processes, tty, cwds, apps, folder } satisfies CodexServedDeps
}

describe('codexServed', () => {
  it('says nothing of a caller no Codex server is: a shell, another engine, a TUI that runs its own hooks', async () => {
    const d = deps([...TERMINAL_TUI, row(700, 12, '/usr/local/bin/claude', 'claude')], { 500: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 12, cwd: '/work/app' }, { pid: 700, cwd: '/work/app' }, { pid: 500, cwd: '/work/app' },
      { pid: 999, cwd: '/work/app' }], d)).toEqual([undefined, undefined, undefined, undefined])
    // Nothing but the table is read for them.
    expect(d.tty).not.toHaveBeenCalled()
    expect(d.cwds).not.toHaveBeenCalled()
    expect(d.apps).not.toHaveBeenCalled()
  })

  it('places a session the daemon runs by the one TUI on a terminal in its folder: its app, its tab and its process', async () => {
    // Diego's: the daemon under launchd, its TUI in Terminal, another in iTerm2 in another folder.
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/other' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
  })

  it('passes the hook\'s shell that did not exec: its caller is the daemon still', async () => {
    const d = deps([...TERMINAL_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS), row(901, 900, '/bin/zsh', '/bin/zsh -lc node notify.mjs')],
      { 500: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 901, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
  })

  it('never takes the app of the TUI that started the daemon: its client is the one in the session\'s folder', async () => {
    // The first TUI, in iTerm2, still runs, and the daemon is its child.
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 600, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/other' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
    expect(await codexServed([{ pid: 900, cwd: '/work/other' }], d))
      .toEqual([{ client: { app: 'iterm', tty: '/dev/ttys009', pid: 600 } }])
  })

  it('takes npm\'s node launcher and its native Codex as one TUI', async () => {
    const npm = `${HOME}/.npm-global/lib/node_modules/@openai/codex`
    const d = deps([row(10, 1, TERMINAL), row(12, 10, '-zsh'),
      row(500, 12, '/opt/homebrew/bin/node', `node ${npm}/bin/codex.js`),
      row(501, 500, `${npm}/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex`),
      row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
    { 500: { tty: 'ttys005', cwd: '/work/app' }, 501: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
  })

  it('never guesses: none in the folder, two there, or one whose parents name no app leaves the client unknown', async () => {
    const tmux = [row(30, 1, '/opt/homebrew/bin/tmux'), row(31, 30, '-zsh'), row(800, 31, BREW, 'codex')]
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, ...tmux, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], {
      500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/app' },
      800: { tty: 'ttys012', cwd: '/work/tmux' },
    })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }, { pid: 900, cwd: '/work/none' }, { pid: 900, cwd: '/work/tmux' },
      { pid: 900 }], d)).toEqual([{}, {}, {}, {}])
  })

  it('counts only a TUI on a terminal: Harness\'s own `codex queue` runs on none', async () => {
    const d = deps([...TERMINAL_TUI, row(700, 1, BREW, `${BREW} queue --thread x`), row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 700: { cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
    // Every Codex's folder in one read, and only the terminals of those in the session's, one process a read.
    expect(d.cwds.mock.calls).toEqual([[[500, 700]]])
    expect(d.tty.mock.calls).toEqual([[500], [700]])
  })

  it('reads each TUI\'s terminal once a lookup, for every ask in its folder: the scan asks for every session at once', async () => {
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }, { pid: 900, cwd: '/work/app' }], d)).toEqual([{}, {}])
    expect(d.tty.mock.calls).toEqual([[500], [600]])
  })

  it('tells no client from one whose terminal could not be read, and gives no tab of a form no tab has', async () => {
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/app' } })
    d.tty.mockImplementation(async (pid: number) => { if (pid === 600) throw new Error('ps failed'); return 'ttys005' })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual([{}])
    const odd = deps([...TERMINAL_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], { 500: { tty: 'console', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], odd)).toEqual([{ client: { app: 'terminal-app', pid: 500 } }])
  })

  it('matches the folder as the kernel resolved it', async () => {
    const d = deps([...TERMINAL_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], { 500: { tty: 'ttys005', cwd: '/private/tmp/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/tmp/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
  })

  it('fails on a table that could not be read, as every caller would read as no server', async () => {
    // externals/support.ts listProcesses gives none when ps failed: it always lists itself.
    const d = deps([])
    await expect(codexServed([{ pid: 900, cwd: '/work/app' }], d)).rejects.toThrow()
  })

  it('says nothing of an app\'s own server, reading no TUI: it runs with its app\'s environment, so its hints place it', async () => {
    const d = deps([...TERMINAL_TUI, row(40, 1, CHATGPT), row(41, 40, CHATGPT_CODEX, `${CHATGPT_CODEX} app-server --analytics-default-enabled`)],
      { 500: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 41, cwd: '/work/app' }], d)).toEqual([undefined])
    expect(d.tty).not.toHaveBeenCalled()
    expect(d.cwds).not.toHaveBeenCalled()
  })

  it('reads each thing once for every ask, and past MAX_CLIENTS TUIs tells none apart', async () => {
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/other' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }, { pid: 900, cwd: '/work/other' }], d)).toEqual([
      { client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }, { client: { app: 'iterm', tty: '/dev/ttys009', pid: 600 } },
    ])
    expect([d.processes, d.cwds, d.tty].map((read) => read.mock.calls.length)).toEqual([1, 1, 2])
    const many = Array.from({ length: MAX_CLIENTS + 1 }, (_, i) => row(1000 + i, 12, BREW, 'codex'))
    const crowded = deps([...TERMINAL_TUI, ...many, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], { 500: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], crowded)).toEqual([{}])
    expect(crowded.cwds).not.toHaveBeenCalled()
    expect(crowded.tty).not.toHaveBeenCalled()
  })
})

describe('servedLookup', () => {
  // Only whether there is one: calling it would read this machine's processes.
  it('reads this machine on macOS and Linux, and asks nothing on Windows, where no process\'s folder can be read', () => {
    expect(servedLookup('darwin')).toBeTypeOf('function')
    expect(servedLookup('linux')).toBeTypeOf('function')
    expect(servedLookup('win32')).toBeUndefined()
  })
})
