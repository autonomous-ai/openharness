import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareApiInstructions } from './apiInstructions.js'

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
})

/** Whether this computer's disk ignores case, as a Mac's does by default. */
function caseBlind(): boolean { return existsSync(realpathSync(tmpdir()).toUpperCase()) }
