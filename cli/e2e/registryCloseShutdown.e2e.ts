/** An unconfirmed raw-directory close cannot release the real daemon's ownership before it exits. */
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFailed } from 'vitest'
import { alive, processTable } from '../src/testing/spawnedRuns.js'
import { IsolatedDaemon } from './harness/daemon.js'

it.skipIf(process.platform === 'win32')('holds a failed-close writer and its local socket until the real core stop deadline exits', async context => {
  const daemon = await IsolatedDaemon.create({ noMaster: true, env: {
    HARNESS_NO_MASTER: '1', DISABLE_HOOK_INSTALL: 'true', TERMINAL_BACKENDS: '',
  }, launch: ['--import', 'tsx', fileURLToPath(new URL('./harness/registryCloseDaemon.ts', import.meta.url))] })
  onTestFailed(() => console.log(daemon.log()))
  let child: NonNullable<IsolatedDaemon['child']> | undefined
  let closed: Promise<number | null> | undefined
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
        if (output.includes('[registry-close-fixture] shutdown is waiting for the registry')) {
          child!.stdout!.off('data', take)
          resolve()
        }
      }
      child!.stdout!.on('data', take)
      void closed!.then(() => reject(new Error('core exited before reaching the Registry shutdown wait')), reject)
    })
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('real core did not complete its failed-close stop within 60 seconds')), 60_000)
    })
    await Promise.race([waiting, deadline])
    expect(daemon.log()).toContain('[cli] ready')
    expect(exited).toBe(false)
    expect(existsSync(join(daemon.dataDir, 'registry.json.lock'))).toBe(true)
    // This is the POSIX data-folder ownership endpoint, not merely a socket pathname left on disk.
    await new Promise<void>((resolve, reject) => {
      const socket = connect(daemon.socketPath)
      socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error('retained local socket did not accept')) })
      socket.once('connect', () => { socket.destroy(); resolve() })
      socket.once('error', reject)
    })
    expect(await Promise.race([closed, deadline])).toBe(0)
    expect({ exited, outEOF, errEOF }).toEqual({ exited: true, outEOF: true, errEOF: true })
    expect(daemon.log()).toContain('the stop is still on the registry after 2500 ms — leaving without it')
    const receipt = JSON.parse(readFileSync(join(daemon.dataDir, 'close-daemon-receipt.json'), 'utf8'))
    ;(context.task.meta as Record<string, unknown>).registryClose = receipt
    expect(receipt).toMatchObject({
      code: 0, attempts: 1, afterFailureWrites: 0, localSocketCloseCalls: 0, flushCalls: 1, cleanFlush: false,
      signalled: true, lockRetained: true, originalLockOwnerRetained: true, uncertainDescriptorOpen: true,
      outcome: { name: 'AtomicWriteUnconfirmed', retryable: false }, refused: { name: 'RegistryPersistenceUnavailable' },
    })
    expect(receipt.stopElapsedMs).toBeGreaterThanOrEqual(2_500)
    expect(alive(child.pid!)).toBe(false)
    expect(processTable().filter(row => row.pgid === child!.pid)).toEqual([])
  } finally {
    clearTimeout(timer)
    await daemon.close()
    if (closed) await closed
    expect(existsSync(daemon.root)).toBe(false)
    if (child) {
      expect(alive(child.pid!)).toBe(false)
      expect(processTable().filter(row => row.pgid === child!.pid)).toEqual([])
      expect({ exited, outEOF, errEOF }).toEqual({ exited: true, outEOF: true, errEOF: true })
      ;(context.task.meta as Record<string, unknown>).cleanup = { rootRemoved: true, leaderGone: true, groupEmpty: true, exited, outEOF, errEOF }
    }
  }
})
