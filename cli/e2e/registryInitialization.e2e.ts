/** Actual callers do not report ready or release process ownership before initialization settles. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFailed } from 'vitest'
import { alive, processTable } from '../src/testing/spawnedRuns.js'
import { IsolatedDaemon } from './harness/daemon.js'

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })])
  } finally { clearTimeout(timer) }
}

it.skipIf(process.platform === 'win32')('holds the real core ownership socket until a pending reload and exiting flush settle', async context => {
  const daemon = await IsolatedDaemon.create({ noMaster: true, env: {
    HARNESS_NO_MASTER: '1', DISABLE_HOOK_INSTALL: 'true', TERMINAL_BACKENDS: '',
  }, launch: ['--import', 'tsx', fileURLToPath(new URL('./harness/registryInitializationDaemon.ts', import.meta.url))] })
  onTestFailed(() => console.log(daemon.log()))
  let child: NonNullable<IsolatedDaemon['child']> | undefined, closed: Promise<number | null> | undefined
  let outEOF = false, errEOF = false, exited = false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await daemon.start({ ready: 'none' })
    child = daemon.child!
    child.stdout!.once('end', () => { outEOF = true })
    child.stderr!.once('end', () => { errEOF = true })
    child.once('exit', () => { exited = true })
    closed = new Promise((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject) })
    const waiting = new Promise<void>((resolve, reject) => {
      let output = ''
      const take = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096)
        if (output.includes('[registry-initialization-fixture] shutdown waits for reload')) {
          child!.stdout!.off('data', take); resolve()
        }
      }
      child!.stdout!.on('data', take)
      void closed!.then(() => reject(new Error('core exited before its pending-reload wait')), reject)
    })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pending initialization shutdown exceeded 60 seconds')), 60_000)
    })
    await Promise.race([waiting, deadline])
    expect(daemon.log()).toContain('[cli] ready')
    expect(exited).toBe(false)
    expect(existsSync(join(daemon.dataDir, 'registry.json.lock'))).toBe(true)
    await new Promise<void>((resolve, reject) => {
      const socket = connect(daemon.socketPath)
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error('retained ownership socket did not accept')) })
      socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject)
    })
    expect(child.kill('SIGUSR2')).toBe(true)
    expect(await Promise.race([closed, deadline])).toBe(0)
    expect({ exited, outEOF, errEOF }).toEqual({ exited: true, outEOF: true, errEOF: true })
    expect(daemon.log()).not.toContain('leaving without it')
    expect(daemon.log()).not.toContain('[fatal-guard]')
    const receiptPath = join(daemon.dataDir, 'initialization-daemon-receipt.json')
    expect(statSync(receiptPath).size).toBeLessThan(8192)
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    ;(context.task.meta as Record<string, unknown>).registryInitialization = receipt
    expect(receipt).toMatchObject({ code: 0, heldSyncs: 1, pending: false, released: true, loaded: true, flushed: true,
      flushCalls: 1, localCloseCalls: 1, entered: 0, closedBeforeRelease: false, lockGone: true, socketGone: true })
    expect(alive(child.pid!)).toBe(false)
    expect(processTable().filter(row => row.pgid === child!.pid)).toEqual([])
  } finally {
    clearTimeout(timer)
    await within(daemon.close(), 30_000, 'isolated daemon cleanup did not settle')
    if (closed) await within(closed, 5_000, 'owned core close and EOF did not settle')
    expect(existsSync(daemon.root)).toBe(false)
    if (child) {
      expect(alive(child.pid!)).toBe(false)
      expect(processTable().filter(row => row.pgid === child!.pid)).toEqual([])
      expect({ exited, outEOF, errEOF }).toEqual({ exited: true, outEOF: true, errEOF: true })
      ;(context.task.meta as Record<string, unknown>).cleanup = { rootRemoved: true, leaderGone: true, groupEmpty: true, exited, outEOF, errEOF }
    }
  }
})
