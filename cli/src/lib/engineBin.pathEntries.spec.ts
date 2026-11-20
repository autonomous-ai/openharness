import { accessSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, type StatSyncOptions } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { executableFileIdentity } from './engineBin.js'
import { engineProcessMatch } from './processTable.js'
// Windows run 44758521149: a PATH folder the user cannot list answered `opendir` EPERM, and every pass failed.
// `stat` and `opendir` fail on that folder only, `under` on every path inside it, `file` on that one path.
const fail = vi.hoisted(() => ({ stat: new Map<string, string>(), opendir: new Map<string, string>(), under: new Map<string, string>(), file: new Map<string, string>(), huge: '' }))
// A dead network share or a hung junction: `hold` keeps one folder's `opendir`, or every call on a path inside a folder,
// waiting until `release()`. `reads` logs each call's start (1) and end (-1).
const hold = vi.hoisted(() => ({ opendir: new Set<string>(), under: new Set<string>(), gate: Promise.resolve(), release: () => {} }))
const reads = vi.hoisted(() => [] as [path: string, change: 1 | -1][])
// Every call answers from the real filesystem at once, through its synchronous form: a case that moves the fake clock
// then knows that every read but a held one has ended, so only the held folder meets its bound.
vi.mock('node:fs/promises', async original => {
 const fs = await original<typeof import('node:fs/promises')>()
 const call = async <T>(syscall: string, target: unknown, own: Map<string, string> | undefined, real: () => T): Promise<T> => {
  const path = String(target)
  reads.push([path, 1])
  try {
   if ((syscall === 'opendir' && hold.opendir.has(path)) || [...hold.under].some(folder => path.startsWith(folder + sep))) {
    await hold.gate
    // Released, a held call answers as a share that went away does, so the read it held ends at once.
    throw Object.assign(new Error(`ENOENT: released, ${syscall} '${path}'`), { code: 'ENOENT', syscall, path })
   }
   // As a real fs error does, the message quotes the path: a line may carry the code only.
   const code = own?.get(path) ?? fail.file.get(path) ?? [...fail.under].find(([folder]) => path.startsWith(folder + sep))?.[1]
   if (code) throw Object.assign(new Error(`${code}: mocked failure, ${syscall} '${path}'`), { code, syscall, path })
   return real()
  } finally { reads.push([path, -1]) }
 }
 const listing = (names: readonly string[]) => (async function* () { for (const name of names) yield { name } })()
 return { ...fs,
  stat: (path: string, options?: StatSyncOptions) => call('stat', path, fail.stat, () => statSync(path, options)),
  lstat: (path: string) => call('lstat', path, undefined, () => lstatSync(path)),
  opendir: (path: string) => call('opendir', path, fail.opendir, () => listing(path === fail.huge
   ? Array.from({ length: 16_385 }, (_, index) => `unrelated-${index}`)
   : readdirSync(path))),
  access: (path: string, mode?: number) => call('access', path, undefined, () => accessSync(path, mode)),
  realpath: (path: string) => call('realpath', path, undefined, () => realpathSync(path)),
 }
})
const inside = (path: string, folder: string) => path === folder || path.startsWith(folder + sep)
const readsOf = (folder: string) => reads.filter(([path, change]) => change === 1 && inside(path, folder)).length
function mostAtOnce(folder: string): number {
 let open = 0, most = 0
 for (const [path, change] of reads) if (inside(path, folder)) most = Math.max(most, open += change)
 return most
}
const roots: string[] = []
let engineBin: typeof import('./engineBin.js'), warn: MockInstance<typeof console.warn>
// The last line logged and the folder cache are module state: every case starts from a fresh module.
beforeEach(async () => {
 hold.gate = new Promise(resolve => { hold.release = () => { hold.opendir.clear(); hold.under.clear(); resolve() } })
 vi.resetModules(); engineBin = await import('./engineBin.js')
 warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
 hold.release(); reads.length = 0
 vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
 fail.stat.clear(); fail.opendir.clear(); fail.under.clear(); fail.file.clear(); fail.huge = ''
 for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function folder(name: string, ...files: string[]): string {
 const root = mkdtempSync(join(tmpdir(), 'path-entries-')); roots.push(root)
 const path = join(root, name); mkdirSync(path)
 for (const file of files) writeFileSync(join(path, file), file, { mode: 0o700 })
 return path
}
const onPath = (...folders: string[]) => vi.stubEnv('PATH', folders.join(delimiter))
function badThenGood(badName = 'bad') {
 const bad = folder(badName, 'codex'), good = folder('good', 'codex')
 onPath(bad, good)
 return { bad, good }
}
const found = async () => (await engineBin.agentCommandOwnershipSnapshotAsync()).engineCandidates?.get('codex')?.map((candidate) => candidate.path)

const KINDS = ['EPERM', 'EACCES', 'EINVAL', 'ELOOP', 'UNKNOWN']
it.each(KINDS)('a folder whose listing fails with %s is probed by name: its engine is found, and the line counts it', async (code) => {
 const { bad, good } = badThenGood(); fail.opendir.set(bad, code)
 expect(await found()).toEqual([join(bad, 'codex'), join(good, 'codex')])
 expect(warn.mock.calls).toEqual([[`[engine] PATH: 1 folder not listed (${code}), probed by name`]])
})
it.each(KINDS)('a folder whose stat fails with %s is probed by name the same way', async (code) => {
 const { bad, good } = badThenGood(); fail.stat.set(bad, code)
 expect(await found()).toEqual([join(bad, 'codex'), join(good, 'codex')])
 expect(warn.mock.calls).toEqual([[`[engine] PATH: 1 folder not listed (${code}), probed by name`]])
})
it.each([['EACCES', 'EACCES'], ['EACCES', 'EPERM'], ['EPERM', 'EPERM'], ['EPERM', 'EACCES']])('a folder not listed (%s) whose probes fail with %s too is skipped, and the pass answers with the rest', async (listing, probes) => {
 const { bad, good } = badThenGood(); fail.opendir.set(bad, listing); fail.under.set(bad, probes)
 expect(await found()).toEqual([join(good, 'codex')])
 expect(warn.mock.calls).toEqual([[`[engine] PATH: 1 folder skipped (${probes})`]])
})
it('ENOENT and ENOTDIR are folders with nothing in them, and are not counted', async () => {
 for (const code of ['ENOENT', 'ENOTDIR']) {
  for (const read of [fail.stat, fail.opendir]) {
   const { bad, good } = badThenGood(); read.set(bad, code)
   expect(await found()).toEqual([join(good, 'codex')])
  }
 }
 expect(warn).not.toHaveBeenCalled()
})
it('a candidate file whose read fails is skipped, not the pass', async () => {
 const { bad, good } = badThenGood(); fail.file.set(join(bad, 'codex'), 'EPERM')
 expect(await found()).toEqual([join(good, 'codex')])
 expect(warn).not.toHaveBeenCalled()
})
it('a relative entry that cannot be resolved is skipped under its kind', async () => {
 const good = folder('good', 'codex'); onPath('rel', good)
 vi.spyOn(process, 'cwd').mockImplementation(() => { throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' }) })
 expect(await found()).toEqual([join(good, 'codex')])
 expect(warn.mock.calls).toEqual([['[engine] PATH: 1 folder skipped (ENOENT)']])
})
it('says the line once, again when it changes, and when everything is read again', async () => {
 const { bad, good } = badThenGood(), bad2 = folder('bad2', 'codex')
 fail.opendir.set(bad, 'EPERM')
 await found()
 await found()
 onPath(bad, bad2, good); fail.opendir.set(bad2, 'EACCES'); fail.under.set(bad2, 'EACCES')
 await found()
 fail.opendir.clear(); fail.under.clear()
 // Fixing a folder's permissions moves its times, so its cached read is stale; here they are moved by hand.
 utimesSync(bad, new Date(0), new Date(0))
 expect(await found()).toEqual([join(bad, 'codex'), join(bad2, 'codex'), join(good, 'codex')])
 expect(warn.mock.calls).toEqual([
  ['[engine] PATH: 1 folder not listed (EPERM), probed by name'],
  ['[engine] PATH: 1 folder not listed (EPERM), probed by name; 1 folder skipped (EACCES)'],
  ['[engine] PATH: every folder read'],
 ])
})
it('names no folder: the lines carry kinds only', async () => {
 const { bad, good } = badThenGood('sentinel-folder-name'), skipped = folder('sentinel-folder-name', 'codex')
 onPath(bad, skipped, good)
 fail.opendir.set(bad, 'EPERM'); fail.opendir.set(skipped, 'EACCES'); fail.under.set(skipped, 'EACCES')
 const lines = [warn, vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'info')]
 for (const line of lines.slice(1)) line.mockImplementation(() => {})
 await found()
 const said = JSON.stringify(lines.map((line) => line.mock.calls))
 expect(said).toContain('[engine] PATH: ')
 expect(said).not.toContain('sentinel-folder-name')
})
it('a running engine from a skipped folder is still matched by its name', async () => {
 const bad = folder('bad', 'claude'), claude = join(bad, 'claude'); onPath(bad)
 fail.opendir.set(bad, 'EACCES'); fail.under.set(bad, 'EACCES')
 const snapshot = await engineBin.agentCommandOwnershipSnapshotAsync(), fileKey = executableFileIdentity(claude)!.fileKey
 expect(snapshot.engineFileKeys?.get('claude')?.has(fileKey)).toBe(false)
 expect(engineProcessMatch({ executable: 'claude', commandPath: claude, args: claude, imageFileKey: fileKey }, 'claude', snapshot).score).toBeGreaterThan(0)
})
it('a folder of more than 16,384 names is probed by name in its own read', async () => {
 const { bad, good } = badThenGood(); fail.huge = bad
 expect(await found()).toEqual([join(bad, 'codex'), join(good, 'codex')])
 expect(warn).not.toHaveBeenCalled()
})

/** The clock moves by a folder's own bound, never as far as the pass's 10 s deadline. */
async function foundAfterTheBound() {
 const pass = found()
 await vi.advanceTimersByTimeAsync(engineBin.PATH_ENTRY_TIMEOUT_MS)
 return await pass
}
it('a folder whose listing does not answer is skipped after its own bound, and the pass answers', async () => {
 const { bad: hung, good } = badThenGood('hung'); hold.opendir.add(hung); vi.useFakeTimers()
 expect(await foundAfterTheBound()).toEqual([join(good, 'codex')])
 expect(warn.mock.calls).toEqual([['[engine] PATH: 1 folder skipped (TIMEOUT)']])
})
it('a folder not listed (EACCES) whose probe by name does not answer is skipped after the same bound', async () => {
 const { bad: hung, good } = badThenGood('hung'); fail.opendir.set(hung, 'EACCES'); hold.under.add(hung); vi.useFakeTimers()
 expect(await foundAfterTheBound()).toEqual([join(good, 'codex')])
 expect(warn.mock.calls).toEqual([['[engine] PATH: 1 folder skipped (TIMEOUT)']])
})
it('a hung folder gives no candidate file, not even for a name its listing could not rule out', async () => {
 // A name outside ASCII is always looked up as a file: the listing compares names in ASCII case only.
 const { bad: hung, good } = badThenGood('hung'); vi.stubEnv('CODEX_PATH', 'cödex')
 hold.opendir.add(hung); hold.under.add(hung); vi.useFakeTimers()
 expect(await foundAfterTheBound()).toEqual([join(good, 'codex')])
 expect(readsOf(join(hung, 'cödex'))).toBe(0)
})
it('a hung folder gives no candidate file to a path that names a file in it either', async () => {
 // An engine's own path (CODEX_PATH) or an install location (~/.local/bin/codex) in a PATH folder that hung.
 const { bad: hung, good } = badThenGood('hung'); vi.stubEnv('CODEX_PATH', join(hung, 'codex'))
 hold.opendir.add(hung); hold.under.add(hung); vi.useFakeTimers()
 const pass = found()
 let answered = false
 void pass.then(() => { answered = true }, () => { answered = true })
 await vi.advanceTimersByTimeAsync(engineBin.PATH_ENTRY_TIMEOUT_MS)
 // By the folder's own bound, never the pass's 10 s deadline: a read of that file would hold the pass in turn.
 expect(answered).toBe(true)
 expect(await pass).toEqual([join(good, 'codex')])
 expect(readsOf(join(hung, 'codex'))).toBe(0)
})
it('is not read again while that read is outstanding, and is read again once it ends', async () => {
 const { bad: hung, good } = badThenGood('hung'); hold.opendir.add(hung); vi.useFakeTimers()
 expect(await foundAfterTheBound()).toEqual([join(good, 'codex')])
 const before = readsOf(hung)
 // No clock moved: a folder whose read is outstanding is skipped at once.
 expect(await found()).toEqual([join(good, 'codex')])
 expect(readsOf(hung)).toBe(before)
 hold.release(); await vi.advanceTimersByTimeAsync(0)
 expect(await found()).toEqual([join(hung, 'codex'), join(good, 'codex')])
 expect(readsOf(hung)).toBeGreaterThan(before)
 expect(warn.mock.calls).toEqual([['[engine] PATH: 1 folder skipped (TIMEOUT)'], ['[engine] PATH: every folder read']])
})
it('one hung folder never holds more than one filesystem read', async () => {
 const { bad: hung, good } = badThenGood('hung'); fail.opendir.set(hung, 'EACCES'); hold.under.add(hung); vi.useFakeTimers()
 for (let pass = 0; pass < 3; pass++) expect(await foundAfterTheBound()).toEqual([join(good, 'codex')])
 expect(mostAtOnce(hung)).toBe(1)
})
