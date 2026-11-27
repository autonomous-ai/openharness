import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProjectFolder, prepareNewFolder, ProjectFolderError, projectsRoot } from './projectFolder.js'

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
    expect(await prepareNewFolder({ source: 'new' }, { root, label: 'Codex', now })).toBe(join(root, 'codex-2026-09-03-09-05'))
    expect(await prepareNewFolder({ source: 'new' }, { root, label: 'Autonomous Circuit', now })).toBe(join(root, 'autonomous-circuit-2026-09-03-09-05'))
    expect(await prepareNewFolder({ source: 'new' }, { root, label: '  ', now })).toBe(join(root, 'harness-2026-09-03-09-05'))
    expect(await prepareNewFolder({ source: 'new' }, { root, label: '!!', now })).toBe(join(root, 'harness-2026-09-03-09-05-07'))
  })

  it('gives a named new project that folder, slugged again here, and never a changed name', async () => {
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'My Game! v2' })).toEqual({ source: 'new', name: 'My-Game-v2' })
    // A name is a path segment: nothing that climbs or hides survives, and nothing usable is no name.
    expect(parseProjectFolder({ projectSource: 'new', projectName: '../../etc' })).toEqual({ source: 'new', name: 'etc' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: ' .. ' })).toEqual({ source: 'new' })
    expect(parseProjectFolder({ projectSource: 'new', projectName: 7 })).toEqual({ source: 'new' })
    expect(await prepareNewFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now })).toBe(join(root, 'My-Game-v2'))
    // Asking again is refused rather than answered with "My-Game-v2-2": the folder is theirs to pick.
    await expect(prepareNewFolder({ source: 'new', name: 'My-Game-v2' }, { root, label: 'Codex', now }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS' })
    expect(await readdir(root)).toEqual(['My-Game-v2'])
  })

  it('names the folder a typed name found, so an app can offer it, and no folder when what is there is a file', async () => {
    await mkdir(join(root, 'payments'))
    await expect(prepareNewFolder({ source: 'new', name: 'payments' }, { root, label: 'Codex', now }))
      .rejects.toMatchObject({ code: 'PROJECT_EXISTS', folder: join(root, 'payments') })
    await writeFile(join(root, 'notes'), 'a file, not a project')
    const refusal = await prepareNewFolder({ source: 'new', name: 'notes' }, { root, label: 'Codex', now }).catch((error: unknown) => error)
    expect(refusal).toMatchObject({ code: 'PROJECT_EXISTS' })
    expect((refusal as ProjectFolderError).folder).toBeUndefined()
    expect(await readFile(join(root, 'notes'), 'utf8')).toBe('a file, not a project')
  })

  it('numbers a suggested name past a folder that exists, instead of refusing it', async () => {
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'robot-noi-chuyen', projectNameMode: 'suggested' }))
      .toEqual({ source: 'new', name: 'robot-noi-chuyen', suggested: true })
    // Any other mode is an ordinary chosen name.
    expect(parseProjectFolder({ projectSource: 'new', projectName: 'robot', projectNameMode: 'mine' }))
      .toEqual({ source: 'new', name: 'robot' })
    const suggested = { source: 'new', name: 'robot-noi-chuyen', suggested: true } as const
    await writeFile(join(root, 'robot-noi-chuyen-2'), 'a file takes the name too')
    expect(await prepareNewFolder(suggested, { root, label: 'Codex', now })).toBe(join(root, 'robot-noi-chuyen'))
    expect(await prepareNewFolder(suggested, { root, label: 'Codex', now })).toBe(join(root, 'robot-noi-chuyen-3'))
  })

  it('gives two projects in the same minute the seconds, then a suffix, and never takes a file’s name', async () => {
    await writeFile(join(root, 'codex-2026-09-03-09-05'), 'keep')
    const folders = await Promise.all([1, 2, 3].map(() => prepareNewFolder({ source: 'new' }, { root, label: 'Codex', now })))
    expect(new Set(folders)).toEqual(new Set([
      join(root, 'codex-2026-09-03-09-05-07'), join(root, 'codex-2026-09-03-09-05-07-2'), join(root, 'codex-2026-09-03-09-05-07-3'),
    ]))
    expect(await readFile(join(root, 'codex-2026-09-03-09-05'), 'utf8')).toBe('keep')
    expect(await readdir(root)).toHaveLength(4)
  })

  it('uses the clock when no time is given', async () => {
    const folder = await prepareNewFolder({ source: 'new' }, { root, label: 'Pi' })
    expect(folder).toMatch(/\/pi-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}$/)
  })
})

// The OS chooses a familiar project root without changing other hn installations.
it('uses lowercase projects only in the explicit Harness OS environment', () => {
  try {
    vi.stubEnv('HARNESS_OS', '1')
    expect(projectsRoot('/home/me')).toBe('/home/me/projects')
    vi.stubEnv('HARNESS_OS', '')
    expect(projectsRoot('/Users/me')).toBe('/Users/me/harnesses')
  } finally { vi.unstubAllEnvs() }
})
