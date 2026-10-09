import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, type Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => clock.now } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir), open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) }
})
vi.mock('../inProcess.js', async original => ({ ...await original<object>(), loadEngine: () => { throw new Error('Optional reader unavailable') } }))

let root = ''
let repair: typeof import('../../lib/sessionRepair.js')
let lookup: typeof import('./exactTranscript.js')['exactTranscript']
const ID = 'aaaaaaaa-1111-4222-8333-444444444444'
const OTHER = 'bbbbbbbb-1111-4222-8333-444444444444'
const path = (...parts: string[]) => join(root, ...parts)
const projects = { kind: 'projects' as const, filename: `${ID}.jsonl` }
const walk = { kind: 'walk' as const, matches: (name: string) => name.endsWith(`${ID}.jsonl`) }
function file(name: string, body = '{}\n'): string {
  mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, body); return name
}
const claude = (folder = 'work', home = path('claude')) => file(join(home, 'projects', folder, `${ID}.jsonl`))
const codex = (folder = 'day', id = ID) => file(path('codex', 'sessions', folder, `rollout-${ID}.jsonl`),
  JSON.stringify({ type: 'session_meta', payload: { id, cwd: path('work'), source: 'cli' } }) + '\n')

beforeEach(async () => {
  clock.now = 0
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat)
  vi.mocked(fs.opendir).mockReset().mockImplementation(actual.opendir)
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath)
  root = realpathSync(mkdtempSync(join(tmpdir(), 'exact-transcript-')))
  for (const [name, value] of Object.entries({ HOME: path('home'), ADAPTER_DATA_DIR: path('data'),
    ADAPTER_RUNTIME_DIR: path('runtime'), CLAUDE_CONFIG_DIR: path('claude'), CLAUDE_PROJECTS_DIR: path('claude', 'projects'),
    CODEX_HOME: path('codex'), PI_HOME: path('pi'), HERMES_HOME: path('hermes') })) vi.stubEnv(name, value)
  vi.resetModules()
  repair = await import('../../lib/sessionRepair.js')
  lookup = (await import('./exactTranscript.js')).exactTranscript
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('exact resume uses complete native evidence', () => {
  it.each(['claude', 'codex'] as const)('holds multiple %s files and recovers when the conflict is removed', async engine => {
    const first = engine === 'claude' ? claude('first') : codex('first')
    const second = engine === 'claude' ? claude('second') : codex('second')
    await expect(repair.findResumedTranscript(engine, ID)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    rmSync(second)
    await expect(repair.findResumedTranscript(engine, ID)).resolves.toBe(first)
  })
  it('checks all moved homes before accepting a default-home answer', async () => {
    claude(); claude('work', path('moved'))
    ;(await import('../../lib/engineHomes.js')).adoptHomes({ CLAUDE_CONFIG_DIR: path('moved') })
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('more than one transcript')
  })
  it('does not treat an unreadable later home as absence', async () => {
    claude(); mkdirSync(path('moved', 'projects'), { recursive: true })
    ;(await import('../../lib/engineHomes.js')).adoptHomes({ CLAUDE_CONFIG_DIR: path('moved') })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.opendir).mockImplementation(async (name, options) => {
      if (String(name) === path('moved', 'projects')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
      return actual.opendir(name, options)
    })
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('could not be read')
    vi.mocked(fs.opendir).mockImplementation(actual.opendir)
    await expect(repair.findResumedTranscript('claude', ID)).resolves.toBe(claude())
  })
  it('requires a readable file even when the filename gives its id', async () => {
    const transcript = claude()
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === transcript) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
      return actual.open(name, flags, mode)
    })
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
  it('uses the Codex header id rather than a coincidental filename substring', async () => {
    codex('wrong', OTHER)
    await expect(repair.findResumedTranscript('codex', ID)).resolves.toBeNull()
    const right = codex('right')
    await expect(repair.findResumedTranscript('codex', ID)).resolves.toBe(right)
  })
  it('holds malformed Codex metadata instead of choosing a readable sibling', async () => {
    codex('right'); file(path('codex', 'sessions', 'unknown', `rollout-${ID}.jsonl`), '{')
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
  it('rejects an overlong argv id before any native lookup', async () => {
    await expect(repair.findResumedTranscript('codex', 'a'.repeat(129))).resolves.toBeNull()
    expect(fs.opendir).not.toHaveBeenCalled()
  })
  it('refuses a private FIFO without opening or waiting for a writer', async () => {
    const name = path('claude', 'projects', 'work', `${ID}.jsonl`)
    mkdirSync(dirname(name), { recursive: true }); execFileSync('mkfifo', [name])
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('not a regular file')
    expect(fs.open).not.toHaveBeenCalled()
  })
  it('streams the directory bound and closes the iterator on exhaustion', async () => {
    mkdirSync(path('pool'))
    let reads = 0, closed = false
    vi.mocked(fs.opendir).mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
      try { while (true) yield { name: `unrelated-${++reads}`, isDirectory: () => false, isSymbolicLink: () => false } }
      finally { closed = true }
    } } as never)
    await expect(lookup([path('pool')], walk)).rejects.toThrow('directory entry limit')
    // Inspecting this private path spends part of the same budget before enumeration starts.
    expect(reads).toBeLessThan(4096); expect(reads).toBeGreaterThan(4000); expect(closed).toBe(true)
    expect(fs.opendir).toHaveBeenCalledWith(path('pool'), { bufferSize: 32 })
  })
  it('bounds homes even when all are absent', async () => {
    await expect(lookup(Array.from({ length: 65 }, (_, n) => path(String(n))), projects)).rejects.toThrow('session-home limit')
    expect(fs.lstat).not.toHaveBeenCalled()
  })
  it('bounds existing candidates while allowing many proven negative projects', async () => {
    for (let n = 0; n < 80; n++) mkdirSync(path('claude', 'projects', String(n)), { recursive: true })
    const exact = claude()
    await expect(repair.findResumedTranscript('claude', ID)).resolves.toBe(exact)
    for (let n = 0; n < 64; n++) claude(String(n))
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('candidate limit')
  })
  it('holds an unfinished deep tree rather than concluding no exact file exists', async () => {
    mkdirSync(path('pool', ...Array.from({ length: 33 }, () => 'directory')), { recursive: true })
    await expect(lookup([path('pool')], walk)).rejects.toThrow('depth limit')
  })
  it('shares the deadline across native header checks', async () => {
    const exact = file(path('pool', `${ID}.jsonl`))
    await expect(lookup([path('pool')], walk, { accepts: async name => { expect(name).toBe(exact); clock.now = 2001; return true } }))
      .rejects.toThrow('deadline')
  })
  it('deduplicates physical file and directory aliases without hiding their paths', async () => {
    const exact = file(path('pool', 'first', `${ID}.jsonl`))
    mkdirSync(path('pool', 'second')); linkSync(exact, path('pool', 'second', `${ID}.jsonl`))
    symlinkSync(path('pool'), path('alias'))
    symlinkSync(path('pool'), path('pool', 'cycle'))
    const found = await lookup([path('pool'), path('alias')], walk)
    expect([exact, path('pool', 'second', `${ID}.jsonl`)]).toContain(found)
  })
  it('rechecks an absent earlier candidate before returning a later exact file', async () => {
    mkdirSync(path('first', 'work'), { recursive: true }); file(path('second', 'work', `${ID}.jsonl`))
    await expect(lookup([path('first'), path('second')], projects, { accepts: async () => {
      file(path('first', 'work', `${ID}.jsonl`)); return true
    } })).rejects.toThrow('pool changed')
  })
  it('rechecks a previously absent root', async () => {
    file(path('second', 'work', `${ID}.jsonl`))
    await expect(lookup([path('first'), path('second')], projects, { accepts: async () => {
      file(path('first', 'work', `${ID}.jsonl`)); return true
    } })).rejects.toThrow('pool changed')
  })
  it('rechecks an alias whose previously missing target appeared', async () => {
    mkdirSync(path('first')); symlinkSync(path('target'), path('first', 'alias'))
    file(path('second', 'work', `${ID}.jsonl`))
    await expect(lookup([path('first'), path('second')], projects, { accepts: async () => {
      file(path('target', `${ID}.jsonl`)); return true
    } })).rejects.toThrow('pool changed')
  })
  it.each(['replace', 'rewrite', 'remove'] as const)('holds a selected file that a later native read can %s', async change => {
    const exact = file(path('pool', `${ID}.jsonl`))
    await expect(lookup([path('pool')], walk, { accepts: async () => {
      if (change === 'replace') { const next = file(path('replacement')); renameSync(next, exact) }
      if (change === 'rewrite') writeFileSync(exact, 'different header\n')
      if (change === 'remove') rmSync(exact)
      return true
    } })).rejects.toThrow('pool changed')
  })
  it('rechecks an excluded header before treating the pool as empty', async () => {
    const exact = file(path('pool', `${ID}.jsonl`))
    await expect(lookup([path('pool')], walk, { accepts: async () => { writeFileSync(exact, 'now matches\n'); return false } }))
      .rejects.toThrow('pool changed')
  })
  it('holds inspection failures and retries without cached absence', async () => {
    const exact = claude()
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('fixture denied'), { code: 'EACCES' }))
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('could not be inspected')
    await expect(repair.findResumedTranscript('claude', ID)).resolves.toBe(exact)
  })
  it('requires a directory at each declared root', async () => {
    file(path('pool'))
    await expect(lookup([path('pool')], walk)).rejects.toThrow('not a directory')
  })
  it.each(['claude', 'codex'] as const)('fences a newly adopted %s home during an exact read', async engine => {
    if (engine === 'claude') claude(); else codex()
    const homes = await import('../../lib/engineHomes.js')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementationOnce(async (name, flags, mode) => {
      homes.adoptHomes({ [engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: path('new-home') })
      return actual.open(name, flags, mode)
    })
    await expect(repair.findResumedTranscript(engine, ID)).rejects.toThrow('known session homes changed')
  })
  it('keeps an explicit Codex profile independent of unrelated adopted homes', async () => {
    const exact = codex()
    const homes = await import('../../lib/engineHomes.js')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementationOnce(async (name, flags, mode) => {
      homes.adoptHomes({ CODEX_HOME: path('new-home') }); return actual.open(name, flags, mode)
    })
    await expect(repair.findResumedTranscript('codex', ID, { codexHome: path('codex') })).resolves.toBe(exact)
  })
  it.each([undefined, 42, ''])('holds a matching-name subagent with inconclusive id %s', async id => {
    codex('right')
    file(path('codex', 'sessions', 'unknown', `rollout-${ID}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id, source: { subagent: 'tool' } } }) + '\n')
    await expect(repair.findResumedTranscript('codex', ID)).rejects.toThrow('no conclusive conversation id')
  })
  it.each(['codex', 'pi'] as const)('ties the %s header to its inspected inode through an ancestor alias ABA', async engine => {
    const cwd = path('work'); mkdirSync(cwd)
    const { piSessionFolder } = await import('../repairIdentities.js')
    const relative = engine === 'codex' ? ['sessions', `rollout-${ID}.jsonl`]
      : ['agent', 'sessions', piSessionFolder(cwd), `day_${ID}.jsonl`]
    const body = (id: string) => JSON.stringify(engine === 'codex'
      ? { type: 'session_meta', payload: { id, cwd, source: 'cli' } } : { type: 'session', id, cwd }) + '\n'
    file(path('target-a', ...relative), body(OTHER)); file(path('target-b', ...relative), body(ID))
    symlinkSync(path('target-a'), path(engine))
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      rmSync(path(engine)); symlinkSync(path('target-b'), path(engine))
      const handle = await actual.open(name, flags, mode)
      rmSync(path(engine)); symlinkSync(path('target-a'), path(engine))
      return handle
    })
    await expect(repair.findResumedTranscript(engine, ID, { cwd })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
  it.each(['codex', 'pi'] as const)('fences the %s descriptor when an ordinary ancestor directory is replaced and restored', async engine => {
    const cwd = path('work'); mkdirSync(cwd)
    const { piSessionFolder } = await import('../repairIdentities.js')
    const relative = engine === 'codex' ? ['codex', 'sessions', `rollout-${ID}.jsonl`]
      : ['pi', 'agent', 'sessions', piSessionFolder(cwd), `day_${ID}.jsonl`]
    const body = (id: string) => JSON.stringify(engine === 'codex'
      ? { type: 'session_meta', payload: { id, cwd, source: 'cli' } } : { type: 'session', id, cwd }) + '\n'
    file(path('anchor', ...relative), body(OTHER)); file(path('alternate', ...relative), body(ID))
    if (engine === 'pi') (await import('../../config/env.js')).env.PI_HOME = path('anchor', 'pi')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      // The sessions directory and transcript retain their own metadata: only an ancestor is renamed.
      // Both opens see the alternate descriptor while the visible path is restored after each open.
      renameSync(path('anchor'), path('holding')); renameSync(path('alternate'), path('anchor'))
      const handle = await actual.open(name, flags, mode)
      renameSync(path('anchor'), path('alternate')); renameSync(path('holding'), path('anchor'))
      return handle
    })
    await expect(repair.findResumedTranscript(engine, ID, { codexHome: path('anchor', 'codex'), cwd }))
      .rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
  it.each(['root', 'ancestor', 'chained target', 'relative parent'] as const)('holds a directory listing redirected through a %s alias and restored', async kind => {
    const relative = kind === 'relative parent'
    claude('conflict', relative ? path('target-a', 'home') : path('target-a'))
    const competing = claude('other', path('moved'))
    mkdirSync(relative ? path('target-b', 'home', 'projects') : path('target-b', 'projects'), { recursive: true })
    if (relative) for (const name of ['target-a', 'target-b']) mkdirSync(path(name, 'leaf'), { recursive: true })
    const alias = relative ? path('bridge') : kind === 'root' ? path('claude', 'projects') : kind === 'ancestor' ? path('claude') : path('outer')
    if (kind === 'root') mkdirSync(path('claude'))
    const target = (name: string) => relative ? path(name, 'leaf') : kind === 'root' ? path(name, 'projects') : path(name)
    symlinkSync(target('target-a'), alias)
    if (kind === 'chained target') symlinkSync(path('outer'), path('claude'))
    if (relative) symlinkSync('bridge/../home', path('claude'))
    ;(await import('../../lib/engineHomes.js')).adoptHomes({ CLAUDE_CONFIG_DIR: path('moved') })
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.opendir).mockImplementationOnce(async (name, options) => {
      rmSync(alias); symlinkSync(target('target-b'), alias)
      const directory = await actual.opendir(name, options)
      rmSync(alias); symlinkSync(target('target-a'), alias)
      return directory
    })
    await expect(repair.findResumedTranscript('claude', ID)).rejects.toThrow('alias changed during lookup')
    rmSync(competing)
    await expect(repair.findResumedTranscript('claude', ID)).resolves.toBe(path('claude', 'projects', 'conflict', `${ID}.jsonl`))
  })
  it.each(['accepted', 'excluded'] as const)('revalidates an %s Pi cwd alias after later native reads', async kind => {
    const cwd = path('work'), other = path('other'), alias = path('cwd-alias')
    mkdirSync(cwd); mkdirSync(other); symlinkSync(kind === 'accepted' ? cwd : other, alias)
    const { piSessionFolder } = await import('../repairIdentities.js')
    const directory = path('pi', 'agent', 'sessions', piSessionFolder(cwd))
    file(join(directory, `first_${ID}.jsonl`), JSON.stringify({ type: 'session', id: ID, cwd: alias }) + '\n')
    const second = file(join(directory, `second_${ID}.jsonl`), JSON.stringify({ type: 'session', id: OTHER, cwd }) + '\n')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(fs.opendir).mockImplementation(async (name, options) => {
      const dir = await actual.opendir(name, options), entries: Dirent[] = []
      for await (const entry of dir) entries.push(entry)
      entries.sort((a, b) => a.name.localeCompare(b.name))
      return { async *[Symbol.asyncIterator]() { yield* entries } } as never
    })
    vi.mocked(fs.open).mockImplementation(async (name, flags, mode) => {
      if (String(name) === second) { rmSync(alias); symlinkSync(kind === 'accepted' ? other : cwd, alias) }
      return actual.open(name, flags, mode)
    })
    await expect(repair.findResumedTranscript('pi', ID, { cwd })).rejects.toThrow('workspace identity changed')
  })
  it('holds unavailable Pi workspace evidence instead of excluding that candidate', async () => {
    const cwd = path('work'); mkdirSync(cwd)
    const { piSessionFolder } = await import('../repairIdentities.js')
    file(path('pi', 'agent', 'sessions', piSessionFolder(cwd), `day_${ID}.jsonl`),
      JSON.stringify({ type: 'session', id: ID, cwd: path('unavailable') }) + '\n')
    await expect(repair.findResumedTranscript('pi', ID, { cwd })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  })
})
