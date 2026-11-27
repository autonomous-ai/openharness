import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, commandLines } from './spawnedRuns.js'
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
  /** What this spec's own children left running (the groups' sleeps, a Codex app server stand-in): ended by their pids,
   *  never any other process (the person's own Codex app servers run on this machine). */
  const detached: number[] = []
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
    for (const pid of detached.splice(0)) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
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
    detached.push(...pids)
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

  // Codex's managed app server detaches itself, names no root and need not work in it: a real one from the tester of
  // #4660 and #4668 outlived its test, launchd's. Codex records it in <CODEX_HOME>/app-server-daemon/daemon.pid.
  it('ends a Codex app server a pid file in a root it was told names, though nothing of the worker still runs', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    folders.push(dir)
    const file = join(dir, 'home', 'codex', 'app-server-daemon', 'daemon.pid')
    // As `codex app-server --managed-daemon` starts: detached by a launcher that writes its pid file and exits.
    const launch = `const { execFileSync, spawn } = require('node:child_process'), { mkdirSync, writeFileSync } = require('node:fs')
const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'app-server', '--managed-daemon'], { argv0: 'codex', detached: true, stdio: 'ignore', cwd: ${JSON.stringify(tmpdir())} })
mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true })
const processStartTime = execFileSync('ps', ['-o', 'lstart=', '-p', String(server.pid)], { encoding: 'utf8' }).trim()
writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: server.pid, processStartTime }))
server.unref()`
    const launcher = spawn(process.execPath, ['-e', launch], { stdio: 'ignore' })
    expect((await once(launcher, 'exit'))[0]).toBe(0)
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid
    detached.push(pid)
    // Until it runs its own command line: a process not yet past its exec still shows its launcher's.
    await expect.poll(() => commandLines([pid]).get(pid) ?? '', { timeout: 10_000 }).toContain('app-server --managed-daemon')
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false)
    expect(existsSync(dir)).toBe(false)
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
