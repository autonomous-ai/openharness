import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'

const fixture = vi.hoisted(() => ({ calls: 0, stall: false, expireAtExit: false, expire: null as (() => void) | null, pipes: false, pipeCount: 0, root: '', children: [] as import('node:child_process').ChildProcess[],
  help: 'stdout' as 'stdout' | 'stderr' | 'broken' }))
vi.mock('./kit/launchExecutable.js', () => ({
  captureLaunchExecutable: async () => ({ state: 'ready',
    executable: { command: '/fixture/permission-engine', identity: 'fixture', current: () => true },
    environment: { HOME: '/fixture/home', PATH: '/fixture/bin' },
  }),
  LAUNCH_LOCATION_VARIABLES: ['HOME', 'PATH'],
}))
// The probe's deadline, expired by a test the moment its child exits, before the loop has read its answer.
vi.mock('../lib/patientExec.js', async original => {
  const actual = await original<typeof import('../lib/patientExec.js')>()
  return { ...actual, patientDeadline: (ms: number, expire: () => void) => {
    if (!fixture.expireAtExit) return actual.patientDeadline(ms, expire)
    fixture.expire = expire
    return () => {}
  } }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, execFile: (file: string, args: string[], options: object, done: (...values: any[]) => void) => {
    expect(file).toBe('/fixture/permission-engine')
    expect(args).toEqual(['--help'])
    const index = fixture.calls++
    if (fixture.pipes) fixture.pipeCount++
    // No engine, shell or owner's files: a private Node child prints its complete help.
    const inheritedPipe = `
      const fs=require('node:fs'), release=${JSON.stringify(join(fixture.root, 'release'))}, ended=${JSON.stringify(join(fixture.root, 'ended-' + index))};
      const exit=()=>{fs.writeFileSync(ended,'done');process.exit(0)};
      setInterval(()=>{if(fs.existsSync(release))exit()},25);setTimeout(exit,15000);
    `
    const script = fixture.pipes ? `
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(inheritedPipe)}],{stdio:['ignore',1,2]});
      process.stdout.write('Usage: fixture\\n  --permission-mode\\n');process.exit(0);
    ` : {
      stdout: 'process.stdout.write("Usage: fixture\\n  --permission-mode\\n")',
      // OpenCode 1.19.0: its whole help on standard error, nothing on standard output, exit 0.
      stderr: 'process.stderr.write("Usage: fixture\\n  --permission-mode\\n")',
      // An npm engine with no Node to run it: env's own complaint, exit 127.
      broken: 'process.stderr.write("/usr/bin/env: \\u2018node\\u2019: No such file or directory\\n");process.exit(127)',
    }[fixture.help]
    const child = actual.execFile(process.execPath, ['-e', script], options, done)
    fixture.children.push(child)
    // Same check-phase stall as e2e/stall.e2e.ts. Node's native timeout loses
    // unread output here even though the child already exited successfully.
    if (fixture.expireAtExit) child.once('exit', () => fixture.expire?.())
    if (fixture.stall) setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_400) })
    return child
  } }
})
beforeEach(() => {
  fixture.calls = 0; fixture.stall = false; fixture.expireAtExit = false; fixture.expire = null; fixture.pipes = false; fixture.pipeCount = 0; fixture.children = []; fixture.help = 'stdout'
  fixture.root = mkdtempSync(join(tmpdir(), 'native-probe-'))
})
afterEach(async () => {
  writeFileSync(join(fixture.root, 'release'), 'release private descendants')
  for (const child of fixture.children) if (child.exitCode === null) child.kill('SIGKILL')
  if (fixture.pipeCount) await vi.waitFor(() => {
    for (let index = 0; index < fixture.pipeCount; index++) expect(existsSync(join(fixture.root, 'ended-' + index))).toBe(true)
  }, { timeout: 3000 })
  rmSync(fixture.root, { recursive: true, force: true })
})

it('keeps a complete permission answer across a core stall without refusing or repeating the probe', async () => {
  fixture.stall = true
  const prepared = await inspectNativeLaunch('claude', { permissionMode: 'auto' })
  expect(prepared.ok).toBe(true)
  if (!prepared.ok) throw Error(prepared.detail)
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('supported')
  expect(fixture.calls).toBe(1)
  expect(fixture.children[0]?.killed).toBe(false)
}, 15_000)

// A hold that ends as the probe's deadline passes: the child exited by itself meanwhile, and its exit and help are an
// answer still, as patientExec.ts reads one (an agent_resume held for good, e2e/stall.e2e.ts).
it('keeps the help of an engine that exited by itself as its deadline passed', async () => {
  fixture.expireAtExit = true
  const prepared = await inspectNativeLaunch('claude', { permissionMode: 'auto' })
  expect(prepared).toMatchObject({ ok: true })
  expect(fixture.calls).toBe(1)
}, 15_000)

it('holds inherited output pipes within a bound and recovers probe capacity after closing only its own streams', async () => {
  const prepared = await inspectNativeLaunch('claude')
  if (!prepared.ok) throw Error(prepared.detail)
  fixture.pipes = true
  const pending = Array.from({ length: 8 }, () => prepared.launch.permission({ permissionMode: 'auto' }))
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('unknown')
  let timer: ReturnType<typeof setTimeout> | undefined
  const answers = await Promise.race([Promise.all(pending), new Promise<'unsettled'>(done => { timer = setTimeout(() => done('unsettled'), 7000) })])
  clearTimeout(timer)
  expect(answers).toEqual(Array(8).fill('unknown'))
  // Each native wrapper exited 0; the inherited pipes alone held its close.
  for (const child of fixture.children) { expect(child.exitCode).toBe(0); expect(child.killed).toBe(false) }
  await new Promise<void>(done => setImmediate(done))
  fixture.pipes = false
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('supported')
  expect(fixture.calls).toBe(9)
}, 15_000)

it('reads help an engine prints to standard error, as OpenCode 1.19.0 does', async () => {
  fixture.help = 'stderr'
  const prepared = await inspectNativeLaunch('claude', { permissionMode: 'auto' })
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw Error(prepared.detail)
  expect(await prepared.launch.permission({ permissionMode: 'auto' })).toBe('supported')
}, 15_000)

it('says in the engine\'s own words why an engine that ran and failed cannot run', async () => {
  fixture.help = 'broken'
  expect(await inspectNativeLaunch('codex', { permissionMode: 'auto' })).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
    detail: 'Codex is installed but cannot run: /usr/bin/env: ‘node’: No such file or directory', refusal: 'ENGINE_CANNOT_RUN' })
}, 15_000)
