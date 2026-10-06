// Two of the periodic-CPU fixes, checked where mocks cannot reach. The deleted-image memo (tmux.ts) runs end
// to end against the real native helper and the real lsof: it rests on the helper reporting a deleted
// executable as `unavailable` (nativeProcessImages.ts) while lsof still names the old path. That part runs
// on macOS only, with the same opt-in as processImages.real.spec.ts (RUN_DARWIN_PROCESS_IMAGES=1 and a built
// artifact). The dial gate (cable/serial.ts) is checked under overlapping finds on every platform.
import { execFile as realExecFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const commands = vi.hoisted(() => [] as string[])
vi.mock('child_process', async original => {
  const actual = await original<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (...args: Parameters<typeof actual.execFile>) => {
      commands.push(String(args[0]))
      return (actual.execFile as (...a: unknown[]) => unknown)(...args)
    },
  }
})

const { env } = await import('../config/env.js')
const { nativeProcessImages } = await import('./nativeProcessImages.js')
const { enrichProcessRows, processRows } = await import('./tmux.js')
const { createDarwinDialFinder } = await import('../cable/serial.js')
const { executableFileIdentity } = await import('./engineBin.js')

const realDescribe = process.platform === 'darwin' && process.env.RUN_DARWIN_PROCESS_IMAGES === '1'
  && process.env.HARNESS_PROCESS_IMAGES_ARTIFACT ? describe : describe.skip
const exec = promisify(realExecFile)
const children: ChildProcess[] = []
const folders: string[] = []
const originalRuntime = env.ADAPTER_RUNTIME_DIR
const lsofCalls = () => commands.filter(command => command.endsWith('lsof')).length

async function fixture(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'harness-periodic-cpu-')))
  folders.push(path)
  return path
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close')
    child.kill('SIGTERM')
    await closed
  }
  vi.unstubAllGlobals()
  env.ADAPTER_RUNTIME_DIR = originalRuntime
  for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true })
})

realDescribe.sequential('deleted executable image memo against the real helper and lsof', () => {
  beforeEach(async () => {
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', await readFile(process.env.HARNESS_PROCESS_IMAGES_ARTIFACT!, 'utf8'))
    env.ADAPTER_RUNTIME_DIR = await fixture()
    // Warm the helper so the first pass below is the native path, not a cold-start fallback.
    expect((await nativeProcessImages([process.pid], 3000)).images.size).toBe(1)
  })

  it('asks lsof once for a deleted image, with identical rows, and stops vouching once the path exists', async () => {
    const root = await fixture()
    const binary = join(root, 'claude-2.1.0')
    await writeFile(join(root, 'sleeper.c'), '#include <unistd.h>\nint main(int argc, char **argv) { (void)argv; sleep(argc > 2 ? 0 : 30); return 0; }\n')
    await exec('/usr/bin/clang', [join(root, 'sleeper.c'), '-o', binary], { timeout: 30_000 })
    // macOS inspects a freshly written Mach-O on its first exec, and unlinking it during that inspection
    // got the child SIGKILLed (seen here): run it to completion once so the sleeper below is a later exec.
    await exec(binary, ['warm', 'up'], { timeout: 30_000 }).catch(() => {})
    const child = spawn(binary, ['30'], { stdio: 'ignore' })
    children.push(child)
    await once(child, 'spawn')
    const pid = child.pid!
    await vi.waitFor(async () => expect((await nativeProcessImages([pid], 3000)).images.has(pid)).toBe(true),
      { timeout: 10_000, interval: 100 })
    await new Promise(resolve => setTimeout(resolve, 500))
    await unlink(binary) // what an auto-update does to a running Claude
    await new Promise(resolve => setTimeout(resolve, 300))
    expect({ exit: child.exitCode, signal: child.signalCode }).toEqual({ exit: null, signal: null })

    // The premise: the helper cannot read a deleted image, and says so instead of omitting the PID.
    const native = await nativeProcessImages([pid], 3000)
    expect(native.images.has(pid)).toBe(false)
    expect(native.unavailable.has(pid)).toBe(true)

    const pass = async () => {
      const rows = await processRows()
      expect(rows).not.toBeNull()
      // The full table, one PID selected: exactly how probeTerminalAgents/lookupPaneEngineProcess call it.
      return (await enrichProcessRows(rows!, new Set([pid]))).find(row => row.pid === pid)!
    }
    commands.length = 0
    const first = await pass()
    expect(first.imagePath).toBe(binary)
    expect(first.imageFileKey).toBeUndefined()
    const afterFirst = lsofCalls()
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    const second = await pass()
    expect(second).toEqual(first)
    expect(lsofCalls()).toBe(afterFirst)

    // Something exists at that path again. The helper then reads the PID's (stale) name as available, so
    // the row is whatever the code without the memo produced: the new file's identity, not a memo answer.
    await writeFile(binary, 'not the running image')
    const third = await pass()
    expect(third.imagePath).toBe(binary)
    expect(third.imageFileKey).toBe(executableFileIdentity(binary)!.fileKey)
  }, 45_000)
})

// findDialPort() and the fleet's scan can overlap. Whatever order their ioreg answers land in, a scan
// taken on a plug edge must never be the one served from cache: the next call confirms it.
describe('dial gate with overlapping finds on a plug edge', () => {
  const dump = `+-o Tim <class IOUSBHostDevice>
  "idVendor" = 12346
  "idProduct" = 4097
  "USB Serial Number" = "AA:01"
  +-o CDC
    +-o serial
      "IOCalloutDevice" = "/dev/cu.usbmodem1101"
`
  const tim = [{ path: '/dev/cu.usbmodem1101', serialNumber: 'AA:01', vendorId: 0x303a, productId: 0x1001 }]

  for (const order of ['half-seen answer lands last', 'half-seen answer lands first']) {
    it(`confirms after both finish (${order})`, async () => {
      let entries = ['cu.debug-console:623:1']
      const answers: ((text: string) => void)[] = []
      const runIoreg = vi.fn(() => new Promise<string>(resolve => answers.push(resolve)))
      const find = createDarwinDialFinder({ listDev: () => entries, runIoreg, now: () => 0 })
      const boot = find(); answers.shift()!(''); expect(await boot).toEqual([])

      entries = [...entries, 'cu.usbmodem1101:900:7'] // the dial is plugged in
      const a = find(), b = find()
      expect(runIoreg).toHaveBeenCalledTimes(3)
      const [answerA, answerB] = answers.splice(0)
      if (order === 'half-seen answer lands last') { answerB(dump); await b; answerA(''); await a }
      else { answerA(''); await a; answerB(dump); await b }

      const confirm = find()
      expect(runIoreg).toHaveBeenCalledTimes(4)
      answers.shift()!(dump)
      expect(await confirm).toEqual(tim)
      expect(await find()).toEqual(tim)
      expect(runIoreg).toHaveBeenCalledTimes(4)
    })
  }

  // The phantom check matches ports to /dev/cu.* by basename. A callout path outside that set can never be
  // confirmed, so it must cost the old every-call ioreg, never a cached answer that outlives the device.
  it('never caches a port whose callout path is not a /dev/cu.* node', async () => {
    const odd = dump.replace('/dev/cu.usbmodem1101', '/dev/tty.usbmodem1101')
    let answer = odd
    const runIoreg = vi.fn(async () => answer)
    const find = createDarwinDialFinder({ listDev: () => ['cu.usbmodem1101:900:7'], runIoreg, now: () => 0 })
    for (let i = 0; i < 3; i++) expect(await find()).toEqual([{ ...tim[0], path: '/dev/tty.usbmodem1101' }])
    expect(runIoreg).toHaveBeenCalledTimes(3)
    answer = ''
    expect(await find()).toEqual([])
  })
})
