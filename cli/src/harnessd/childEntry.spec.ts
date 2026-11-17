import { afterEach, describe, expect, it, vi } from 'vitest'

const admission = vi.hoisted(() => ({ check: vi.fn<(...args: unknown[]) => string | null>(() => null) }))
vi.mock('./childAdmission.js', () => ({ childAdmissionFailure: admission.check }))
const argv = process.argv
const exit = new Error('test exit')
afterEach(() => { process.argv = argv; vi.unstubAllEnvs(); vi.restoreAllMocks(); admission.check.mockReset().mockReturnValue(null) })
const enter = async (command: string) => {
  process.argv = [process.execPath, '/cli.js', command]
  vi.resetModules()
  await import('./childEntry.js')
}

describe('the common first import', () => {
  it('does not inspect ordinary CLI or master commands', async () => {
    await enter('__harnessd')
    expect(admission.check).not.toHaveBeenCalled()
  })
  it('admits core and service before their entry can load runtime modules', async () => {
    for (const command of ['__run', '__service']) {
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
})
