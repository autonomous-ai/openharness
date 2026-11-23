/**
 * The dial follows the pane focused in WezTerm and the window focused in kitty
 * (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md), on the real daemon: Claude Code in a WezTerm pane
 * or a kitty window tells the app's own names for it through its own hooks, run on a pty that a stand-in under the
 * app's process name made (harness/orcaHost.ts), as the devices take a pane as the agent's own only on a pty its app
 * made. A fake `wezterm` and a fake `kitten`, first on the daemon's PATH, answer the focus reads in the recorded forms
 * (RECORDED_WEZTERM.listClients, RECORDED_KITTY.focusedMatch) from a file the test writes, move that focus on the dial's
 * tap as the apps do, and note each run. kitty's socket is a real one of the test's, so the devices find it this
 * account's. The real WezTerm and kitty never run. The app in front is a line on the stdin of the real `harness hardware
 * watch --json`, as the Harness Device app writes it.
 *
 * PANE_FOCUS_CPU=1 adds the devices' CPU over a minute with the poll running and a minute with another app in front, one
 * JSON line per app (the spec's "Limits and cost"). Run it alone on an idle machine, with E2E_BUNDLE=1.
 */
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { observedAgentId } from '../src/cable/hosts/observed.js'
import { FOCUS_POLL_MS } from '../src/cable/hosts/focusPoll.js'
import { writeExecutable } from '../src/testing/executableFixture.js'
import { RECORDED_KITTY } from '../src/testing/recordedKitty.js'
import { RECORDED_WEZTERM } from '../src/testing/recordedWezterm.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { FakeDial } from './harness/fakeDial.js'
import { installedHook, type ClaudeEvent } from './harness/inOrca.js'
import { orcaTerminal } from './harness/orcaHost.js'

const execFileAsync = promisify(execFile)

// How `harness hardware watch` is started: the run's bundle when there is one (E2E_BUNDLE), as the daemon runs.
const CLI_ENTRY = process.env.E2E_BUNDLE_PATH ? [process.env.E2E_BUNDLE_PATH] : ['--import', 'tsx', 'src/cli.ts']

/** What the round dial's firmware says in its greeting: it holds one app's ring (docs/specs/2026-11-14-dial-app-filter.md). */
const FILTER = { appFilter: 'v1' }
const DIAL = 'E2E-A'
type App = 'wezterm' | 'kitty'
const APPS: App[] = ['wezterm', 'kitty']
const BUNDLE: Record<App, string> = { wezterm: 'com.github.wez.wezterm', kitty: 'net.kovidgoyal.kitty' }
const GHOSTTY = 'com.mitchellh.ghostty'
/** The name of the process that makes the app's panes' ptys (scannedApp.ts PTY_HOSTS). */
const MAKER: Record<App, string> = { wezterm: 'wezterm-gui', kitty: 'kitty' }
/** The front settles 1 s after the watch's line (appFilter.ts FRONT_SETTLE_MS): nothing of the app's runs before. */
const BEFORE_SETTLE_MS = 900
/** Every pane and poll line the devices may say: an outcome or a count, never a pane, a socket or an agent (Task 6). */
const PANE_LINE = /^\[device\] (pane · (moved|skipped · (no tile|echo|unknown agent|not in front))|focus poll · (started|stopped · \d+ reads, \d+ failed( · failing)?))$/

/** A pane id no line of the log holds by chance: eight digits. */
const paneId = (): string => String(randomInt(10_000_000, 100_000_000))

/** The fake app's command, first on the daemon's PATH: notes each run as a file in its own log folder as it starts (its
 *  mtime the time, renamed into place so it is read whole, as fakeOrca.ts's), then answers from its focus file. */
interface FakeApp {
  /** The pane (WezTerm) or window (kitty) with focus from now on. */
  focus(id: string): void
  /** Every run since install, its arguments and its time, oldest first. */
  calls(): Array<{ args: string; at: number }>
  /** Whether a run of it is under way. */
  running(): boolean
}

const NOTE = (dir: string) => `file=$(mktemp '${dir}/log/.XXXXXX')
printf '%s\\n' "$@" > "$file"
mv "$file" '${dir}/log/'"run\${file##*/}"
`

/** `wezterm`: `list-clients` prints the GUI's one client as recorded, its `focused_pane_id` the focus file's, and
 *  `activate-pane` moves the focus, as the GUI does. Anything else exits 1, as with no GUI running. */
const weztermScript = (dir: string): string => `#!/bin/sh
${NOTE(dir)}if [ $# -eq 5 ] && [ "$1 $2 $3 $4 $5" = 'cli --no-auto-start list-clients --format json' ]; then
  sed "s/\\"focused_pane_id\\": 0\\$/\\"focused_pane_id\\": $(cat '${dir}/focus')/" '${dir}/clients.json'
  exit 0
fi
if [ $# -eq 5 ] && [ "$1 $2 $3 $4" = 'cli --no-auto-start activate-pane --pane-id' ]; then
  printf '%s' "$5" > '${dir}/focus.new' && mv '${dir}/focus.new' '${dir}/focus'
  exit 0
fi
exit 1
`

/** `kitten`, on [listenOn] alone: `get-colors --match` exits 0 with the recorded first line when the expression asks
 *  `state:focused` and names the focus file's window, else exits 1 with kitty's no-match error; `focus-window --match
 *  id:<n>` moves the focus, as kitty does. Anything else exits 1. */
const kittenScript = (dir: string, listenOn: string): string => `#!/bin/sh
${NOTE(dir)}[ $# -eq 6 ] && [ "$1 $2 $3" = '@ --to ${listenOn}' ] || exit 1
focused=$(cat '${dir}/focus')
case "$4 $5" in
  'get-colors --match')
    if printf ' %s ' "$6" | grep -q 'state:focused' && printf ' %s ' "$6" | grep -Eq "[ (]id:$focused[ )]"; then
      echo '${RECORDED_KITTY.focusedMatch.focused.stdoutFirstLine}'
      exit 0
    fi
    printf 'Error: No matching windows for expression: %s\\n' "$6" >&2
    exit 1 ;;
  'focus-window --match')
    case "$6" in id:*) printf '%s' "\${6#id:}" > '${dir}/focus.new' && mv '${dir}/focus.new' '${dir}/focus'; exit 0 ;; esac ;;
esac
exit 1
`

/** [app]'s fake in the daemon's `bin`, before `d.start()`. */
function installFake(d: IsolatedDaemon, app: App, listenOn: string): FakeApp {
  const dir = join(d.root, `fake-${app}`)
  mkdirSync(join(dir, 'log'), { recursive: true })
  const bin = join(d.binDir, app === 'wezterm' ? 'wezterm' : 'kitten')
  const put = (name: string, text: string) => {
    writeFileSync(join(dir, `${name}.new`), text)
    renameSync(join(dir, `${name}.new`), join(dir, name))
  }
  if (app === 'wezterm') {
    const recorded = RECORDED_WEZTERM.listClients.gui.stdout
    // The answer the fake prints is the recorded one with only its focused pane swapped.
    expect(recorded.match(/"focused_pane_id": 0$/gm)).toHaveLength(1)
    put('clients.json', recorded)
  }
  // As the GUI started (RECORDED_WEZTERM.listClients.gui), and kitty's first window: no agent's.
  put('focus', '0')
  // Admitted by macOS's check of a new executable before the devices run it: a first read held past FOCUS_READ_MS by it
  // would mark kitty's socket refused (kitty.ts).
  writeExecutable(bin, app === 'wezterm' ? weztermScript(dir) : kittenScript(dir, listenOn))
  return {
    focus: (id) => put('focus', id),
    calls: () => readdirSync(join(dir, 'log')).filter((name) => name.startsWith('run')).map((name) => {
      const path = join(dir, 'log', name)
      return { args: readFileSync(path, 'utf8').split('\n').slice(0, -1).join(' '), at: statSync(path).mtimeMs }
    }).sort((a, b) => a.at - b.at),
    running: () => spawnSync('pgrep', ['-f', bin]).status === 0,
  }
}

/** A session in a pane or window of [app]'s own, by its names there: its hooks run on a pty a process under the app's
 *  name made, with the daemon's environment and those names alone (no Orca variable). */
interface Agent { id: string; sessionId: string; pane: string; hook(event: ClaudeEvent, fields?: Record<string, unknown>): Promise<void> }

/** The devices' CPU time in seconds by `ps` (10 ms on macOS, 1 s on Linux). */
async function cpuSeconds(pid: number): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' })
  // `[[dd-]hh:]mm:ss[.cc]`
  const [days, clock] = stdout.trim().includes('-') ? stdout.trim().split('-') : ['0', stdout.trim()]
  return Number(days) * 86_400 + clock.split(':').reverse().reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0)
}

describe('the dial follows the focused pane in WezTerm and kitty', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  let socket: { server: Server; folder: string } | undefined
  const children: ChildProcess[] = []
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await desk?.close()
    await daemon?.close()
    if (socket) {
      const { server, folder } = socket
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
      rmSync(folder, { recursive: true, force: true })
    }
    daemon = undefined
    desk = undefined
    socket = undefined
  })

  /** A daemon of its own, a kitty socket of this account's at a short path, [app]'s fake in its `bin` before it starts,
   *  and the dial on the desk shown its first list. */
  const fresh = async (app: App) => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    desk = new Desk(file)
    // Short, as a kitty socket's path is (kitty.ts PATH_SOCKET), and this account's, as the devices check.
    const folder = mkdtempSync('/tmp/hk-')
    const server = createServer()
    socket = { server, folder }
    await new Promise<void>((resolve) => { server.listen(join(folder, 's'), resolve) })
    const listenOn = `unix:${join(folder, 's')}`
    const fake = installFake(d, app, listenOn)
    onTestFailed(() => { console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`) })
    await d.start()
    const dial = await desk.plug(DIAL, 'e2:e0:00:00:00:0a', FILTER)
    await dial.next((m) => m.t === 'agents.end', 45_000, 'the first list')

    /** A session in a pane of [app]'s own, a terminal of its own. */
    const agent = (): Agent => {
      const sessionId = randomUUID()
      const pane = paneId()
      const cwd = join(d.projectsDir, pane)
      mkdirSync(cwd, { recursive: true })
      const hints = app === 'wezterm' ? { WEZTERM_PANE: pane, TERM_PROGRAM: 'WezTerm' } : { KITTY_WINDOW_ID: pane, KITTY_LISTEN_ON: listenOn }
      const terminal = orcaTerminal(d, children, { name: MAKER[app] })
      return {
        id: observedAgentId('claude', sessionId), sessionId, pane,
        async hook(event, fields = {}) {
          const command = await installedHook(d, event)
          const stdin = JSON.stringify({ session_id: sessionId, cwd, hook_event_name: event, ...fields })
          const run = await (await terminal).run('/bin/sh', ['-c', command], { ...d.env, ...hints }, stdin, cwd)
          expect(run.code, run.stderr).toBe(0)
        },
      }
    }

    // One watch, as the Harness Device app holds one open until it quits; each front a line on its stdin.
    let watch: ChildProcess | undefined
    /** [bundle] comes in front; when the test told it. */
    const front = (bundle: string): number => {
      watch ??= spawn(process.execPath, [...CLI_ENTRY, 'hardware', 'watch', '--json'], {
        cwd: CLI_ROOT, env: { ...d.env, TMUX_PANE: '' }, stdio: ['pipe', 'ignore', 'ignore'],
      })
      if (!children.includes(watch)) children.push(watch)
      watch.stdin!.write(`${JSON.stringify({ front: bundle })}\n`)
      return Date.now()
    }
    return { d, dial, fake, listenOn, agent, front }
  }

  /** Each session started, and its row on the dial. */
  const listed = async (dial: FakeDial, ...agents: Agent[]): Promise<void> => {
    for (const agent of agents) {
      await agent.hook('SessionStart', { source: 'startup' })
      await dial.next((m) => m.t === 'agent' && m.id === agent.id, 45_000, 'the agent listed')
    }
  }

  /** The daemon's pane and poll lines, each from its `[device]` on. */
  const paneLines = (d: IsolatedDaemon): string[] => d.log().split('\n')
    .filter((line) => line.includes('[device] pane ') || line.includes('[device] focus poll '))
    .map((line) => line.slice(line.indexOf('[device]')))
  const count = (d: IsolatedDaemon, line: string): number => paneLines(d).filter((said) => said === line).length
  const said = (d: IsolatedDaemon, what: string, test: (line: string) => boolean): Promise<string> =>
    until(what, () => paneLines(d).find(test), 30_000, 50)
  /** The poll's stop, once said: no read is under way after it once no run of the fake is. */
  const stopped = async (d: IsolatedDaemon, fake: FakeApp): Promise<{ line: string; at: number }> => {
    const line = await until('the poll stopped', () => paneLines(d).find((said) => said.startsWith('[device] focus poll · stopped')), 30_000, 50)
    await until("the fake's runs ended", () => !fake.running(), 10_000, 20)
    return { line, at: Date.now() }
  }

  it.each(APPS)(
    '%s: the settle follows the focused agent, a focus change turns the dial, the dial\'s tap is not pulled back, and another app in front stops the calls',
    async (app) => {
      const { d, dial, fake, listenOn, agent, front } = await fresh(app)
      const a = agent()
      const b = agent()
      await listed(dial, a, b)

      // 1. B has focus as the app comes in front: its settle starts the poll, and the first read turns the dial to B.
      fake.focus(b.pane)
      let since = dial.messages.length
      front(BUNDLE[app])
      await dial.next((m) => m.t === 'focus' && m.agentId === b.id, 45_000, "B's focus", since)
      await said(d, 'the poll started', (line) => line === '[device] focus poll · started')
      await until('one pane move', () => count(d, '[device] pane · moved') === 1, 30_000, 50)

      // 2. The person focuses A in the app: a read sees it, and the dial follows.
      since = dial.messages.length
      fake.focus(a.pane)
      await dial.next((m) => m.t === 'focus' && m.agentId === a.id, 30_000, "A's focus", since)
      await until('two pane moves', () => count(d, '[device] pane · moved') === 2, 30_000, 50)

      // 3. The dial turns to B and taps it: the app's own focus runs, and the read that sees B focused is the tap's echo,
      // which never turns the dial back.
      const tapped = dial.messages.length
      dial.send({ t: 'focus', agentId: b.id })
      dial.send({ t: 'agent.open', agentId: b.id })
      const focusing = app === 'wezterm'
        ? `cli --no-auto-start activate-pane --pane-id ${b.pane}`
        : `@ --to ${listenOn} focus-window --match id:${b.pane}`
      await until("the tap's focus in the app", () => fake.calls().some((call) => call.args === focusing), 30_000, 50)
      await said(d, "the tap's echo", (line) => line === '[device] pane · skipped · echo')
      expect(count(d, '[device] pane · moved')).toBe(2)

      // 4. Another app in front: at its settle the poll stops, and the app is asked nothing more.
      front(GHOSTTY)
      const quiet = await stopped(d, fake)
      expect(quiet.line).toMatch(/^\[device\] focus poll · stopped · [1-9]\d* reads, 0 failed$/)

      // 5. The app in front again: nothing runs until it settles, then the poll starts again.
      const toldAt = front(BUNDLE[app])
      await until('the poll started again', () => count(d, '[device] focus poll · started') === 2, 30_000, 50)
      expect(fake.calls().filter((call) => call.at >= quiet.at && call.at <= toldAt + BEFORE_SETTLE_MS)).toEqual([])
      await until('a read after the start', () => fake.calls().some((call) => call.at > toldAt + BEFORE_SETTLE_MS), 30_000, 50)

      // 6. The dial stayed on B: no focus for A since the tap.
      expect(dial.messages.slice(tapped).filter((m) => m.t === 'focus' && m.agentId === a.id)).toEqual([])

      // 7. Outcomes and counts only: no session id, pane or window id, or socket.
      for (const line of paneLines(d)) expect(line).toMatch(PANE_LINE)
      const log = d.log()
      for (const secret of [a.sessionId, b.sessionId, listenOn.slice('unix:'.length)]) expect(log).not.toContain(secret)
      for (const pane of [a.pane, b.pane]) expect(log).not.toMatch(new RegExp(`\\b${pane}\\b`))
    },
  )

  describe.runIf(process.env.PANE_FOCUS_CPU === '1')('CPU', () => {
    const MINUTE_MS = 60_000
    const measured = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

    it.each(APPS)("%s: the devices' CPU over a minute with the poll running and with another app in front", async (app) => {
      const { d, dial, fake, agent, front } = await fresh(app)
      const a = agent()
      const b = agent()
      await listed(dial, a, b)
      fake.focus(a.pane)
      const toldAt = front(BUNDLE[app])
      await said(d, 'the poll started', (line) => line === '[device] focus poll · started')
      const [pid, ...more] = d.servicePids('devices')
      expect(more).toEqual([])

      // A minute with the poll running.
      let cpu = await cpuSeconds(pid)
      let at = performance.now()
      await measured(MINUTE_MS)
      const pollCpuPercent = 100 * (await cpuSeconds(pid) - cpu) / ((performance.now() - at) / 1000)

      // A minute with Ghostty in front: the poll stopped at its settle, and the app is asked nothing.
      front(GHOSTTY)
      const quiet = await stopped(d, fake)
      const reads = Number(/ (\d+) reads,/.exec(quiet.line)![1])
      cpu = await cpuSeconds(pid)
      at = performance.now()
      await measured(MINUTE_MS)
      const awayCpuPercent = 100 * (await cpuSeconds(pid) - cpu) / ((performance.now() - at) / 1000)

      // Past the runner: a passing case's console is not printed.
      process.stdout.write(`${JSON.stringify({ app, platform: platform(), arch: arch(), pollCpuPercent, awayCpuPercent, reads })}\n`)
      // One read at most every FOCUS_POLL_MS from the front's line to the stop, the first at once.
      expect(reads).toBeGreaterThan(0)
      expect(reads).toBeLessThanOrEqual(Math.floor((quiet.at - toldAt) / FOCUS_POLL_MS) + 1)
      expect(fake.calls().filter((call) => call.at >= quiet.at)).toEqual([])
    }, 300_000)
  })
})
