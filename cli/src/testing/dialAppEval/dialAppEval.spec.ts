/**
 * Tier A of the dial eval (docs/plans/2026-11-21-dial-app-eval-design.md, "Tier A: replay, in process"): the real devices
 * (services/devices.ts) in this process on virtual time, with the real cable to a loopback dial and the real store readers
 * on fixtures in a temp folder. Only this computer is stood in for: every reader of it is mocked below and answers from
 * the scenario's model of the machine (tierA/machine.ts), so the devices see the scenario's processes and none of the
 * host's.
 *
 * Nothing real is reached. The network guard (netGuard.ts) is the one way this spec refuses the network: installed
 * before any import, a connection to anything but this machine fails, and fails the case it happened in, named by host
 * and port. A child process fails the case too: the devices must start no `claude`, `codex`, `orca`, `open`, `xdg-open`
 * or `ps`. The homes, the stores and the transcripts are throwaway folders.
 */
import { homedir, tmpdir } from 'node:os'
import { basename } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flagOf, ORCA_PROGRAMS, programOf } from './argv.js'
import { claudeGhost, claudeSessions, editorGhost, editorSession, itermGhost, itermSession, keys, listed, MAIN, orcaGhost, orcaOpening,
  orcaSession, orcaStarted, scenario, scenariosFor, started, turned } from './catalog.js'
import { rings } from './checks.js'
import { loadBaseline, SKIP_RATCHET_ENV, tierAVerdict } from './grade.js'
import { describeAttempt } from './netGuard.js'
import { collect, runScenario, uncaughtProbes, writeResults, type ScenarioRun } from './runner.js'
import { TierADriver } from './tierA/driver.js'
import { agentIdOf, orcaTerminalHandle, orcaWorktreeId, type Platform, type Scenario, type Seen, type Step } from './types.js'

// First of all, so no import below opens a connection unguarded.
const guard = await vi.hoisted(async () => (await import('./netGuard.js')).guardThisProcess())
const { machine } = await vi.hoisted(async () => await import('./tierA/machine.js'))

// Every way to start a process, refused and noted: each one started past the stand-ins fails the case it happened in.
const { reached, refused } = await vi.hoisted(async () => await import('./tierA/refuseProcesses.js'))
vi.mock('node:child_process', refused)
vi.mock('child_process', refused)
// Each read is counted from its call to its end, so the clock moves on only once it lands (tierA/clock.ts).
const counted = vi.hoisted(() => async (real: () => Promise<object>) => (await import('./tierA/clock.js')).countFsCalls(await real()))
vi.mock('node:fs/promises', counted)
vi.mock('fs/promises', counted)
// Every random UUID from the machine's count, as every time is virtual: a scenario run twice makes the same frames.
const counting = vi.hoisted(() => async (real: () => Promise<object>) => ({ ...await real(), randomUUID: () => machine.uuid() }))
vi.mock('node:crypto', counting)
vi.mock('crypto', counting)
// The machine's processes, and whether one still runs, from the model. A session's transcript has no stamp there: one
// waiting on the person stays so until its next hook.
vi.mock('../../lib/sessionSearch/externals/support.js', async (real) => ({
  ...await real<typeof import('../../lib/sessionSearch/externals/support.js')>(),
  listProcesses: async () => [...machine.processes.values()].map(({ pid, ppid, executable }) => ({ pid, ppid, executable, args: '' })),
  processAlive: (pid: number) => machine.processes.has(pid),
  fileStamp: async () => null,
}))
// The sessions the machine's processes have open, their folders, transcripts and records (a Claude Code's names it, as
// the scan reads it: steps/sessions.ts). Every session counts as busy, as OpenSessions.busy answers for a record it
// cannot read: a turn ends by its own Stop hook.
vi.mock('../../lib/sessionSearch/external.js', async (real) => ({
  ...await real<typeof import('../../lib/sessionSearch/external.js')>(),
  OpenSessions: class {
    async owners() {
      return new Map([...machine.owners].filter(([, owner]) => machine.processes.has(owner.pid))
        .map(([sessionId, { engine, pid, record }]) => [sessionId, { pid, engine, tty: machine.processes.get(pid)?.tty ?? null, record }]))
    }
    async busy() { return true }
  },
  SessionRows: class {
    async find(wanted: ReadonlyMap<string, string>) {
      return new Map([...wanted.keys()].flatMap((sessionId) => {
        const owner = machine.owners.get(sessionId)
        return owner ? [[sessionId, { cwd: owner.cwd, transcriptPath: owner.transcriptPath }] as const] : []
      }))
    }
  },
}))
// Which app each process runs in, the process table and terminals a session's place is read from, and the apps' bundle
// ids: the model's, never this machine's `ps` or `plutil`. A process the model names no app for is walked on an iTerm2
// scenario's machine by the real walk, over the model's table and bundle ids, from iTerm2's home: iTerm2's own processes
// carry no app id, so its server rule is what names them (docs/plans/2026-11-22-dial-eval-iterm2-plan.md, Decision 4).
vi.mock('../../cable/hosts/scannedApp.js', async (real) => {
  const actual = await real<typeof import('../../cable/hosts/scannedApp.js')>()
  return {
    ...actual,
    learnApps: async (pids: readonly number[]) => {
      const named = new Map(pids.flatMap((pid) => {
        const app = machine.appOf(pid)
        return app ? [[pid, app] as const] : []
      }))
      const home = machine.itermHome
      const rest = pids.filter((pid) => !named.has(pid))
      if (home === undefined || !rest.length) return named
      const walked = await actual.scannedApps(rest, { platform: 'darwin', roots: actual.appRoots(home), home,
        processes: async () => [...machine.processes.values()].map(({ pid, ppid, executable }) => ({ pid, ppid, executable })),
        bundleId: async (bundle) => machine.bundleIds.get(bundle) })
      return new Map([...named, ...walked])
    },
    readProcessNames: async () => [...machine.processes.values()].map(({ pid, ppid, executable, tty }) => ({ pid, ppid, executable, ...(tty ? { tty } : {}) })),
    readTtyName: async (pid: number) => machine.processes.get(pid)?.tty,
    readBundleId: async (bundle: string) => machine.bundleIds.get(bundle),
  }
})
// The folders there are the model's: Cursor's folder row opens a session's own, never one of this machine's.
vi.mock('../../cable/hosts/cursorFolder.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/cursorFolder.js')>(),
  isFolder: (path: string) => machine.folders.has(path),
}))
// No folder or socket of this machine is watched: the stores' watch is the world's (tierA/storeWatch.ts), and a watch on
// a socket's folder is the model's, told as herdr's socket appears (tierA/steps/herdr.ts).
vi.mock('../../cable/hosts/folderWatch.js', () => ({ watchNearest: () => () => {} }))
vi.mock('../../cable/hosts/unixSocket.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/unixSocket.js')>(),
  watchSocket: (where: { socketPath: string }, changed: () => void) => {
    const watch = (): void => changed()
    const watches = machine.socketWatches.get(where.socketPath) ?? new Set()
    machine.socketWatches.set(where.socketPath, watches.add(watch))
    return () => { watches.delete(watch) }
  },
}))
// A terminal's last access is the model's (tierA/machine.ts atimes): herdr's client lookup ranks clients by it, and the
// real read would stat this machine's own /dev/ttysNNN.
vi.mock('../../cable/hosts/herdrOuter.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/herdrOuter.js')>(),
  ttyAtime: async (tty: string) => machine.atimes.get(tty.replace(/^\/dev\//, '')),
}))
// The model's machine has no Zellij or kitty, and tmux only where the world installed it (an iTerm2 scenario's, or one
// whose Orca agent runs under tmux, never on Windows): no login shell is asked where they are. A tmux found runs
// through the world's `run`, answered from its model (tierA/steps/tmux.ts).
vi.mock('../../lib/tmuxOnPath.js', async (real) => ({
  ...await real<typeof import('../../lib/tmuxOnPath.js')>(),
  ensureTmuxOnPath: async () => {
    const path = machine.installed.get('tmux')
    return path === undefined ? { state: 'absent', reason: 'not on the eval machine' } : { state: 'adopted', path, from: 'standard install location' }
  },
}))
vi.mock('../../cable/hosts/zellij.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/zellij.js')>(),
  zellijFinder: () => async () => ({ state: 'absent', reason: 'not on the eval machine' }),
}))
vi.mock('../../cable/hosts/kitty.js', async (real) => ({
  ...await real<typeof import('../../cable/hosts/kitty.js')>(),
  kittyFinder: () => async () => ({ state: 'absent', reason: 'not on the eval machine' }),
}))
// The voice router warms an engine's process: here it warms none, and routes no words.
vi.mock('../../lib/voiceRouter.js', () => ({
  setVoiceRouterSessions: () => {},
  setVoiceRouterDeviceConnected: () => {},
  shutdownVoiceRouter: () => {},
  routeVoiceTask: async () => ({ agentId: '', confidence: 0, reason: 'no router in tier A', needNewAgent: false }),
}))
// Orca's account homes: an Orca that is not there, should anything build its own read of them.
vi.mock('../../devices/orcaHomes.js', async (real) => ({
  ...await real<typeof import('../../devices/orcaHomes.js')>(),
  orcaHomesDeps: () => ({ run: async () => ({ code: null, stdout: '', timedOut: false }), onPath: () => null, exists: () => false, platform: 'linux', uid: 1 }),
}))

const { startDevices } = await import('../../services/devices.js')
const { learnApps } = await import('../../cable/hosts/scannedApp.js')
const { ensureTmuxOnPath } = await import('../../lib/tmuxOnPath.js')
const { ttyAtime } = await import('../../cable/hosts/herdrOuter.js')

const PLATFORMS: readonly Platform[] = ['darwin', 'win32', 'linux']
/**
 * Tier A runs on a Mac or a Linux host. On a Windows one a platform's store paths flip (a posix path is no path of that
 * host, tierA/storeWatch.ts onHost), a temp folder a reader still holds is EBUSY to remove, and secureState's retries
 * wait in real time (lib/secureState.ts pauseSync): its virtual times would not be the baseline's.
 */
const WINDOWS_HOST = process.platform === 'win32'
/** Every scenario run, in the order run: what the results file holds. */
const runs: ScenarioRun[] = []

beforeEach(() => { reached.length = 0 })
afterEach(() => {
  expect(guard.taken().map(describeAttempt)).toEqual([])
  expect(reached).toEqual([])
})
afterAll(() => {
  const out = process.env.DIAL_EVAL_OUT
  if (out) writeResults(out, 'spec', collect(runs))
  // What was refused after the last case, in the hooks, fails the file.
  try {
    expect(guard.taken().map(describeAttempt)).toEqual([])
  } finally {
    guard.uninstall()
  }
})

describe.skipIf(WINDOWS_HOST).each(PLATFORMS)('tier A on %s', (platform) => {
  it.for(scenariosFor('a', platform))('$id', async (scenario) => {
    const run = await runScenario(new TierADriver({ startDevices }), scenario, platform)
    runs.push(run)
    expect(run.error).toBeUndefined()
    expect(run.wrongSends).toEqual([])
    expect(uncaughtProbes(run)).toEqual([])
  })
})

describe.skipIf(WINDOWS_HOST)('tier A', () => {
  it('reaches no network: a fetch to example.invalid fails and the guard names it', async () => {
    await expect(fetch('http://example.invalid/')).rejects.toThrow()
    expect(guard.taken().map(describeAttempt)).toEqual(['node net example.invalid:80'])
  })

  it('a voice step whose target the face never shows leaves its scenario ungraded, and says so', async () => {
    // The person turns the dial to b and the step speaks to a: the glass never showed a.
    const voice = scenario({
      id: 'S3', app: 'claude', title: 'Eval voice to a session not on the face', dims: ['D5'], tiers: ['a'],
      sessions: [...claudeSessions(['a', 'b']), claudeGhost],
      steps: [
        { kind: 'claude.write', sessions: ['a', 'b'] },
        ...listed('claude', ['a', 'b']),
        { kind: 'swipe', session: 'b' },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' },
      ],
      checks: [], probes: [],
    })
    const run = await runScenario(new TierADriver({ startDevices }), voice, 'darwin')
    expect(run.gaps.map((g) => g.reason)).toEqual(['voice step 4: the face never showed a'])
  })

  it('C1 twice gives the same frames, faces, commands and deliveries at the same virtual times', async () => {
    const c1 = MAIN.find((s) => s.id === 'C1')!
    const seen = async () => {
      const driver = new TierADriver({ startDevices })
      await runScenario(driver, c1, 'darwin')
      const { frames, faces, commands, deliveries } = driver.seen()
      return { frames, faces, commands, deliveries }
    }
    const first = await seen()
    const second = await seen()
    expect(first.frames.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  /** VS Code's V5: a in w1, b in w2, b's window focused. */
  const v5 = MAIN.find((s) => s.id === 'V5')!

  it("V5 on darwin: a tap on b, in the second window, writes show with raise for b's shell on that window's stream alone, and runs open -b com.microsoft.VSCode", async () => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, v5, 'darwin')
    expect(run.error).toBeUndefined()
    const { streams = [], commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const shows = streams.filter((l) => l.line.show !== undefined)
    expect(shows.map(({ window, line }) => ({ window, line }))).toEqual([{ window: 'eval-w2-1', line: { show: 'b', raise: true } }])
    expect(shows[0]!.at).toBeGreaterThanOrEqual(tap.at)
    expect(commands.filter((c) => c.at >= tap.at).map((c) => c.argv)).toEqual([['/usr/bin/open', '-b', 'com.microsoft.VSCode']])
  })

  it('V5 twice gives the same streams, frames and commands at the same virtual times', async () => {
    const seen = async () => {
      const driver = new TierADriver({ startDevices })
      await runScenario(driver, v5, 'darwin')
      const { streams, frames, commands } = driver.seen()
      return { streams, frames, commands }
    }
    const first = await seen()
    const second = await seen()
    expect(first.streams?.length).toBeGreaterThan(0)
    expect(second).toEqual(first)
  })

  it("the devices' log lines are seen at their virtual times: each of V5's windows opens its stream at its step", async () => {
    const driver = new TierADriver({ startDevices })
    await runScenario(driver, v5, 'darwin')
    const { logs = [], steps } = driver.seen()
    const windows = steps.filter((s) => s.kind === 'editor.window').map((s) => s.at)
    expect(logs.filter((l) => l.line.startsWith('[devices] vscode stream · open')).map((l) => l.at)).toEqual(windows)
  })

  /** Two terminals in one VS Code window, a the active one: what a stroke and a quit are tried on. */
  const twoTerminals = (id: string, title: string, more: Step[]) => scenario({
    id, app: 'vscode', title, dims: ['D3'], tiers: ['a'],
    sessions: [editorSession('a', 'vscode'), editorSession('b', 'vscode'), editorGhost('vscode')],
    steps: [
      ...started(['a', 'b']),
      { kind: 'editor.window', window: 'w1', active: 'a', focused: true },
      ...listed('vscode', ['a', 'b']),
      ...more,
    ],
    checks: [], probes: [],
  })

  it("a stroke on a, in front in VS Code, writes a scroll line for a's shell on its window's stream, while it is the active terminal", async () => {
    const stroked = twoTerminals('S1', 'Eval a stroke on the active terminal', [
      { kind: 'swipe', session: 'a' },
      { kind: 'wait', ms: 2_000 },
      { label: 'stroke', kind: 'stroke' },
    ])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, stroked, 'darwin')
    expect(run.error).toBeUndefined()
    const { streams = [], steps } = driver.seen()
    const at = steps.find((s) => s.label === 'stroke')!.at
    const scrolls = streams.filter((l) => l.line.scroll !== undefined)
    expect(scrolls.length).toBeGreaterThan(0)
    expect(scrolls.every((l) => l.at >= at && l.window === 'eval-w1-1' && l.line.pid === 'a' && l.line.page === undefined)).toBe(true)
    // Three moves of 8 are 60 px: three lines of 16 toward older ones (scrollLines.ts).
    expect(scrolls.reduce((sum, l) => sum + (l.line.scroll as number), 0)).toBe(-3)
    const states = streams.filter((l) => l.line.type === 'vscode-state' && l.at <= scrolls[0]!.at)
    expect(states.at(-1)!.line).toMatchObject({ active: 'a', focused: true })
  })

  it("VS Code's quit ends its window's stream gone, and its relaunch opens eval-w1-2 on the sessions' new shells", async () => {
    const quit = twoTerminals('S2', 'Eval a quit and a relaunch', [{ kind: 'quit', app: 'vscode' }, { kind: 'relaunch', app: 'vscode' }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, quit, 'darwin')
    expect(run.error).toBeUndefined()
    const lines = (driver.seen().streams ?? []).map(({ window, line }) => ({ window, line }))
    expect(lines).toEqual([
      { window: 'eval-w1-1', line: { type: 'vscode', window: 'eval-w1-1' } },
      { window: 'eval-w1-1', line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'a', focused: true } },
      { window: 'eval-w1-1', line: { ended: 'gone' } },
      { window: 'eval-w1-2', line: { type: 'vscode', window: 'eval-w1-2' } },
      { window: 'eval-w1-2', line: { type: 'vscode-state', terminals: ['a', 'b'], active: 'a', focused: true } },
    ])
  })

  /** Cursor's U6: its own agent c, in its folder: what a tap on its folder row runs. */
  const cursorAgent = MAIN.find((s) => s.id === 'U6')!
  const folderCommands: Readonly<Record<Platform, string[]>> = {
    darwin: ['/usr/bin/open', '-b', 'com.todesktop.230313mzl4w4u92', '/work/eval-c'],
    linux: ['/opt/eval/bin/cursor', '/work/eval-c'],
    win32: ['harness-pty', 'cursor-folder', '/work/eval-c'],
  }

  it.for(PLATFORMS)("a tap on Cursor's own agent opens Cursor's window for its folder on %s: open -b com.todesktop.230313mzl4w4u92 on darwin, Cursor's CLI on linux, harness-pty cursor-folder on win32", async (platform) => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, cursorAgent, platform)
    expect(run.error).toBeUndefined()
    const { commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    expect(commands.filter((c) => c.at >= tap.at).map((c) => c.argv)).toEqual([folderCommands[platform]])
  })

  it.for(PLATFORMS)("the editor extension's setup runs nothing: no gap on %s", async (platform) => {
    const run = await runScenario(new TierADriver({ startDevices }), cursorAgent, platform)
    expect(run.error).toBeUndefined()
    expect(run.gaps).toEqual([])
  })

  const o1 = MAIN.find((s) => s.id === 'O1')!
  /** The last whole list the dial was sent, each row by its session's key and its name. */
  const lastList = (seen: Seen, of: Scenario) => {
    const last = rings(seen).at(-1)
    return last && { at: last.at, rows: last.rows.map((r) => ({ key: of.sessions.find((s) => agentIdOf(s) === r.id)?.key ?? 'other', name: r.name })) }
  }
  const isList = (argv: string[]): boolean => argv[1] === 'terminal' && argv[2] === 'list'

  it("O1 on darwin: the five are listed in Orca's tab order, by their names, after a terminal list", async () => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, o1, 'darwin')
    expect(run.error).toBeUndefined()
    const seen = driver.seen()
    // Codex's hooks carry no title: its row is its tab's. c's own title wins over its tab's, a's; d's tab was renamed.
    const list = lastList(seen, o1)!
    expect(list.rows).toEqual([{ key: 'a', name: 'Eval Alpha' }, { key: 'c', name: 'Eval Charlie' }, { key: 'b', name: 'Eval Bravo' },
      { key: 'd', name: 'Eval Renamed' }, { key: 'e', name: 'Eval Echo' }])
    const read = seen.commands.find((c) => isList(c.argv))
    expect(read?.ok).toBe(true)
    expect(list.at).toBeGreaterThanOrEqual(read!.at)
  })

  /** O7: a and c in w1, b in w2; its tap on b, then its rest on c. */
  const o7 = MAIN.find((s) => s.id === 'O7')!
  /** What brings Orca forward: open's bundle on macOS, the window raise on Linux. */
  const raisesOrca: Readonly<Record<'darwin' | 'linux', (argv: string[]) => boolean>> = {
    darwin: (argv) => argv.join(' ') === '/usr/bin/open -b com.stablyai.orca',
    linux: (argv) => argv[0] === 'raise',
  }

  // Not on win32: the devices find no orca.exe where Orca's installer puts it (the Orca spec's decision 3), a gap O7
  // grades.
  it.for(['darwin', 'linux'] as const)("O7's tap on b in the other worktree runs worktree activate for its worktree, terminal switch for its handle, then the platform's raise, in that order, on %s", async (platform) => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, o7, platform)
    expect(run.error).toBeUndefined()
    const { commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const rest = steps.find((s) => s.label === 'rest')!
    const after = commands.filter((c) => c.at >= tap.at && c.at < rest.at).map((c) => c.argv)
    const orca = after[0]?.[0]
    expect(after.slice(0, 2)).toEqual([[orca, 'worktree', 'activate', '--worktree', `id:${orcaWorktreeId('w2')}`, '--json'],
      [orca, 'terminal', 'switch', '--terminal', orcaTerminalHandle('b'), '--json']])
    expect(after).toHaveLength(3)
    expect(raisesOrca[platform](after[2]!)).toBe(true)
  })

  /** O20: a in w1, c a chat in w2, d one in w1; its tap on c, then its rest on d. */
  const o20 = MAIN.find((s) => s.id === 'O20')!

  // On macOS alone: Linux raises Orca by its window's class, which the product has not confirmed (frontApp.ts
  // WINDOW_CLASSES), or by the agent's process, which a resting chat has none of. O20 grades that raise as it is.
  it("O20's tap on a chat in the other worktree runs worktree activate for that worktree, then brings Orca forward, and no terminal switch", async () => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, o20, 'darwin')
    expect(run.error).toBeUndefined()
    const { commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const rest = steps.find((s) => s.label === 'rest')!
    const after = commands.filter((c) => c.at >= tap.at && c.at < rest.at).map((c) => c.argv)
    expect(after[0]?.slice(1)).toEqual(['worktree', 'activate', '--worktree', `id:${orcaWorktreeId('w2')}`, '--json'])
    expect(after).toHaveLength(2)
    expect(raisesOrca.darwin(after[1]!)).toBe(true)
  })

  /** O11: a, b and c in w1, c under tmux in its tab; its tap on c, then the person turns to c. */
  const o11 = MAIN.find((s) => s.id === 'O11')!
  const orcaTerminal = (argv: string[], verb: string): boolean =>
    ORCA_PROGRAMS.includes(programOf(argv)) && argv[1] === 'terminal' && argv[2] === verb
  /** A tmux run that shows c's pane, `select-window ; select-pane` on its own session, as tmux's lookup finds the client
   *  in Orca: by Orca's main process on Linux, by Orca's terminal host on macOS (scannedApp.ts scannedApps). Eval O11
   *  found macOS's client in no app, c off Orca's page and its tap switching no Orca terminal (2026-11-26). */
  const showsC = (argv: string[]): boolean => {
    const verb = argv.indexOf('select-pane')
    return programOf(argv) === 'tmux' && verb > 0 && flagOf(argv.slice(verb), '-t') === 'pane:c'
  }

  // Eval O11 found tmux's pane alone came forward, inside whichever tab Orca showed (2026-11-25).
  it.for(['darwin', 'linux'] as const)("O11's tap on c under tmux switches Orca to c's terminal before tmux shows its pane and Orca comes forward, and types nothing, on %s", async (platform) => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, o11, platform)
    expect(run.error).toBeUndefined()
    const { commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const face = steps.find((s) => s.label === 'face')!
    const after = commands.filter((c) => c.at >= tap.at && c.at < face.at)
    const switched = after.findIndex((c) => c.ok && orcaTerminal(c.argv, 'switch')
      && flagOf(c.argv, '--terminal') === orcaTerminalHandle('c'))
    const shown = after.findIndex((c) => c.ok && showsC(c.argv))
    const raised = after.findIndex((c) => raisesOrca[platform](c.argv))
    expect(switched).toBeGreaterThanOrEqual(0)
    expect(shown).toBeGreaterThan(switched)
    expect(raised).toBeGreaterThan(switched)
    expect(after.filter((c) => orcaTerminal(c.argv, 'send'))).toEqual([])
    expect(run.wrongSends).toEqual([])
    const open = Object.fromEntries(run.results.filter((r) => r.check.startsWith('open.')).map((r) => [r.check, r.score]))
    expect(open).toMatchObject({ 'open.worktree': 1, 'open.switch': 1, 'open.pane': 1 })
  })

  it("a ring of 40 agents in 40 worktrees reads Orca's layout at most once per change in its agents, and not once in a minute with no change", async () => {
    const agents = keys('k', 1, 40, 2)
    const worktreeOf = (key: string): string => key.replace('k', 'w')
    const forty = scenario({
      id: 'S5', app: 'orca', title: 'Eval forty agents in forty worktrees', dims: ['D1'], tiers: ['a'],
      sessions: [...agents.map((key) => orcaSession(key, { worktree: worktreeOf(key) })), orcaGhost],
      steps: [{ kind: 'orca.layout', worktrees: agents.map(worktreeOf) }, ...started(agents), { kind: 'wait', ms: 60_000 }],
      checks: [], probes: [],
    })
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, forty, 'darwin')
    expect(run.error).toBeUndefined()
    const { commands, steps } = driver.seen()
    const reads = commands.filter((c) => isList(c.argv))
    // Each agent changes Orca's ring twice: as it starts, and as its maker read finds its pane Orca's own.
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.length).toBeLessThanOrEqual(2 * agents.length)
    expect(reads.every((c) => c.ok)).toBe(true)
    // Nothing changed after the last start, for a minute and the end's settle.
    const last = steps.at(-1)!.at
    expect(reads.filter((c) => c.at > last)).toEqual([])
  })

  it('O1 twice gives the same frames, faces, commands and deliveries at the same virtual times', async () => {
    const seen = async () => {
      const driver = new TierADriver({ startDevices })
      await runScenario(driver, o1, 'darwin')
      const { frames, faces, commands, deliveries } = driver.seen()
      // Orca's CLI is in each world's own temp folder: a command is its program and its arguments.
      return { frames, faces, deliveries,
        commands: commands.map(({ argv: [program, ...args], ...command }) => ({ ...command, argv: [basename(program!), ...args] })) }
    }
    const first = await seen()
    const second = await seen()
    expect(first.commands.some((c) => isList(c.argv))).toBe(true)
    expect(second).toEqual(first)
  })

  /** O4: a and b in w1, the plugin's stream open, Orca in front; its focus line for b, then its tap on a. */
  const o4 = MAIN.find((s) => s.id === 'O4')!

  it("O4's focus line for b, with Orca settled in front, turns the dial to b", async () => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, o4, 'darwin')
    expect(run.error).toBeUndefined()
    const { faces, steps, commands } = driver.seen()
    const focus = steps.find((s) => s.label === 'focus')!
    const tap = steps.find((s) => s.label === 'tap')!
    const [a, b] = o4.sessions.slice(0, 2).map(agentIdOf)
    expect(commands.some((c) => c.argv[2] === 'watch-focus' && c.at <= focus.at)).toBe(true)
    // a, the newest, is on the face until the focus; the face b comes at the focus's own virtual moment.
    expect(faces.filter((f) => f.at < focus.at).at(-1)?.active).toBe(a)
    expect(faces.filter((f) => f.at < tap.at).at(-1)?.active).toBe(b)
  })

  /** a and b in w1, d in w2, then the plugin says w1 is on Orca's screen. */
  const frontOnW1 = (): Scenario => scenario({
    id: 'S4', app: 'orca', title: "Eval the ring keeps to the worktree on Orca's screen", dims: ['D1'], tiers: ['a'],
    sessions: [orcaSession('a'), orcaSession('b', { tab: 1 }), orcaSession('d', { worktree: 'w2' }), orcaGhost],
    steps: [...orcaOpening(['w1', 'w2']), ...orcaStarted(['d', 'b', 'a']), ...listed('orca', ['a', 'b', 'd']),
      { label: 'front', kind: 'orca.front', worktree: 'w1' }, ...listed('orca', ['a', 'b'])],
    checks: [], probes: [],
  })

  it("with the plugin's front on w1, only w1's agents are listed", async () => {
    const of = frontOnW1()
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, of, 'darwin')
    expect(run.error).toBeUndefined()
    const seen = driver.seen()
    const front = seen.steps.find((s) => s.label === 'front')!
    const before = lastList({ ...seen, frames: seen.frames.filter((f) => f.at < front.at) }, of)!
    expect(before.rows.map((r) => r.key)).toEqual(['a', 'b', 'd'])
    expect(lastList(seen, of)!.rows.map((r) => r.key)).toEqual(['a', 'b'])
  })

  /** iTerm2's two plain tabs, a in w1's tab 0 and b in tab 1, started in `order` and listed, then `more`. */
  const twoTabs = (id: string, title: string, order: string[], more: Step[]): Scenario => scenario({
    id, app: 'iterm', title, dims: ['D3'], platforms: ['darwin'], tiers: ['a'],
    sessions: [itermSession('a', { tab: 0 }), itermSession('b', { tab: 1 }), itermGhost],
    steps: [...started(order), ...listed('iterm', [...order].reverse()), ...more],
    checks: [], probes: [],
  })

  it("the walk names a plain tab's agent iterm by iTerm2's server, under iTerm2 and under launchd", async () => {
    const one = scenario({
      id: 'S6', app: 'iterm', title: 'Eval one tab, then iTerm2 relaunched', dims: ['D1'], platforms: ['darwin'], tiers: ['a'],
      sessions: [itermSession('a'), itermGhost], steps: [...started(['a']), { kind: 'iterm.relaunch' }], checks: [], probes: [],
    })
    const driver = new TierADriver({ startDevices })
    await driver.start(one, 'darwin')
    try {
      await driver.step(one.steps[0] as Exclude<Step, { kind: 'wait' }>)
      const agent = machine.owners.get(one.sessions[0]!.id)!.pid
      // No process of iTerm2's carries an app id: what names it is the real walk, over the model's table.
      expect(machine.appOf(agent)).toBeUndefined()
      const login = machine.processes.get(machine.processes.get(agent)!.ppid)!.ppid
      const server = machine.processes.get(login)!.ppid
      const iterm = machine.processes.get(server)!.ppid
      expect(basename(machine.processes.get(server)!.executable)).toMatch(/^iTermServer-/)
      expect(await learnApps([agent])).toEqual(new Map([[agent, 'iterm']]))
      await driver.step(one.steps[1] as Exclude<Step, { kind: 'wait' }>)
      expect([machine.processes.has(iterm), machine.processes.get(server)!.ppid]).toEqual([false, 1])
      expect(await learnApps([agent])).toEqual(new Map([[agent, 'iterm']]))
    } finally {
      await driver.stop()
    }
  })

  it("I5 on darwin: a tap on b runs open -b com.googlecode.iterm2 and writes b's select with raise on the tabs stream, and none "
    + 'for another tab', async () => {
    const i5 = twoTabs('I5', 'Eval a tap on a tab row', ['b', 'a'], [{ label: 'tap', kind: 'tap', session: 'b' }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, i5, 'darwin')
    expect(run.error).toBeUndefined()
    const { streams = [], commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const after = commands.filter((c) => c.at >= tap.at)
    expect(after.map(({ argv, ok }) => ({ argv, ok }))).toEqual([{ argv: ['/usr/bin/open', '-b', 'com.googlecode.iterm2'], ok: true }])
    const selects = streams.filter((l) => l.window === 'tabs' && l.at >= tap.at)
    expect(selects.map((l) => l.line)).toEqual([{ app: 'iterm', tab: 'w1.1.0', raise: true }])
    expect(selects[0]!.at).toBeGreaterThanOrEqual(after[0]!.at)
  })

  it("I8: b's tab selected with iTerm2 settled in front turns the dial to b within 1 s", async () => {
    // a first, so the face is on a: the dial keeps the row it shows as b arrives, and must move for the select.
    const i8 = twoTabs('I8', "Eval the person selects b's tab", ['a', 'b'],
      [{ label: 'select', kind: 'iterm.select', window: 'w1', tab: 1 }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, i8, 'darwin')
    expect(run.error).toBeUndefined()
    const { faces, steps } = driver.seen()
    const select = steps.find((s) => s.label === 'select')!
    const [a, b] = i8.sessions.slice(0, 2).map(agentIdOf)
    expect(faces.filter((f) => f.at < select.at).at(-1)?.active).toBe(a)
    const moved = faces.find((f) => f.at >= select.at && f.active === b)
    expect((moved?.at ?? Infinity) - select.at).toBeLessThanOrEqual(1_000)
  })

  /** A plain tab a in w1's tab 0 and Claude Code in tmux t, whose client runs in tab 1, started t then a and listed, then
   *  `more`. */
  const tmuxTab = (id: string, title: string, more: Step[]): Scenario => scenario({
    id, app: 'iterm', title, dims: ['D3'], platforms: ['darwin'], tiers: ['a'],
    sessions: [itermSession('a', { tab: 0 }), itermSession('t', { place: 'tmux', tab: 1 }), itermGhost],
    steps: [...started(['t', 'a']), ...listed('iterm', ['a', 't']), ...more],
    checks: [], probes: [],
  })

  /** Claude Code a in w1's tab 0 and c under tmux in its tab 1, started c then a and listed on Orca's page. */
  const orcaTmux = scenario({
    id: 'S8', app: 'orca', title: 'Eval an Orca agent under tmux', dims: ['D1'], tiers: ['a'],
    sessions: [orcaSession('a', { worktree: 'w1', tab: 0 }), orcaSession('c', { worktree: 'w1', tab: 1, tmux: true }), orcaGhost],
    steps: [...orcaOpening(['w1']), ...orcaStarted(['c', 'a']), ...listed('orca', ['a', 'c'])],
    checks: [], probes: [],
  })

  it("tmux is found on an iTerm2 scenario's machine and on one whose Orca agent runs under tmux, never on Windows", async () => {
    const found = async (of: Scenario, platform: Platform = 'darwin') => {
      const driver = new TierADriver({ startDevices })
      await driver.start(of, platform)
      try {
        return await ensureTmuxOnPath()
      } finally {
        await driver.stop()
      }
    }
    const c1 = MAIN.find((s) => s.id === 'C1')!
    const adopted = { state: 'adopted', path: '/opt/eval/bin/tmux', from: 'standard install location' }
    expect(await found(tmuxTab('S7', 'Eval tmux is installed', []))).toEqual(adopted)
    for (const platform of ['darwin', 'linux'] as const) expect(await found(orcaTmux, platform), platform).toEqual(adopted)
    expect((await found(orcaTmux, 'win32')).state).toBe('absent')
    expect((await found(c1)).state).toBe('absent')
    // C1's devices run no tmux.
    const driver = new TierADriver({ startDevices })
    expect((await runScenario(driver, c1, 'darwin')).error).toBeUndefined()
    expect(driver.seen().commands.filter((c) => basename(c.argv[0]!) === 'tmux')).toEqual([])
  })

  it.for(['linux', 'darwin'] as const)(
    "an Orca agent under tmux: tmux's lookup runs on the world's tmux and finds its client in Orca on Linux and macOS (%s)",
    async (platform) => {
      const driver = new TierADriver({ startDevices })
      const run = await runScenario(driver, orcaTmux, platform)
      expect(run.error).toBeUndefined()
      expect(run.gaps).toEqual([])
      const { commands, logs = [] } = driver.seen()
      expect(commands.filter((c) => c.argv[1] === 'list-clients').map(({ argv, ok }) => ({ argv: argv.slice(0, 4), ok })))
        .toContainEqual({ argv: ['/opt/eval/bin/tmux', 'list-clients', '-t', 'pane:c'], ok: true })
      expect(logs.map((l) => l.line)).toContain('[device] tmux client · found')
    })

  it("I6 inline: a rest on the tmux row with iTerm2 in front writes its client's tab select without raise and runs "
    + 'select-window ; select-pane for its pane', async () => {
    const i6 = tmuxTab('I6', 'Eval a rest on a tmux row', [{ label: 'rest', kind: 'swipe', session: 't' }, { kind: 'wait', ms: 2_000 }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, i6, 'darwin')
    expect(run.error).toBeUndefined()
    expect(run.gaps).toEqual([])
    const { streams = [], commands, steps } = driver.seen()
    const rest = steps.find((s) => s.label === 'rest')!
    const selects = streams.filter((l) => l.window === 'tabs' && l.at >= rest.at)
    expect(selects.map((l) => l.line)).toEqual([{ app: 'iterm', tab: 'w1.1.0' }])
    const after = commands.filter((c) => c.at >= rest.at)
    expect(after.filter((c) => c.argv.includes('select-pane')).map(({ argv, ok }) => ({ argv, ok }))).toEqual([
      { argv: ['/opt/eval/bin/tmux', 'select-window', '-t', 'pane:t', ';', 'select-pane', '-t', 'pane:t'], ok: true },
    ])
    // Nothing brings iTerm2 forward on a rest: it is in front.
    expect(after.filter((c) => c.argv[0] === '/usr/bin/open')).toEqual([])
  })

  /** A plain tab a in w1's tab 0 and Claude Code in herdr h and g, whose client runs in tab 1, started h, g then a and
   *  listed, then `more`. */
  const herdrTab = (id: string, title: string, more: Step[]): Scenario => scenario({
    id, app: 'iterm', title, dims: ['D3'], platforms: ['darwin'], tiers: ['a'],
    sessions: [itermSession('a', { tab: 0 }), itermSession('h', { place: 'herdr', tab: 1 }),
      itermSession('g', { place: 'herdr', tab: 1, split: 1 }), itermGhost],
    steps: [...started(['h', 'g', 'a']), ...listed('iterm', ['a', 'g', 'h']), ...more],
    checks: [], probes: [],
  })

  it("I7 inline: a tap on a herdr row runs herdr agent focus for its pane and open -b iTerm2, and writes its client's tab "
    + 'select with raise', async () => {
    const i7 = herdrTab('I7', 'Eval a tap on a herdr row', [{ label: 'tap', kind: 'tap', session: 'h' }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, i7, 'darwin')
    expect(run.error).toBeUndefined()
    expect(run.gaps).toEqual([])
    const { streams = [], commands, steps } = driver.seen()
    const tap = steps.find((s) => s.label === 'tap')!
    const after = commands.filter((c) => c.at >= tap.at && ['herdr', 'open'].includes(basename(c.argv[0]!)))
    expect(after.map(({ argv, ok }) => ({ argv, ok }))).toEqual([
      { argv: ['/opt/eval/bin/herdr', 'agent', 'focus', 'pane:h'], ok: true },
      { argv: ['/usr/bin/open', '-b', 'com.googlecode.iterm2'], ok: true },
    ])
    const selects = streams.filter((l) => l.window === 'tabs' && l.at >= tap.at)
    expect(selects.map((l) => l.line)).toEqual([{ app: 'iterm', tab: 'w1.1.0', raise: true }])
  })

  it("every scenario but iTerm2's keeps noHerdr: C1's devices ask no herdr", async () => {
    const herdrOf = async (of: Scenario) => {
      const driver = new TierADriver({ startDevices })
      expect((await runScenario(driver, of, 'darwin')).error).toBeUndefined()
      const { logs = [], commands } = driver.seen()
      return { said: logs.filter((l) => l.line.startsWith('[herdr]')).map((l) => l.line),
        ran: commands.filter((c) => ['herdr', 'lsof', 'ps'].includes(basename(c.argv[0]!))).map((c) => c.argv) }
    }
    // On iTerm2's machine herdr is installed, and its source subscribes once its server runs.
    expect((await herdrOf(herdrTab('S8', 'Eval herdr is installed', []))).said).toContain('[herdr] socket · live')
    expect(await herdrOf(MAIN.find((s) => s.id === 'C1')!)).toEqual({ said: [], ran: [] })
  })

  /** The #4544 case (the spec's I2): a plain tab a in w1's tab 0, Claude Code in tmux t, whose client runs in tab 1, and
   *  Claude Code in herdr h and g, whose client runs in tab 2, started a, t, h, then g, and listed on iTerm2's page, all
   *  four, as tmux's and herdr's pages list t, h and g too (docs/plans/2026-11-26-dial-mux-host-pages-design.md), then
   *  `more`. */
  const case4544 = (id: string, title: string, more: Step[]): Scenario => scenario({
    id, app: 'iterm', title, dims: ['D1'], platforms: ['darwin'], tiers: ['a'],
    sessions: [itermSession('a', { tab: 0 }), itermSession('t', { place: 'tmux', tab: 1 }), itermSession('h', { place: 'herdr', tab: 2 }),
      itermSession('g', { place: 'herdr', tab: 2, split: 1 }), itermGhost],
    steps: [...started(['a', 't', 'h', 'g']), ...listed('iterm', ['a', 't', 'h', 'g'], []), ...more],
    checks: [], probes: [],
  })
  const i2 = case4544('I2', 'Eval the #4544 case, hooked', [])
  /** I3: the four idle, each with a turn behind it, then the devices start again and no hook follows. */
  const i3 = case4544('I3', 'Eval the #4544 case, found by the scan after the devices start again',
    [...turned(['a', 't', 'h', 'g']), { label: 'restart', kind: 'devices.restart' }, { kind: 'wait', ms: 10_000 }])

  it("I3: after the devices start again, before any hook, iTerm2's page lists a, t, h and g, and tmux's and herdr's t, h "
    + 'and g too: the apps frame counts iTerm2 4, tmux 1, herdr 2, and no Other page', async () => {
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, i3, 'darwin')
    expect(run.error).toBeUndefined()
    expect(run.gaps).toEqual([])
    const seen = driver.seen()
    const restart = seen.steps.find((s) => s.label === 'restart')!
    expect(seen.steps.filter((s) => s.index > restart.index && s.kind === 'hook')).toEqual([])
    // What the new devices sent the dial, from their welcome on: the last hook came at the restart's own moment.
    const welcome = seen.frames.findIndex((f) => f.at >= restart.at && f.message.t === 'welcome')
    expect(welcome).toBeGreaterThanOrEqual(0)
    const [a, ...nested] = i3.sessions.slice(0, 4).map(agentIdOf)
    const frames = seen.frames.slice(welcome)
    const after = rings({ frames })
    expect(after.at(-1)?.page).toBe('iterm')
    expect(after.at(-1)!.rows.map((r) => r.id)).toEqual([a, ...nested])
    // A tmux or herdr agent is counted on its terminal app's page and on the multiplexer's (Diego's 2026-11-26 rule,
    // docs/plans/2026-11-26-dial-mux-host-pages-design.md).
    const apps = frames.filter((f) => f.message.t === 'apps').at(-1)?.message.apps as Array<{ id: string; count: number }> | undefined
    expect((apps ?? []).filter((p) => p.count > 0).map((p) => `${p.id} ${p.count}`).sort()).toEqual(['herdr 2', 'iterm 4', 'tmux 1'])
    expect(after.filter((r) => r.page !== 'iterm' && r.rows.some((row) => row.id === a))).toEqual([])
  })

  it('after the devices start again the mod polls the new devices: a voice reaches its session', async () => {
    const spoken = scenario({
      id: 'S9', app: 'iterm', title: 'Eval a voice after the devices start again', dims: ['D5'], platforms: ['darwin'], tiers: ['a'],
      sessions: [itermSession('a'), itermGhost],
      steps: [...started(['a']), ...listed('iterm', ['a']), ...turned(['a']), { kind: 'devices.restart' },
        // The mod asks again within a minute of a poll the devices could not hold.
        { kind: 'wait', ms: 60_000 },
        { label: 'voice', kind: 'voice', transcript: 'Eval words for alpha.', target: 'a' }],
      checks: [], probes: [],
    })
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, spoken, 'darwin')
    expect(run.error).toBeUndefined()
    expect(run.gaps).toEqual([])
    const { deliveries, steps } = driver.seen()
    const voice = steps.find((s) => s.label === 'voice')!
    expect(deliveries.filter((d) => d.at >= voice.at).map(({ path, target, text }) => ({ path, target, text })))
      .toEqual([{ path: 'mod', target: 'a', text: 'Eval words for alpha.' }])
  })

  it("after the devices start again a rest on a tab row writes its select on the tabs stream the watch opened again", async () => {
    const rested = twoTabs('S10', 'Eval a rest after the devices start again', ['a', 'b'],
      [{ kind: 'devices.restart' }, { label: 'rest', kind: 'swipe', session: 'a' }, { kind: 'wait', ms: 2_000 }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, rested, 'darwin')
    expect(run.error).toBeUndefined()
    const { streams = [], steps } = driver.seen()
    const rest = steps.find((s) => s.label === 'rest')!
    // The devices' selects: the stream's open and the person's tab reports carry a type.
    const selects = streams.filter((l) => l.window === 'tabs' && l.at >= rest.at && l.line.type === undefined)
    expect(selects.map((l) => l.line)).toEqual([{ app: 'iterm', tab: 'w1.0.0' }])
  })

  it("after the devices start again the watch tells them the app in front again: b's tab selected turns the dial to b within 1 s",
    async () => {
    const selected = twoTabs('S11', "Eval b's tab selected after the devices start again", ['a', 'b'],
      [{ kind: 'devices.restart' }, { kind: 'wait', ms: 2_000 }, { label: 'select', kind: 'iterm.select', window: 'w1', tab: 1 }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, selected, 'darwin')
    expect(run.error).toBeUndefined()
    const { faces, steps } = driver.seen()
    const select = steps.find((s) => s.label === 'select')!
    const [a, b] = selected.sessions.slice(0, 2).map(agentIdOf)
    expect(faces.filter((f) => f.at < select.at).at(-1)?.active).toBe(a)
    const moved = faces.find((f) => f.at >= select.at && f.active === b)
    expect((moved?.at ?? Infinity) - select.at).toBeLessThanOrEqual(1_000)
  })

  it('a restart the dial never comes back from fails its step, saying so', async () => {
    const unplugged = twoTabs('S12', 'Eval the devices start again with the dial unplugged', ['a'],
      [{ kind: 'unplug' }, { kind: 'devices.restart' }])
    const run = await runScenario(new TierADriver({ startDevices }), unplugged, 'darwin')
    expect(run.error).toBe('step 4 (devices.restart) threw: S12: the devices never welcomed the dial after they started again')
  })

  it('after the devices start again the watch opens its tabs stream again on their listener on its own retry, waiting on no '
    + 'dial', async () => {
    const unplugged = twoTabs('S13', 'Eval the tabs stream after the devices start again with the dial unplugged', ['a'],
      [{ kind: 'unplug' }, { label: 'restart', kind: 'devices.restart' }])
    const driver = new TierADriver({ startDevices })
    const run = await runScenario(driver, unplugged, 'darwin')
    // The dial never comes back to them, so the step fails (S12), with the stream open again all the same.
    expect(run.error).toBe('step 4 (devices.restart) threw: S13: the devices never welcomed the dial after they started again')
    const { streams = [], steps } = driver.seen()
    const restart = steps.find((s) => s.label === 'restart')!
    expect(streams.filter((l) => l.window === 'tabs' && l.at >= restart.at).map((l) => l.line)).toEqual([{ type: 'tabs' }])
  })

  it.for([i2, i3])('$id twice gives the same frames, streams, commands and deliveries at the same virtual times', async (of) => {
    const seen = async () => {
      const driver = new TierADriver({ startDevices })
      expect((await runScenario(driver, of, 'darwin')).error).toBeUndefined()
      const { frames, streams, commands, deliveries } = driver.seen()
      return { frames, streams, commands, deliveries }
    }
    const first = await seen()
    const second = await seen()
    expect(first.commands.some((c) => basename(c.argv[0]!) === 'tmux')).toBe(true)
    expect(second).toEqual(first)
  })

  it("ttyAtime answers the model's access time, never this machine's", async () => {
    machine.reset()
    machine.atimes.set('ttys9998', 1_234)
    expect(await ttyAtime('/dev/ttys9998')).toBe(1_234)
    expect(await ttyAtime('/dev/ttys9999')).toBeUndefined()
  })

  // The baseline is written on a Mac and checked on Linux: a result naming this host's folders would differ there.
  // A tty or a pane id is the machine's, not the scenario's: evidence names tabs and panes by label (itermRecords.ts).
  it('no result carries an absolute path, a tty or a pane id', () => {
    expect(runs.length).toBeGreaterThan(0)
    const results = collect(runs)
    const written = JSON.stringify(results)
    for (const part of [tmpdir(), homedir(), '/work/eval-', '/dev/tty', 'ttys0']) expect(written).not.toContain(part)
    // tmux's and herdr's pane ids in any evidence, and a tmux session's name in iTerm2's: an editor's window id
    // (eval-w2-1) is the scenario's own.
    for (const { app, evidence } of results.results) {
      for (const line of evidence) {
        for (const id of [/%[0-9]+/, /w[0-9A-Z]+:p[0-9A-Z]+/, ...(app === 'iterm' ? [/eval-w[0-9]+-[0-9]+/] : [])]) {
          expect(line).not.toMatch(id)
        }
      }
    }
  })

  // The eval command judges the ratchet itself, over both tiers, and says so for its children (run.ts).
  it.skipIf(process.env[SKIP_RATCHET_ENV] === '1')('matches the baseline', () => {
    const baseline = loadBaseline()
    expect(baseline).not.toBeNull()
    const verdict = tierAVerdict(collect(runs), baseline!)
    expect(verdict.ok, verdict.message).toBe(true)
  })
})
