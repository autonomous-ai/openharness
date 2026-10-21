// The bin\ replacement on real Windows (spec §3): a running .exe cannot be overwritten or deleted there, only renamed,
// which is what installPreparedPty relies on. With Node's fs the path can be missing for the moment between two
// adjacent renames in bin\ (the rename aside and the rename in), and never longer. This checks that bar from the
// calls themselves: which branch ran, that nothing comes between the two renames of a pair, and that the path is
// there after every pair and at the end. A poller measures misses too, and reports them; the Windows timer's
// ~15.6 ms granularity means its count proves little either way. Windows only; it runs on Windows CI. Everything lives in its own
// temporary root: the "harness.exe" here is a copy of this Node, so it runs and can be held open with no real
// install behind it.
//   cd cli && npx vitest run src/lib/windows/ptyInstall.windows.real.spec.ts
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PTY_PAYLOAD_FILES } from './ptyPayload.js'
import { defaultPtyInstallFs, installPreparedPty, sweepAsideFiles, type PtyInstallFs } from './ptyInstall.js'

const BIN_FILES = ['harness.exe', 'harness-launch.exe']

/** Polls each path every millisecond until told to stop. Shared counters: [stop, polls, missing]. */
const POLLER = `
const { workerData, parentPort } = require('node:worker_threads')
const { existsSync } = require('node:fs')
const flags = new Int32Array(workerData.shared)
const pause = new Int32Array(new SharedArrayBuffer(4))
while (Atomics.load(flags, 0) === 0) {
  for (const path of workerData.paths) if (!existsSync(path)) Atomics.add(flags, 2, 1)
  Atomics.add(flags, 1, 1)
  Atomics.wait(pause, 0, 0, 1)
}
parentPort.postMessage('stopped')
`

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe.runIf(process.platform === 'win32')('ptyInstall on real Windows', () => {
  let root: string
  let children: ChildProcess[] = []
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pty-install-real-')) })
  afterEach(async () => {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once('exit', () => resolve())
      child.kill()
    })))
    children = []
    rmSync(root, { recursive: true, force: true })
  })

  /** A program file: this Node, with [tag] appended so each version's bytes differ (Windows ignores the overlay). */
  function program(path: string, tag: string): void {
    writeFileSync(path, Buffer.concat([readFileSync(process.execPath), Buffer.from(tag)]))
  }

  function payload(dir: string, tag: string): void {
    mkdirSync(dir, { recursive: true })
    for (const name of PTY_PAYLOAD_FILES) {
      if (BIN_FILES.includes(name)) program(join(dir, name), tag)
      else writeFileSync(join(dir, name), `${tag} ${name}`)
    }
  }

  async function started(file: string): Promise<ChildProcess> {
    const child = spawn(file, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true })
    children.push(child)
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    return child
  }

  it('bin files are replaced while copies of them run, and the path is missing at most between the two renames of a pair', async () => {
    const ptyRoot = join(root, 'runtime', 'pty')
    const bin = join(root, 'bin')
    payload(join(ptyRoot, '0.10.0'), 'old')
    writeFileSync(join(ptyRoot, 'current-pty'), '0.10.0\r\n')
    mkdirSync(bin)
    for (const name of BIN_FILES) copyFileSync(join(ptyRoot, '0.10.0', name), join(bin, name))
    const staging = join(ptyRoot, `.staging-${process.pid}-${Date.now()}`)
    payload(staging, 'new')

    // 1. Copies of both bin files run, so neither can be overwritten or deleted.
    const running = await Promise.all(BIN_FILES.map((name) => started(join(bin, name))))

    // 2. The real calls, recorded: every call in order, whether a rename over a bin file was refused, and whether
    //    the path was there right after each pair's rename in.
    const calls: string[] = []
    const presentAfterPair: boolean[] = []
    let refusedOver = 0
    let awaitingPutBack: string | null = null
    const isBinFile = (p: string) => BIN_FILES.some((name) => p === join(bin, name))
    const fs: PtyInstallFs = {
      ...defaultPtyInstallFs,
      rename: (from, to) => {
        // A pair ends with its rename in, or, when that fails, with the old file's rename back.
        const pairIn = isBinFile(to) && (calls.at(-1)?.startsWith(`aside ${to}`) ?? false)
        const putBack = to === awaitingPutBack
        calls.push(isBinFile(from) && to.includes('.old-') ? `aside ${from}` : isBinFile(to) ? `in ${to}` : `rename ${to}`)
        try {
          defaultPtyInstallFs.rename(from, to)
        } catch (error) {
          calls[calls.length - 1] += ' !failed'
          if (pairIn) awaitingPutBack = to
          else if (isBinFile(to) && !putBack) refusedOver++
          throw error
        }
        if (pairIn || putBack) {
          presentAfterPair.push(existsSync(to))
          awaitingPutBack = null
        }
      },
      link: (a, b) => { calls.push(`link ${b}`); defaultPtyInstallFs.link(a, b) },
      copyFile: (a, b) => { calls.push(`copy ${b}`); defaultPtyInstallFs.copyFile(a, b) },
      writeFile: (p, d) => { calls.push(`write ${p}`); defaultPtyInstallFs.writeFile(p, d) },
      rm: (p, o) => { calls.push(`rm ${p}`); defaultPtyInstallFs.rm(p, o) },
      sleep: (ms) => { calls.push(`sleep ${ms}`); defaultPtyInstallFs.sleep(ms) },
    }

    // 3. Another thread looks for the paths every millisecond, from before the install to after it.
    const shared = new SharedArrayBuffer(12)
    const flags = new Int32Array(shared)
    const poller = new Worker(POLLER, { eval: true, workerData: { shared, paths: BIN_FILES.map((n) => join(bin, n)) } })
    const stopped = new Promise((resolve) => poller.once('message', resolve))
    while (Atomics.load(flags, 1) < 5) await tick()
    expect(installPreparedPty({ version: '0.11.0', staging, protocol: 2, features: ['seed'] }, root, fs)).toBe(true)
    const after = Atomics.load(flags, 1)
    while (Atomics.load(flags, 1) < after + 5) await tick()
    Atomics.store(flags, 0, 1)
    await stopped
    await poller.terminate()
    const pairs = presentAfterPair.length
    console.log(`[ptyInstall real] branch: ${pairs > 0 ? 'rename-aside pairs' : 'rename over'}; renames over refused: ${refusedOver}; `
      + `pairs: ${pairs}; polls: ${Atomics.load(flags, 1)}; polls that found a path missing: ${Atomics.load(flags, 2)}`)

    // Each successful rename aside is followed at once by its rename in: no other call and no sleep between.
    calls.forEach((call, i) => {
      if (!call.startsWith('aside ') || call.endsWith('!failed')) return
      expect(calls[i + 1], `after "${call}"`).toMatch(new RegExp(`^in ${call.slice('aside '.length).replace(/[\\.]/g, '\\$&')}`))
    })
    // The path is there after every pair, and at the end.
    expect(presentAfterPair.every(Boolean)).toBe(true)
    for (const name of BIN_FILES) expect(existsSync(join(bin, name))).toBe(true)

    // 4. The new bytes are in place, and the running copies were kept aside rather than lost.
    for (const name of BIN_FILES) expect(readFileSync(join(bin, name)).equals(readFileSync(join(ptyRoot, '0.11.0', name)))).toBe(true)
    const aside = () => readdirSync(bin).filter((n) => n.includes('.old-'))
    for (const name of BIN_FILES) {
      const old = readFileSync(join(ptyRoot, '0.10.0', name))
      expect(aside().some((n) => n.startsWith(`${name}.old-`) && readFileSync(join(bin, n)).equals(old))).toBe(true)
    }

    // 5. The aside files go once the copies have exited.
    await Promise.all(running.map((child) => new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill() })))
    // Windows releases an image a moment after the process is reported gone.
    let left = sweepAsideFiles(root)
    for (let attempt = 0; left > 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      left = sweepAsideFiles(root)
    }
    expect(left).toBe(0)
    expect(aside()).toEqual([])
  }, 120_000)
})
