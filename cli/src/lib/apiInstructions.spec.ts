import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareApiInstructions } from './apiInstructions.js'

// A saved API as the metadata store lists it: the note needs only that one exists, never a key.
const saved = () => ({ list: vi.fn(() => [{ id: 'fixture' }]) as never })
const MARKER = '<!-- harness:apis -->'

// A start wrote the note into the instruction file of whatever folder it launched in, the person's own repository
// included, while its comment promised only workspaces Harness made (core audit, security 9).
describe('the saved APIs\' note goes only into a workspace Harness made', () => {
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

  it('writes nothing into a folder the person chose', () => {
    for (const engine of ['codex', 'claude', 'gemini', 'opencode']) prepareApiInstructions(saved(), mine, engine, root)
    expect(readdirSync(mine)).toEqual(['AGENTS.md'])
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
  })

  it('reads no saved API for a folder the person chose', () => {
    const store = saved()
    prepareApiInstructions(store, mine, 'codex', root)
    expect(store.list).not.toHaveBeenCalled()
  })

  it('takes a link in the projects root to a folder of the person\'s for that folder', () => {
    symlinkSync(mine, join(root, 'linked'), 'junction')
    prepareApiInstructions(saved(), join(root, 'linked'), 'codex', root)
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
  })

  it('takes the projects root itself for no workspace', () => {
    prepareApiInstructions(saved(), root, 'codex', root)
    expect(readdirSync(root)).toEqual([])
  })

  it('notes a new project and a worktree Harness made', () => {
    for (const folder of [join(root, 'scratch'), join(root, 'worktrees', 'repo', 'branch')]) {
      mkdirSync(folder, { recursive: true })
      prepareApiInstructions(saved(), folder, 'codex', root)
      expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain(MARKER)
    }
  })

  it('is held to where Harness makes its workspaces when no root is given, as the core calls it', () => {
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    vi.stubEnv('HARNESS_OS', '')
    const made = join(root, 'scratch')
    mkdirSync(made)
    prepareApiInstructions(saved(), mine, 'codex')
    prepareApiInstructions(saved(), made, 'codex')
    expect(readFileSync(join(mine, 'AGENTS.md'), 'utf8')).toBe('# My rules\n')
    expect(readFileSync(join(made, 'AGENTS.md'), 'utf8')).toContain(MARKER)
  })
})
