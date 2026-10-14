/** Capacity evidence includes the retained local-filesystem fence, without host services. */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createNativeHookStagePool } from './nativeHookStaging.js'
import { nativeHookScope, type NativeHookScope } from './nativeHookScope.js'
import { NativeEvidenceBudget } from './nativeEvidence.js'
import { prepareProcessImageHelper } from '../../lib/nativeProcessImageArtifact.js'

// This measures bounded recovery/final-fence CPU and filesystem reads. Actual
// flush lifetime and crash behavior are covered separately with OS processes.
const opened = vi.hoisted(() => new Set<string>())
const fixture = vi.hoisted(() => ({ linux: false }))
const heldReasons = vi.hoisted(() => [] as string[])
vi.mock('./nativeHookFiles.js', async original => {
  const real = await original<typeof import('./nativeHookFiles.js')>()
  return { ...real, HookPreparationHeld: class extends real.HookPreparationHeld {
    constructor(message: string) { super(message); heldReasons.push(message) }
  } }
})
vi.mock('./nativeHookBoot.js', async original => {
  const real = await original<typeof import('./nativeHookBoot.js')>()
  return { kernelBootId: (budget: NativeEvidenceBudget) => fixture.linux
    ? Promise.resolve('linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa') : real.kernelBootId(budget) }
})
vi.mock('./nativeEvidence.js', async original => {
  const real = await original<typeof import('./nativeEvidence.js')>()
  return { ...real, nativeBytes: (path: string, limit: number, budget: NativeEvidenceBudget) => fixture.linux && path === '/proc/self/status'
    ? Promise.resolve(Buffer.from(`NStgid:\t${process.pid}\nNSpid:\t${process.pid}\n`)) : real.nativeBytes(path, limit, budget) }
})
vi.mock('node:fs', async original => { const fs = await original<typeof import('node:fs')>(); return { ...fs,
  statfsSync: (path: string, options: Parameters<typeof fs.statfsSync>[1]) => fixture.linux && path.startsWith('/proc/self/fd/')
    ? { type: 0xef53n } : fs.statfsSync(path, options),
  readlinkSync: (path: string) => fixture.linux && path === '/proc/self' ? String(process.pid) : fs.readlinkSync(path),
  statSync: (path: string, options: Parameters<typeof fs.statSync>[1]) => fixture.linux && path === '/proc/self/ns/pid'
    ? { dev: 4n, ino: 5n, isFile: () => true } : fs.statSync(path, options),
  openSync: (path: string, flags: number) => fixture.linux && path.startsWith('/proc/self/fdinfo/') ? 987654 : fs.openSync(path, flags),
  closeSync: (fd: number) => { if (fd !== 987654) fs.closeSync(fd) },
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => fd === 987654
    ? Buffer.from('mnt_id:\t17\n').copy(buffer, offset, position, position + length) : fs.readSync(fd, buffer, offset, length, position),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(null)),
  opendirSync: (path: string, options: Parameters<typeof fs.opendirSync>[1]) => { opened.add(path); return fs.opendirSync(path, options) },
} })
let root: string | undefined, scope: NativeHookScope | undefined
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  scope?.close(); scope = undefined; fixture.linux = false
  Object.defineProperty(process, 'platform', platform)
  if (root) rmSync(root, { recursive: true, force: true })
})

it.each(['native', 'linux-fixture'])('recovers the last available generation with the %s retained local-root fence', async mode => {
  heldReasons.length = 0
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-staging-capacity-')))
  fixture.linux = mode === 'linux-fixture'
  if (fixture.linux) Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  let helper: string | null = null
  if (process.platform === 'darwin') {
    const artifactPath = join(root, 'scope-artifact.json')
    execFileSync('python3', ['scripts/build-process-images.py', '--output', artifactPath], { timeout: 60_000 })
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
    helper = await prepareProcessImageHelper(artifact, join(root, 'runtime'))
    expect(helper).toBeTruthy()
  }
  scope = await nativeHookScope(root, new NativeEvidenceBudget(), {
    prepare: async () => helper ? { path: helper, key: 'fixture-built-artifact' } : null, invalidate: () => {},
  })
  const writer = { boot: scope.boot, namespace: scope.namespace, pid: 8100, birth: process.platform === 'darwin' ? '1791547140:123456' : '12345' }
  // One retained proof belongs to the fixture; all pools and actual I/O settle
  // before afterEach closes it. Only durability latency remains mocked.
  // Isolate the worst full-lane history cost; composed catalog tests exercise
  // the production normal/terminal split and its eight-lane cutover proof.
  const makePool = () => createNativeHookStagePool({ root: root!, writer, verifyWriter: scope!.verify,
    closeWriter: () => {}, dead: async () => false, terminalGenerations: 0 })
  const first = await makePool().acquire(); await first.close()
  const directory = join(root, '.native-hook-stage-0'), witnesses = directory + '.witnesses'
  const initial = JSON.parse(readlinkSync(join(witnesses, '00000000.claim')))
  const seed = (history: string, liveLast = false) => {
    for (let generation = 1; generation < 8_191; generation++) {
      const prefix = String(generation).padStart(8, '0')
      const text = JSON.stringify([...initial.slice(0, 4), randomUUID(), initial[5]])
      const released = JSON.stringify([1, createHash('sha256').update(text).digest('hex')])
      for (const parent of [history, history + '.witnesses']) {
        symlinkSync(text, join(parent, prefix + '.claim'))
        if (!liveLast || generation < 8_190) symlinkSync(released, join(parent, prefix + '.release'))
      }
    }
  }
  seed(directory)
  let lastPulse = performance.now(), maxGapMs = 0, pulses = 0
  const pulse = setInterval(() => {
    const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastPulse); lastPulse = now; pulses++
  }, 1)
  const began = performance.now()
  try {
    const lease = await makePool().acquire()
    const recoveryMs = performance.now() - began, fenceStart = performance.now()
    lease.verify()
    const fenceMs = performance.now() - fenceStart, stage = lease.stage(join(root, 'receipt'))
    expect(stage.path, JSON.stringify(heldReasons)).toContain('.native-hook-stage-0/00008191.')
    expect(pulses).toBeGreaterThan(1)
    await stage.finish(); await lease.close()
    process.stdout.write(JSON.stringify({ mode, generations: 8_192, recoveryMs, fenceMs, maxGapMs }) + '\n')
  } finally { clearInterval(pulse) }
  // A full lane and another long, live history cannot starve a later free lane.
  const busy = await makePool().acquire(); await busy.close()
  const busyDirectory = join(root, '.native-hook-stage-1'); seed(busyDirectory, true)
  const before = [directory, busyDirectory].map(path => readdirSync(path).sort())
  opened.clear()
  const beganFreeLane = performance.now(), free = await makePool().acquire()
  const freeLaneAfterFullAndLiveMs = performance.now() - beganFreeLane
  const freeStage = free.stage(join(root, 'next'))
  expect(freeStage.path).toContain('.native-hook-stage-2/')
  expect([...opened]).not.toContain(directory)
  expect([...opened]).not.toContain(busyDirectory)
  expect([directory, busyDirectory].map(path => readdirSync(path).sort())).toEqual(before)
  process.stdout.write(JSON.stringify({ freeLaneAfterFullAndLiveMs }) + '\n')
  await freeStage.finish(); await free.close()
}, 60_000)
