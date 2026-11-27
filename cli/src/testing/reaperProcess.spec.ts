import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, commandLines, startTimes } from './spawnedRuns.js'
import { writeExecutable } from './executableFixture.js'

const REAPER = resolve(import.meta.dirname, '..', '..', 'e2e', 'harness', 'reaperProcess.mjs')

let root = ''
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

// The worker's reaper keeps its own copy of rootProcesses.ts's rule: a wrong root would have every process that names it
// SIGKILLed, group and all, and every folder under it made writable and removed.
it('the worker\'s reaper sweeps and removes nothing but a test root', () => {
  root = mkdtempSync(join(tmpdir(), 'reaper-guard-'))
  const notRoots = [join(root, 'not-a-root'), join(root, 'htmux-abc', 'bin')]
  for (const folder of notRoots) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'kept'), '')
  }
  const lines = notRoots.map((folder, i) => `${JSON.stringify({ tmux: join(root, `no-server-${i}`), root: folder })}\n`).join('')
  // Its stdin closing is the worker gone: it reaps and exits.
  const run = spawnSync(process.execPath, [REAPER], { input: lines, encoding: 'utf8', timeout: 20_000 })
  expect(run.status, run.stderr).toBe(0)
  for (const folder of notRoots) {
    expect(existsSync(join(folder, 'kept')), folder).toBe(true)
    expect(run.stderr).toContain(`[e2e reaper] not a test root, left alone: ${folder}`)
  }
})

describe.skipIf(process.platform === 'win32')('the worker\'s reaper and a process left in a root\'s folder', () => {
  const folders: string[] = []
  const started: ChildProcess[] = []
  /** What this spec's own children left running (the groups' sleeps, a Codex app server stand-in), by pid, with the start
   *  each had as it started: ended while each pid is still that process, never any other (the person's own Codex app
   *  servers run on this machine, and one could have such a pid since). */
  const detached = new Map<number, string>()
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
    const now = startTimes([...detached.keys()])
    for (const [pid, start] of detached) if (now.get(pid) === start) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    detached.clear()
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  /**
   * A process group of its own, as a daemon's master leads one, whose leader started a `sleep` in each of [cwds], each
   * in a session of its own as a Codex read is started: their command lines name nothing, and only the leader's tree,
   * seen before the reaper ends the group, reaches them. The group as the worker tells the reaper it, and the sleeps'
   * pids, running.
   */
  const group = async (cwds: string[]): Promise<{ line: object; pids: number[] }> => {
    const script = `const { spawn } = require('node:child_process')
console.log(JSON.stringify(${JSON.stringify(cwds)}.map((cwd) => spawn('sleep', ['600'], { cwd, stdio: 'ignore', detached: true }).pid)))
setInterval(() => {}, 1 << 30)`
    const leader = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    started.push(leader)
    const [said] = await once(createInterface({ input: leader.stdout! }), 'line') as [string]
    const pids = JSON.parse(said) as number[]
    for (const [pid, start] of startTimes(pids)) detached.set(pid, start)
    return { line: { group: leader.pid }, pids }
  }
  /** The reaper, told [lines], its worker then gone: what it wrote, once it has exited. Not spawnSync: this worker
   *  must be free to reap its own children, or one the reaper ended stays a zombie, alive to a signal. */
  const reaped = async (lines: object[], env: NodeJS.ProcessEnv = process.env): Promise<string> => {
    const reaper = spawn(process.execPath, [REAPER], { stdio: ['pipe', 'ignore', 'pipe'], env })
    let said = ''
    reaper.stderr!.on('data', (chunk: Buffer) => { said += chunk.toString() })
    reaper.stdin!.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))
    const [code] = await once(reaper, 'exit')
    expect(code, said).toBe(0)
    return said
  }

  it('ends a process whose folder is in a root it was told, and leaves one in a folder whose name only begins the root\'s', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir, `${dir}x`)
    mkdirSync(join(dir, 'work'))
    mkdirSync(`${dir}x`)
    const { line, pids: [inside, beside] } = await group([join(dir, 'work'), `${dir}x`])
    const said = await reaped([line, { tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => alive(inside!), { timeout: 10_000 }).toBe(false)
    expect(alive(beside!)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(said).toContain(`[e2e reaper] ended 1 processes that still named ${dir} or ran in it`)
  })

  /** A stand-in for `codex app-server --managed-daemon`, as it starts: detached by a launcher that writes its pid file at
   *  [file] and exits. Its pid, once it runs its own command line. */
  const standIn = async (file: string): Promise<number> => {
    const launch = `const { execFileSync, spawn } = require('node:child_process'), { mkdirSync, writeFileSync } = require('node:fs')
const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'app-server', '--managed-daemon'], { argv0: 'codex', detached: true, stdio: 'ignore', cwd: ${JSON.stringify(tmpdir())} })
mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true })
const processStartTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(server.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: server.pid, processStartTime }))
server.unref()`
    const launcher = spawn(process.execPath, ['-e', launch], { stdio: 'ignore' })
    expect((await once(launcher, 'exit'))[0]).toBe(0)
    const { pid, processStartTime } = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; processStartTime: string }
    detached.set(pid, processStartTime)
    // Until it runs its own command line: a process not yet past its exec still shows its launcher's.
    await expect.poll(() => commandLines([pid]).get(pid) ?? '', { timeout: 10_000 }).toContain('app-server --managed-daemon')
    return pid
  }

  // Codex's managed app server detaches itself, names no root and need not work in it: a real one from the tester of
  // #4660 and #4668 outlived its test, launchd's. Codex records it in <CODEX_HOME>/app-server-daemon/daemon.pid.
  it('ends a Codex app server a pid file in a root it was told names, though nothing of the worker still runs', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir)
    const pid = await standIn(join(dir, 'home', 'codex', 'app-server-daemon', 'daemon.pid'))
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    expect(existsSync(dir)).toBe(false)
    expect(said).toContain(`[e2e reaper] ended 1 Codex app servers that pid files in ${dir} named`)
  })

  /**
   * A stand-in for Codex 0.172's managed pair, as it starts: a launcher that exits, leaving launchd `codex app-server daemon
   * pid-update-loop` run as [loop], working outside the root, which starts the app server as its child in a group of its
   * own and records it in `<CODEX_HOME>/app-server-daemon/daemon.pid`, [home] its CODEX_HOME, and itself in
   * `daemon-updater.pid` beside it when [recorded], as Codex does. Neither names more of the root than [loop] does. Their
   * pids, once each runs its own command line.
   */
  const standInPair = async (home: string, loop: string, recorded = true): Promise<{ loop: number; server: number }> => {
    const updater = `const { execFileSync, spawn } = require('node:child_process'), { mkdirSync, writeFileSync } = require('node:fs'), { join } = require('node:path')
const started = (pid) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim()
const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'app-server', '--managed-daemon'], { argv0: 'codex', detached: true, stdio: 'ignore' })
const pair = { loop: { pid: process.pid, started: started(process.pid) }, server: { pid: server.pid, started: started(server.pid) } }
const dir = join(process.env.CODEX_HOME, 'app-server-daemon')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'daemon.pid'), JSON.stringify({ pid: pair.server.pid, processStartTime: pair.server.started }))
if (process.env.RECORDED) writeFileSync(join(dir, 'daemon-updater.pid'), JSON.stringify({ pid: pair.loop.pid, processStartTime: pair.loop.started }))
console.log(JSON.stringify(pair))
setInterval(() => {}, 1 << 30)`
    const launch = `const loop = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(updater)}, 'app-server', 'daemon', 'pid-update-loop'], { argv0: process.env.LOOP, detached: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: ${JSON.stringify(tmpdir())} })
require('node:readline').createInterface({ input: loop.stdout }).once('line', (line) => { console.log(line); process.exit(0) })`
    const env = { ...process.env, CODEX_HOME: home, LOOP: loop, RECORDED: recorded ? '1' : '' }
    const launcher = spawn(process.execPath, ['-e', launch], { stdio: ['ignore', 'pipe', 'ignore'], env })
    const [said] = await once(createInterface({ input: launcher.stdout! }), 'line') as [string]
    const pair = JSON.parse(said) as { loop: { pid: number; started: string }; server: { pid: number; started: string } }
    for (const { pid, started } of [pair.loop, pair.server]) detached.set(pid, started)
    expect((await once(launcher, 'exit'))[0]).toBe(0)
    // Until each runs its own command line: a process not yet past its exec still shows its parent's.
    await expect.poll(() => commandLines([pair.loop.pid]).get(pair.loop.pid) ?? '', { timeout: 10_000 }).toContain('app-server daemon pid-update-loop')
    await expect.poll(() => commandLines([pair.server.pid]).get(pair.server.pid) ?? '', { timeout: 10_000 }).toContain('app-server --managed-daemon')
    return { loop: pair.loop.pid, server: pair.server.pid }
  }

  // Codex 0.172's updater outlived close() in the real-Codex dial skill case: launchd's, as its server is, and working in
  // the root's work folder, outside the worker's tree. Codex records it beside its server.
  it('ends the updater Codex records beside its app server, the server\'s parent, though nothing of the worker still runs', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir)
    const home = join(dir, 'home', 'codex')
    const pair = await standInPair(home, join(home, 'packages', 'bin', 'codex'))
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => [alive(pair.server), alive(pair.loop)], { timeout: 10_000 }).toEqual([false, false])
    expect(said).toContain(`[e2e reaper] ended 2 Codex app servers that pid files in ${dir} named`)
  })

  it('never ends an app server\'s parent no pid file in the root records: the person\'s own updater', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir)
    const pair = await standInPair(join(dir, 'home', 'codex'), 'codex', false)
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => alive(pair.server), { timeout: 10_000 }).toBe(false)
    expect(alive(pair.loop)).toBe(true)
    expect(said).toContain(`[e2e reaper] ended 1 Codex app servers that pid files in ${dir} named`)
  })

  // macOS's `ps -p` given one pid of 100000 or over prints nothing of any pid asked with it, and exits 1.
  it('ends a Codex app server though another pid file in the root names a pid no machine gives', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir)
    // Past any pid a real machine gives: macOS's are under 100000, Linux's at most 4194304.
    mkdirSync(join(dir, 'home', 'stale', 'app-server-daemon'), { recursive: true })
    writeFileSync(join(dir, 'home', 'stale', 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: 4_194_305, processStartTime: 'Mon Nov 23 10:00:03 2026' }))
    const pid = await standIn(join(dir, 'home', 'codex', 'app-server-daemon', 'daemon.pid'))
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    expect(said).toContain(`[e2e reaper] ended 1 Codex app servers that pid files in ${dir} named`)
  })

  it('sweeps and removes nothing in a folder named like a root that is not directly in the temporary folder, or is a link', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-guard-')))
    const nested = join(outer, 'htmux-abc'), elsewhere = join(outer, 'elsewhere'), link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    folders.push(outer, link)
    for (const folder of [nested, elsewhere]) { mkdirSync(folder); writeFileSync(join(folder, 'kept'), '') }
    symlinkSync(elsewhere, link)
    const { line, pids: kept } = await group([nested, elsewhere])
    const said = await reaped([line, { tmux: join(outer, 'no-server-1'), root: nested }, { tmux: join(outer, 'no-server-2'), root: link }])
    for (const refused of [nested, link]) expect(said).toContain(`[e2e reaper] not a test root, left alone: ${refused}`)
    expect(kept.map(alive)).toEqual([true, true])
    expect([nested, elsewhere].map((folder) => existsSync(join(folder, 'kept')))).toEqual([true, true])
  })

  // Linux reads /proc, which nothing here can stand in for: there the owner of /proc/<pid> is the same check.
  it.runIf(process.platform === 'darwin')('takes a working folder only from a process of its own account', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-uid-')))
    folders.push(dir, outside)
    const { line, pids: [mine, theirs] } = await group([outside, outside])
    // An lsof that puts both in the root, the second as another account's. The real one lists another account's only for root.
    const bin = join(outside, 'bin'), uid = process.getuid!()
    mkdirSync(bin)
    writeExecutable(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p%s\\nu%s\\nfcwd\\nn%s\\n' ${mine} ${uid} ${dir}/work ${theirs} ${uid + 1} ${dir}/work\n`)
    await reaped([line, { tmux: join(dir, 'no-server'), root: dir }], { ...process.env, PATH: `${bin}:${process.env.PATH}` })
    await expect.poll(() => alive(mine!), { timeout: 10_000 }).toBe(false)
    expect(alive(theirs!)).toBe(true)
  })
})
