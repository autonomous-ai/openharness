import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProjectFolder, prepareProjectFolder, ProjectFolderError } from './projectFolder.js'

describe('project folder preparation', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'harness-project-test-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('accepts the existing GitHub forms and rejects credentials, helpers and ambiguous source choices', () => {
    expect(parseProjectFolder({})).toBeNull()
    expect(parseProjectFolder({ projectSource: 'new' })).toEqual({ source: 'new' })
    for (const url of ['owner/repo', 'https://github.com/owner/repo.git', 'git@github.com:owner/repo']) {
      expect(parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })).toMatchObject({ source: 'remote', name: 'repo' })
    }
    for (const url of ['ext::bad', '/tmp/repo', '--upload-pack=bad', 'https://user:secret@github.com/owner/repo', 'owner/repo;command', 'https://github.com/owner/repo?token=secret']) {
      expect(() => parseProjectFolder({ projectSource: 'remote', repositoryUrl: url })).toThrow(ProjectFolderError)
    }
    expect(() => parseProjectFolder({ projectSource: 'new', repositoryUrl: 'owner/repo' })).toThrow(ProjectFolderError)
  })

  const now = () => new Date(2026, 8, 3, 9, 5, 7)

  it('names a new project after its agent and the time, every part two digits so folders sort', async () => {
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: 'Codex', now })).toBe(join(root, 'codex-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: 'Autonomous Circuit', now })).toBe(join(root, 'autonomous-circuit-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: '  ', now })).toBe(join(root, 'harness-2026-09-03-09-05'))
    expect(await prepareProjectFolder({ source: 'new' }, { root, label: '!!', now })).toBe(join(root, 'harness-2026-09-03-09-05-07'))
  })

  it('gives a named new project that folder, slugged again here, and never a changed name', async () => {
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'My Game! v2' })).toEqual({ source: 'new', name: 'My-Game-v2' })
    // A name is a path segment: nothing that climbs or hides survives, and nothing usable is no name.
    expect(parseProjectFolder({ projectSource: 'new', projectName: '../../etc' })).toEqual({ source: 'new', name: 'etc' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: ' .. ' })).toEqual({ source: 'new' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: 7 })).toEqual({ source: 'new' })
    expect(await prepareProjectFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now })).toBe(join(root, 'My-Game-v2'))
    // Asking again is refused rather than answered with "My-Game-v2-2": the folder is theirs to pick.
    await expect(prepareProjectFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(await readdir(root)).toEqual(['My-Game-v2'])
  })

  it('gives two projects in the same minute the seconds, then a suffix, and never takes a file’s name', async () => {
    await writeFile(join(root, 'codex-2026-09-03-09-05'), 'keep')
    const folders = await Promise.all([1, 2, 3].map(() => prepareProjectFolder({ source: 'new' }, { root, label: 'Codex', now })))
    expect(new Set(folders)).toEqual(new Set([
      join(root, 'codex-2026-09-03-09-05-07'), join(root, 'codex-2026-09-03-09-05-07-2'), join(root, 'codex-2026-09-03-09-05-07-3'),
    ]))
    expect(await readFile(join(root, 'codex-2026-09-03-09-05'), 'utf8')).toBe('keep')
    expect(await readdir(root)).toHaveLength(4)
  })

  it('uses the clock when no time is given', async () => {
    const folder = await prepareProjectFolder({ source: 'new' }, { root, label: 'Pi' })
    expect(folder).toMatch(/\/pi-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/)
  })

  it('publishes a complete clone and never replaces existing files or starts a second clone', async () => {
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    const clone = vi.fn(async (url: string, destination: string) => {
      expect(url).toBe('https://github.com/owner/repo.git')
      await mkdir(destination)
      await writeFile(join(destination, 'README.md'), 'saved checkout')
    })
    const folder = await prepareProjectFolder(project, { root, clone })
    expect(folder).toBe(join(root, 'repo'))
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('saved checkout')
    expect(await readdir(root)).toEqual(['repo'])
    await expect(prepareProjectFolder(project, { root, clone })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(clone).toHaveBeenCalledTimes(1)
    expect(await readFile(join(folder, 'README.md'), 'utf8')).toBe('saved checkout')
  })

  it('cleans only its private staging on failure and preserves a concurrently created destination', async () => {
    const project = parseProjectFolder({ projectSource: 'remote', repositoryUrl: 'owner/repo' })!
    await expect(prepareProjectFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      throw new ProjectFolderError('CLONE_FAILED', 'Could not clone')
    } })).rejects.toMatchObject({ code: 'CLONE_FAILED' })
    expect(await readdir(root)).toEqual([])
    await expect(prepareProjectFolder(project, { root, clone: async (_, destination) => {
      await mkdir(destination)
      await mkdir(join(root, 'repo'))
      await writeFile(join(root, 'repo', 'draft'), 'keep me')
    } })).rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(await readFile(join(root, 'repo', 'draft'), 'utf8')).toBe('keep me')
    expect(await readdir(root)).toEqual(['repo'])
  })
})
