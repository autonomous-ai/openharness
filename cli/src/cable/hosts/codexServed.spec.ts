// Where a Codex session its own server runs is seen. Every process here is made up: no test reads this machine's
// processes, their terminals or their folders.
import { describe, expect, it, vi } from 'vitest'
import type { RunningProcess } from '../../lib/sessionSearch/externals/types.js'
import { codexServed, type CodexServedDeps, MAX_CLIENTS, servedLookup } from './codexServed.js'
import type { Nested, NestedPlace } from './outer.js'
import { appRoots, type ProcessName, scannedApps, type WindowsProcess } from './scannedApp.js'

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

  it('never guesses: none in the folder, two there in two apps, or one whose parents name no app leaves the client unknown', async () => {
    const tmux = [row(30, 1, '/opt/homebrew/bin/tmux'), row(31, 30, '-zsh'), row(800, 31, BREW, 'codex')]
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, ...tmux, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], {
      500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009', cwd: '/work/app' },
      800: { tty: 'ttys012', cwd: '/work/tmux' },
    })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }, { pid: 900, cwd: '/work/none' }, { pid: 900, cwd: '/work/tmux' },
      { pid: 900 }], d)).toEqual([{}, {}, {}, {}])
  })

  it('places a session at the app when every TUI on a terminal in its folder is in that one app, with no tab', async () => {
    // Two Terminal tabs in one folder (Ken's VM, 2026-11-27, #4663 step 10): whichever is the client, it is in Terminal.
    const secondTab = [row(13, 10, 'login'), row(14, 13, '-zsh'), { ...row(501, 14, BREW, 'codex'), generation: 'ps:1764230400000' }]
    const d = deps([...TERMINAL_TUI, ...secondTab, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 501: { tty: 'ttys006', cwd: '/work/app' } })
    // With both TUIs and the start the table read for each, so the session leaves Terminal's page once one of them exits,
    // its pid then another process's or none (observed.ts tick).
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual(
      [{ client: { app: 'terminal-app' }, clients: [{ pid: 500 }, { pid: 501, generation: 'ps:1764230400000' }] }])
    // Both TUIs' apps in the one walk.
    expect(d.apps.mock.calls.at(-1)![0]).toEqual([500, 501])
  })

  it('never takes the app of two TUIs when one of them names none: Terminal\'s beside one in tmux', async () => {
    const tmux = [row(30, 1, '/opt/homebrew/bin/tmux'), row(31, 30, '-zsh'), row(800, 31, BREW, 'codex')]
    const d = deps([...TERMINAL_TUI, ...tmux, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 800: { tty: 'ttys012', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual([{}])
  })

  it('never guesses past a TUI whose folder could not be read: it may be a second one in the session\'s', async () => {
    // Another user's Codex, whose folder lsof may not read, beside the one in /work/app.
    const d = deps([...TERMINAL_TUI, ...ITERM_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      { 500: { tty: 'ttys005', cwd: '/work/app' }, 600: { tty: 'ttys009' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual([{}])
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

  it('takes only the daemon\'s own arguments for the daemon: any other server, in no app, is placed by its hints', async () => {
    // `codex mcp-server` under the person's tmux, an app server over stdio under an editor no app root names, and one
    // started by hand on a unix socket, which a TUI's `--remote` reaches as it reaches the daemon.
    const tmux = [row(30, 1, '/opt/homebrew/bin/tmux'), row(31, 30, '-zsh'), row(800, 31, BREW, `${BREW} mcp-server`)]
    const editor = [row(50, 1, '/opt/idea/bin/idea'), row(51, 50, BREW, `${BREW} app-server --analytics-default-enabled`)]
    const d = deps([...TERMINAL_TUI, ...tmux, ...editor, row(900, 1, BREW, `${BREW} app-server --listen unix:///tmp/codex.sock`)],
      { 500: { tty: 'ttys005', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 800, cwd: '/work/app' }, { pid: 51, cwd: '/work/app' }], d)).toEqual([undefined, undefined])
    expect(d.tty).not.toHaveBeenCalled()
    expect(d.cwds).not.toHaveBeenCalled()
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d))
      .toEqual([{ client: { app: 'terminal-app', tty: '/dev/ttys005', pid: 500 } }])
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

// The tester's rig (Needs-you-right Part 5): the daemon's parent is the TUI, whose parent is the tmux server under
// launchd, so the TUI's own walk names no app; the scan's lookup by process names the app holding tmux's client.
describe('codexServed in tmux or herdr inside an app', () => {
  /** A tmux pane as tmux's nested lookup gives one (tmux.ts createTmuxNested). */
  const PANE = { adapter: 'tmux', id: '%3:700:ghostty' }
  /** A multiplexer's server under launchd, its shell, and the TUI typed there. */
  const inMux = (server: string, tui = 700, at = 30) =>
    [row(at, 1, server), row(at + 1, at, '-zsh'), row(tui, at + 1, BREW, 'codex')]
  const TMUX_TUI = inMux('/opt/homebrew/bin/tmux')
  const GHOSTTY: NestedPlace = { app: 'ghostty', tty: '/dev/ttys003', pid: 650, pane: PANE }
  const IN_APP = { 700: { tty: 'ttys010', cwd: '/work/app' } }

  /** deps() with the scan's maker read naming [host] for 700, and its lookup by process answering [place]. */
  function nestingDeps(rows: readonly RunningProcess[], host: string, place: NestedPlace = GHOSTTY,
    places: Record<number, { tty?: string; cwd?: string }> = IN_APP) {
    const madeBy = vi.fn(async (pids: readonly number[], _rows: readonly ProcessName[]) =>
      new Map<number, Omit<Nested, 'pid' | 'rows'>>(pids.includes(700) ? [[700, { host, tty: 'ttys010', maker: 30 }]] : []))
    const nested = vi.fn((_found: Nested) => Promise.resolve(place))
    return { ...deps(rows, places), madeBy, nested }
  }

  it('places a session whose one TUI runs in tmux inside Ghostty at Ghostty, nested in tmux, at its pane', async () => {
    const d = nestingDeps([...TMUX_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], 'tmux')
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual([{
      client: { app: 'ghostty', tty: '/dev/ttys003', pid: 650 }, nest: 'tmux', pane: PANE, clients: [{ pid: 700 }],
    }])
    // The walk's own rows, as the scan hands its table to both.
    const rows = d.madeBy.mock.calls[0]![1]
    expect(rows.map(({ pid }) => pid)).toEqual([30, 31, 700, 900])
    expect(d.madeBy.mock.calls).toEqual([[[700], rows]])
    expect(d.nested.mock.calls).toEqual([[{ host: 'tmux', tty: 'ttys010', maker: 30, pid: 700, rows }]])
  })

  it('places one in herdr inside Ghostty nested in herdr, with the start the table read for its TUI', async () => {
    const [server, shell, tui] = inMux('/opt/homebrew/bin/herdr')
    const d = nestingDeps([server!, shell!, { ...tui!, generation: 'ps:1764230400000' }, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], 'herdr')
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], d)).toEqual([{
      client: { app: 'ghostty', tty: '/dev/ttys003', pid: 650 }, nest: 'herdr', pane: PANE,
      clients: [{ pid: 700, generation: 'ps:1764230400000' }],
    }])
  })

  it('leaves it on no app\'s page when the lookup names no app, the maker read names none or fails, or no lookup is given', async () => {
    const rows = [...TMUX_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)]
    const ask = [{ pid: 900, cwd: '/work/app' }]
    expect(await codexServed(ask, nestingDeps(rows, 'tmux', {}))).toEqual([{}])
    const none = nestingDeps(rows, 'tmux')
    none.madeBy.mockResolvedValue(new Map())
    expect(await codexServed(ask, none)).toEqual([{}])
    expect(none.nested).not.toHaveBeenCalled()
    const failed = nestingDeps(rows, 'tmux')
    failed.madeBy.mockRejectedValue(new Error('ps failed'))
    expect(await codexServed(ask, failed)).toEqual([{}])
    expect(failed.nested).not.toHaveBeenCalled()
    // A maker no lookup by process is for: Zellij's needs its session's name from the hints (its own item).
    const zellij = nestingDeps(rows, 'zellij')
    expect(await codexServed(ask, zellij)).toEqual([{}])
    expect(zellij.nested).not.toHaveBeenCalled()
    expect(await codexServed(ask, deps(rows, IN_APP))).toEqual([{}])
  })

  it('asks no lookup by process for two TUIs in the folder: one in tmux and one in Terminal, or both in tmux', async () => {
    const mixed = nestingDeps([...TERMINAL_TUI, ...TMUX_TUI, row(900, 1, DAEMON_BIN, DAEMON_ARGS)], 'tmux', GHOSTTY,
      { 500: { tty: 'ttys005', cwd: '/work/app' }, ...IN_APP })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], mixed)).toEqual([{}])
    expect(mixed.madeBy).not.toHaveBeenCalled()
    const both = nestingDeps([...TMUX_TUI, ...inMux('/opt/homebrew/bin/tmux', 800, 40), row(900, 1, DAEMON_BIN, DAEMON_ARGS)],
      'tmux', GHOSTTY, { ...IN_APP, 800: { tty: 'ttys011', cwd: '/work/app' } })
    expect(await codexServed([{ pid: 900, cwd: '/work/app' }], both)).toEqual([{}])
    expect(both.madeBy).not.toHaveBeenCalled()
  })
})

// Windows names no terminal: a Codex TUI there has a console and no tty, and harness-pty reads its folder
// (docs/plans/2026-11-27-windows-codex-rescan-design.md).
describe('codexServed on Windows', () => {
  const NPM = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex'
  const NATIVE = `${NPM}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe`
  const NODE = 'C:\\Program Files\\nodejs\\node.exe'
  /** A row as the PTY host's table gives it, each started at [at] (`w:<FILETIME>`): a child after its parent. */
  const win = (pid: number, ppid: number, at: number, executable: string, args: string = executable) =>
    ({ pid, ppid, executable, args, startMarker: `w:${134087000000000000 + at * 10_000}` })
  /** VS Code's terminal: npm's launcher (420) and its native Codex (421), which started the daemon (430). */
  const vscodeTui = (first = 0) => [win(400, 1, first, 'Code.exe'), win(401, 400, first + 1, 'Code.exe'),
    win(409, 401, first + 2, 'pwsh.exe'), win(420, 409, first + 3, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`),
    win(421, 420, first + 4, NATIVE)]
  const daemon = (ppid: number, at: number) =>
    win(430, ppid, at, NATIVE, `${NATIVE} app-server --listen unix:// --analytics-default-enabled`)

  function winDeps(rows: readonly ReturnType<typeof win>[], cwds: Record<number, string>) {
    const tty = vi.fn(async (_pid: number) => undefined)
    return {
      platform: 'win32' as const,
      processes: vi.fn(async () => rows),
      cwds: vi.fn(async (pids: readonly number[]) => new Map(pids.flatMap((pid) => (cwds[pid] ? [[pid, cwds[pid]] as const] : [])))),
      tty,
      apps: vi.fn((pids: readonly number[], names: readonly WindowsProcess[]) => scannedApps(pids, {
        platform: 'win32', roots: [], processes: async () => names, bundleId: async () => undefined,
      })),
      folder: vi.fn(async (path: string) => path),
    } satisfies CodexServedDeps
  }

  it('the one TUI in the session\'s folder is the client, with no terminal read: Windows names none', async () => {
    const d = winDeps([...vscodeTui(), daemon(421, 5)], { 420: 'C:\\work\\dial' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], d)).toEqual([{ client: { app: 'vscode', pid: 420 } }])
    expect(d.tty).not.toHaveBeenCalled()
    // npm's launcher and its native Codex are one TUI: the launcher's folder alone is read.
    expect(d.cwds.mock.calls).toEqual([[[420]]])
  })

  it('its folder unread, none; two TUIs there in VS Code, VS Code with no tab; a `codex queue` among them, none', async () => {
    const unread = winDeps([...vscodeTui(), daemon(421, 5)], {})
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], unread)).toEqual([{}])
    // Ken's VM, 2026-11-27 (#4663 step 10): two VS Code terminals in one folder. VS Code holds whichever is the client.
    const second = [win(410, 401, 6, 'pwsh.exe'), win(440, 410, 7, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`), win(441, 440, 8, NATIVE)]
    const two = winDeps([...vscodeTui(), daemon(421, 5), ...second], { 420: 'C:\\work\\dial', 440: 'C:\\work\\dial' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], two)).toEqual([{ client: { app: 'vscode' }, clients: [{ pid: 420 }, { pid: 440 }] }])
    // Harness's own `codex queue` has no terminal to tell it from a TUI on Windows, and its parents name no app: never a
    // guess between them.
    const queue = winDeps([...vscodeTui(), daemon(421, 5), win(450, 1, 6, NATIVE, `${NATIVE} queue --thread x`)],
      { 420: 'C:\\work\\dial', 450: 'C:\\work\\dial' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], queue)).toEqual([{}])
  })

  it('a second TUI whose folder could not be read, an elevated one: none, never the one in the folder', async () => {
    const elevated = [win(410, 401, 6, 'pwsh.exe'), win(440, 410, 7, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`), win(441, 440, 8, NATIVE)]
    const d = winDeps([...vscodeTui(), daemon(421, 5), ...elevated], { 420: 'C:\\work\\dial' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], d)).toEqual([{}])
  })

  it('the daemon\'s parent is the first TUI, in Windows Terminal: the client in VS Code places it', async () => {
    const terminal = [win(500, 1, 0, 'WindowsTerminal.exe'), win(509, 500, 1, 'pwsh.exe'),
      win(520, 509, 2, NODE, `"${NODE}" ${NPM}\\bin\\codex.js`), win(521, 520, 3, NATIVE)]
    const d = winDeps([...terminal, ...vscodeTui(4), daemon(521, 9)], { 420: 'C:\\work\\dial', 520: 'C:\\work\\other' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], d)).toEqual([{ client: { app: 'vscode', pid: 420 } }])
  })

  it('the first TUI gone, its pid taken by a later VS Code: the daemon is still the daemon', async () => {
    const d = winDeps([...vscodeTui(), daemon(405, 5), win(405, 1, 6, 'Code.exe')], { 420: 'C:\\work\\dial' })
    expect(await codexServed([{ pid: 430, cwd: 'C:\\work\\dial' }], d)).toEqual([{ client: { app: 'vscode', pid: 420 } }])
  })
})

describe('servedLookup', () => {
  // Only whether there is one: calling it would read this machine's processes.
  it('reads this machine on every platform', () => {
    expect(servedLookup('darwin')).toBeTypeOf('function')
    expect(servedLookup('linux')).toBeTypeOf('function')
    expect(servedLookup('win32')).toBeTypeOf('function')
    expect(servedLookup('darwin', { madeBy: async () => new Map(), nested: () => undefined })).toBeTypeOf('function')
  })
})
