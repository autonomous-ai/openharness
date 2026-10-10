import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget, nativeBytes, nativeProbe, nativeText } from './nativeEvidence.js'

vi.mock('node:child_process', async original => ({ ...await original<object>(), execFile: vi.fn() }))
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-evidence-')); vi.resetAllMocks() })
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it.each(['error', 'stderr', 'utf8'] as const)('rejects %s even beside a readable probe prefix', async mode => {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const done = args.at(-1) as (error: Error | null, stdout: Buffer, stderr: Buffer) => void
    done(mode === 'error' ? new Error('maxBuffer') : null, mode === 'utf8' ? Buffer.from([255]) : Buffer.from('p42\0\n'),
      Buffer.from(mode === 'stderr' ? 'partial results' : ''))
  }) as never)
  await expect(nativeProbe('lsof', [], new NativeEvidenceBudget())).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
it('holds a failed spawn and never launches a probe after the shared deadline', async () => {
  vi.mocked(execFile).mockImplementation(() => { throw new Error('spawn failed') })
  await expect(nativeProbe('ps', [], new NativeEvidenceBudget())).rejects.toThrow('could not start')
  vi.mocked(execFile).mockClear()
  await expect(nativeProbe('ps', [], new NativeEvidenceBudget(-1))).rejects.toThrow('deadline')
  expect(execFile).not.toHaveBeenCalled()
})
it('passes a decreasing shared timeout, hard kill and byte limit to every probe', async () => {
  let now = 100
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args.at(-1) as Function)(null, Buffer.from('complete\n'), Buffer.alloc(0))
  }) as never)
  const budget = new NativeEvidenceBudget(1000)
  await expect(nativeProbe('ps', [], budget, 1234)).resolves.toBe('complete\n')
  now += 100
  await nativeProbe('lsof', [], budget)
  expect(vi.mocked(execFile).mock.calls[0][2]).toMatchObject({ timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 1234, encoding: 'buffer', env: { LC_TIME: 'C' } })
  expect(vi.mocked(execFile).mock.calls[1][2]).toMatchObject({ timeout: 900 })
})
it('bounds cumulative bytes, operations and subprocesses, not just one read', () => {
  expect(() => new NativeEvidenceBudget().step(16 * 1024 * 1024 + 1)).toThrow('work limit')
  const work = new NativeEvidenceBudget()
  expect(() => { for (let index = 0; index <= 32768; index++) work.step() }).toThrow('work limit')
  const probes = new NativeEvidenceBudget()
  expect(() => { for (let index = 0; index <= 64; index++) probes.probe() }).toThrow('probe limit')
})
it('reads bounded EOF and refuses an oversized, missing or nonregular process record', async () => {
  const path = join(root, 'record')
  writeFileSync(path, Buffer.from([65, 0, 66]))
  await expect(nativeBytes(path, 3, new NativeEvidenceBudget())).resolves.toEqual(Buffer.from([65, 0, 66]))
  await expect(nativeBytes(path, 2, new NativeEvidenceBudget())).rejects.toThrow('byte limit')
  await expect(nativeBytes(join(root, 'missing'), 3, new NativeEvidenceBudget())).rejects.toThrow('read completely')
  mkdirSync(join(root, 'directory'))
  await expect(nativeBytes(join(root, 'directory'), 3, new NativeEvidenceBudget())).rejects.toThrow('not a regular file')
  expect(() => nativeText(Buffer.from([255]))).toThrow('UTF-8')
})
