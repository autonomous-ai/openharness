import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectNativeLaunch } from './nativeLaunch.js'

const fixture = vi.hoisted(() => ({ calls: 0, stall: false, pipes: false, pipeCount: 0, root: '', children: [] as import('node:child_process').ChildProcess[] }))
vi.mock('./kit/launchExecutable.js', () => ({
  captureLaunchExecutable: async () => ({ state: 'ready',
    executable: { command: '/fixture/permission-engine', identity: 'fixture', current: () => true },
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
    ` : 'process.stdout.write("Usage: fixture\\n  --permission-mode\\n")'
    const child = actual.execFile(process.execPath, ['-e', script], options, done)
    fixture.children.push(child)
    // Same check-phase stall as e2e/stall.e2e.ts. Node's native timeout loses
    // unread output here even though the child already exited successfully.
    if (fixture.stall) setImmediate(() => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_400) })
    return child
  } }
})
beforeEach(() => {
  fixture.calls = 0; fixture.stall = false; fixture.pipes = false; fixture.pipeCount = 0; fixture.children = []
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
