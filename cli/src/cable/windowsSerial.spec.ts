import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowsDialWatch, harnessSerialBinary, openWindowsPort, parseSerialState, windowsPortInUse,
  type CommandFor, type WindowsDialWatch,
} from './windowsSerial.js'

const FAKE = fileURLToPath(new URL('./__fixtures__/fakeHarnessSerial.mjs', import.meta.url))
const fake: CommandFor = (args) => ({ file: process.execPath, args: [FAKE, ...args] })
const line = (value: unknown) => JSON.stringify(value)
const until = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const eventually = async <T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 3_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const roots: string[] = []
const children: ReturnType<typeof spawn>[] = []
const trackedSpawn: typeof spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args)
  children.push(child)
  return child
}) as typeof spawn
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
let watches: WindowsDialWatch[] = []
afterEach(async () => {
  for (const watch of watches.splice(0)) watch.stop()
  for (const child of children.splice(0)) {
    if (alive(child.pid)) child.kill('SIGKILL')
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
    await until(() => !alive(child.pid), 1_000)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const watchWith = (lines: string[], extra: Record<string, string> = {}, deps: Partial<Parameters<typeof createWindowsDialWatch>[0]> = {}) => {
  vi.stubEnv('FAKE_SERIAL_LINES', JSON.stringify(lines))
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value)
  const log = vi.fn()
  const watch = createWindowsDialWatch({ command: fake, log, spawn: trackedSpawn, ...deps })
  watches.push(watch)
  return { watch, log }
}

describe('finding harness-serial.exe', () => {
  const runtime = (name: string) => {
    const tmp = mkdtempSync(join(tmpdir(), 'serial-bin-'))
    roots.push(tmp)
    const root = join(tmp, name)
    mkdirSync(join(root, 'pty', '0.4.21'), { recursive: true })
    writeFileSync(join(root, 'pty', 'current-pty'), '0.4.21\n')
    return root
  }

  it('takes HARNESS_SERIAL_BIN as it is, then the installed host version, then the bundle', () => {
    const root = runtime('runtime')
    const installed = join(root, 'pty', '0.4.21', 'harness-serial.exe')
    const beside = join('/bundle', 'pty', 'harness-serial.exe')
    const exists = (file: string) => file === installed || file === beside
    expect(harnessSerialBinary({ env: { HARNESS_SERIAL_BIN: ' C:\\x\\harness-serial.exe ' }, runtimeDir: root, exists })).toBe('C:\\x\\harness-serial.exe')
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists })).toBe(installed)
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists: (file) => file === beside })).toBe(beside)
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, besideDir: '/bundle', exists: () => false })).toBeNull()
  })

  // Review Focus 1: a profile whose name has spaces, an apostrophe, & and % and is not ASCII.
  it('finds it under a profile path a shell would mangle', () => {
    const root = runtime("Nguyễn Văn A' & 100%")
    const installed = join(root, 'pty', '0.4.21', 'harness-serial.exe')
    expect(harnessSerialBinary({ env: {}, runtimeDir: root, exists: (file) => file === installed })).toBe(installed)
  })
})

describe('the watch line', () => {
  it('takes COM ports with the dial ids, and drops what is not a port', () => {
    expect(parseSerialState(line({ console: true, ports: [
      { path: 'COM9', serialNumber: '28:84:85:00:00:01', session: '133' },
      { path: 'COM10' },
      { path: 'NUL' }, { serialNumber: 'x' }, null,
    ] }))).toEqual({ console: true, ports: [
      { path: 'COM9', vendorId: 0x303a, productId: 0x1001, serialNumber: '28:84:85:00:00:01', session: '133' },
      { path: 'COM10', vendorId: 0x303a, productId: 0x1001 },
    ] })
    for (const bad of ['', 'not json', '{"ports":[]}', '{"console":"yes","ports":[]}', '{"console":true}', '[]']) {
      expect(parseSerialState(bad)).toBeNull()
    }
  })
})

describe('the daemon\'s watch', () => {
  it('spawns only on the first getter, fails closed, and discovers a late state after the first read deadline', async () => {
    const { watch } = watchWith([line({ console: false, ports: [{ path: 'COM17' }] })], { FAKE_SERIAL_DELAY: '180' }, { firstLineMs: 30 })
    expect(children).toHaveLength(0)
    expect(watch.console()).toBe(false)
    expect(children).toHaveLength(1)
    expect(await watch.ports()).toEqual([])
    expect(watch.console()).toBe(false)
    expect((await eventually(() => watch.ports(), ports => ports.length > 0))[0]?.path).toBe('COM17')
    expect(watch.console()).toBe(false)
  })

  it('bounds an unresponsive watch first read once and kills a watch that ignores stdin EOF on stop', async () => {
    const { watch } = watchWith([], { FAKE_SERIAL_STUBBORN: '1' }, { firstLineMs: 35 })
    expect(await watch.ports()).toEqual([])
    const start = performance.now()
    expect(await watch.ports()).toEqual([])
    expect(performance.now() - start).toBeLessThan(25)
    const pid = children.at(-1)!.pid
    watch.stop()
    await until(() => !alive(pid), 3_000)
  })

  it('wakes a waiting caller on stop and ignores a delayed state from its old process', async () => {
    const { watch } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] })], { FAKE_SERIAL_DELAY: '100' })
    const ports = watch.ports()
    watch.stop()
    expect(await ports).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(watch.console()).toBe(false)
  })

  it('reports a failed spawn once, stays fail closed, and can recover on a later scan', async () => {
    let clock = 0
    let missing = true
    const command: CommandFor = args => missing ? { file: '/missing/harness-serial.exe', args } : fake(args)
    const { watch, log } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] })], {}, { command, now: () => clock })
    expect(await watch.ports()).toEqual([])
    expect(watch.console()).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    missing = false
    clock = 5_000
    expect((await watch.ports())[0]?.path).toBe('COM3')
    expect(watch.console()).toBe(true)
  })

  it('treats an invalid executable argument as an unavailable watch without throwing from either getter', async () => {
    const { watch, log } = watchWith([], {}, { command: args => ({ file: '\0', args }) })
    expect(watch.console()).toBe(false)
    expect(await watch.ports()).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('waits for the first line, then serves the dials and whether this user is at the screen', async () => {
    // Review Focus 5: two dials at once.
    const { watch } = watchWith([line({ console: false, ports: [{ path: 'COM9', serialNumber: 'AA' }, { path: 'COM10', serialNumber: 'BB' }] })])
    expect(watch.console()).toBe(false) // An unknown console is fail closed; the getter still starts discovery.
    const ports = await watch.ports()
    expect(ports.map((port) => port.path)).toEqual(['COM9', 'COM10'])
    expect(watch.console()).toBe(false)
  })

  // Review Focus 4. The junk line comes first, so the first answer waits for the real one.
  it('reads a line split across two writes, and skips a line that is not a state', async () => {
    const { watch } = watchWith(['harness-serial 0.1.0 starting', line({ console: true, ports: [{ path: 'COM3' }] })], { FAKE_SERIAL_SPLIT: '1' })
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
  })

  it('follows the newest line', async () => {
    const { watch } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] }), line({ console: true, ports: [] })])
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
    expect(await eventually(() => watch.ports(), (ports) => ports.length === 0)).toEqual([])
  })

  it('forgets the dials when the watch ends, says why once, and starts it again no sooner than 5 s', async () => {
    let clock = 0
    const command = vi.fn(fake)
    const { watch, log } = watchWith([line({ console: true, ports: [{ path: 'COM3' }] })], { FAKE_SERIAL_EXIT: '2' }, { command, now: () => clock })
    expect((await watch.ports()).map((port) => port.path)).toEqual(['COM3'])
    await until(() => log.mock.calls.some(([text]) => String(text).includes('error: enumeration failed')))
    expect(await watch.ports()).toEqual([])
    expect(watch.console()).toBe(false)
    expect(command).toHaveBeenCalledTimes(1)
    clock = 4_999
    await watch.ports()
    expect(command).toHaveBeenCalledTimes(1)
    clock = 5_000
    await watch.ports()
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('says once that harness-serial is not installed, and finds no dial', async () => {
    let clock = 0
    const log = vi.fn()
    const watch = createWindowsDialWatch({ command: () => null, log, now: () => clock })
    for (let i = 0; i < 3; i++) { clock += 10_000; expect(await watch.ports()).toEqual([]) }
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toContain('harness-serial is not installed')
  })

  // Review Focus 3: the daemon killed outright. Its watch must end with it, or it would outlive every daemon.
  it.each(['watch', 'open'])('ends its %s with a parent that is killed, because the pipe closes', async (mode) => {
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, [${JSON.stringify(FAKE)}, ${JSON.stringify(mode)}, 'COM3'], { stdio: ['pipe', 'ignore', 'ignore'] })
      console.log(child.pid)
      setInterval(() => {}, 1000)
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (chunk) => resolve(String(chunk)))))
    parent.kill('SIGKILL')
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    await until(() => !alive(), 5_000)
  })

  it('lets a parent using the real bridge exit naturally and takes the watch with it', async () => {
    const source = new URL('./windowsSerial.ts', import.meta.url).href
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { spawn } from 'node:child_process'
      const { createWindowsDialWatch } = await import(${JSON.stringify(source)})
      const watch = createWindowsDialWatch({
        command: args => ({ file: process.execPath, args: [${JSON.stringify(FAKE)}, ...args] }),
        spawn: (...args) => { const child = spawn(...args); console.log(child.pid); return child },
      })
      watch.console()
    `], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.push(parent)
    const pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', chunk => resolve(String(chunk)))))
    await until(() => !alive(parent.pid), 3_000)
    await until(() => !alive(pid), 3_000)
  })
})

describe('the link to one dial', () => {
  it('starts from an executable and fixture path containing shell metacharacters and non-ASCII letters', async () => {
    const root = mkdtempSync(join(tmpdir(), "Nguyễn Văn A' & 100%-"))
    roots.push(root)
    const executable = join(root, 'harness-serial.exe')
    // Windows symlinks can require privileges; a copied executable exercises the same shell-free path there.
    if (process.platform === 'win32') copyFileSync(process.execPath, executable)
    else symlinkSync(process.execPath, executable)
    const fixture = join(root, 'fake serial.mjs')
    copyFileSync(FAKE, fixture)
    const stream = await openWindowsPort({ file: executable, args: [fixture, 'open', 'COM17'] }, { spawn: trackedSpawn })
    const response = new Promise<Buffer>(resolve => stream.once('data', resolve))
    stream.write(Buffer.from('exact bytes'))
    expect(await response).toEqual(Buffer.from('exact bytes'))
    const closed = new Promise(resolve => stream.once('close', resolve))
    const pid = children.at(-1)!.pid
    stream.destroy()
    await closed
    expect(alive(pid)).toBe(false)
  })

  it('requires a complete open line and kills an unresponsive child within the close deadline', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'partial')
    await expect(openWindowsPort(fake(['open', 'COM3'])!, { spawn: trackedSpawn, openWaitMs: 120, closeWaitMs: 50 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await until(() => !alive(children.at(-1)!.pid))
    vi.stubEnv('FAKE_SERIAL_OPEN', 'stubborn')
    await expect(openWindowsPort(fake(['open', 'COM3'])!, { spawn: trackedSpawn, openWaitMs: 120, closeWaitMs: 50 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    await until(() => !alive(children.at(-1)!.pid))
  })

  it('rejects startup failures with EIO and no orphan child', async () => {
    await expect(openWindowsPort({ file: '/missing/harness-serial.exe', args: [] }, { spawn: trackedSpawn })).rejects.toMatchObject({ code: 'EIO' })
    vi.stubEnv('FAKE_SERIAL_OPEN', 'unknown-failure')
    await expect(openWindowsPort({ file: process.execPath, args: [FAKE, 'invalid'] }, { spawn: trackedSpawn })).rejects.toMatchObject({ code: 'EIO' })
  })

  it('kills an opened child that ignores stdin EOF before reporting close', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'stubborn-open')
    const stream = await openWindowsPort(fake(['open', 'COM3'])!, { spawn: trackedSpawn, closeWaitMs: 60 })
    const child = children.at(-1)!
    const closed = new Promise(resolve => stream.once('close', resolve))
    stream.destroy()
    await closed
    expect(alive(child.pid)).toBe(false)
    expect(child.signalCode).toBe('SIGKILL')
    expect(child.exitCode).not.toBe(0)
  })

  it('closes a backpressured child and all owned pipes without consuming the readable stream', async () => {
    const stream = await openWindowsPort({ file: process.execPath, args: ['-e', `
      process.stderr.write('open\\n')
      process.stdout.write(Buffer.alloc(256 * 1024, 7))
      process.stdin.resume()
      process.stdin.on('end', () => process.exit(0))
    `] }, { spawn: trackedSpawn, closeWaitMs: 60 })
    const child = children.at(-1)!
    // Wait for real readable backpressure, rather than assuming the child has produced its bytes.
    await until(() => stream.readableLength >= stream.readableHighWaterMark)
    expect(child.stdout?.isPaused()).toBe(true)
    let closed = false
    stream.once('close', () => { closed = true })
    stream.destroy()
    await until(() => closed, 400)
    expect(alive(child.pid)).toBe(false)
    expect(child.stdin?.destroyed).toBe(true)
    expect(child.stdout?.destroyed).toBe(true)
    expect(child.stderr?.destroyed).toBe(true)
  })

  it('closes stdin on writable EOF and waits for the child to release the port', async () => {
    const stream = await openWindowsPort(fake(['open', 'COM3'])!, { spawn: trackedSpawn })
    const pid = children.at(-1)!.pid
    const error = vi.fn()
    stream.on('error', error)
    const closed = new Promise(resolve => stream.once('close', resolve))
    stream.end(Buffer.from('last bytes'))
    stream.resume()
    await closed
    expect(error).not.toHaveBeenCalled()
    expect(alive(pid)).toBe(false)
  })

  it('carries bytes both ways, a frame larger than one pipe write included, and ends its child on close', async () => {
    const stream = await openWindowsPort(fake(['open', 'COM3'])!)
    const received: Buffer[] = []
    stream.on('data', (chunk: Buffer) => received.push(chunk))
    const big = Buffer.alloc(100_000, 7)
    await new Promise<void>((resolve, reject) => stream.write(Buffer.from([0, 255, 13, 10]), (error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => stream.write(big, (error) => error ? reject(error) : resolve()))
    await until(() => Buffer.concat(received).length === 4 + big.length)
    expect(Buffer.concat(received)).toEqual(Buffer.concat([Buffer.from([0, 255, 13, 10]), big]))
    const closed = new Promise((resolve) => stream.once('close', resolve))
    stream.destroy()
    await closed
  })

  it('refuses a port another program has, one that is gone, and one that never says open', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'busy')
    await expect(openWindowsPort(fake(['open', 'COM3'])!)).rejects.toMatchObject({ code: 'EBUSY' })
    vi.stubEnv('FAKE_SERIAL_OPEN', 'gone')
    await expect(openWindowsPort(fake(['open', 'COM3'])!)).rejects.toMatchObject({ code: 'ENOENT' })
    vi.stubEnv('FAKE_SERIAL_OPEN', 'silent')
    await expect(openWindowsPort(fake(['open', 'COM3'])!, { openWaitMs: 300 })).rejects.toMatchObject({ code: 'ETIMEDOUT' })
  })

  it('fails with the reason harness-serial gave when the dial is unplugged', async () => {
    vi.stubEnv('FAKE_SERIAL_OPEN', 'unplug:100')
    const stream = await openWindowsPort(fake(['open', 'COM3'])!)
    const events: string[] = []
    stream.on('end', () => events.push('end'))
    stream.on('error', () => events.push('error'))
    stream.resume()
    // Both listeners first: 'close' follows 'error' at once.
    const closed = new Promise((resolve) => stream.once('close', resolve))
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => stream.once('error', resolve))
    expect(error.code).toBe('closed: The device is not connected.')
    await closed
    expect(events[0]).toBe('error')
  })
})

describe('is another program holding the port', () => {
  it('treats an invalid executable argument as cannot tell', async () => {
    expect(await windowsPortInUse('COM3', args => ({ file: '\0', args }))).toBe(false)
  })
  it('is busy only when harness-serial says busy; cannot tell reads as free', async () => {
    for (const [probe, held] of [['busy', true], ['free', false], ['gone', false]] as const) {
      vi.stubEnv('FAKE_SERIAL_PROBE', probe)
      expect(await windowsPortInUse('COM3', fake)).toBe(held)
    }
    expect(await windowsPortInUse('COM3', () => null)).toBe(false)
  })
})
