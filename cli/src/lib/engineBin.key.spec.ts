import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const os = vi.hoisted(() => ({ homedirFails: false }))
vi.mock('node:os', async original => {
 const real = await original<typeof import('node:os')>()
 return { ...real, homedir: () => {
  if (os.homedirFails) throw Object.assign(new Error('ENOENT: home unavailable'), { code: 'ENOENT' })
  return real.homedir()
 } }
})
import * as engineBin from './engineBin.js'
const roots: string[] = [], startFolder = process.cwd()
afterEach(() => {
 vi.restoreAllMocks(); vi.unstubAllEnvs(); os.homedirFails = false; process.chdir(startFolder)
 for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(folder = '') {
 const root = mkdtempSync(join(tmpdir(), 'ownership-key-')); roots.push(root)
 const bin = join(root, folder); mkdirSync(bin, { recursive: true })
 vi.stubEnv('PATH', folder || root)
 writeFileSync(join(bin, 'codex'), 'codex', { mode: 0o700 })
 return { root }
}
// The firmware flash deleted the worktree a daemon was started in: every pass then threw ENOENT from process.cwd().
it('answers while the working folder is gone: the key does not read it', async () => {
 const { root } = fixture()
 vi.spyOn(process, 'cwd').mockImplementation(() => { throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' }) })
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join(root, 'codex'))
})
it('a failure reading the key\'s inputs rejects, logs its kind once, and never throws', async () => {
 fixture(); os.homedirFails = true
 const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
 let pass!: Promise<unknown>
 expect(() => { pass = engineBin.agentCommandOwnershipSnapshotAsync() }).not.toThrow()
 await expect(pass).rejects.toMatchObject({ code: 'ENOENT' })
 expect(errors.mock.calls).toEqual([['[engine] ENOENT: executable ownership unavailable']])
})
it('the next pass answers once that failure is gone', async () => {
 const { root } = fixture(); os.homedirFails = true
 vi.spyOn(console, 'error').mockImplementation(() => {})
 await expect(Promise.resolve().then(() => engineBin.agentCommandOwnershipSnapshotAsync())).rejects.toMatchObject({ code: 'ENOENT' })
 os.homedirFails = false
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join(root, 'codex'))
})
it('a relative PATH entry resolves against the process\'s working folder', async () => {
 const { root } = fixture('rel')
 process.chdir(root)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join('rel', 'codex'))
})
