import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeResumeMarkers } from './nativeResumeMarker.js'
import type { NativeArchiveLink } from './nativeArchive.js'

const fault = vi.hoisted(() => ({ file: '', renamed: false, removed: false, failPublish: false, failRemove: false, stats: 0,
  published: undefined as (() => void) | undefined, unlinked: undefined as (() => void) | undefined,
  unlinking: undefined as (() => void) | undefined, opened: undefined as ((path: string) => void) | undefined,
  closed: undefined as ((path: string) => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>(), paths = new Map<number, string>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args); paths.set(fd, String(args[0])); fault.opened?.(String(args[0])); return fd
  }, closeSync: (fd: number) => {
    const path = paths.get(fd) ?? ''; actual.closeSync(fd); paths.delete(fd); fault.closed?.(path)
  }, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => { fault.stats++; return actual.lstatSync(...args) },
  renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    actual.renameSync(...args)
    if (String(args[1]) === fault.file) { fault.renamed = true; fault.published?.() }
  }, unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
    if (String(args[0]) === fault.file) fault.unlinking?.()
    actual.unlinkSync(...args)
    if (String(args[0]) === fault.file) { fault.removed = true; fault.unlinked?.() }
  }, fsyncSync: (fd: number) => {
    if (actual.fstatSync(fd).isDirectory() && (fault.failPublish && fault.renamed || fault.failRemove && fault.removed)) throw Error('fixture directory sync failed')
    actual.fsyncSync(fd)
  } }
})
let root: string, directory: string, file: string, markers: NativeResumeMarkers
const link: NativeArchiveLink = { version: 1, agentId: 'original-agent', requestId: 'original-resume-request',
  launchToken: 'original-launch-token', target: 'a'.repeat(64) }
const authority = () => ({ verify: vi.fn(), current: vi.fn() })
const reserve = () => markers.reserve(link, authority())
const finish = () => markers.finish(link, authority())
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-resume-marker-'))); directory = join(root, 'saved')
  mkdirSync(directory, { mode: 0o700 }); file = join(directory, `${link.agentId}.resume`)
  markers = new NativeResumeMarkers(directory)
  fault.file = file; fault.renamed = fault.removed = fault.failPublish = fault.failRemove = false; fault.stats = 0
})
afterEach(() => {
  fault.file = ''; fault.published = fault.unlinked = fault.unlinking = undefined; fault.closed = fault.opened = undefined
  fault.failPublish = fault.failRemove = false; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
})

it('retains one complete reservation across retries and confirms cleanup independently of marker absence', () => {
  const proof = reserve(), inode = statSync(file).ino
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, nativeArchive: link })
  expect(() => proof.verify()).not.toThrow()
  expect(() => reserve().verify()).not.toThrow()
  expect(() => new NativeResumeMarkers(directory).reserve(link, authority()).verify()).not.toThrow()
  expect(statSync(file).ino).toBe(inode)
  finish(); expect(existsSync(file)).toBe(false)
  const retained = authority(); markers.finish(link, retained)
  expect(retained.verify).toHaveBeenCalled(); expect(retained.current).toHaveBeenCalled()
  expect(() => proof.verify()).toThrow()
})

it.each(['legacy', 'malformed', 'version', 'request', 'token', 'target', 'agent'])('preserves a different %s marker during reservation and cleanup', changed => {
  const value = { version: 1, nativeArchive: { ...link } }
  if (changed === 'version') value.version = 2
  if (changed === 'request') value.nativeArchive.requestId = 'different-resume-request'
  if (changed === 'token') value.nativeArchive.launchToken = 'different-launch-token'
  if (changed === 'target') value.nativeArchive.target = 'b'.repeat(64)
  if (changed === 'agent') value.nativeArchive.agentId = 'different-agent'
  const content = changed === 'legacy' ? '{"token":"original-launch-token"}' : changed === 'malformed' ? '{' : JSON.stringify(value)
  writeFileSync(file, content, { mode: 0o600 })
  expect(reserve).toThrow(); expect(finish).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(content)
})

it('requires actual publication confirmation and retains constant proof work through repeated failed retries', () => {
  fault.failPublish = true
  expect(reserve).toThrow('sync failed')
  const counts: number[] = []
  for (let i = 0; i < 8; i++) {
    fault.stats = 0; expect(reserve).toThrow('sync failed'); counts.push(fault.stats)
  }
  expect(new Set(counts).size).toBe(1)
  fault.failPublish = false
  expect(() => reserve().verify()).not.toThrow()
})

it('does not adopt an equal substitute for its uncertain published marker', () => {
  fault.failPublish = true; expect(reserve).toThrow(); fault.failPublish = false
  writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
  expect(reserve).toThrow()
})

it('retains its actual publisher through the first inspection after publication', () => {
  let replaced = false
  fault.closed = path => {
    if (!replaced && fault.renamed && path === directory) {
      replaced = true
      writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
    }
  }
  expect(reserve).toThrow(); expect(replaced).toBe(true)
})

it('confirms an uncertain unlink without recreating its marker', () => {
  reserve(); fault.failRemove = true
  expect(finish).toThrow('sync failed'); expect(existsSync(file)).toBe(false)
  fault.failRemove = false
  expect(finish).not.toThrow()
  expect(() => reserve().verify()).not.toThrow()
})

it('retains the original parent when unlink takes effect and then reports an error', () => {
  reserve(); fault.unlinked = () => { throw Error('fixture unlink completion unknown') }
  expect(finish).toThrow('completion unknown'); expect(existsSync(file)).toBe(false)
  fault.unlinked = undefined
  renameSync(directory, join(root, 'previous')); mkdirSync(directory, { mode: 0o700 })
  expect(finish).toThrow()
})

it('can retry the exact original marker when unlink fails without removing it', () => {
  reserve(); const inode = statSync(file).ino
  fault.unlinking = () => { throw Error('fixture unlink unavailable') }
  expect(finish).toThrow('unlink unavailable'); expect(statSync(file).ino).toBe(inode)
  fault.unlinking = undefined
  expect(finish).not.toThrow(); expect(existsSync(file)).toBe(false)
})

it('cannot adopt an equal replacement for the surviving marker after a failed unlink', () => {
  reserve(); fault.unlinking = () => { throw Error('fixture unlink unavailable') }
  expect(finish).toThrow('unlink unavailable'); fault.unlinking = undefined
  writeFileSync(`${file}.new`, readFileSync(file), { mode: 0o600 }); renameSync(`${file}.new`, file)
  expect(finish).toThrow(); expect(existsSync(file)).toBe(true)
})

it('does not fsync a substitute directory when the original pathname returns after acquisition', () => {
  reserve(); const retained = authority(); let substituted = false, restored = false
  retained.current.mockImplementation(() => {
    if (!fault.removed || substituted) return
    substituted = true
    renameSync(directory, join(root, 'previous')); mkdirSync(directory, { mode: 0o700 })
  })
  fault.opened = path => {
    if (path !== directory || !substituted || restored) return
    restored = true
    renameSync(directory, join(root, 'substitute')); renameSync(join(root, 'previous'), directory)
  }
  expect(() => markers.finish(link, retained)).toThrow('descriptor changed')
  expect(substituted).toBe(true); expect(restored).toBe(true)
  fault.opened = undefined
  expect(finish).not.toThrow()
})

it.each(['same', 'successor'])('preserves a %s marker that reappears after uncertain cleanup', changed => {
  reserve(); fault.failRemove = true; expect(finish).toThrow(); fault.failRemove = false
  const value = { version: 1, nativeArchive: { ...link, ...(changed === 'successor' ? { requestId: 'successor-resume-request' } : {}) } }
  const content = JSON.stringify(value); writeFileSync(file, content, { mode: 0o600 })
  expect(finish).toThrow(); expect(reserve).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(content)
})

it.each(['reserve', 'finish'])('pins the original directory through uncertain %s', operation => {
  if (operation === 'reserve') { fault.failPublish = true; expect(reserve).toThrow(); fault.failPublish = false }
  else { reserve(); fault.failRemove = true; expect(finish).toThrow(); fault.failRemove = false }
  renameSync(directory, join(root, 'previous')); mkdirSync(directory, { mode: 0o700 })
  if (operation === 'reserve') writeFileSync(file, readFileSync(join(root, 'previous', `${link.agentId}.resume`)), { mode: 0o600 })
  expect(operation === 'reserve' ? reserve : finish).toThrow()
})

it('requires independent cleanup authority even when the marker is missing', () => {
  const retained = authority()
  retained.verify.mockImplementation(() => { throw Object.assign(Error('receipt missing'), { code: 'ENOENT' }) })
  expect(() => markers.finish(link, retained)).toThrow('receipt missing')
})

it('retains source and local revocation after cleanup removes the marker', () => {
  reserve(); const retained = authority()
  retained.current.mockImplementation(() => { if (fault.removed) throw Error('cleanup revoked') })
  expect(() => markers.finish(link, retained)).toThrow('cleanup revoked')
  expect(existsSync(file)).toBe(false)
  expect(finish).not.toThrow()
})

it('checks post-sync absence after closing the original directory', () => {
  reserve()
  fault.closed = path => {
    if (fault.removed && path === directory) {
      fault.closed = undefined
      writeFileSync(file, JSON.stringify({ version: 1, nativeArchive: link }), { mode: 0o600 })
    }
  }
  expect(finish).toThrow()
  expect(existsSync(file)).toBe(true)
})
