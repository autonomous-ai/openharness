import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprint } from './bundleFingerprint.js'
import { WORKER_COHORT_ENV, WORKER_CONTRACT, WORKER_PLAN } from './workerContract.js'

const admission = vi.hoisted(() => ({ check: vi.fn<(...args: unknown[]) => string | null>(() => null) }))
vi.mock('./childAdmission.js', () => ({ childAdmissionFailure: admission.check }))
vi.mock('./bundleFingerprint.js', () => ({ fingerprint: vi.fn(() => 'a'.repeat(64)) }))
const argv = process.argv
const exit = new Error('test exit')
afterEach(() => { process.argv = argv; vi.unstubAllEnvs(); vi.restoreAllMocks(); admission.check.mockReset().mockReturnValue(null); vi.mocked(fingerprint).mockReset().mockReturnValue('a'.repeat(64)) })
const enter = async (command: string, file = '/cli.js') => {
  process.argv = [process.execPath, file, command]
  vi.resetModules()
  await import('./childEntry.js')
}

describe('the common first import', () => {
  it('does not inspect ordinary CLI or master commands', async () => {
    await enter('__harnessd')
    expect(admission.check).not.toHaveBeenCalled()
  })
  it('admits core and service before their entry can load runtime modules', async () => {
    for (const command of ['__run', '__service', '__storage']) {
      await enter(command)
      expect(admission.check).toHaveBeenLastCalledWith(process.env, process.ppid, '/cli.js')
    }
    vi.stubEnv('HARNESSD_CORE_SCRIPT', '/original-cli.js')
    await enter('__run')
    // Canonical helper metadata is deliberately not executed-artifact proof.
    expect(admission.check).toHaveBeenLastCalledWith(process.env, process.ppid, '/cli.js')
  })
  it('exits with a fixed actionable reason before an unadmitted child entry continues', async () => {
    admission.check.mockReturnValue('selected bundle changed')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(process, 'exit').mockImplementation(() => { throw exit })
    await expect(enter('__service')).rejects.toBe(exit)
    expect(error).toHaveBeenCalledWith('[harnessd] child bundle admission failed: selected bundle changed')
  })

  it.each(['start', '__run'])('remembers the exact standalone %s entry before dispatch can rewrite argv', async command => {
    await enter(command, '/explicit/initial.mjs')
    const { executedEntry } = await import('./executedEntry.js')
    expect(executedEntry()).toEqual({ file: '/explicit/initial.mjs', sha256: 'a'.repeat(64), admitted: false })
    expect(fingerprint).toHaveBeenCalledWith('/explicit/initial.mjs')
  })

  it.each(['HARNESSD_SUPERVISED', 'HARNESSD_SERVICE_TOKEN'])('retains the admitted original hash from %s without selecting the canonical helper', async field => {
    vi.stubEnv(field, '1')
    vi.stubEnv(WORKER_COHORT_ENV, `${process.ppid}:${WORKER_CONTRACT}:${WORKER_PLAN}:${'b'.repeat(64)}`)
    vi.stubEnv('HARNESSD_CORE_SCRIPT', '/mutable/helper.js')
    vi.mocked(fingerprint).mockClear()
    await enter('__run', '/immutable/core.mjs')
    const { executedEntry } = await import('./executedEntry.js')
    expect(executedEntry()).toEqual({ file: '/immutable/core.mjs', sha256: 'b'.repeat(64), admitted: true })
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it('does not invent an execution identity for a missing file, hash or admitted proof', async () => {
    await enter('__run', '')
    expect((await import('./executedEntry.js')).executedEntry()).toBeUndefined()
    vi.mocked(fingerprint).mockReturnValue(null)
    await enter('start')
    expect((await import('./executedEntry.js')).executedEntry()).toBeUndefined()
    vi.stubEnv('HARNESSD_SUPERVISED', '1')
    vi.stubEnv(WORKER_COHORT_ENV, '')
    await enter('__run')
    expect((await import('./executedEntry.js')).executedEntry()).toBeUndefined()
  })
})
