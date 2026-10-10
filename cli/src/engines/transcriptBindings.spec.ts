import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NativeFiles } from './kit/nativeFiles.js'
import { NativeEvidenceBudget } from './kit/nativeEvidence.js'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, openSync: vi.fn(actual.openSync), readSync: vi.fn(actual.readSync), closeSync: vi.fn(actual.closeSync),
    opendirSync: vi.fn(actual.opendirSync), lstatSync: vi.fn(actual.lstatSync) }
})
let root: string, home: string, file: string, actual: typeof fs, bindings: typeof import('./transcriptBindings.js')
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const record = (id = A, source: unknown = 'cli') => JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source } }) + '\n'
function write(path: string, text = record()): void { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text, { mode: 0o600 }) }
const proof = () => bindings.savedTranscriptEvidence('codex', A, file)
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>('node:fs')
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync)
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync)
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync)
  vi.mocked(fs.opendirSync).mockReset().mockImplementation(actual.opendirSync)
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(actual.lstatSync)
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'binding-transcript-')))
  home = join(root, 'codex'); file = join(home, 'sessions', 'day', `rollout-${A}.jsonl`)
  vi.stubEnv('ADAPTER_DATA_DIR', join(root, 'data')); vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('CLAUDE_PROJECTS_DIR', join(root, 'claude', 'projects'))
  vi.stubEnv('COMMANDCODE_HOME', join(root, 'commandcode')); vi.stubEnv('GROK_HOME', join(root, 'grok'))
  vi.stubEnv('AGY_HOME', join(root, 'agy')); vi.stubEnv('COPILOT_HOME', join(root, 'copilot'))
  write(join(root, 'data', 'engine-homes.json'), '{}'); write(file)
  vi.resetModules(); bindings = await import('./transcriptBindings.js')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }) })

it('verifies an owned exact binding and follows a canonical alias', () => {
  const alias = join(home, 'sessions', 'alias.jsonl'); fs.symlinkSync(file, alias)
  for (const path of [file, alias]) {
    const result = bindings.savedTranscriptEvidence('codex', A, path)
    expect(result.path).toBe(path); expect(() => result.verify()).not.toThrow()
  }
})
it('holds a fresh malformed catalog, but an explicit profile remains independent', () => {
  const old = proof()
  fs.writeFileSync(join(root, 'data', 'engine-homes.json'), '{')
  expect(proof).toThrow('catalog')
  expect(() => old.verify()).toThrow('catalog')
  const explicit = bindings.savedTranscriptEvidence('codex', A, file, home)
  expect(explicit.path).toBe(file); expect(() => explicit.verify()).not.toThrow()
  fs.writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  expect(proof().path).toBe(file)
})
it('never uses a now-omitted moved home as permission to release its binding', () => {
  fs.writeFileSync(join(root, 'data', 'engine-homes.json'), JSON.stringify({ codex: [join(root, 'moved')] }))
  proof().verify()
  fs.writeFileSync(join(root, 'data', 'engine-homes.json'), '{}')
  expect(proof).toThrow('omits')
})
it('distinguishes a proven outside or absent file from an unreadable file', () => {
  const outside = join(root, 'elsewhere.jsonl'); write(outside)
  for (const path of [outside, join(home, 'sessions', 'absent.jsonl')]) {
    const result = bindings.transcriptEvidence('codex', path)
    expect(result.valid).toBe(false); expect(() => result.verify()).not.toThrow()
  }
  vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
    return Reflect.apply(actual.openSync, actual, [path, ...args])
  }) as typeof fs.openSync)
  expect(proof).toThrow('binding file could not be read')
})
it('keeps an absent announced file fenced to its existing parent and root', () => {
  const path = join(home, 'sessions', 'day', 'announced.jsonl')
  const result = bindings.transcriptEvidence('codex', path, undefined, true)
  expect(result.valid).toBe(true); result.verify()
  write(path)
  expect(() => result.verify()).toThrow('changed')
})
it('requires an owned announced parent and retains its ownership until publication', () => {
  const path = join(dirname(file), 'announced.jsonl')
  const result = bindings.transcriptEvidence('codex', path, undefined, true)
  vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    const stat = Reflect.apply(actual.lstatSync, actual, [path, ...args])
    return String(path) === dirname(file) ? Object.assign(stat, { uid: stat.uid + 1n }) : stat
  }) as typeof fs.lstatSync)
  expect(() => result.verify()).toThrow('changed')
  expect(() => bindings.transcriptEvidence('codex', path, undefined, true)).toThrow('owner')
})
it('does not authorize a dangling leaf alias through its original parent', () => {
  const path = join(dirname(file), 'announced.jsonl')
  fs.symlinkSync(join(root, 'outside-absent.jsonl'), path)
  expect(() => bindings.transcriptEvidence('codex', path, undefined, true)).toThrow('absent leaf')
})
it.each([
  ['commandcode', 'commandcode/projects/project/session.jsonl'],
  ['grok', 'grok/sessions/project/session/updates.jsonl'],
  ['agy', 'agy/brain/session/transcript.jsonl'],
  ['copilot', 'copilot/session-state/session/events.jsonl'],
] as const)('fences the unwritten %s derived locator before its root exists', (engine, suffix) => {
  const path = join(root, suffix)
  expect(bindings.transcriptEvidence(engine, path).valid).toBe(false)
  const result = bindings.transcriptEvidence(engine, path, undefined, 'derived')
  expect(result.valid).toBe(true); result.verify()
  fs.mkdirSync(dirname(path), { recursive: true })
  expect(() => result.verify()).toThrow('changed')
  const parentOnly = bindings.transcriptEvidence(engine, path, undefined, 'derived')
  expect(parentOnly.valid).toBe(true); parentOnly.verify()
  write(path, '')
  expect(() => parentOnly.verify()).toThrow('changed')
  expect(bindings.transcriptEvidence(engine, path).valid).toBe(true)
})
it('does not let an unwritten locator borrow a dangling directory or leaf alias', () => {
  const base = join(root, 'commandcode', 'projects')
  fs.mkdirSync(base, { recursive: true })
  for (const [path, link] of [[join(base, 'project', 'session.jsonl'), join(base, 'project')],
    [join(base, 'session.jsonl'), join(base, 'session.jsonl')]]) {
    fs.symlinkSync(join(root, 'outside-absent'), link)
    expect(() => bindings.transcriptEvidence('commandcode', path, undefined, 'derived')).toThrow('absent leaf')
    fs.rmSync(link)
  }
})
it('requires owned surviving ancestry and keeps a derived locator inside its declared root', () => {
  const path = join(root, 'commandcode', 'projects', 'project', 'session.jsonl')
  const result = bindings.transcriptEvidence('commandcode', path, undefined, 'derived')
  vi.mocked(fs.lstatSync).mockImplementation(((at: fs.PathLike, ...args: unknown[]) => {
    const info = Reflect.apply(actual.lstatSync, actual, [at, ...args])
    return String(at) === root ? Object.assign(info, { uid: info.uid + 1n }) : info
  }) as typeof fs.lstatSync)
  expect(() => result.verify()).toThrow('changed')
  expect(() => bindings.transcriptEvidence('commandcode', path, undefined, 'derived')).toThrow('owner')
  vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync)
  expect(bindings.transcriptEvidence('commandcode', join(root, 'outside', 'session.jsonl'), undefined, 'derived').valid).toBe(false)
})
it('does not treat an existing unreadable derived transcript as an unwritten locator', () => {
  const path = join(root, 'commandcode', 'projects', 'project', 'session.jsonl')
  write(path, '')
  vi.mocked(fs.openSync).mockImplementation(((at: fs.PathLike, ...args: unknown[]) => {
    if (String(at) === path) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
    return Reflect.apply(actual.openSync, actual, [at, ...args])
  }) as typeof fs.openSync)
  expect(() => bindings.transcriptEvidence('commandcode', path, undefined, 'derived')).toThrow('could not be read')
})
it.each(['', '{', record().slice(0, -4), ' '.repeat(128 * 1024) + record(), record(A, { future: 'unknown' })])('holds an incomplete or unknown native header', text => {
  fs.writeFileSync(file, text)
  expect(proof).toThrow()
})
it('holds invalid UTF-8 in metadata but does not decode a truncated body after its complete line', () => {
  fs.writeFileSync(file, Buffer.from([123, 255, 125]))
  expect(proof).toThrow('UTF-8')
  fs.writeFileSync(file, Buffer.concat([Buffer.from(record()), Buffer.from([255])]))
  expect(proof().path).toBe(file)
})
it('finishes short reads and bounds a non-progressing or excessive read sequence', () => {
  vi.mocked(fs.readSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
    actual.readSync(fd, bytes, offset, Math.min(length, 7), position)) as typeof fs.readSync)
  expect(proof().path).toBe(file)
  vi.mocked(fs.readSync).mockReturnValue(0)
  expect(proof).toThrow('ended')
  vi.mocked(fs.readSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, _length: number, position: number) =>
    actual.readSync(fd, bytes, offset, 1, position)) as typeof fs.readSync)
  expect(proof).toThrow('read-operation limit')
})
it('binds the opened descriptor even if a pathname is swapped and restored before the open returns', () => {
  const foreign = join(root, 'foreign.jsonl'); write(foreign, record(B))
  vi.mocked(fs.openSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) =>
    Reflect.apply(actual.openSync, actual, [String(path) === file ? foreign : path, ...args])) as typeof fs.openSync)
  expect(proof).toThrow('unconfirmed identity')
})
it('preserves a complete header across body appends and holds a changed header at commit', () => {
  const first = proof(); fs.appendFileSync(file, '{"body":"new turn"}\n'); first.verify()
  const next = proof(); fs.writeFileSync(file, record(B))
  expect(() => next.verify()).toThrow('header changed')
})
it('does not let a repeated header read replace the earlier evidence in one operation', async () => {
  const { sessionStoreOf } = await import('./sessionStoreContracts.js')
  const files = new NativeFiles(), first = sessionStoreOf('codex')!.first!
  files.header(file, first); fs.writeFileSync(file, record(B))
  expect(() => files.header(file, first)).toThrow('header changed')
})
it('retains path ancestry across a replacement that keeps the same file inode', () => {
  const read = proof(), replacement = join(root, 'replacement')
  fs.mkdirSync(replacement); fs.linkSync(file, join(replacement, `rollout-${A}.jsonl`))
  fs.renameSync(dirname(file), join(root, 'original')); fs.renameSync(replacement, dirname(file))
  expect(() => read.verify()).toThrow('path or alias changed')
})

function child(): string {
  const path = join(home, 'sessions', 'child', `rollout-${B}.jsonl`)
  write(path, record(B, { subagent: { thread_spawn: { parent_thread_id: A, depth: 1 } } }))
  return path
}
it('repairs a child overwrite only after proving the whole parent pool', () => {
  const path = child(), held = bindings.savedTranscriptEvidence('codex', A, path)
  expect(held.path).toBe(file); held.verify()
  const competitor = join(home, 'sessions', 'later', `rollout-${A}.jsonl`)
  write(competitor)
  expect(() => held.verify()).toThrow('directory pool changed')
  expect(() => bindings.savedTranscriptEvidence('codex', A, path)).toThrow('more than one')
})
it.each(['file', 'directory'])('does not repair through an outside %s alias', kind => {
  const path = child(), outside = join(root, 'outside')
  fs.mkdirSync(outside); fs.renameSync(file, join(outside, `rollout-${A}.jsonl`))
  if (kind === 'file') fs.symlinkSync(join(outside, `rollout-${A}.jsonl`), file)
  else fs.symlinkSync(outside, join(home, 'sessions', 'linked'))
  expect(() => bindings.savedTranscriptEvidence('codex', A, path)).toThrow('escaped')
})
it('holds an escaped directory before reading even its empty candidate pool', () => {
  const path = child(), outside = join(root, 'empty-outside')
  fs.mkdirSync(outside); fs.symlinkSync(outside, join(home, 'sessions', 'linked'))
  expect(() => bindings.savedTranscriptEvidence('codex', A, path)).toThrow('directory escaped')
})
it('retains absent and present roots in an explicit operation scope', () => {
  const moved = join(root, 'moved'), sessions = join(moved, 'sessions')
  fs.writeFileSync(join(root, 'data', 'engine-homes.json'), JSON.stringify({ codex: [moved] }))
  const scope = bindings.transcriptRootEvidence('codex')
  const result = bindings.savedTranscriptEvidence('codex', A, file, undefined, undefined, scope)
  result.verify(); scope.verify()
  fs.mkdirSync(sessions, { recursive: true })
  expect(() => scope.verify()).toThrow('changed')
})
it('retains an unreadable competing directory even after the parent was found', () => {
  const path = child(), blocked = join(home, 'sessions', 'blocked'); fs.mkdirSync(blocked)
  vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) === blocked) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
    return Reflect.apply(actual.opendirSync, actual, [path, ...args])
  }) as typeof fs.opendirSync)
  expect(() => bindings.savedTranscriptEvidence('codex', A, path)).toThrow('could not be read completely')
})
it('does not infer an empty directory from an iterator acquired during an ancestor round trip', () => {
  const path = child(), sessions = join(home, 'sessions'), elsewhere = join(root, 'empty')
  fs.mkdirSync(elsewhere)
  vi.mocked(fs.opendirSync).mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
    if (String(path) !== sessions) return Reflect.apply(actual.opendirSync, actual, [path, ...args])
    fs.renameSync(home, home + '-aside'); fs.mkdirSync(home); fs.mkdirSync(sessions)
    const result = Reflect.apply(actual.opendirSync, actual, [sessions, ...args])
    fs.renameSync(home, home + '-temporary'); fs.renameSync(home + '-aside', home)
    return result
  }) as typeof fs.opendirSync)
  expect(() => bindings.savedTranscriptEvidence('codex', A, path)).toThrow('ancestor changed')
})
it('holds pool overflow, expired work and failed descriptor close', () => {
  const directory = join(root, 'wide'); fs.mkdirSync(directory)
  for (let index = 0; index < 4097; index++) fs.writeFileSync(join(directory, String(index)), '')
  expect(() => new NativeFiles().entries(directory)).toThrow('entry limit')
  expect(() => new NativeFiles(new NativeEvidenceBudget(-1)).file(file)).toThrow('deadline')
  vi.mocked(fs.closeSync).mockImplementation(fd => { actual.closeSync(fd); throw new Error('fixture close failed') })
  expect(() => new NativeFiles().file(file)).toThrow('could not be closed')
}, 30_000)
