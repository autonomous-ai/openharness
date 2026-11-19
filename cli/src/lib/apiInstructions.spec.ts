import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_INSTRUCTIONS, prepareApiInstructions } from './apiInstructions.js'

// Pass-through, recording what reaches each file: opened, written, or renamed onto. Once a test fills the disk, a
// write stops part way, as ENOSPC leaves it.
const disk = vi.hoisted(() => ({ events: [] as string[], full: false }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.events.push(`open ${String(args[0])}`); return actual.openSync(...args) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      disk.events.push(`write ${String(args[0])}`)
      if (!disk.full) return actual.writeFileSync(...args)
      actual.writeFileSync(args[0], String(args[1]).slice(0, 8))
      throw Object.assign(new Error('ENOSPC: fixture'), { code: 'ENOSPC' })
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.events.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
  }
})

// An API saved, as the list a launch reads says it: the note needs only that one is, never a key.
const saved = () => ({ saved: vi.fn(() => true) })
const MARKER = '<!-- harness:apis -->'

// A start wrote the note into the instruction file of whatever folder it launched in, the person's own repository
// included, while its comment promised only workspaces Harness made (core audit, security 9).
describe('the saved APIs\' note goes only into a project folder Harness made', () => {
  let dir: string, root: string, mine: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'api-notes-')))
    root = join(dir, 'harnesses')
    mine = join(dir, 'code', 'mine')
    mkdirSync(root)
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'AGENTS.md'), '# My rules\n')
  })
  afterEach(() => {
    disk.full = false
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })
  const made = (...path: string[]): string => { const folder = join(root, ...path); mkdirSync(folder, { recursive: true }); return folder }

  it('writes nothing into a folder the person chose', () => {
    for (const engine of ['codex', 'claude', 'gemini', 'opencode']) prepareApiInstructions(saved(), mine, engine, root)
    expect(readdirSync(mine)).toEqual(['AGENTS.md'])
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
  })

  it('reads no saved API for a folder the person chose', () => {
    const store = saved()
    prepareApiInstructions(store, mine, 'codex', root)
    expect(store.saved).not.toHaveBeenCalled()
  })

  it('takes a link in the projects root to a folder of the person\'s for that folder', () => {
    symlinkSync(mine, join(root, 'linked'), 'junction')
    prepareApiInstructions(saved(), join(root, 'linked'), 'codex', root)
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
  })

  it('notes a new project Harness made', () => {
    const project = made('scratch')
    prepareApiInstructions(saved(), project, 'codex', root)
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain(MARKER)
  })

  it('leaves a repository alone: a clone, a worktree and the folder that holds the worktrees', () => {
    const clone = made('clone', '.git')
    const worktree = made('worktrees', 'repo', 'branch')
    writeFileSync(join(worktree, '.git'), 'gitdir: elsewhere\n')
    for (const folder of [join(clone, '..'), worktree, join(root, 'worktrees')]) prepareApiInstructions(saved(), folder, 'claude', root)
    expect(readdirSync(join(clone, '..'))).toEqual(['.git'])
    expect(readdirSync(worktree)).toEqual(['.git'])
    expect(readdirSync(join(root, 'worktrees'))).toEqual(['repo'])
  })

  it('takes the projects root itself, and a folder deeper in a project, for no project folder', () => {
    const deeper = made('scratch', 'src')
    prepareApiInstructions(saved(), root, 'codex', root)
    prepareApiInstructions(saved(), deeper, 'codex', root)
    expect(readdirSync(root)).toEqual(['scratch'])
    expect(readdirSync(deeper)).toEqual([])
  })

  it('writes nothing, and says nothing, before Harness has made any project folder', () => {
    rmSync(root, { recursive: true })
    expect(() => prepareApiInstructions(saved(), mine, 'codex', root)).not.toThrow()
    expect(readdirSync(mine)).toEqual(['AGENTS.md'])
  })

  it('throws a folder it cannot resolve, for the caller\'s log line', () => {
    expect(() => prepareApiInstructions(saved(), join(root, 'gone'), 'codex', root)).toThrow(/ENOENT/)
  })

  // A Mac's disk ignores case by default: a folder named in another case is still the one on disk.
  it.runIf(caseBlind())('reads a folder named in another case as the one on disk', () => {
    const project = made('scratch')
    prepareApiInstructions(saved(), project.replace('harnesses', 'HARNESSES'), 'codex', root)
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain(MARKER)
  })

  it('is held to where Harness makes its workspaces when no root is given, as the core calls it', () => {
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    vi.stubEnv('HARNESS_OS', '')
    const project = made('scratch')
    prepareApiInstructions(saved(), mine, 'codex')
    prepareApiInstructions(saved(), project, 'codex')
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toContain(MARKER)
  })

  it('the save goes through a temporary file renamed onto the target', () => {
    const file = join(made('scratch'), 'AGENTS.md')
    writeFileSync(file, '# Project rules\n')
    disk.events = []
    prepareApiInstructions(saved(), join(root, 'scratch'), 'codex', root)
    expect(disk.events.filter((event) => event.endsWith(` ${file}`))).toEqual([`rename ${file}`])
    expect(readFileSync(file, 'utf8')).toBe(`# Project rules\n\n${API_INSTRUCTIONS}`)
  })

  // A torn write lost the instructions written there before the note.
  it('a write that fails part way leaves the old file', () => {
    const project = made('scratch')
    writeFileSync(join(project, 'AGENTS.md'), '# Project rules\n')
    disk.full = true
    expect(() => prepareApiInstructions(saved(), project, 'codex', root)).toThrow('ENOSPC')
    disk.full = false
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe('# Project rules\n')
    expect(readdirSync(project)).toEqual(['AGENTS.md'])
  })

  // A file the person made read-only stays as they left it: the write refuses it, and the core logs why.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves a read-only instruction file as it is, and throws', () => {
    const project = made('scratch')
    const file = join(project, 'AGENTS.md')
    writeFileSync(file, '# Project rules\n')
    chmodSync(file, 0o444)
    expect(() => prepareApiInstructions(saved(), project, 'codex', root)).toThrow(/EACCES/)
    expect(readFileSync(file, 'utf8')).toBe('# Project rules\n')
    expect(statSync(file).mode & 0o777).toBe(0o444)
  })

  // Windows keeps no mode bits.
  it.skipIf(process.platform === 'win32')('keeps the file\'s own mode, and gives a new one 0644', () => {
    const project = made('scratch')
    prepareApiInstructions(saved(), project, 'claude', root)
    expect(statSync(join(project, 'CLAUDE.md')).mode & 0o777).toBe(0o644)
    writeFileSync(join(project, 'AGENTS.md'), '# Project rules\n')
    chmodSync(join(project, 'AGENTS.md'), 0o640)
    prepareApiInstructions(saved(), project, 'codex', root)
    expect(statSync(join(project, 'AGENTS.md')).mode & 0o777).toBe(0o640)
  })
})

/** Whether this computer's disk ignores case, as a Mac's does by default. */
function caseBlind(): boolean { return existsSync(realpathSync(tmpdir()).toUpperCase()) }
