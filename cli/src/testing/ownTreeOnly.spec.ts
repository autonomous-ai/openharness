import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endRootProcesses, seenNow, underRoot } from './rootProcesses.js'
import { writeExecutable } from './executableFixture.js'
import { namedTree, processTable, processTree, SpawnedRuns, type Run } from './spawnedRuns.js'

/**
 * The harness reads of the machine's processes each one's pid, parent and group, and nothing more of any but the test's
 * own: the tree of the processes the test started (PM, 2026-11-23). Here every `ps`, `lsof`, `pgrep` and `pkill` the code
 * under test runs is answered from a made-up machine and noted, and every signal is noted and sent nowhere: no process of
 * this computer is read or signalled, the person's own among them.
 */
interface Made { pid: number; ppid: number; pgid: number; command: string; cwd: string; uid: number; started: string }
/**
 * The made-up machine: its processes, the runs asked of it and the signals sent. [ANSWER] is what `ps` or `lsof` prints
 * there and its exit status, as source, so the fake binaries a process of its own runs (the worker's reaper) answer the
 * same way this worker's mock does.
 */
const machine = vi.hoisted(() => {
  const ANSWER = `(rows, name, args) => {
    const at = args.indexOf('-p')
    const asked = at < 0 ? undefined : args[at + 1].split(',').map(Number)
    const listed = rows.filter((row) => asked === undefined || asked.includes(row.pid))
    const status = asked !== undefined && listed.length < asked.length ? 1 : 0
    if (name === 'lsof') return { stdout: listed.map((row) => 'p' + row.pid + '\\nu' + row.uid + '\\nfcwd\\nn' + row.cwd + '\\n').join(''), status }
    const o = args.findIndex((arg) => arg === '-o' || /^-[a-zA-Z]*o$/.test(arg))
    const fields = args[o + 1].split(',').map((field) => field.replace(/=$/, ''))
    const value = (row, field) => field === 'command' || field === 'args' ? row.command
      : field === 'comm' ? row.command.split(' ')[0] : field === 'lstart' ? row.started : String(row[field])
    return { stdout: listed.map((row) => fields.map((field) => value(row, field)).join(' ') + '\\n').join(''), status }
  }`
  return {
    ANSWER,
    answer: new Function(`return ${ANSWER}`)() as (rows: Made[], name: string, args: readonly string[]) => { stdout: string; status: number },
    rows: [] as Made[], runs: [] as Array<{ file: string; args: string[] }>, signals: [] as Array<[number, string | number]>,
    /** Whether `ps -A` fails there, as one cut off at its timeout does. */
    tableFails: false,
  }
})

/** What the harness told the worker's reaper of the processes it started (reaper.ts watchOwn): never a real reaper. */
const told = vi.hoisted(() => [] as Array<[number, string]>)
vi.mock('../../e2e/harness/reaper.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  watchOwn: (pid: number, started: string) => { told.push([pid, started]) },
  forgetOwn: () => {},
}))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const { basename } = await import('node:path')
  const { promisify } = await import('node:util')
  // The computer's own readers, by name or from a system folder: a fake of a spec's own in a folder of its own runs.
  const READERS = ['ps', 'lsof', 'pgrep', 'pkill']
  const reads = (file: string) => READERS.includes(basename(file)) && (!file.includes('/') || /^\/(usr\/)?s?bin\//.test(file))
  /** What [file] would print with [args] on the made-up machine, and its exit status: pgrep and pkill find nothing. */
  const answer = (file: string, args: readonly string[]): { stdout: string; status: number } => {
    machine.runs.push({ file, args: [...args] })
    const name = basename(file)
    if (name === 'ps' && args.includes('-A') && machine.tableFails) return { stdout: '', status: 1 }
    return name === 'pgrep' || name === 'pkill' ? { stdout: '', status: 1 } : machine.answer(machine.rows, name, args)
  }
  const failed = (file: string, status: number, stdout: string) =>
    Object.assign(new Error(`${file} exited ${status}`), { status, stdout, stderr: '' })
  const execFileSync = ((file: string, args?: readonly string[], options?: object) => {
    if (!reads(file)) return real.execFileSync(file, args ?? [], options)
    const { stdout, status } = answer(file, args ?? [])
    if (status !== 0) throw failed(file, status, stdout)
    return stdout
  }) as typeof real.execFileSync
  const spawnSync = ((file: string, args?: readonly string[], options?: object) => {
    if (!reads(file)) return real.spawnSync(file, args ?? [], options)
    const { stdout, status } = answer(file, args ?? [])
    return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status, signal: null }
  }) as typeof real.spawnSync
  const execFile = ((file: string, args: readonly string[], ...rest: unknown[]) => {
    if (!reads(file)) return (real.execFile as (...all: unknown[]) => ChildProcess)(file, args, ...rest)
    const done = rest.find((one) => typeof one === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const { stdout, status } = answer(file, args)
    setImmediate(() => done?.(status === 0 ? null : failed(file, status, stdout), stdout, ''))
    return {} as ChildProcess
  }) as typeof real.execFile
  Object.assign(execFile, {
    [promisify.custom]: (file: string, args: readonly string[], options?: object) => new Promise((resolve, reject) => {
      execFile(file, args, options ?? {}, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))
    }),
  })
  return { ...real, execFileSync, spawnSync, execFile, default: { ...real, execFileSync, spawnSync, execFile } }
})

/** The made-up machine's pids, past any pid a real machine gives (macOS stops at 99998, Linux at 4194304). */
const P = (n: number): number => 5_000_000 + n
const LSTART = 'Mon Nov 23 10:00:00 2026'
const UID = process.getuid?.() ?? 501
const made = (pid: number, ppid: number, pgid: number, command: string, cwd = '/repo', started = LSTART, uid = UID): Made =>
  ({ pid, ppid, pgid, command, cwd, uid, started })

/** The fields a read asked for, and the pids it asked of (none: every process). */
const fieldsOf = (args: readonly string[]): string[] => {
  const o = args.findIndex((arg) => arg === '-o' || /^-[a-zA-Z]*o$/.test(arg))
  return o < 0 ? [] : args[o + 1]!.split(',').map((field) => field.replace(/=$/, ''))
}
const askedOf = (args: readonly string[]): number[] | undefined => {
  const at = args.indexOf('-p')
  return at < 0 ? undefined : args[at + 1]!.split(',').map(Number)
}
/**
 * The reads that went past what the harness may read: anything more than a pid, a parent, a group of every process;
 * more than a start time of a process not in [tree] nor in [seen] (a pid the test once saw, read to tell whether it is
 * still that process); anything of a process not in [tree] beyond that; and every pgrep and pkill, which read each
 * process's command line.
 */
function beyond(tree: Iterable<number>, seen: Iterable<number> = []): string[] {
  const ours = new Set(tree), once = new Set([...ours, ...seen])
  const IDENTITY = ['pid', 'ppid', 'pgid']
  return machine.runs.filter(({ file, args }) => {
    const name = basename(file)
    if (name === 'pgrep' || name === 'pkill') return true
    if (name !== 'ps' && name !== 'lsof') return false
    const asked = askedOf(args)
    const fields = name === 'lsof' ? ['cwd'] : fieldsOf(args)
    if (asked === undefined) return !fields.every((field) => IDENTITY.includes(field))
    if (fields.every((field) => [...IDENTITY, 'lstart'].includes(field))) return asked.some((pid) => !once.has(pid))
    return asked.some((pid) => !ours.has(pid))
  }).map(({ file, args }) => `${file} ${args.join(' ')}`)
}

let folders: string[] = []
beforeEach(() => {
  machine.rows = []
  machine.runs = []
  machine.signals = []
  machine.tableFails = false
  const kill = process.kill.bind(process)
  // Signal 0 to a made-up pid: gone. Any other signal is noted and sent nowhere; none ever reaches a real process.
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (Math.abs(pid) < P(0)) {
      if (signal === 0) return kill(pid, 0)
      throw new Error(`a signal to a real process: ${pid} ${String(signal)}`)
    }
    if (signal !== 0) machine.signals.push([pid, signal ?? 'SIGTERM'])
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A test root, as isolatedTmux makes one: directly in the temporary folder, by its real path. */
function testRoot(): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'htmux-')))
  folders.push(root)
  return root
}

const WORKER = process.pid
const VITEST = P(1)
const MASTER = P(10), CORE = P(11), CODEX = P(20), CODEX_CHILD = P(21), TMUX = P(30), PANE = P(31), LEFT = P(32), OWN_CALL = P(40)
const PERSON = [P(100), P(101), P(102)]

/**
 * A daemon under test on the made-up machine, with the person's own processes beside it, two of which name its root or
 * work in it: the worker and its group's leader; the daemon's master leading its group, its core, the core's Codex
 * rate-limit read in a group of its own with its child; the root's tmux server, launchd's, with a pane and what the
 * pane left; a tmux call of the worker's own, in the worker's group; and the person's editor naming a file in the root,
 * their Claude Code working in it, and its child.
 */
function daemonUnder(root: string): Made[] {
  return [
    made(VITEST, 1, VITEST, 'node vitest'),
    made(WORKER, VITEST, VITEST, 'node (vitest 1)'),
    made(MASTER, WORKER, MASTER, 'node /repo/cli/src/cli.ts __harnessd'),
    made(CORE, MASTER, MASTER, 'node /repo/cli/src/cli.ts __run'),
    made(CODEX, CORE, CODEX, `node ${root}/bin/codex app-server`),
    made(CODEX_CHILD, CODEX, CODEX, 'node /repo/cli/e2e/harness/fakeEngine.mjs app-server'),
    made(TMUX, 1, TMUX, `tmux -S ${root}/tmux-501/default new-session`, root),
    made(PANE, TMUX, PANE, '-zsh', `${root}/projects/a`),
    made(LEFT, PANE, LEFT, 'sleep 600', `${root}/projects/a`),
    made(OWN_CALL, WORKER, VITEST, `tmux -S ${root}/tmux-501/default list-panes`),
    made(PERSON[0]!, 1, PERSON[0]!, `vim ${root}/notes.txt`, '/Users/person'),
    made(PERSON[1]!, 1, PERSON[1]!, 'claude', `${root}/projects/a`),
    made(PERSON[2]!, PERSON[1]!, PERSON[1]!, 'node mcp-server', root),
  ]
}
/** The test's tree on that machine: the worker's, and the tmux server's. */
const TREE = [WORKER, MASTER, CORE, CODEX, CODEX_CHILD, TMUX, PANE, LEFT, OWN_CALL]

const SERVER = P(50), HELPER = P(51), CAT = P(52), HERDR = P(60), HERDR_PANE = P(61), STALE = P(70)
/**
 * What the harness started and noted as it started it (IsolatedDaemon.own), launchd's now that its parent is gone: the
 * fake iTerm2's server, in the worker's group, with its tab's helper and the helper's `cat`, which name nothing of the
 * root; herdr's server its client started, leading a group of its own with a pane's shell, naming nothing of the root
 * and working outside it; and a pid noted for a server since gone, which a process of the person's has now, of the same
 * path, started later.
 */
function noted(root: string): Made[] {
  const server = `${root}/home/Library/Application Support/iTerm2/iTermServer-3.6.6`
  return [
    made(SERVER, 1, VITEST, `${server} -e under-app python3 -c pty /bin/cat`),
    made(HELPER, SERVER, VITEST, 'python3 -c pty /bin/cat'),
    made(CAT, HELPER, CAT, '/bin/cat'),
    made(HERDR, 1, HERDR, '/opt/homebrew/bin/herdr server', '/Users/person'),
    made(HERDR_PANE, HERDR, HERDR, '-zsh', '/Users/person'),
    made(STALE, 1, STALE, `${server} -e under-app`, '/Users/person', 'Mon Nov 23 10:07:00 2026'),
  ]
}
/** The pids noted and the start each had then. */
const NOTED = new Map([[SERVER, LSTART], [HERDR, LSTART], [STALE, LSTART]])
/** What descends from the noted processes that still run as themselves. */
const NOTED_TREE = [SERVER, HELPER, CAT, HERDR, HERDR_PANE]

describe("the process table the harness reads of every process", () => {
  it('is each one\'s pid, parent and group, and nothing else', () => {
    machine.rows = daemonUnder('/tmp/htmux-x')
    const table = processTable()
    expect(table.find((row) => row.pid === CODEX)).toEqual({ pid: CODEX, ppid: CORE, pgid: CODEX })
    expect(machine.runs).toEqual([{ file: 'ps', args: ['-A', '-o', 'pid=,ppid=,pgid='] }])
  })

  it('makes a tree of children, and of the members of a group one of the tree leads, never pid 1', () => {
    const table = [made(1, 0, 1, 'launchd'), made(P(1), 1, P(1), 'a'), made(P(2), P(1), P(2), 'b'), made(P(3), 1, P(2), 'b orphan'),
      made(P(4), P(3), P(4), 'c'), made(P(5), 1, P(5), 'stranger')]
    expect(processTree(table, [P(1), 1]).map((row) => row.pid)).toEqual([P(1), P(2), P(3), P(4)])
  })

  it("asks the command line of the tree's processes alone", () => {
    machine.rows = daemonUnder('/tmp/htmux-x')
    expect(namedTree([WORKER, TMUX]).map((row) => row.pid)).toEqual(TREE)
    expect(beyond(TREE)).toEqual([])
  })
})

// A working folder is read by lsof on macOS; Linux reads /proc, which nothing here can stand in for.
const FOLDERS = process.platform === 'darwin'

describe("the daemon's close sweep", () => {
  it('sees, before anything is ended, the start time of what the test\'s tree holds, and nothing else of it', () => {
    machine.rows = daemonUnder('/tmp/htmux-x')
    const seen = seenNow([WORKER, TMUX])
    expect([...seen.keys()]).toEqual(TREE)
    expect(seen.get(LEFT)).toBe(LSTART)
    expect(beyond([], TREE)).toEqual([])
  })

  it.runIf(FOLDERS)('ends what the tree left once its parents are gone, asks nothing of a process outside it, and ends none', async () => {
    const root = testRoot()
    machine.rows = daemonUnder(root)
    // What the close saw before it stopped the daemon and the tmux server.
    const seen = new Map(TREE.map((pid) => [pid, LSTART]))
    // Then: the master, its core, the server and its pane gone; the read and what the pane left launchd's; the core's
    // pid another's by now, working in the root.
    machine.rows = machine.rows.filter((row) => ![MASTER, TMUX, PANE].includes(row.pid))
      .map((row) => row.pid === CORE ? made(CORE, 1, CORE, 'bash', root, 'Mon Nov 23 10:05:00 2026')
        : [CODEX, LEFT].includes(row.pid) ? { ...row, ppid: 1 } : row)
    expect(await endRootProcesses(root, seen, new Map(), 0)).toEqual([])
    expect(machine.signals).toEqual([[-CODEX, 'SIGKILL'], [-LEFT, 'SIGKILL'], [OWN_CALL, 'SIGKILL']])
    expect(beyond([WORKER, CODEX, CODEX_CHILD, LEFT, OWN_CALL], TREE)).toEqual([])
  })

  it.runIf(FOLDERS)('ends what the harness noted it started and what descends from it, by its start, once launchd has it, whatever it names, and spares a process given a noted pid since', async () => {
    const root = testRoot()
    machine.rows = [...daemonUnder(root), ...noted(root)]
    // Nothing seen before: only the note keeps the fake iTerm2's server and herdr's the test's.
    expect(await endRootProcesses(root, new Map(), NOTED, 0)).toEqual([])
    const ended = machine.signals.map(([pid]) => pid)
    expect(ended).toEqual(expect.arrayContaining([SERVER, HELPER, -CAT, -HERDR]))
    expect(ended.filter((pid) => [STALE, ...PERSON].includes(Math.abs(pid)))).toEqual([])
    expect(beyond([WORKER, MASTER, CORE, CODEX, CODEX_CHILD, OWN_CALL, ...NOTED_TREE], NOTED.keys())).toEqual([])
  })
})

describe("the harness's note of a process it started (IsolatedDaemon.own)", () => {
  /** An IsolatedDaemon of the made-up machine, its tmux server [TMUX], with no daemon started. */
  async function daemon(): Promise<{ own(pid: number): void; treeRoots(): Promise<number[]>; kill(): Promise<void> } & Record<string, unknown>> {
    const { IsolatedDaemon } = await import('../../e2e/harness/daemon.js' as string) as { IsolatedDaemon: { prototype: object } }
    return Object.assign(Object.create(IsolatedDaemon.prototype), { owned: new Map(), seen: new Map(), tmux: { run: async () => String(TMUX) } })
  }

  it.runIf(FOLDERS)("reads its start alone, tells the worker's reaper, and keeps it and its tree the test's once launchd has it, never a process given its pid since", async () => {
    const root = testRoot()
    told.length = 0
    machine.rows = [...daemonUnder(root), ...noted(root).map((row) => row.pid === STALE ? { ...row, started: LSTART } : row)]
    const d = await daemon()
    for (const pid of NOTED.keys()) d.own(pid)
    expect(told).toEqual([...NOTED])
    expect(beyond([], NOTED.keys())).toEqual([])
    // The server noted as STALE is gone, and a process of the person's has its pid.
    machine.rows = [...daemonUnder(root), ...noted(root)]
    machine.runs = []
    const roots = await d.treeRoots()
    expect(roots).toEqual([WORKER, TMUX, SERVER, HERDR])
    // Tier B's leftover check counts the server, which names the root, from the note alone.
    expect(underRoot(root, roots).map((row) => row.pid)).toContain(SERVER)
    expect(beyond([...TREE, ...NOTED_TREE], NOTED.keys())).toEqual([])
  })

  it('ends the daemon as a crash does though the process table cannot be read', async () => {
    const d = await daemon()
    const kill = vi.fn()
    d.child = { kill, once: (_event: string, done: () => void) => done() }
    machine.tableFails = true
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    await d.kill()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    expect(said.mock.calls).toEqual([[expect.stringMatching(/^\[e2e sweep\] could not see the test's processes before ending the daemon: /)]])
  })
})

describe("tier B's cost", () => {
  it.runIf(FOLDERS)("counts the tree's processes under the root, and asks nothing of one outside it", () => {
    const root = testRoot()
    machine.rows = daemonUnder(root)
    expect(underRoot(root, [WORKER, TMUX]).map((row) => row.pid)).toEqual([CODEX, CODEX_CHILD, TMUX, PANE, LEFT, OWN_CALL])
    expect(beyond(TREE)).toEqual([])
  })
})

describe('a spec run\'s processes (SpawnedRuns)', () => {
  /** 10:00:00 on the day of the made-up machine, plus [seconds], and as `ps` prints a start. */
  const at = (seconds: number): Date => new Date(2026, 10, 23, 10, 0, seconds)
  const lstart = (date: Date): string => {
    const [day, month, , year] = date.toDateString().split(' ')
    return `${day} ${month} ${String(date.getDate()).padStart(2)} ${date.toTimeString().slice(0, 8)} ${year}`
  }
  const GROUP = P(210), MEMBER = P(211), ITS_CHILD = P(212), DAEMON = P(200), DAEMONS_CHILD = P(201), NAMES_ROOT = P(300)

  /**
   * A run that began at 10:00:00 and has exited, its group and a daemon its pid file names, written at 10:00:30; its own
   * process started when `ps` says [leaderStarted].
   */
  function exitedRun(daemonStarted: Date, started = at(0).getTime(), leaderStarted = at(0)): Run {
    const root = mkdtempSync(join(tmpdir(), 'spawned-runs-'))
    folders.push(root)
    mkdirSync(join(root, 'data'))
    const file = join(root, 'data', 'adapter.pid')
    writeFileSync(file, `${DAEMON}\n`)
    utimesSync(file, at(30), at(30))
    machine.rows = [
      made(MEMBER, 1, GROUP, 'node member'), made(ITS_CHILD, MEMBER, ITS_CHILD, 'node child'),
      made(DAEMON, 1, DAEMON, 'node daemon', '/repo', lstart(daemonStarted)), made(DAEMONS_CHILD, DAEMON, DAEMON, 'node its child'),
      made(NAMES_ROOT, 1, NAMES_ROOT, `vim ${root}/notes.txt`),
    ]
    const child = { exitCode: 0, signalCode: null } as unknown as ChildProcess
    return { child, pgid: GROUP, root, label: 'leaky', started, leaderStarted: leaderStarted.getTime(), exited: Promise.resolve(0), stdout: '', stderr: '' }
  }

  it('are its group, what descends from it, and the daemon its pid file names while that pid started in its time', () => {
    const run = exitedRun(at(5))
    expect(new SpawnedRuns().belonging(run).map((row) => row.pid).sort()).toEqual([DAEMON, DAEMONS_CHILD, MEMBER, ITS_CHILD].sort())
    expect(beyond([MEMBER, ITS_CHILD, DAEMON, DAEMONS_CHILD], [DAEMON])).toEqual([])
  })

  it('leave out a pid its pid file names that started after the file was written: another process has it', () => {
    const run = exitedRun(at(40))
    expect(new SpawnedRuns().belonging(run).map((row) => row.pid).sort()).toEqual([MEMBER, ITS_CHILD].sort())
    expect(beyond([MEMBER, ITS_CHILD], [DAEMON])).toEqual([])
  })

  it("take the daemon whose `ps` start is the second before the run's clock, as Linux's can be, while no sooner than the run's own process", () => {
    // Linux's lstart is the boot time truncated to the second plus the process's age, truncated again.
    const run = exitedRun(at(-1), at(0).getTime() + 400, at(-1))
    expect(new SpawnedRuns().belonging(run).map((row) => row.pid).sort()).toEqual([DAEMON, DAEMONS_CHILD, MEMBER, ITS_CHILD].sort())
  })

  it("leave out a pid its pid file names that started before the run's own process: the run did not start it", () => {
    const run = exitedRun(at(-5))
    expect(new SpawnedRuns().belonging(run).map((row) => row.pid).sort()).toEqual([MEMBER, ITS_CHILD].sort())
    expect(beyond([MEMBER, ITS_CHILD], [DAEMON])).toEqual([])
  })

  it("are killed after their SIGTERM while each runs as itself, never a process given one of their pids meanwhile", async () => {
    const run = exitedRun(at(5))
    const signal = vi.mocked(process.kill).getMockImplementation()!
    vi.mocked(process.kill).mockImplementation((pid, sent) => {
      // The member ends at its SIGTERM, and a process of the person's has its pid by the SIGKILL.
      if (sent === 'SIGTERM' && pid === MEMBER) {
        machine.rows = machine.rows.map((row) => row.pid === MEMBER ? made(MEMBER, 1, MEMBER, 'vim', '/Users/person', 'Mon Nov 23 10:07:00 2026') : row)
        machine.runs = []
      }
      return signal(pid, sent)
    })
    await new SpawnedRuns().end(run)
    const killed = machine.signals.filter(([, sent]) => sent === 'SIGKILL').map(([pid]) => pid)
    expect(killed).toEqual(expect.arrayContaining([-GROUP, ITS_CHILD, DAEMON, DAEMONS_CHILD]))
    expect(killed).not.toContain(MEMBER)
    expect(beyond([ITS_CHILD, DAEMON, DAEMONS_CHILD], [MEMBER])).toEqual([])
  })
})

describe("the worker's reaper", () => {
  const REAPER = resolve(import.meta.dirname, '..', '..', 'e2e', 'harness', 'reaperProcess.mjs')

  /**
   * `ps`, `lsof` and `tmux` first on the reaper's PATH, answering from the made-up machine as this worker's mock does
   * and noting each run: the tmux server's `kill-server` ends it and its pane, and leaves launchd what the pane left.
   */
  function fakeBin(server: number[]): { bin: string; runs: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'made-up-machine-')))
    folders.push(dir)
    const file = join(dir, 'machine.json'), runs = join(dir, 'runs.jsonl'), script = join(dir, 'fake.mjs'), bin = join(dir, 'bin')
    writeFileSync(file, JSON.stringify({ rows: machine.rows, server }))
    writeFileSync(script, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [name, ...args] = process.argv.slice(2)
const made = JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8'))
appendFileSync(${JSON.stringify(runs)}, JSON.stringify({ file: name, args }) + '\\n')
if (name === 'tmux') {
  const [pid] = made.server
  if (args.includes('display-message')) {
    if (!made.rows.some((row) => row.pid === pid)) process.exit(1)
    process.stdout.write(pid + '\\n')
  }
  if (args.includes('kill-server')) {
    made.rows = made.rows.filter((row) => !made.server.includes(row.pid)).map((row) => made.server.includes(row.ppid) ? { ...row, ppid: 1 } : row)
    writeFileSync(${JSON.stringify(file)}, JSON.stringify(made))
  }
  process.exit(0)
}
const { stdout, status } = (${machine.ANSWER})(made.rows, name, args)
process.stdout.write(stdout)
process.exit(status)
`)
    mkdirSync(bin)
    for (const name of ['ps', 'lsof', 'tmux']) writeExecutable(join(bin, name), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${name} "$@"\n`)
    return { bin, runs }
  }

  it.runIf(FOLDERS)("asks nothing of a process outside the test's tree, ends none, and ends what its tmux server's tree left", async () => {
    const root = testRoot()
    // The worker is gone: a made-up pid stands in for it, so the reaper's machine holds no real process at all.
    const GONE = P(2)
    machine.rows = daemonUnder(root).map((row) => ({ ...row, pid: row.pid === WORKER ? GONE : row.pid, ppid: row.ppid === WORKER ? GONE : row.ppid }))
    const { bin, runs } = fakeBin([TMUX, PANE])
    const reaper = spawn(process.execPath, [REAPER], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    let said = ''
    reaper.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString() })
    reaper.stdin!.end(`${JSON.stringify({ tmux: join(root, 'tmux-501', 'default'), root })}\n`)
    const [code] = await once(reaper, 'exit')
    expect(code, said).toBe(0)
    expect(said).toContain(`[e2e reaper] ended 1 processes that still named ${root} or ran in it`)
    machine.runs = readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { file: string; args: string[] })
    expect(beyond([LEFT], [TMUX, PANE, LEFT])).toEqual([])
  })

  it.runIf(FOLDERS)('ends what the worker noted it started and what descends from it, by its start, once launchd has it, and spares a process given a noted pid since', async () => {
    const root = testRoot()
    const GONE = P(2)
    machine.rows = [...daemonUnder(root), ...noted(root)]
      .map((row) => ({ ...row, pid: row.pid === WORKER ? GONE : row.pid, ppid: row.ppid === WORKER ? GONE : row.ppid }))
    const { bin, runs } = fakeBin([TMUX, PANE])
    const reaper = spawn(process.execPath, [REAPER], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    let said = ''
    reaper.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString() })
    reaper.stdin!.end([{ tmux: join(root, 'tmux-501', 'default'), root }, ...[...NOTED].map(([own, started]) => ({ own, started }))]
      .map((line) => `${JSON.stringify(line)}\n`).join(''))
    const [code] = await once(reaper, 'exit')
    expect(code, said).toBe(0)
    expect(said).toContain(`[e2e reaper] the test worker ended with ${NOTED_TREE.length} processes it started, or theirs, still running: SIGKILL`)
    machine.runs = readFileSync(runs, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { file: string; args: string[] })
    expect(beyond([LEFT, ...NOTED_TREE], [TMUX, PANE, LEFT, ...NOTED.keys()])).toEqual([])
  })
})

describe('the harness beside the sweep', () => {
  it("tells the herdrs outside this worker from each process's pid and parent alone", async () => {
    const { othersNow } = await import('../../e2e/harness/herdrServer.js' as string) as { othersNow(): number[] }
    machine.rows = [made(VITEST, 1, VITEST, 'node vitest'), made(WORKER, VITEST, VITEST, 'node (vitest 1)'),
      made(P(400), WORKER, P(400), '/opt/homebrew/bin/herdr'), made(P(500), 1, P(500), '/Users/person/.local/bin/herdr')]
    const others = othersNow()
    expect(others).toContain(P(500))
    expect(others).not.toContain(P(400))
    expect(beyond([])).toEqual([])
  })

  it("finds herdr's server as its client's child from each process's pid and parent and the client's children's paths alone", async () => {
    const { childNamed } = await import('../../e2e/harness/herdrServer.js' as string) as { childNamed(parent: number, name: string): Promise<number | undefined> }
    const CLIENT = P(400), ITS_SERVER = P(401), ITS_SHELL = P(402)
    machine.rows = [made(VITEST, 1, VITEST, 'node vitest'), made(WORKER, VITEST, VITEST, 'node (vitest 1)'),
      made(CLIENT, WORKER, CLIENT, '/opt/homebrew/bin/herdr'), made(ITS_SHELL, CLIENT, CLIENT, '/bin/sh -c stty'),
      made(ITS_SERVER, CLIENT, ITS_SERVER, '/opt/homebrew/bin/herdr server'), made(P(500), 1, P(500), '/Users/person/.local/bin/herdr server')]
    expect(await childNamed(CLIENT, 'herdr')).toBe(ITS_SERVER)
    expect(beyond([ITS_SHELL, ITS_SERVER])).toEqual([])
  })

  it("kills herdr's server and client by the identity noted as each started, and of a pid another process has since, reads its start alone and kills nothing", async () => {
    const herdr = await import('../../e2e/harness/herdrServer.js' as string) as {
      identityOf(pid: number): unknown
      clientStarted(pid: number, identity: unknown): { reused(): boolean }
      killGroup(server: object): void
      killOwn(pid: number, identity: unknown): void
    }
    const OWN = P(400), TAKEN = P(401)
    machine.rows = [made(OWN, WORKER, OWN, '/opt/homebrew/bin/herdr'), made(TAKEN, WORKER, TAKEN, '/opt/homebrew/bin/herdr')]
    const own = herdr.identityOf(OWN), taken = herdr.identityOf(TAKEN)
    // TAKEN's process went, and one of the person's has its pid now.
    machine.rows = [machine.rows[0]!, made(TAKEN, 1, TAKEN, '/Users/person/.local/bin/herdr', '/Users/person', 'Mon Nov 23 10:07:00 2026')]
    machine.runs = []
    expect(herdr.clientStarted(TAKEN, taken).reused()).toBe(true)
    herdr.killGroup(herdr.clientStarted(TAKEN, taken))
    herdr.killOwn(TAKEN, taken)
    expect(machine.signals).toEqual([])
    expect(beyond([], [TAKEN])).toEqual([])
    herdr.killGroup(herdr.clientStarted(OWN, own))
    herdr.killOwn(OWN, own)
    expect(machine.signals).toEqual([[-OWN, 'SIGKILL'], [OWN, 'SIGKILL']])
  })

  it("kills a tab's command and shell while each runs as itself, never a process given one of their pids since", async () => {
    const outside = await import('../../e2e/harness/outsideAgent.js' as string) as {
      killTab(tab: object): void
      closeTab(tab: object, what: string): Promise<void>
    }
    const ENGINE = P(600), SHELL = P(601)
    const tab = { process: { exitCode: 0, signalCode: null, kill: vi.fn() }, pid: ENGINE, shellPid: SHELL, started: new Map([[ENGINE, LSTART], [SHELL, LSTART]]) }
    // The engine went, and a process of the person's has its pid now.
    machine.rows = [made(ENGINE, 1, ENGINE, 'vim', '/Users/person', 'Mon Nov 23 10:07:00 2026'), made(SHELL, WORKER, SHELL, '/bin/sh')]
    outside.killTab(tab)
    await outside.closeTab(tab, 'the tab')
    // The made-up machine answers each signal that its process is gone: killTab's SIGKILL is not sent after its SIGCONT.
    expect(machine.signals).toEqual([[SHELL, 'SIGCONT'], [SHELL, 'SIGKILL']])
    expect(beyond([SHELL], [ENGINE])).toEqual([])
  })

  it("ends the fake iTerm2 while it runs as itself, and of a pid another process has since, sends nothing and waits for nothing", async () => {
    const outside = await import('../../e2e/harness/outsideAgent.js' as string) as {
      relaunchIterm(tab: { appPid?: number; started: ReadonlyMap<number, string> }): Promise<void>
    }
    const OWN = P(700), TAKEN = P(701)
    // TAKEN's app went, and a process of the person's has its pid now and runs on.
    machine.rows = [made(OWN, WORKER, OWN, 'iTerm2'), made(TAKEN, 1, TAKEN, 'vim', '/Users/person', 'Mon Nov 23 10:07:00 2026')]
    const signal = vi.mocked(process.kill).getMockImplementation()!
    vi.mocked(process.kill).mockImplementation((pid, sent) => pid === TAKEN && sent === 0 ? true : signal(pid, sent))
    await outside.relaunchIterm({ appPid: TAKEN, started: new Map([[TAKEN, LSTART]]) })
    expect(machine.signals).toEqual([])
    await outside.relaunchIterm({ appPid: OWN, started: new Map([[OWN, LSTART]]) })
    expect(machine.signals).toEqual([[OWN, 'SIGKILL']])
    expect(beyond([OWN], [TAKEN])).toEqual([])
  })

  it("finds the endurance run's strays in the test's tree alone", async () => {
    const { strays } = await import('../../e2e/harness/endurance.js' as string) as {
      strays(d: { root: string; treeRoots(): Promise<number[]> }): Promise<string[]>
    }
    const root = testRoot()
    machine.rows = daemonUnder(root)
    expect(await strays({ root, treeRoots: async () => [WORKER, TMUX] })).toEqual([
      `${CODEX} node ${root}/bin/codex app-server`, `${TMUX} tmux -S ${root}/tmux-501/default new-session`,
      `${OWN_CALL} tmux -S ${root}/tmux-501/default list-panes`,
    ])
    expect(beyond(TREE)).toEqual([])
  })
})

