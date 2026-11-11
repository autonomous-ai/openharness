import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'

const fixture = vi.hoisted(() => ({ identity: '', calls: 0, stall: false, pipes: false, pipeCount: 0, root: '', children: [] as import('node:child_process').ChildProcess[],
  help: 'stdout' as 'stdout' | 'stderr' | 'broken' }))
vi.mock('./kit/launchExecutable.js', () => ({
  captureLaunchExecutable: async () => ({ state: 'ready',
    // Each test's engine is an install of its own: its help is kept by the file's identity (nativeLaunch.ts).
    executable: { command: '/fixture/permission-engine', identity: fixture.identity, current: () => true },
    environment: { HOME: '/fixture/home', PATH: '/fixture/bin' },
  }),
  LAUNCH_LOCATION_VARIABLES: ['HOME', 'PATH'],
}))
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
    if (fixture.stall) setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_400) })
    return child
  } }
})
let installs = 0
beforeEach(() => {
  fixture.identity = `install-${++installs}`; fixture.calls = 0; fixture.stall = false; fixture.pipes = false; fixture.pipeCount = 0; fixture.children = []; fixture.help = 'stdout'
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

it('holds inherited output pipes within a bound and recovers probe capacity after closing only its own streams', async () => {
  fixture.pipes = true
  // Eight installs asked at once: one probe each, whose descendants hold its pipes.
  const pending = Array.from({ length: 8 }, (_, index) => { fixture.identity = `held-${index}`; return inspectNativeLaunch('claude') })
  await vi.waitFor(() => expect(fixture.calls).toBe(8))
  fixture.identity = 'held-8'
  const held = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting to confirm the selected executable’s permission flags (/fixture/permission-engine).' }
  expect(await inspectNativeLaunch('claude')).toEqual(held)
  let timer: ReturnType<typeof setTimeout> | undefined
  const answers = await Promise.race([Promise.all(pending), new Promise<'unsettled'>(done => { timer = setTimeout(() => done('unsettled'), 7000) })])
  clearTimeout(timer)
  expect(answers).toEqual(Array(8).fill(held))
  // Each native wrapper exited 0; the inherited pipes alone held its close.
  for (const child of fixture.children) { expect(child.exitCode).toBe(0); expect(child.killed).toBe(false) }
  await new Promise<void>(done => setImmediate(done))
  fixture.pipes = false
  // No answer is kept: the same install is asked again, and answers.
  fixture.identity = 'held-0'
  expect(await inspectNativeLaunch('claude')).toMatchObject({ ok: true })
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

// #3466 sends no permission mode by default: a launch with no flag of its own still asks the engine for its help, as auto
// mode's flag would, since that is what tells an engine that cannot run (or is still being downloaded) from one that can.
it('refuses, with its own reason, an engine that cannot run when the launch names no mode', async () => {
  fixture.help = 'broken'
  expect(await inspectNativeLaunch('codex', {})).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
    detail: 'Codex is installed but cannot run: /usr/bin/env: ‘node’: No such file or directory', refusal: 'ENGINE_CANNOT_RUN' })
}, 15_000)

it('starts an engine that runs when the launch names no mode, with one probe of its help, whatever its help lists', async () => {
  const prepared = await inspectNativeLaunch('codex', {})
  expect(prepared).toMatchObject({ ok: true })
  if (!prepared.ok) throw Error(prepared.detail)
  expect(await prepared.launch.permission({})).toBe('supported')
  expect(fixture.calls).toBe(1)
}, 15_000)

// What an engine's help says, and that it runs, is a fact about the installed file. Asked at every launch, a restore or a
// held pass of many Swarm agents met the probes' cap of 8 and held the rest; a relaunch or fork asked twice.
it('asks an engine install for its help once, for launches that ask together and every launch after', async () => {
  const launches = await Promise.all(Array.from({ length: 12 }, () => inspectNativeLaunch('claude', {})))
  for (const launch of launches) expect(launch).toMatchObject({ ok: true })
  const relaunch = await inspectNativeLaunch('claude', { permissionMode: 'auto' })
  if (!relaunch.ok) throw Error(relaunch.detail)
  expect(await relaunch.launch.prepareHooks(0, () => true)).toBe(true)
  expect(await relaunch.launch.permission({ permissionMode: 'auto' })).toBe('supported')
  expect(fixture.calls).toBe(1)
}, 15_000)

it('asks again an install that failed, and one that changed', async () => {
  fixture.help = 'broken'
  expect(await inspectNativeLaunch('codex', {})).toMatchObject({ ok: false, refusal: 'ENGINE_CANNOT_RUN' })
  // Repaired around the same file (its Node installed): asked again, and it runs.
  fixture.help = 'stdout'
  expect(await inspectNativeLaunch('codex', {})).toMatchObject({ ok: true })
  expect(await inspectNativeLaunch('codex', {})).toMatchObject({ ok: true })
  expect(fixture.calls).toBe(2)
  // Upgraded, or its download finished: a new file, asked afresh.
  fixture.identity = 'upgraded'
  expect(await inspectNativeLaunch('codex', {})).toMatchObject({ ok: true })
  expect(fixture.calls).toBe(3)
}, 15_000)
