import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ fail: false, current: true, onSync: undefined as (() => void) | undefined }))
vi.mock('node:fs', async real => {
  const actual = await real<typeof import('node:fs')>()
  return { ...actual, fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
    fault.onSync?.()
    if (fault.fail) queueMicrotask(() => done(Error('fixture disk unavailable')))
    else actual.fsync(fd, done)
  } }
})
let root: string
let publish: typeof import('./publishedGridConfig.js').publishGridConfigDir
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'published-grid-')))
  vi.stubEnv('HOME', root); vi.stubEnv('ADAPTER_DATA_DIR', root)
  fault.fail = false; fault.current = true; fault.onSync = undefined
  vi.resetModules(); publish = (await import('./publishedGridConfig.js')).publishGridConfigDir
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const files = [{ name: 'models.json', content: '{"model":"fixture"}\n' }]

it('publishes complete immutable versions and preserves a live version across an unavailable replacement', async () => {
  const before = await publish('fixture-agent', files)
  expect(before.proof.current()).toBe(true)
  expect(lstatSync(before.directory).mode & 0o777).toBe(0o700)
  const changed = [{ name: 'models.json', content: '{"model":"other"}\n' }]
  fault.fail = true
  await expect(publish('fixture-agent', changed)).rejects.toThrow('fixture disk unavailable')
  expect(readFileSync(join(before.directory, 'models.json'), 'utf8')).toBe(files[0]!.content)
  expect(before.proof.current()).toBe(true)
  fault.fail = false
  const after = await publish('fixture-agent', changed)
  expect(after.directory).not.toBe(before.directory)
  expect(after.proof.current()).toBe(true)
  expect((await publish('fixture-agent', changed)).directory).toBe(after.directory)
  expect(readFileSync(join(before.directory, 'models.json'), 'utf8')).toBe(files[0]!.content)
})

it('never overwrites changed published files or a borrowed conversation directory', async () => {
  const target = join(root, 'native', 'sessions'), links = [{ name: 'sessions', target }]
  const result = await publish('fixture-agent', files, links)
  expect(readlinkSync(join(result.directory, 'sessions'))).toBe(target)
  writeFileSync(join(target, 'conversation'), 'retained user data')
  writeFileSync(join(result.directory, 'models.json'), 'foreign configuration')
  expect(result.proof.current()).toBe(false)
  await expect(publish('fixture-agent', files, links)).rejects.toThrow('published configuration was changed')
  expect(readFileSync(join(result.directory, 'models.json'), 'utf8')).toBe('foreign configuration')
  expect(readFileSync(join(target, 'conversation'), 'utf8')).toBe('retained user data')
})

it('invalidates borrowed-directory aliases in the retained dispatch proof', async () => {
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'home')
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias)
  const result = await publish('fixture-agent', files, [{ name: 'sessions', target: join(alias, 'sessions') }])
  expect(result.proof.current()).toBe(true)
  rmSync(alias); symlinkSync(b, alias)
  expect(result.proof.current()).toBe(false)
  expect(result.proof.files.some(file => file.facts.some(fact => fact.path === alias && fact.alias))).toBe(true)
})

it('holds when ownership changes during disk confirmation and safely resumes the same private publication', async () => {
  fault.onSync = () => { fault.current = false }
  await expect(publish('fixture-agent', files, [], () => fault.current)).rejects.toThrow()
  fault.onSync = undefined; fault.current = true
  const result = await publish('fixture-agent', files)
  expect(result.proof.current()).toBe(true)
})

it('does not let a changed native alias during publication redirect borrowed sessions', async () => {
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'home')
  mkdirSync(a); mkdirSync(b); symlinkSync(a, alias)
  fault.onSync = () => { fault.onSync = undefined; rmSync(alias); symlinkSync(b, alias) }
  await expect(publish('fixture-agent', files, [{ name: 'sessions', target: join(alias, 'sessions') }])).rejects.toThrow()
  expect(() => lstatSync(join(b, 'sessions'))).toThrow()
})

it('checks every file, manifest and directory again when a completed publication is reused', async () => {
  const first = await publish('fixture-agent', files)
  renameSync(first.directory, first.directory + '-foreign')
  mkdirSync(first.directory, { mode: 0o700 })
  expect(first.proof.current()).toBe(false)
  // A new directory cannot borrow the old completion. Its old owned files stay intact.
  await expect(publish('fixture-agent', files)).rejects.toThrow('directory identity changed')
  expect(readFileSync(join(first.directory + '-foreign', 'models.json'), 'utf8')).toBe(files[0]!.content)
})

it('pins a newly created directory across its first ownership-record flush', async () => {
  let replaced = ''
  fault.onSync = () => {
    const parent = join(root, 'grid-launch-config')
    const names = readdirSync(parent)
    if (!names.some(name => name.startsWith('.harness-hook-') && name.endsWith('.tmp')
      && JSON.parse(readFileSync(join(parent, name), 'utf8')).directory)) return
    const leaf = names.find(name => /^[a-f0-9]{64}$/.test(name))!
    replaced = join(parent, leaf)
    fault.onSync = undefined
    renameSync(replaced, replaced + '-original'); mkdirSync(replaced, { mode: 0o700 })
  }
  await expect(publish('fixture-agent', files)).rejects.toThrow()
  expect(replaced).not.toBe('')
  expect(readdirSync(replaced)).toEqual([])
  expect(readdirSync(replaced + '-original')).toEqual([])
  await expect(publish('fixture-agent', files)).rejects.toThrow()
})

it('retains the original native alias when a joining publisher captures its link proof', async () => {
  const a = join(root, 'a'), b = join(root, 'b'), alias = join(root, 'home')
  mkdirSync(join(a, 'sessions'), { recursive: true }); mkdirSync(join(b, 'sessions'), { recursive: true }); symlinkSync(a, alias)
  const { NativePaths } = await import('../engines/kit/nativePaths.js')
  const original = NativePaths.prototype.resolveSync
  let linkReads = 0
  vi.spyOn(NativePaths.prototype, 'resolveSync').mockImplementation(function (this: InstanceType<typeof NativePaths>, path, missingOkay) {
    if (path.startsWith(join(root, 'grid-launch-config')) && path.endsWith('/sessions') && ++linkReads === 2) {
      rmSync(alias); symlinkSync(b, alias)
    }
    return original.call(this, path, missingOkay)
  })
  const links = [{ name: 'sessions', target: join(alias, 'sessions') }]
  const results = await Promise.allSettled([publish('fixture-agent', files, links), publish('fixture-agent', files, links)])
  expect(linkReads).toBeGreaterThanOrEqual(2)
  expect(results[1]!.status).toBe('rejected')
  for (const result of results) if (result.status === 'fulfilled') expect(result.value.proof.current()).toBe(false)
})

it('holds a removed published file instead of recreating it behind an existing process', async () => {
  const first = await publish('fixture-agent', files)
  rmSync(join(first.directory, 'models.json'))
  await expect(publish('fixture-agent', files)).rejects.toThrow('configuration was removed')
  expect(first.proof.current()).toBe(false)
  expect(() => lstatSync(join(first.directory, 'models.json'))).toThrow()
})

it.each(['missing', 'replaced'] as const)('holds a %s borrowed session directory without recreating or adopting it', async kind => {
  const target = join(root, 'native-home', 'sessions')
  const links = [{ name: 'sessions', target }]
  const first = await publish('fixture-agent', files, links)
  writeFileSync(join(target, 'conversation'), 'original history')
  renameSync(target, target + '-retained')
  if (kind === 'replaced') mkdirSync(target)
  await expect(publish('fixture-agent', files, links)).rejects.toThrow()
  expect(first.proof.current()).toBe(false)
  expect(readFileSync(join(target + '-retained', 'conversation'), 'utf8')).toBe('original history')
  if (kind === 'missing') expect(() => lstatSync(target)).toThrow()
  else expect(readdirSync(target)).toEqual([])
})

it('does not recreate a removed publication directory that a live engine may still name', async () => {
  const first = await publish('fixture-agent', files)
  renameSync(first.directory, first.directory + '-retained')
  await expect(publish('fixture-agent', files)).rejects.toThrow()
  expect(() => lstatSync(first.directory)).toThrow()
  expect(readFileSync(join(first.directory + '-retained', 'models.json'), 'utf8')).toBe(files[0]!.content)
})

it.each([
  ['../escape', 'content'], ['.harness-config.json', 'content'], ['same/name', 'content'], ['models.json', 'x'.repeat(1024 * 1024)],
])('holds invalid or oversized configuration %s', async (name, content) => {
  await expect(publish('fixture-agent', [{ name, content }])).rejects.toThrow()
  expect(() => lstatSync(join(root, 'grid-launch-config'))).toThrow()
})
