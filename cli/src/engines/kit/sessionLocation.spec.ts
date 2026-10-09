import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURSOR_TRANSCRIPT } from '../cursor/contract.js'
import { GROK_TRANSCRIPT } from '../grok/contract.js'
import { COPILOT_PROCESS_SESSION, COPILOT_TRANSCRIPT } from '../copilot/contract.js'
import { AGY_PROCESS_SESSION } from '../agy/contract.js'
import { locateProcessSession, locateTranscript, transcriptGroups } from './sessionLocation.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat), readlink: vi.fn(actual.readlink) }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = vi.fn(() => { throw new Error('Unexpected host process probe') })
  Object.defineProperty(execFile, promisify.custom, { value: (...args: unknown[]) => new Promise((resolve, reject) => {
    Reflect.apply(execFile, undefined, [...args, (error: unknown, stdout: string, stderr: string) =>
      error ? reject(error) : resolve({ stdout, stderr })])
  }) })
  return { ...actual, execFile }
})
const A = 'aaaaaaaa-1111-4222-8333-444444444444', B = 'bbbbbbbb-1111-4222-8333-444444444444'
let root: string
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let actual: typeof fs
const permission = () => Object.assign(new Error('private fixture denied'), { code: 'EACCES' })
function file(path: string, text = ''): string { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path }
const cursor = (project = 'p', id = A) => file(join(root, 'projects', project, 'agent-transcripts', id, `${id}.jsonl`), '{}\n')
const lock = (id = A, time = 1000) => {
  const path = file(join(root, 'session-state', id, 'inuse.4242.lock'))
  utimesSync(path, time / 1000, time / 1000); return path
}
const lookup = () => locateTranscript(CURSOR_TRANSCRIPT, root, A)
const copilot = () => locateProcessSession(COPILOT_PROCESS_SESSION, root, 4242)
const agy = () => locateProcessSession(AGY_PROCESS_SESSION, root, 4242)
function descriptors(...paths: string[]): void {
  const folder = join(root, 'proc', '4242', 'fd'); mkdirSync(folder, { recursive: true })
  paths.forEach((path, index) => symlinkSync(path, join(folder, String(index))))
}
function lsof(stdout: string, error: unknown = null): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void
    callback(error, stdout, ''); return {}
  }) as typeof execFile)
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-location-')))
  actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  const mapped = (path: unknown) => String(path).startsWith('/proc/') ? join(root, 'proc', String(path).slice(6)) : path
  vi.mocked(fs.opendir).mockReset().mockImplementation(((path: unknown, ...args: unknown[]) =>
    Reflect.apply(actual.opendir, actual, [mapped(path), ...args])) as typeof fs.opendir)
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat)
  vi.mocked(fs.readlink).mockReset().mockImplementation(((path: unknown, ...args: unknown[]) =>
    Reflect.apply(actual.readlink, actual, [mapped(path), ...args])) as typeof fs.readlink)
  vi.mocked(execFile).mockReset().mockImplementation(() => { throw new Error('Unexpected host process probe') })
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('keeps verified missing stores and invalid IDs distinct from unreadable stores', async () => {
  await expect(lookup()).resolves.toBeNull()
  vi.mocked(fs.opendir).mockClear()
  await expect(locateTranscript(CURSOR_TRANSCRIPT, root, '../escape')).resolves.toBeNull()
  expect(fs.opendir).not.toHaveBeenCalled()
  cursor(); vi.mocked(fs.opendir).mockRejectedValueOnce(permission())
  await expect(lookup()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
it('holds duplicate transcripts instead of accepting the first project', async () => {
  cursor('first'); cursor('second')
  await expect(lookup()).rejects.toThrow('more than one transcript')
})
it('allows two project links to name the same native file', async () => {
  cursor('p'); symlinkSync(join(root, 'projects', 'p'), join(root, 'projects', 'alias'))
  await expect(lookup()).resolves.toMatch(/\/(p|alias)\/agent-transcripts\//)
})
it('holds an unreadable competitor after finding a usable transcript', async () => {
  cursor('first'); const second = cursor('second')
  vi.mocked(fs.stat).mockImplementation(((path, ...args) => String(path) === second
    ? Promise.reject(permission()) : Reflect.apply(actual.stat, actual, [path, ...args])) as typeof fs.stat)
  await expect(lookup()).rejects.toThrow('could not be inspected')
})
it('holds a selected transcript that disappears before publication', async () => {
  const path = cursor(); let reads = 0
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === path && ++reads === 2) unlinkSync(path)
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  await expect(lookup()).rejects.toThrow('selected transcript changed')
})
it('bounds directory buffering and supplied group probes', async () => {
  const close = vi.fn()
  vi.mocked(fs.opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
    try { for (let i = 0; i < 5000; i++) yield { name: String(i), isDirectory: () => true } }
    finally { close() }
  } } as never)
  await expect(transcriptGroups(root, CURSOR_TRANSCRIPT)).rejects.toThrow('directory entry limit')
  expect(close).toHaveBeenCalledOnce()
  expect(fs.opendir).toHaveBeenCalledWith(join(root, 'projects'), { bufferSize: 32 })
  vi.mocked(fs.stat).mockClear()
  await expect(locateTranscript(CURSOR_TRANSCRIPT, root, A, { groups: Array(4097).fill('p') })).rejects.toThrow('probe limit')
  expect(fs.stat).not.toHaveBeenCalled()
})
it('holds a nonregular direct transcript instead of declaring it absent', async () => {
  mkdirSync(join(root, 'session-state', A, 'events.jsonl'), { recursive: true })
  await expect(locateTranscript(COPILOT_TRANSCRIPT, root, A)).rejects.toThrow('not a regular file')
})
it.each(['missing', 'relative', 'oversized'])('holds a Grok candidate with a %s workspace sidecar', async mode => {
  file(join(root, 'sessions', 'hash', A, 'updates.jsonl'))
  if (mode !== 'missing') file(join(root, 'sessions', 'hash', '.cwd'), mode === 'relative' ? 'relative' : '/' + 'x'.repeat(65536))
  await expect(locateTranscript(GROK_TRANSCRIPT, root, A, { cwd: '/workspace' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
it('does not let an encoded Grok candidate hide an unreadable hashed competitor', async () => {
  file(join(root, 'sessions', encodeURIComponent('/workspace'), A, 'updates.jsonl'))
  file(join(root, 'sessions', 'hash', A, 'updates.jsonl'))
  await expect(locateTranscript(GROK_TRANSCRIPT, root, A, { cwd: '/workspace' })).rejects.toThrow('sidecar could not be read')
})
it('excludes a verified other workspace and preserves registry path rejection', async () => {
  file(join(root, 'sessions', 'hash', A, 'updates.jsonl')); file(join(root, 'sessions', 'hash', '.cwd'), '/elsewhere')
  await expect(locateTranscript(GROK_TRANSCRIPT, root, A, { cwd: '/workspace' })).resolves.toBeNull()
  cursor(); await expect(locateTranscript(CURSOR_TRANSCRIPT, root, A, { valid: () => false })).resolves.toBeNull()
})
it('checks the selected Grok workspace after later sidecars and transcript evidence', async () => {
  file(join(root, 'sessions', 'a', A, 'updates.jsonl'))
  const selected = file(join(root, 'sessions', 'a', '.cwd'), '/workspace')
  file(join(root, 'sessions', 'b', A, 'updates.jsonl'))
  const other = file(join(root, 'sessions', 'b', '.cwd'), '/elsewhere')
  const groups = await transcriptGroups(root, GROK_TRANSCRIPT); groups.sort()
  let reads = 0
  vi.mocked(fs.open).mockImplementation(((path, ...args) => {
    // Each bounded read opens twice. Change the selected evidence during the other sidecar's recheck.
    if (String(path) === other && ++reads === 3) writeFileSync(selected, '/changed')
    return Reflect.apply(actual.open, actual, [path, ...args])
  }) as typeof fs.open)
  await expect(locateTranscript(GROK_TRANSCRIPT, root, A, { cwd: '/workspace', groups })).rejects.toThrow('sidecar changed')
})
it('revalidates the selected registry path after all asynchronous reads', async () => {
  cursor()
  const valid = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
  await expect(locateTranscript(CURSOR_TRANSCRIPT, root, A, { valid })).rejects.toThrow('selected transcript path changed')
})
it('holds equally new process locks instead of guessing by directory order', async () => {
  lock(A); lock(B)
  await expect(copilot()).rejects.toThrow('newest process lock is ambiguous')
})
it('does not let an unreadable process claim make a sibling newest', async () => {
  lock(A); const unknown = lock(B, 2000)
  vi.mocked(fs.stat).mockImplementation(((path, ...args) => String(path) === unknown
    ? Promise.reject(permission()) : Reflect.apply(actual.stat, actual, [path, ...args])) as typeof fs.stat)
  await expect(copilot()).rejects.toThrow('could not be inspected')
})
it('rechecks the selected process claim after the other claims', async () => {
  const selected = lock(A, 3000), other = lock(B, 1000); let otherReads = 0
  vi.mocked(fs.stat).mockImplementation(((path, ...args) => {
    if (String(path) === other && ++otherReads === 2) writeFileSync(selected, 'changed')
    return Reflect.apply(actual.stat, actual, [path, ...args])
  }) as typeof fs.stat)
  await expect(copilot()).rejects.toThrow('process lock changed')
})
it('bounds process-lock enumeration before selecting from a partial pool', async () => {
  lock()
  vi.mocked(fs.opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
    for (let i = 0; i < 5000; i++) yield { name: 'irrelevant', isDirectory: () => false }
  } } as never)
  await expect(copilot()).rejects.toThrow('directory entry limit')
})
it('accepts repeated descriptors for one conversation, but holds two distinct locks', async () => {
  const first = join(root, 'presence', `${A}.lock`)
  descriptors(first, first)
  await expect(agy()).resolves.toBe(A)
  symlinkSync(join(root, 'presence', `${B}.lock`), join(root, 'proc', '4242', 'fd', 'third'))
  await expect(agy()).rejects.toThrow('more than one conversation lock')
})
it('holds unavailable or partially readable process descriptors', async () => {
  await expect(agy()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  descriptors(join(root, 'presence', `${A}.lock`), '/dev/null')
  vi.mocked(fs.readlink).mockRejectedValueOnce(permission())
  await expect(agy()).rejects.toThrow('descriptor could not be read')
})
it('ignores unrelated descriptors only after reading the complete pool', async () => {
  descriptors('/dev/null', join(root, 'presence', 'invalid.lock'))
  await expect(agy()).resolves.toBeNull()
  expect(execFile).not.toHaveBeenCalled()
})
it.each(['error', 'partial', 'oversized', 'entries'])('holds %s lsof output instead of using its readable prefix', async mode => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const valid = `p4242\nn${join(root, 'presence', `${A}.lock`)}\n`
  lsof(mode === 'partial' ? valid.trimEnd() : mode === 'oversized' ? valid + 'x'.repeat(256 * 1024) + '\n'
    : mode === 'entries' ? valid + '\n'.repeat(4096) : valid, mode === 'error' ? Object.assign(new Error('probe failed'), { stdout: valid }) : null)
  await expect(agy()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(execFile).toHaveBeenCalledWith('lsof', ['-n', '-P', '-w', '-p', '4242', '-Fn'],
    expect.objectContaining({ timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }), expect.any(Function))
})
it('uses a completed Darwin descriptor probe without running a host binary', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  lsof(`p4242\nn${join(root, 'presence', `${A}.lock`)}\n`)
  await expect(agy()).resolves.toBe(A)
})

it('allows ordinary transcript appends while retaining the same file identity', async () => {
  const path = cursor(); let reads = 0
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === path && ++reads === 2) writeFileSync(path, '{}\n{}\n')
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  await expect(lookup()).resolves.toBe(path)
})
it('holds a competing transcript that appears during the rest of the lookup', async () => {
  cursor('first'); mkdirSync(join(root, 'projects', 'other'), { recursive: true })
  const appearing = join(root, 'projects', 'other', 'agent-transcripts', A, `${A}.jsonl`)
  let reads = 0
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === appearing && ++reads === 2) file(appearing)
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  await expect(lookup()).rejects.toThrow('transcript candidate changed')
})
it('does not use a shared directory listing after its root changes', async () => {
  cursor('first')
  const groups = await transcriptGroups(root, CURSOR_TRANSCRIPT)
  cursor('new')
  await expect(locateTranscript(CURSOR_TRANSCRIPT, root, A, { groups })).rejects.toThrow('directory list changed')
})
it('holds a new process session directory appearing while old claims are rechecked', async () => {
  const selected = lock(A, 3000), other = lock(B, 1000); let reads = 0
  vi.mocked(fs.stat).mockImplementation(((name, ...args) => {
    if (String(name) === other && ++reads === 2) lock('cccccccc-1111-4222-8333-444444444444', 9000)
    return Reflect.apply(actual.stat, actual, [name, ...args])
  }) as typeof fs.stat)
  await expect(copilot()).rejects.toThrow('session directories changed')
  expect(selected).toContain(A)
})
it('rechecks a held conversation descriptor after inspecting unrelated descriptors', async () => {
  const held = join(root, 'presence', `${A}.lock`)
  descriptors(held, '/dev/null'); let reads = 0
  const fd = join(root, 'proc', '4242', 'fd', '0')
  vi.mocked(fs.readlink).mockImplementation(((name, ...args) => {
    const mapped = join(root, 'proc', String(name).slice(6))
    if (String(name).endsWith('/1') && ++reads === 2) {
      unlinkSync(fd); symlinkSync(join(root, 'presence', `${B}.lock`), fd)
    }
    return Reflect.apply(actual.readlink, actual, [mapped, ...args])
  }) as typeof fs.readlink)
  await expect(agy()).rejects.toThrow('descriptor changed')
})
it('holds a descriptor pool that grows before publication', async () => {
  descriptors(join(root, 'presence', `${A}.lock`)); let opens = 0
  vi.mocked(fs.opendir).mockImplementation(((name, ...args) => {
    if (++opens === 2) symlinkSync(join(root, 'presence', `${B}.lock`), join(root, 'proc', '4242', 'fd', '1'))
    return Reflect.apply(actual.opendir, actual, [join(root, 'proc', String(name).slice(6)), ...args])
  }) as typeof fs.opendir)
  await expect(agy()).rejects.toThrow('descriptor list changed')
})
it('holds a deleted lock that the process still has open', async () => {
  descriptors(join(root, 'presence', `${A}.lock (deleted)`))
  await expect(agy()).rejects.toThrow('deleted conversation lock')
})
it('holds changing Darwin descriptor evidence', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  let reads = 0
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: unknown, stdout: string, stderr: string) => void
    callback(null, `p4242\nn${join(root, 'presence', `${++reads === 1 ? A : B}.lock`)}\n`, ''); return {}
  }) as typeof execFile)
  await expect(agy()).rejects.toThrow('descriptors changed')
})

it('does not allow a supplied subset to hide another project', async () => {
  cursor('first'); cursor('second')
  await expect(locateTranscript(CURSOR_TRANSCRIPT, root, A, { groups: ['first'] })).rejects.toThrow('more than one transcript')
})
