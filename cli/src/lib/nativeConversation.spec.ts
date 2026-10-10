import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as syncFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeConversationFixture } from '../testing/nativeConversationEvidence.js'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { nativeOpenFileSession, type NativeConversationOptions, type NativeConversationSources } from './nativeConversation.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), readlink: vi.fn(actual.readlink), lstat: vi.fn(actual.lstat) }
})
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, closeSync: vi.fn(actual.closeSync), lstatSync: vi.fn(actual.lstatSync) }
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string, cwd: string, home: string, held: string[], sources: NativeConversationSources
const id = (n = 1) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
const header = (sessionId = id(), folder = cwd) => JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: folder, source: 'cli' } }) + '\n'
function rollout(n = 1, folder = cwd, base = home): string {
  const file = join(base, 'day', `rollout-${id(n)}.jsonl`)
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, header(id(n), folder)); return file
}
const find = (options: Pick<NativeConversationOptions, 'expected' | 'budget'> = {}) =>
  nativeOpenFileSession('codex', 42, [home], cwd, { sources, ...options })
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.readlink).mockReset().mockImplementation(actual.readlink)
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  const sync = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(syncFs.closeSync).mockReset().mockImplementation(sync.closeSync)
  vi.mocked(syncFs.lstatSync).mockReset().mockImplementation(sync.lstatSync)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-conversation-')))
  cwd = join(root, 'work'); home = join(root, 'sessions'); mkdirSync(cwd); mkdirSync(home)
  held = []; sources = nativeConversationFixture(async () => held)
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it('deduplicates multiple descriptors, aliases and hard links for the same open file', async () => {
  const own = rollout(), alias = join(home, 'rollout-alias.jsonl'), link = join(home, 'rollout-hardlink.jsonl')
  symlinkSync(own, alias); linkSync(own, link); held = [own, own, alias, link]
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it('holds two eligible files rather than letting Stop accept an empty identity', async () => {
  held = [rollout(1), rollout(2)]
  await expect(find()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
it.each(['missing', 'invalid', 'empty', 'wrong-id', 'unknown-folder'] as const)('cannot exclude a %s competitor to make a healthy file unique', async mode => {
  const own = rollout(1), other = rollout(2)
  held = [own, other]
  if (mode === 'missing') rmSync(other)
  if (mode === 'invalid') writeFileSync(other, '{bad')
  if (mode === 'empty') writeFileSync(other, '')
  if (mode === 'wrong-id') writeFileSync(other, header('not-an-id'))
  if (mode === 'unknown-folder') writeFileSync(other, header(id(2), join(root, 'missing')))
  await expect(find()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
it('retains excluded-header evidence until the whole pool has been read', async () => {
  const otherCwd = join(root, 'other'); mkdirSync(otherCwd)
  const own = rollout(), other = rollout(2, otherCwd); held = [own, other]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const pool = await read(...args)
    return { ...pool, verify: async () => { await pool.verify(); writeFileSync(other, header(id(2))) } }
  }
  await expect(find()).rejects.toThrow('header changed')
})
it('checks descriptors after asynchronous process verification so a new conversation holds', async () => {
  const own = rollout(), next = rollout(2); held = [own]
  const read = sources.processes
  sources.processes = async (...args) => {
    const proof = await read(...args)
    return { ...proof, verify: async () => { await proof.verify(); held.push(next) } }
  }
  await expect(find()).rejects.toThrow('descriptors changed')
})
it('catches ordinary ancestor replacement even when the same file inode and header survive', async () => {
  const own = rollout(), replacement = join(root, 'replacement')
  mkdirSync(replacement); linkSync(own, join(replacement, 'rollout-' + id() + '.jsonl')); held = [own]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const pool = await read(...args)
    return { ...pool, verify: async () => {
      await pool.verify(); renameSync(dirname(own), join(root, 'original')); renameSync(replacement, dirname(own))
    } }
  }
  await expect(find()).rejects.toThrow('path or alias changed')
})
it('binds the opened header descriptor to the process inode across a path swap and restoration', async () => {
  const own = rollout(), foreign = rollout(2); held = [own]
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let swapped = false
  vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
    if (String(path) !== own || swapped) return actual.open(path, flags, mode)
    swapped = true
    const file = await actual.open(foreign, flags, mode)
    // The pathname is already back to the expected file when control resumes.
    return file
  })
  await expect(find()).rejects.toThrow('not the file held by the process')
})
it('ignores appended body text while retaining the exact metadata header', async () => {
  const own = rollout(); held = [own]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const pool = await read(...args)
    return { ...pool, verify: async () => { await pool.verify(); writeFileSync(own, readFileSync(own, 'utf8') + '{"body":"new output"}\n') } }
  }
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it('does not decode a partial body character after a valid header with leading blank lines', async () => {
  const own = rollout(); held = [own]
  writeFileSync(own, Buffer.concat([Buffer.from('\n\n' + header()), Buffer.from([0xc3])]))
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it('holds path aliases that loop and pools that exceed the candidate budget', async () => {
  const loop = join(home, 'rollout-loop.jsonl'); symlinkSync(loop, loop); held = [loop]
  await expect(find()).rejects.toThrow('alias depth limit')
  const own = rollout(); held = Array(65).fill(own)
  await expect(find()).rejects.toThrow('descriptor limit')
})
it('keeps one deadline across pool inspection and final verification', async () => {
  held = [rollout()]
  await expect(find({ budget: new NativeEvidenceBudget(-1) })).rejects.toThrow('deadline')
})
it('checks core\'s expected owner before accepting the current occupant of the pid', async () => {
  held = [rollout()]
  await expect(find({ expected: { pid: 42, executable: '/fixture-tools/codex', startMarker: 'different' } })).rejects.toThrow('process changed')
})
it.each(['café', 'back\\n', 'newline\n', 'literal\\xc3\\xa9'])('uses kernel file identity to resolve macOS spelling %j', async folder => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const own = rollout(1, cwd, join(home, folder)); held = [own]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const proof = await read(...args)
    return { ...proof, descriptors: proof.descriptors.map(row => ({ ...row,
      path: row.path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/é/g, '\\xc3\\xa9') })) }
  }
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it('does not round large inode values to accept a different file', async () => {
  const own = rollout(); held = [own]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const proof = await read(...args)
    return { ...proof, descriptors: proof.descriptors.map(row => ({ ...row, inode: statSync(own, { bigint: true }).ino + 1n })) }
  }
  await expect(find()).rejects.toThrow('does not name the process file')
})
it.each([false, 0, {}, [], { thread_spawn: {} }])('holds a malformed delegated-source claim %j', async claim => {
  const own = rollout(), other = rollout(2); held = [own, other]
  writeFileSync(other, JSON.stringify({ type: 'session_meta', payload: { id: id(2), cwd, source: { subagent: claim } } }) + '\n')
  await expect(find()).rejects.toThrow('delegated-source claim is invalid')
})
it.each([false, 0, null, [], {}, { future: 'unknown' }, { custom: '' }, { custom: 'fixture', subagent: 'review' }, 'future'].map(source => ({ source })))('holds an invalid or unknown source variant $source', async ({ source }) => {
  const own = rollout(); held = [own]
  writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: id(), cwd, source } }) + '\n')
  await expect(find()).rejects.toThrow('source is invalid or unknown')
})
it.each([undefined, 'cli', 'vscode', 'exec', 'mcp', 'unknown', { custom: 'fixture' }].map(source => ({ source })))('retains declared native or legacy source $source', async ({ source }) => {
  const own = rollout(); held = [own]
  writeFileSync(own, JSON.stringify({ type: 'session_meta', payload: { id: id(), cwd, source } }) + '\n')
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it('does not exclude a malformed workspace claim to make a healthy rollout unique', async () => {
  const malformed = join(root, 'regular-file'); writeFileSync(malformed, 'not a directory')
  held = [rollout(), rollout(2, malformed)]
  await expect(find()).rejects.toThrow('folder is not a directory')
})
it('requires a valid child id even when a delegated header would otherwise be excluded', async () => {
  const own = rollout(), other = rollout(2); held = [own, other]
  writeFileSync(other, JSON.stringify({ type: 'session_meta', payload: { cwd, source: { subagent: 'review' } } }) + '\n')
  await expect(find()).rejects.toThrow('conclusive conversation id')
})
it('reads a launcher child even when the launcher holds another profile\'s rollout', async () => {
  const own = rollout(), outside = rollout(2, cwd, join(root, 'other-profile'))
  const rows = [{ pid: 42, parentPid: 1, executable: 'node', args: 'node /fixture/codex.js' },
    { pid: 43, parentPid: 42, executable: 'codex', args: 'codex' }]
  sources = nativeConversationFixture(async pid => pid === 42 ? [outside] : [own], async () => rows)
  await expect(find()).resolves.toEqual({ sessionId: id(), transcriptPath: own })
  sources = nativeConversationFixture(async pid => pid === 42 ? [rollout(2)] : [own], async () => rows)
  await expect(find()).rejects.toThrow('more than one open rollout')
})
it('rejects a symlink target borrowed during ancestor replacement even after the ancestor is restored', async () => {
  const own = rollout(), active = join(root, 'active'), spare = join(root, 'spare'), saved = join(root, 'saved')
  mkdirSync(active); mkdirSync(spare)
  symlinkSync(join(root, 'decoy'), join(active, 'bridge')); symlinkSync(home, join(spare, 'bridge'))
  held = [own]
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const pool = await read(...args)
    return { ...pool, descriptors: pool.descriptors.map(row => ({ ...row, path: join(active, 'bridge', 'day', `rollout-${id()}.jsonl`) })) }
  }
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.readlink).mockImplementation(async (path, options) => {
    if (String(path) !== join(active, 'bridge')) return actual.readlink(path, options as never)
    renameSync(active, saved); renameSync(spare, active)
    try { return await actual.readlink(path, options as never) }
    finally { renameSync(active, spare); renameSync(saved, active) }
  })
  await expect(find()).rejects.toThrow('path or alias changed')
})
it('preserves a typed hold if closing the final header descriptor fails', async () => {
  held = [rollout()]
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(syncFs.closeSync).mockImplementationOnce(fd => { actual.closeSync(fd); throw Error('fixture close failure') })
  await expect(find()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: expect.stringContaining('the native rollout header could not be closed') })
})
it('retains workspace competitors across distinct spellings of the same physical directory', async () => {
  const alias = join(root, 'other-workspace-spelling')
  held = [rollout(), rollout(2, alias)]
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const sync = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.lstat).mockImplementation((path, ...args) => actual.lstat(String(path) === alias ? cwd : path, ...args) as never)
  vi.mocked(syncFs.lstatSync).mockImplementation((path, ...args) => sync.lstatSync(String(path) === alias ? cwd : path, ...args) as never)
  await expect(find()).rejects.toThrow('more than one open rollout')
})
it('recognizes a native home through a distinct spelling of the same physical directory', async () => {
  const own = rollout(), alias = join(root, 'other-home-spelling'); held = [own]
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const sync = await vi.importActual<typeof import('node:fs')>('node:fs')
  vi.mocked(fs.lstat).mockImplementation((path, ...args) => actual.lstat(String(path) === alias ? home : path, ...args) as never)
  vi.mocked(syncFs.lstatSync).mockImplementation((path, ...args) => sync.lstatSync(String(path) === alias ? home : path, ...args) as never)
  await expect(nativeOpenFileSession('codex', 42, [alias], cwd, { sources })).resolves.toEqual({ sessionId: id(), transcriptPath: own })
})
it.each(['descriptors', 'process'])('rechecks %s changed during the last asynchronous descriptor read', async mode => {
  const own = rollout(), next = rollout(2); held = [own]
  const rows = [{ pid: 42, parentPid: 1, executable: 'codex', args: 'codex' }]
  sources = nativeConversationFixture(async () => held, async () => rows)
  const read = sources.descriptors
  sources.descriptors = async (...args) => {
    const pool = await read(...args)
    return { ...pool, verify: async () => {
      await pool.verify()
      if (mode === 'descriptors') held = [next]
      else rows[0].args = 'codex resume a different conversation'
    } }
  }
  await expect(find()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
