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
  }
})

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
    expect(await endRootProcesses(root, seen, 0)).toEqual([])
    expect(machine.signals).toEqual([[-CODEX, 'SIGKILL'], [-LEFT, 'SIGKILL'], [OWN_CALL, 'SIGKILL']])
    expect(beyond([WORKER, CODEX, CODEX_CHILD, LEFT, OWN_CALL], TREE)).toEqual([])
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

  /** A run that began at 10:00:00 and has exited, its group and a daemon its pid file names, written at 10:00:30. */
  function exitedRun(daemonStarted: Date): Run {
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
    return { child, pgid: GROUP, root, label: 'leaky', started: at(0).getTime(), exited: Promise.resolve(0), stdout: '', stderr: '' }
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

