import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const subprocess = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: subprocess.exec }))
let answer: (error: Error | null, stdout: string) => void
const roots: string[] = []
let child: { kill: ReturnType<typeof vi.fn>; stdin: { end: ReturnType<typeof vi.fn> }; stdout: { destroy: ReturnType<typeof vi.fn> }; stderr: { destroy: ReturnType<typeof vi.fn> } }
beforeEach(() => {
 vi.useFakeTimers(); vi.resetModules(); subprocess.exec.mockReset()
 child = { kill: vi.fn(), stdin: { end: vi.fn() }, stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } }
 subprocess.exec.mockImplementation((_binary, _args, _options, callback) => { answer = callback; return child })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'engine-path-shell-')); roots.push(root)
 const bin = join(root, 'only-in-shell'); mkdirSync(bin)
 const executable = join(bin, 'opencode'); writeFileSync(executable, 'engine', { mode: 0o700 })
 vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root); vi.stubEnv('PATH', join(root, 'missing'))
 vi.stubEnv('SHELL', '/test/bash'); vi.stubEnv('NODE_ENV', 'production')
 return { root, bin, executable }
}
it.skipIf(process.platform === 'win32')('shares the first shell between discovery and launch and waits for its complete PATH', async () => {
 const { bin, executable } = fixture()
 const mod = await import('./engineBin.js')
 const snapshot = mod.agentCommandOwnershipSnapshotAsync(), launch = mod.opencodeBinAsync()
 expect(subprocess.exec).toHaveBeenCalledTimes(1)
 expect(subprocess.exec.mock.calls[0][1][0]).toBe('-ic')
 answer(null, `banner\n__HARNESS_ENGINE_PATH__=${bin}\n`)
 expect(await launch).toBe(executable)
 expect((await snapshot).engineCandidates?.get('opencode')?.[0]?.path).toBe(executable)
 expect((await mod.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('opencode')).toHaveLength(1)
 expect(subprocess.exec).toHaveBeenCalledTimes(1)
})
it.skipIf(process.platform === 'win32')('kills a hung PATH shell at its deadline and retains daemon-PATH discovery', async () => {
 const { bin, executable } = fixture(); vi.stubEnv('PATH', bin)
 const mod = await import('./engineBin.js'), pending = mod.agentCommandOwnershipSnapshotAsync()
 await vi.advanceTimersByTimeAsync(5_000)
 expect(child.kill).toHaveBeenCalledWith('SIGKILL')
 expect((await pending).engineCandidates?.get('opencode')?.[0]?.path).toBe(executable)
 await mod.agentCommandOwnershipSnapshotAsync()
 expect(subprocess.exec).toHaveBeenCalledTimes(1)
})
it.skipIf(process.platform === 'win32')('does not publish an old shell answer after PATH changes', async () => {
 const { bin, root } = fixture(), mod = await import('./engineBin.js')
 const pending = mod.agentCommandOwnershipSnapshotAsync()
 const changed = expect(pending).rejects.toThrow('ENGINE_LOOKUP_CHANGED')
 vi.stubEnv('PATH', root)
 answer(null, `__HARNESS_ENGINE_PATH__=${bin}\n`)
 await changed
 const next = mod.agentCommandOwnershipSnapshotAsync()
 expect(subprocess.exec).toHaveBeenCalledTimes(2)
 answer(null, '__HARNESS_ENGINE_PATH__=\n')
 expect((await next).engineCandidates?.get('opencode')).toEqual([])
})
it.skipIf(process.platform === 'win32')('never joins a synchronous reader\'s old PATH capture as evidence for a new PATH', async () => {
 const { bin, root } = fixture(), mod = await import('./engineBin.js')
 mod.agentCommandOwnershipSnapshot()
 expect(subprocess.exec).toHaveBeenCalledTimes(1)
 vi.stubEnv('PATH', root)
 const pending = mod.agentCommandOwnershipSnapshotAsync()
 const changed = expect(pending).rejects.toThrow('ENGINE_PATH_CHANGED')
 answer(null, `__HARNESS_ENGINE_PATH__=${bin}\n`)
 try { await changed } finally { answer(null, '__HARNESS_ENGINE_PATH__=\n') }
})
