import { describe, expect, it, vi } from 'vitest'
import { daemonStopHandler, daemonStopRoute } from './daemonStopRoute.js'

describe('harness stop, as the core hears it', () => {
  it('answers first, then asks its master to stop everything', async () => {
    const later: Array<() => void> = []
    const askMaster = vi.fn(() => true)
    const stopHere = vi.fn()
    const handle = daemonStopHandler({ askMaster, stopHere, defer: (run) => later.push(run) })
    await expect(handle()).resolves.toEqual({ status: 202, body: { ok: true } })
    expect(askMaster).not.toHaveBeenCalled()
    later.forEach((run) => run())
    expect(askMaster).toHaveBeenCalledOnce()
    expect(stopHere).not.toHaveBeenCalled()
  })

  it('stops itself when no master runs it', async () => {
    const stopHere = vi.fn()
    const handle = daemonStopHandler({ askMaster: () => false, stopHere })
    await handle()
    await new Promise((done) => setImmediate(done))
    expect(stopHere).toHaveBeenCalledOnce()
  })

  it('is served on Windows only: a Mac or Linux core has no such route and stops by signal, as before', () => {
    const deps = { askMaster: () => true, stopHere: vi.fn() }
    expect(daemonStopRoute(deps, 'darwin')).toEqual({})
    expect(daemonStopRoute(deps, 'linux')).toEqual({})
    expect(daemonStopRoute(deps, 'win32').onDaemonStop).toBeTypeOf('function')
    expect(Object.keys(daemonStopRoute(deps))).toEqual(process.platform === 'win32' ? ['onDaemonStop'] : [])
  })
})
