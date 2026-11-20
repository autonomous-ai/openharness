import { chmodSync, mkdtempSync, mkdirSync, renameSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const reads = vi.hoisted(() => ({ gate: null as Promise<void> | null, calls: 0, active: 0, most: 0, failure: '', large: '', entries: 0, forbidWindowsSync: false }))
vi.mock('node:fs', async original => {
 const fs = await original<typeof import('node:fs')>()
 return { ...fs, accessSync: (...args: Parameters<typeof fs.accessSync>) => {
  if (reads.forbidWindowsSync && /hermes\.(exe|cmd|bat|com)$/.test(String(args[0]))) throw new Error('synchronous Windows PATH scan')
  return fs.accessSync(...args)
 } }
})
vi.mock('node:fs/promises', async original => {
 const fs = await original<typeof import('node:fs/promises')>()
 return { ...fs, opendir: async (directory: string) => {
  if (String(directory) !== reads.large) return await fs.opendir(directory)
  return (async function* () { for (let index = 0; index < 20_000; index++) { reads.entries++; yield { name: `unrelated-${index}` } } })()
 }, access: async (...args: Parameters<typeof fs.access>) => {
  reads.calls++; reads.active++; reads.most = Math.max(reads.most, reads.active)
  try {
   if (reads.gate) { await reads.gate; throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
   if (reads.failure) throw Object.assign(new Error('read failed'), { code: reads.failure })
   return await fs.access(...args)
  } finally { reads.active-- }
 } }
})
import * as engineBin from './engineBin.js'
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); reads.gate = null; reads.failure = ''; reads.large = ''; reads.entries = 0; reads.forbidWindowsSync = false; reads.calls = reads.active = reads.most = 0; vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'ownership-async-')); roots.push(root)
 vi.stubEnv('PATH', root)
 const file = join(root, 'codex'); writeFileSync(file, 'codex', { mode: 0o700 })
 return { root, file }
}
it('returns complete first-discovery identities through asynchronous filesystem work', async () => {
 const { file } = fixture()
 const snapshot = await engineBin.agentCommandOwnershipSnapshotAsync()
 expect(snapshot.engineFileKeys?.get('codex')?.has(engineBin.executableFileIdentity(file)!.fileKey)).toBe(true)
})
it('observes replacement, removal, and a changed PATH on the next discovery', async () => {
 const { root, file } = fixture()
 const first = await engineBin.agentCommandOwnershipSnapshotAsync()
 const replacement = join(root, 'replacement'); writeFileSync(replacement, 'new', { mode: 0o700 }); renameSync(replacement, file)
 const second = await engineBin.agentCommandOwnershipSnapshotAsync()
 expect(second.engineFileKeys?.get('codex')).not.toEqual(first.engineFileKeys?.get('codex'))
 rmSync(file)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toEqual([])
 const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'codex'), 'codex', { mode: 0o700 })
 vi.stubEnv('PATH', other)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join(other, 'codex'))
})

it('bounds filesystem fan-out, shares a pass, and cannot multiply reads after its deadline', async () => {
 fixture(); vi.useFakeTimers()
 const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
 let release!: () => void
 reads.gate = new Promise(resolve => { release = resolve })
 const first = engineBin.agentCommandOwnershipSnapshotAsync()
 expect(engineBin.agentCommandOwnershipSnapshotAsync()).toBe(first)
 const rejected = expect(first).rejects.toThrow('ENGINE_LOOKUP_TIMEOUT')
 await vi.waitFor(() => expect(reads.active).toBe(8))
 await vi.advanceTimersByTimeAsync(10_000)
 await rejected
 expect(reads.calls).toBe(8)
 expect(reads.most).toBe(8)
 await expect(engineBin.agentCommandOwnershipSnapshotAsync()).rejects.toThrow('ENGINE_LOOKUP_TIMEOUT')
 expect(reads.calls).toBe(8)
 release()
 await vi.advanceTimersByTimeAsync(0)
 reads.gate = null
 vi.useRealTimers()
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toHaveLength(1)
 expect(errors).toHaveBeenCalledWith('[engine] ENGINE_LOOKUP_TIMEOUT: executable ownership unavailable')
})
it('a candidate file that fails to read (EIO) is skipped, and the pass answers', async () => {
 fixture(); reads.failure = 'EIO'
 const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toEqual([])
 expect(errors).not.toHaveBeenCalled()
})
it('refuses an in-flight answer when PATH changes', async () => {
 const { root } = fixture(); vi.useFakeTimers()
 let release!: () => void
 reads.gate = new Promise(resolve => { release = resolve })
 const pending = engineBin.agentCommandOwnershipSnapshotAsync()
 const rejected = expect(pending).rejects.toThrow('ENGINE_LOOKUP_CHANGED')
 await vi.advanceTimersByTimeAsync(0)
 vi.stubEnv('PATH', join(root, 'changed'))
 await expect(engineBin.agentCommandOwnershipSnapshotAsync()).rejects.toThrow('ENGINE_LOOKUP_CHANGED')
 release(); await vi.advanceTimersByTimeAsync(0)
 await rejected
})

it('does not repeat missing-command filesystem probes while PATH directories are unchanged', async () => {
 const { root } = fixture()
 const directories = Array.from({ length: 48 }, (_, index) => join(root, `bin${index}`))
 for (const directory of directories) mkdirSync(directory)
 vi.stubEnv('PATH', directories.join(process.platform === 'win32' ? ';' : ':'))
 await engineBin.agentCommandOwnershipSnapshotAsync()
 reads.calls = 0
 await engineBin.agentCommandOwnershipSnapshotAsync()
 expect(reads.calls).toBeLessThan(100)
 // A newly installed name invalidates the directory's negative result without waiting for a TTL.
 const installed = join(directories[0], 'codex'); writeFileSync(installed, 'new', { mode: 0o700 })
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(installed)
})

it.skipIf(process.platform === 'win32')('rechecks chmod and symlink targets without depending on directory mtime', async () => {
 const { root, file } = fixture()
 chmodSync(file, 0o600)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toEqual([])
 chmodSync(file, 0o700)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toHaveLength(1)
 rmSync(file)
 const target = join(root, 'target'), link = join(root, 'link')
 mkdirSync(target); mkdirSync(link)
 const destination = join(target, 'binary'); writeFileSync(destination, 'one', { mode: 0o700 })
 symlinkSync(destination, join(link, 'codex')); vi.stubEnv('PATH', link)
 const first = await engineBin.agentCommandOwnershipSnapshotAsync()
 const replacement = join(target, 'replacement'); writeFileSync(replacement, 'two', { mode: 0o700 }); renameSync(replacement, destination)
 const second = await engineBin.agentCommandOwnershipSnapshotAsync()
 expect(second.engineFileKeys?.get('codex')).not.toEqual(first.engineFileKeys?.get('codex'))
})
it('finds a directory created after a negative lookup', async () => {
 const { root } = fixture(), missing = join(root, 'missing')
 vi.stubEnv('PATH', missing)
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')).toEqual([])
 mkdirSync(missing); writeFileSync(join(missing, 'codex'), 'new', { mode: 0o700 })
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(join(missing, 'codex'))
})

it('stops a huge PATH directory at its bound and uses fixed command probes instead', async () => {
 const { root, file } = fixture(); reads.large = root
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(file)
 expect(reads.entries).toBe(16_385)
 reads.entries = 0
 expect((await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.[0]?.path).toBe(file)
 expect(reads.entries).toBe(0)
})

it('resolves the Windows Hermes launcher without a synchronous PATH scan', async () => {
 const { root } = fixture(), install = join(root, 'hermes'), bin = join(install, 'bin')
 mkdirSync(bin, { recursive: true }); mkdirSync(join(install, 'hermes-agent', 'hermes_cli'), { recursive: true })
 writeFileSync(join(install, 'hermes-agent', 'hermes_cli', 'main.py'), '')
 writeFileSync(join(bin, 'hermes.exe'), 'launcher', { mode: 0o700 })
 const boot = join(bin, 'hermes-boot.py'); writeFileSync(boot, 'boot')
 vi.stubEnv('PATH', bin); reads.forbidWindowsSync = true
 const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
 Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
 try {
  const snapshot = await engineBin.agentCommandOwnershipSnapshotAsync()
  expect(snapshot.engineFileKeys?.get('hermes')?.has(engineBin.executableFileIdentity(boot)!.fileKey)).toBe(true)
 } finally { Object.defineProperty(process, 'platform', platform) }
})
