import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { executableFileIdentity } from './engineBin.js'
import { engineProcessMatch } from './processTable.js'
// Windows run 44758521149: a PATH folder the user cannot list answered `opendir` EPERM, and every pass failed.
// `stat` and `opendir` fail on that folder only, `under` on every path inside it, `file` on that one path.
const fail = vi.hoisted(() => ({ stat: new Map<string, string>(), opendir: new Map<string, string>(), under: new Map<string, string>(), file: new Map<string, string>(), huge: '' }))
vi.mock('node:fs/promises', async original => {
 const fs = await original<typeof import('node:fs/promises')>()
 // As a real fs error does, the message quotes the path: a line may carry the code only.
 const check = (syscall: string, target: unknown, own?: Map<string, string>) => {
  const path = String(target)
  const code = own?.get(path) ?? fail.file.get(path) ?? [...fail.under].find(([folder]) => path.startsWith(folder + sep))?.[1]
  if (code) throw Object.assign(new Error(`${code}: mocked failure, ${syscall} '${path}'`), { code, syscall, path })
 }
 return { ...fs,
  stat: async (...args: Parameters<typeof fs.stat>) => { check('stat', args[0], fail.stat); return await fs.stat(...args) },
  lstat: async (...args: Parameters<typeof fs.lstat>) => { check('lstat', args[0]); return await fs.lstat(...args) },
  opendir: async (...args: Parameters<typeof fs.opendir>) => {
   check('opendir', args[0], fail.opendir)
   if (String(args[0]) !== fail.huge) return await fs.opendir(...args)
   return (async function* () { for (let index = 0; index <= 16_384; index++) yield { name: `unrelated-${index}` } })()
  },
  access: async (...args: Parameters<typeof fs.access>) => { check('access', args[0]); return await fs.access(...args) },
  realpath: async (...args: Parameters<typeof fs.realpath>) => { check('realpath', args[0]); return await fs.realpath(...args) },
 }
})
const roots: string[] = []
let engineBin: typeof import('./engineBin.js'), warn: MockInstance<typeof console.warn>
// The last line logged and the folder cache are module state: every case starts from a fresh module.
beforeEach(async () => {
 vi.resetModules(); engineBin = await import('./engineBin.js')
 warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
 vi.restoreAllMocks(); vi.unstubAllEnvs()
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
