import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ exec: vi.fn(), sync: vi.fn(() => { throw new Error('sync version probe') }) }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: fake.exec, execFileSync: fake.sync }))
import { targetHost } from './launch.js'
import { PTY_PROTOCOL } from './protocol.js'
const roots: string[] = []
const response = () => JSON.stringify({ version: '1.2.3', protocol: PTY_PROTOCOL, features: ['seed'] })
let answer: (error: Error | null, stdout: string) => void
let child: { kill: ReturnType<typeof vi.fn>; stdin: { end: ReturnType<typeof vi.fn> }; stdout: { destroy: ReturnType<typeof vi.fn> }; stderr: { destroy: ReturnType<typeof vi.fn> } }
beforeEach(() => {
 vi.useFakeTimers(); fake.exec.mockReset(); fake.sync.mockClear()
 child = { kill: vi.fn(), stdin: { end: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } }
 fake.exec.mockImplementation((_file, _args, _options, callback) => { answer = callback; return child })
})
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'pty-version-async-')); roots.push(root)
 const file = join(root, 'host'); writeFileSync(file, 'fixture', { mode: 0o700 })
 return { file, options: { env: { HARNESS_PTY_BIN: file }, runtimeDir: root, besideDir: root } }
}
it('shares an asynchronous hidden version probe for overlapping target reads', async () => {
 const { options } = fixture()
 const a = targetHost(options), b = targetHost(options)
 expect(fake.sync).not.toHaveBeenCalled()
 expect(fake.exec).toHaveBeenCalledTimes(1)
 expect(fake.exec.mock.calls[0][2]).toMatchObject({ windowsHide: true })
 answer(null, response())
 expect(await a).toMatchObject({ version: '1.2.3', features: ['seed'] })
 expect(await b).toEqual(await a)
})
it('ends a hung version probe independently of its callback', async () => {
 const { options } = fixture(), pending = targetHost(options)
 let settled = false
 void Promise.resolve(pending).then(() => { settled = true })
 expect(fake.sync).not.toHaveBeenCalled()
 await vi.advanceTimersByTimeAsync(5_000)
 expect(settled).toBe(true)
 expect(await pending).toBeNull()
 expect(child.kill).toHaveBeenCalledWith('SIGKILL')
})
it('does not publish a version for an executable changed during its probe', async () => {
 const { file, options } = fixture(), pending = targetHost(options)
 expect(fake.exec).toHaveBeenCalledTimes(1)
 utimesSync(file, new Date(), new Date(Date.now()+10_000))
 answer(null, response())
 expect(await pending).toBeNull()
 const next = targetHost(options)
 expect(fake.exec).toHaveBeenCalledTimes(2)
 answer(null, response())
 expect(await next).toMatchObject({ version: '1.2.3' })
})
