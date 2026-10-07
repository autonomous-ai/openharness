import { afterEach, describe, expect, it, vi } from 'vitest'
import { listDir } from '../lib/fsBrowse.js'
import { readGitProject } from '../lib/gitProject.js'
import { MediaPreviewError, readMediaPreviewChunk } from '../lib/mediaPreview.js'
import { projectPreview } from '../lib/projectPreview.js'
import type { RegisteredSession } from '../lib/registry.js'
import { readSessionGitPullRequest } from '../lib/sessionGitPullRequest.js'
import { detectScmProject } from '../scm/scmProjects.js'
import { fakeCore } from '../testing/fakeCore.js'
import { PROJECTS_REQUESTS, startProjects } from './projects.js'

vi.mock('../lib/fsBrowse.js', () => ({ listDir: vi.fn(async () => ({ path: '/home/me', entries: [], truncated: false })) }))
vi.mock('../lib/gitProject.js', () => ({ readGitProject: vi.fn(async () => ({ path: '/work/app', branch: 'main' })) }))
vi.mock('../scm/scmProjects.js', () => ({ detectScmProject: vi.fn(async () => ({ kind: 'git', git: { isGit: true } })) }))
vi.mock('../lib/projectPreview.js', () => ({ projectPreview: vi.fn(async () => ({ path: '/work/app', readme: '# app' })) }))
vi.mock('../lib/sessionGitPullRequest.js', () => ({ readSessionGitPullRequest: vi.fn(async () => ({ status: 'found', number: 12 })) }))
vi.mock('../lib/mediaPreview.js', async (importOriginal) => ({
  MediaPreviewError: (await importOriginal<typeof import('../lib/mediaPreview.js')>()).MediaPreviewError,
  readMediaPreviewChunk: vi.fn(async () => ({ mime: 'image/png', data: 'AAAA', done: true })),
}))

const ASKER = { local: false, owner: false }
const row = (agentId: string, cwd: string | null) => ({ agentId, sessionId: `s-${agentId}`, cwd }) as RegisteredSession

function setup() {
  const agents = [row('a1', '/work/app'), row('a2', null)]
  const core = fakeCore({ agents: { live: vi.fn(() => agents), resolve: vi.fn((id: string) => agents.find((agent) => agent.agentId === id || agent.sessionId === id)) } })
  const requests = startProjects(core)
  return { core, ask: (type: string, payload: Record<string, unknown> = {}) => requests[type]!(payload, ASKER), requests }
}

describe('the project and folder readers', () => {
  afterEach(() => { vi.clearAllMocks() })

  it('answer exactly the requests they declare', () => {
    expect(Object.keys(setup().requests).sort()).toEqual([...PROJECTS_REQUESTS].sort())
  })

  it('git_pull_request: an agent\'s branch and pull request, asked by either id, with the context it was shown', async () => {
    const { ask } = setup()
    expect(await ask('git_pull_request', { agentId: 's-a1', history: true, offset: 20 })).toEqual({ status: 'found', number: 12 })
    expect(readSessionGitPullRequest).toHaveBeenLastCalledWith(row('a1', '/work/app'), { expected: undefined, history: true, offset: 20 })
    const context = { cwd: '/work/app', branch: 'feature', remote: null }
    await ask('git_pull_request', { agentId: 'a1', context, offset: 'later' })
    expect(readSessionGitPullRequest).toHaveBeenLastCalledWith(row('a1', '/work/app'), { expected: context, history: false, offset: undefined })
    await ask('git_pull_request', { agentId: 'a1', context: { cwd: '/w', branch: 'b', remote: 'origin' } })
    expect(readSessionGitPullRequest).toHaveBeenCalledTimes(3)
  })

  it('git_pull_request: unavailable for an agent with no folder, a malformed context, or a read that fails', async () => {
    const { ask } = setup()
    for (const payload of [{}, { agentId: 7 }, { agentId: 'nobody' }, { agentId: 'a2' }]) {
      expect(await ask('git_pull_request', payload)).toEqual({ status: 'unavailable' })
    }
    for (const context of [null, 'main', { cwd: 1, branch: 'b', remote: null }, { cwd: '/w', branch: 2, remote: null }, { cwd: '/w', branch: 'b', remote: 3 }]) {
      expect(await ask('git_pull_request', { agentId: 'a1', context })).toEqual({ status: 'unavailable' })
    }
    expect(readSessionGitPullRequest).not.toHaveBeenCalled()
    vi.mocked(readSessionGitPullRequest).mockRejectedValueOnce(new Error('gh missing'))
    expect(await ask('git_pull_request', { agentId: 'a1' })).toEqual({ status: 'unavailable' })
  })

  it('git_project_info and project_preview: read within the home and the folders agents run in', async () => {
    const { ask } = setup()
    expect(await ask('git_project_info', { path: '/work/app', refresh: true })).toEqual({ path: '/work/app', branch: 'main' })
    expect(readGitProject).toHaveBeenLastCalledWith('/work/app', { refresh: true, knownRoots: ['/work/app'] })
    await ask('git_project_info', { path: 9 })
    expect(readGitProject).toHaveBeenLastCalledWith('', { refresh: false, knownRoots: ['/work/app'] })
    expect(await ask('project_preview', { path: '/work/app' })).toEqual({ path: '/work/app', readme: '# app' })
    expect(projectPreview).toHaveBeenLastCalledWith('/work/app', ['/work/app'])
    await ask('project_preview')
    expect(projectPreview).toHaveBeenLastCalledWith('', ['/work/app'])
  })

  it('git_project_info and project_preview: a read that fails is UNAVAILABLE', async () => {
    const { ask } = setup()
    vi.mocked(readGitProject).mockRejectedValueOnce(new Error('git failed'))
    expect(await ask('git_project_info', { path: '/work/app' })).toEqual({ error: 'UNAVAILABLE' })
    vi.mocked(projectPreview).mockRejectedValueOnce(new Error('unreadable'))
    expect(await ask('project_preview', { path: '/work/app' })).toEqual({ error: 'UNAVAILABLE' })
  })

  it('scm_project_info: the same probe through the SCM seam, with the same fence, and `none` when it fails', async () => {
    const { ask } = setup()
    expect(await ask('scm_project_info', { path: '/work/app', refresh: true })).toEqual({ kind: 'git', git: { isGit: true } })
    expect(detectScmProject).toHaveBeenLastCalledWith('/work/app', { refresh: true, knownRoots: ['/work/app'] })
    await ask('scm_project_info', { path: 9 })
    expect(detectScmProject).toHaveBeenLastCalledWith('', { refresh: false, knownRoots: ['/work/app'] })
    vi.mocked(detectScmProject).mockRejectedValueOnce(new Error('probe failed'))
    expect(await ask('scm_project_info', { path: '/work/app' })).toEqual({ kind: 'none', error: 'UNAVAILABLE' })
  })

  it('fs_list_dir: one folder\'s subfolders, or why not', async () => {
    const { ask } = setup()
    expect(await ask('fs_list_dir', { path: '/home/me' })).toEqual({ path: '/home/me', entries: [], truncated: false })
    expect(listDir).toHaveBeenLastCalledWith('/home/me')
    vi.mocked(listDir).mockResolvedValueOnce({ error: 'FORBIDDEN' })
    expect(await ask('fs_list_dir')).toEqual({ error: 'FORBIDDEN' })
    expect(listDir).toHaveBeenLastCalledWith('')
  })

  it('agent_read_file: a media chunk from the agent\'s project, or why not', async () => {
    const { ask } = setup()
    expect(await ask('agent_read_file', { agentId: 'a1', path: 'shot.png', media: true, offset: 0, revision: 'r1' }))
      .toEqual({ mime: 'image/png', data: 'AAAA', done: true })
    expect(readMediaPreviewChunk).toHaveBeenLastCalledWith('/work/app', 'shot.png', 0, 'r1')
    expect(await ask('agent_read_file', { path: 'shot.png', media: true })).toEqual({ error: 'MISSING_AGENT_OR_PATH' })
    expect(await ask('agent_read_file', { agentId: 'a1', media: true })).toEqual({ error: 'MISSING_AGENT_OR_PATH' })
    expect(await ask('agent_read_file', { agentId: 'a1', path: 'notes.md' })).toEqual({ error: 'UNSUPPORTED', detail: 'agent_read_file serves media previews only' })
    expect(await ask('agent_read_file', { agentId: 'a2', path: 'shot.png', media: true })).toEqual({ error: 'AGENT_NOT_FOUND' })
    vi.mocked(readMediaPreviewChunk).mockRejectedValueOnce(new MediaPreviewError('OUTSIDE_PROJECT'))
    expect(await ask('agent_read_file', { agentId: 'a1', path: '../x.png', media: true })).toEqual({ error: 'OUTSIDE_PROJECT' })
    vi.mocked(readMediaPreviewChunk).mockRejectedValueOnce(new Error('EIO'))
    expect(await ask('agent_read_file', { agentId: 'a1', path: 'shot.png', media: true })).toEqual({ error: 'MEDIA_READ_FAILED' })
  })
})
