import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ now: 0 }))
vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => clock.now } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir), open: vi.fn(actual.open) }
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
    expect(reads).toBe(4096); expect(closed).toBe(true)
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
})
