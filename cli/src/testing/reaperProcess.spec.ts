import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { alive } from './spawnedRuns.js'
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
  afterEach(() => {
    for (const child of started.splice(0)) child.kill('SIGKILL')
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })
  /** A `sleep` in [cwd], running: its command line names nothing. */
  const sleeper = async (cwd: string): Promise<ChildProcess> => {
    const child = spawn('sleep', ['600'], { cwd, stdio: 'ignore' })
    started.push(child)
    await once(child, 'spawn')
    return child
  }
  const gone = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
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
    const inside = await sleeper(join(dir, 'work')), beside = await sleeper(`${dir}x`)
    const said = await reaped([{ tmux: join(dir, 'no-server'), root: dir }])
    await expect.poll(() => gone(inside), { timeout: 10_000 }).toBe(true)
    expect(inside.signalCode).toBe('SIGKILL')
    expect(alive(beside.pid!)).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(said).toContain(`[e2e reaper] ended 1 processes that still named ${dir} or ran in it`)
  })

  it('sweeps and removes nothing in a folder named like a root that is not directly in the temporary folder, or is a link', async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-guard-')))
    const nested = join(outer, 'htmux-abc'), elsewhere = join(outer, 'elsewhere'), link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    folders.push(outer, link)
    for (const folder of [nested, elsewhere]) { mkdirSync(folder); writeFileSync(join(folder, 'kept'), '') }
    symlinkSync(elsewhere, link)
    const kept = [await sleeper(nested), await sleeper(elsewhere)]
    const said = await reaped([{ tmux: join(outer, 'no-server-1'), root: nested }, { tmux: join(outer, 'no-server-2'), root: link }])
    for (const refused of [nested, link]) expect(said).toContain(`[e2e reaper] not a test root, left alone: ${refused}`)
    expect(kept.map((child) => alive(child.pid!))).toEqual([true, true])
    expect([nested, elsewhere].map((folder) => existsSync(join(folder, 'kept')))).toEqual([true, true])
  })

  // Linux reads /proc, which nothing here can stand in for: there the owner of /proc/<pid> is the same check.
  it.runIf(process.platform === 'darwin')('takes a working folder only from a process of its own account', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'reaper-uid-')))
    folders.push(dir, outside)
    const mine = await sleeper(outside), theirs = await sleeper(outside)
    // An lsof that puts both in the root, the second as another account's. The real one lists another account's only for root.
    const bin = join(outside, 'bin'), uid = process.getuid!()
    mkdirSync(bin)
    writeExecutable(join(bin, 'lsof'), `#!/bin/sh\nprintf 'p%s\\nu%s\\nfcwd\\nn%s\\n' ${mine.pid} ${uid} ${dir}/work ${theirs.pid} ${uid + 1} ${dir}/work\n`)
    await reaped([{ tmux: join(dir, 'no-server'), root: dir }], { ...process.env, PATH: `${bin}:${process.env.PATH}` })
    await expect.poll(() => gone(mine), { timeout: 10_000 }).toBe(true)
    expect(alive(theirs.pid!)).toBe(true)
  })
})
