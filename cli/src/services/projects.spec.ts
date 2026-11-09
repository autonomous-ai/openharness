import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstructions, readSharedInstructions, writeInstructions } from '../lib/agentInstructions.js'
import { createPullRequestsStatusReader } from '../lib/pullRequestsStatus.js'
import { listDir } from '../lib/fsBrowse.js'
import { readGitProject } from '../lib/gitProject.js'
import { MediaPreviewError, readMediaPreviewChunk } from '../lib/mediaPreview.js'
import { projectPreview } from '../lib/projectPreview.js'
import type { RegisteredSession } from '../lib/registry.js'
import { readSessionGitPullRequest } from '../lib/sessionGitPullRequest.js'
import { detectScmProject } from '../scm/scmProjects.js'
import { fakeCore } from '../testing/fakeCore.js'
import { PROJECTS_REQUESTS, startProjects } from './projects.js'

const readPullRequests = vi.hoisted(() => vi.fn(async (_urls: unknown) => ({ rows: [] })))
vi.mock('../lib/pullRequestsStatus.js', () => ({ createPullRequestsStatusReader: vi.fn(() => readPullRequests) }))
vi.mock('../lib/fsBrowse.js', () => ({ listDir: vi.fn(async () => ({ path: '/home/me', entries: [], truncated: false })) }))
vi.mock('../lib/gitProject.js', () => ({ readGitProject: vi.fn(async () => ({ path: '/work/app', branch: 'main' })) }))
vi.mock('../scm/scmProjects.js', () => ({ detectScmProject: vi.fn(async () => ({ kind: 'git', git: { isGit: true } })) }))
vi.mock('../lib/projectPreview.js', () => ({ projectPreview: vi.fn(async () => ({ path: '/work/app', readme: '# app' })) }))
vi.mock('../lib/sessionGitPullRequest.js', () => ({ readSessionGitPullRequest: vi.fn(async () => ({ status: 'found', number: 12 })) }))
// The instructions file is the real one, on a real folder: only a failure no real disk gives on demand needs a stand-in.
vi.mock('../lib/agentInstructions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agentInstructions.js')>()
  return {
    ...actual, readInstructions: vi.fn(actual.readInstructions), writeInstructions: vi.fn(actual.writeInstructions),
    readSharedInstructions: vi.fn(actual.readSharedInstructions),
  }
})
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
  it('reads linked PRs with the local reader, without an agent or folder', async () => {
    const { requests } = setup()
    const urls = ['https://github.com/o/r/pull/12']
    expect(await requests.git_pull_requests_status!({ urls }, { local: true, owner: true })).toEqual({ rows: [] })
    expect(createPullRequestsStatusReader).toHaveBeenCalled()
    expect(readPullRequests).toHaveBeenLastCalledWith(urls)
    expect(await requests.git_pull_requests_status!({ urls }, { local: false, owner: true, accountOwner: true })).toEqual({ rows: [] })
    for (const asker of [{ local: true, owner: false }, { local: false, owner: true }, { local: false, owner: true, accountOwner: false }]) {
      expect(await requests.git_pull_requests_status!({ urls }, asker)).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(readPullRequests).toHaveBeenCalledTimes(2)
  })

  it('asks core for aggregate work evidence, and falls back to unknown', async () => {
    const { core, ask } = setup()
    await ask('git_pull_request', { agentId: 'a1' })
    const options = vi.mocked(readSessionGitPullRequest).mock.calls.at(-1)![1]!
    expect(await options.usage!()).toBeNull()
    core.usage = async () => ({ totalTokens: 1, updatedAt: '2026-10-01T00:00:00Z' })
    expect(await options.usage!()).toMatchObject({ totalTokens: 1 })
  })
  afterEach(() => { vi.clearAllMocks() })

  it('answer exactly the requests they declare', () => {
    expect(Object.keys(setup().requests).sort()).toEqual([...PROJECTS_REQUESTS].sort())
  })

  it('git_pull_request: an agent\'s branch and pull request, asked by either id, with the context it was shown', async () => {
    const { ask } = setup()
    expect(await ask('git_pull_request', { agentId: 's-a1', history: true, offset: 20 })).toEqual({ status: 'found', number: 12 })
    expect(readSessionGitPullRequest).toHaveBeenLastCalledWith(row('a1', '/work/app'), { usage: expect.any(Function), expected: undefined, history: true, offset: 20 })
    const context = { cwd: '/work/app', branch: 'feature', remote: null }
    await ask('git_pull_request', { agentId: 'a1', context, offset: 'later' })
    expect(readSessionGitPullRequest).toHaveBeenLastCalledWith(row('a1', '/work/app'), { usage: expect.any(Function), expected: context, history: false, offset: undefined })
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

// An agent's instructions file lives in the agent's own folder, on the computer the agent runs on. The owner's other
// computers read and save it there, so it goes through neither GitHub nor our servers (lib/agentInstructions.ts).
describe('an agent\'s instructions file', () => {
  const LOCAL_OWNER = { local: true, owner: true }
  const OWN_COMPUTER = { local: false, owner: true, accountOwner: true, machine: { machineId: 'mac-1', label: 'Mac 1' } }
  const TYPES = ['agent_instructions_read', 'agent_instructions_write'] as const
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
  const folders: string[] = []
  afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })

  async function project() {
    const cwd = await mkdtemp(join(tmpdir(), 'harness-projects-instructions-'))
    folders.push(cwd)
    const resolve = vi.fn((id: string) => id === 'a1' ? row('a1', cwd) : id === 'a2' ? row('a2', null) : id === 'gone' ? row('gone', join(cwd, 'moved-away'))
      : id === 'loop' ? row('loop', join(cwd, 'loop')) : undefined)
    const requests = startProjects(fakeCore({ agents: { resolve } }))
    const ask = (type: string, payload: Record<string, unknown>, asker: Record<string, unknown> = LOCAL_OWNER) => requests[type]!(payload, asker as never)
    return { cwd, resolve, ask, file: join(cwd, 'agents', 'Faye.md') }
  }

  it('is declared with the project readers, which the core routes from that list', () => {
    expect(PROJECTS_REQUESTS).toEqual(expect.arrayContaining([...TYPES]))
  })

  it('reads the file with its version, and says there is none, for the account\'s own computers and this one', async () => {
    const { ask, file, cwd } = await project()
    for (const asker of [LOCAL_OWNER, OWN_COMPUTER]) {
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }, asker)).toEqual({ text: null, version: '' })
    }
    await mkdir(join(cwd, 'agents'))
    await writeFile(file, 'Be brief.\n')
    for (const asker of [LOCAL_OWNER, OWN_COMPUTER]) {
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }, asker)).toEqual({ text: 'Be brief.\n', version: sha256('Be brief.\n') })
    }
  })

  // What instructs most agents is the project's AGENTS.md and CLAUDE.md in its folder, whether or not the agent has a file of
  // its own here (a Product Manager in a repository that has no agents folder at all). The read shows them beside its own, as
  // a read-only extra, and says which of them is there and not shown, and why: a reader that predates it never looks at the
  // fields, and a save never touches them.
  describe('the files that instruct it besides, AGENTS.md and CLAUDE.md in its folder', () => {
    // Each file comes with where it is, from the agent's folder, and with the engines that load it.
    const both = [
      { name: 'AGENTS.md', path: 'AGENTS.md', loadedBy: ['codex'], text: 'Agent rules\n', truncated: false },
      { name: 'CLAUDE.md', path: 'CLAUDE.md', loadedBy: ['claude'], text: 'Claude rules\n', truncated: false },
    ]
    const agentsIs = (why: string) => ({ name: 'AGENTS.md', path: 'AGENTS.md', loadedBy: ['codex'], why })

    it('are shown, read only, for an agent with no file of its own, and beside one that has it', async () => {
      const { ask, file, cwd } = await project()
      await writeFile(join(cwd, 'AGENTS.md'), 'Agent rules\n')
      await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      for (const asker of [LOCAL_OWNER, OWN_COMPUTER]) {
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }, asker)).toEqual({ text: null, version: '', shared: both })
      }
      await mkdir(join(cwd, 'agents'))
      await writeFile(file, 'Be brief.\n')
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ text: 'Be brief.\n', version: sha256('Be brief.\n'), shared: both })
    })

    it('are left out of the answer altogether when there are none, as an answer from a daemon that predates them reads', async () => {
      const { ask, cwd } = await project()
      const none = await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
      expect(none).toEqual({ text: null, version: '' })
      expect(none).not.toHaveProperty('shared')
      expect(none).not.toHaveProperty('skipped')
      await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ text: null, version: '', shared: [both[1]] })
    })

    it('are never written: a save answers as before and leaves both as they were', async () => {
      const { ask, cwd } = await project()
      await writeFile(join(cwd, 'AGENTS.md'), 'Agent rules\n')
      await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      const saved = await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'mine', version: '' })
      expect(saved).toEqual({ version: sha256('mine') })
      expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'AGENTS', text: 'not that file', version: '' })).toEqual({ version: sha256('not that file') })
      expect(await readFile(join(cwd, 'AGENTS.md'), 'utf8')).toBe('Agent rules\n')
      expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('Claude rules\n')
      expect(await readFile(join(cwd, 'agents', 'AGENTS.md'), 'utf8')).toBe('not that file')
    })

    it('never fail the read: one that is not text is left out, said to be so, and logged by that name, never what it held', async () => {
      const { ask, cwd } = await project()
      await writeFile(join(cwd, 'AGENTS.md'), Buffer.from([0x66, 0xff, 0xfe, 0x66]))
      await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({
          text: null, version: '', shared: [both[1]], skipped: [agentsIs('not_text')],
        })
        expect(log.mock.calls.map((call) => call.join(' '))).toEqual(['[projects] agent_instructions_read left out AGENTS.md · NOT_UTF8'])
      } finally { log.mockRestore() }
    })

    it('say what a file that is not a plain file is, and log nothing: a link or a folder is as the person made it', async () => {
      const { ask, cwd } = await project()
      await mkdir(join(cwd, 'AGENTS.md'))
      await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({
          text: null, version: '', shared: [both[1]], skipped: [agentsIs('not_a_file')],
        })
        if (process.platform !== 'win32') {
          await rm(join(cwd, 'AGENTS.md'), { recursive: true })
          await symlink('nowhere.md', join(cwd, 'AGENTS.md'))
          expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({
            text: null, version: '', shared: [both[1]], skipped: [agentsIs('link')],
          })
          // And a link that stays inside the project is followed: both are shown, with the one text.
          await rm(join(cwd, 'AGENTS.md'))
          await symlink('CLAUDE.md', join(cwd, 'AGENTS.md'))
          expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({
            text: null, version: '', shared: [{ ...both[0], text: 'Claude rules\n' }, both[1]],
          })
        }
        expect(log).not.toHaveBeenCalled()
      } finally { log.mockRestore() }
    })

    it('that the disk fails on are left out too, and logged by file name and code, never where or what', async () => {
      const { ask } = await project()
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        vi.mocked(readSharedInstructions).mockResolvedValueOnce({
          shared: [],
          skipped: [
            { ...agentsIs('unreadable'), error: Object.assign(new Error('/Users/me/secret-project/AGENTS.md: input/output error'), { code: 'EIO' }) },
            { name: 'CLAUDE.md', path: '../CLAUDE.md', loadedBy: ['claude'], why: 'unreadable', error: new Error('no code on this one') },
            { ...agentsIs('unreadable'), error: undefined },
          ],
        })
        const answer = await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
        // The answer says that they are unreadable, and not what went wrong: that is for the log.
        expect(answer).toEqual({
          text: null, version: '',
          skipped: [agentsIs('unreadable'), { name: 'CLAUDE.md', path: '../CLAUDE.md', loadedBy: ['claude'], why: 'unreadable' }, agentsIs('unreadable')],
        })
        expect(log.mock.calls.map((call) => call.join(' '))).toEqual([
          '[projects] agent_instructions_read left out AGENTS.md · EIO',
          '[projects] agent_instructions_read left out ../CLAUDE.md · unknown',
          '[projects] agent_instructions_read left out AGENTS.md · unknown',
        ])
      } finally { log.mockRestore() }
    })

    // The caps are per file, and one read carries 256 KiB of these files in all, however many there are and however long: and the
    // agent's own file besides, at most 64 KiB.
    it('never make a read carry more than 256 KiB of them, and the agent\'s own file besides', async () => {
      const { ask, cwd, file } = await project()
      await mkdir(join(cwd, 'agents'))
      await mkdir(join(cwd, '.claude'))
      await writeFile(file, 'o'.repeat(65_536))
      await writeFile(join(cwd, 'AGENTS.md'), 'a'.repeat(100_000))
      for (const name of ['CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) await writeFile(join(cwd, name), 'c'.repeat(1_000_000))
      const answer = await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }) as {
        text: string; shared: Array<{ path: string; text: string; truncated: boolean }>; skipped: Array<{ path: string; why: string }>
      }
      expect(answer.text).toHaveLength(65_536)
      expect(answer.shared.map((one) => [one.path, one.text.length, one.truncated])).toEqual([
        ['AGENTS.md', 65_536, true], ['CLAUDE.md', 65_536, true], ['AGENTS.override.md', 65_536, true], ['CLAUDE.local.md', 65_536, true],
      ])
      expect(answer.skipped).toEqual([{ name: 'CLAUDE.md', path: '.claude/CLAUDE.md', loadedBy: ['claude'], why: 'too_much' }])
    })

    // The agent's own file failing must not hide the project's: a name the file cannot have, a file over the limit, not text, an
    // `agents` that is a link, a disk that fails. The error is the answer, as it was, and the two fields come beside it.
    describe('come beside an error of the agent\'s own file', () => {
      const set = async (cwd: string) => {
        await mkdir(join(cwd, 'AGENTS.md'))
        await writeFile(join(cwd, 'CLAUDE.md'), 'Claude rules\n')
      }
      const beside = { shared: [both[1]], skipped: [agentsIs('not_a_file')] }

      it('a name the file cannot have', async () => {
        const { ask, cwd } = await project()
        await set(cwd)
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: '../Faye' })).toEqual({ error: 'BAD_NAME', ...beside })
      })

      it('a file over the limit', async () => {
        const { ask, cwd } = await project()
        await set(cwd)
        await mkdir(join(cwd, 'agents'))
        await writeFile(join(cwd, 'agents', 'Faye.md'), Buffer.alloc(65_537, 97))
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'TOO_LARGE', ...beside })
      })

      it('a file that is not text, which is logged as it was', async () => {
        const { ask, cwd, file } = await project()
        await set(cwd)
        await mkdir(join(cwd, 'agents'))
        await writeFile(file, Buffer.from([0x66, 0xff, 0xfe, 0x66]))
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'NOT_UTF8', ...beside })
          expect(log.mock.calls.map((call) => call.join(' '))).toEqual(['[projects] agent_instructions_read failed · NOT_UTF8'])
        } finally { log.mockRestore() }
      })

      it.skipIf(process.platform === 'win32')('an agents folder that is a link', async () => {
        const { ask, cwd } = await project()
        await set(cwd)
        await mkdir(join(cwd, 'elsewhere'))
        await symlink(join(cwd, 'elsewhere'), join(cwd, 'agents'))
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'UNSAFE_PATH', ...beside })
      })

      it('a disk that fails, which is logged as it was', async () => {
        const { ask, cwd } = await project()
        await set(cwd)
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          vi.mocked(readInstructions).mockRejectedValueOnce(Object.assign(new Error('/Users/me/secret-project/agents/Faye.md went wrong'), { code: 'EIO' }))
          expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'READ_FAILED', ...beside })
          expect(log.mock.calls.map((call) => call.join(' '))).toEqual(['[projects] agent_instructions_read failed · EIO'])
        } finally { log.mockRestore() }
      })

      it('and not beside a refusal that came before the folder was known, nor an error of a save', async () => {
        const { ask, cwd } = await project()
        await set(cwd)
        vi.mocked(readSharedInstructions).mockClear()
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: '' })).toEqual({ error: 'MISSING_AGENT_OR_NAME' })
        expect(await ask('agent_instructions_read', { agentId: 'nobody', name: 'Faye' })).toEqual({ error: 'AGENT_NOT_FOUND' })
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }, { local: false, owner: true })).toEqual({ error: 'OWNER_REQUIRED' })
        for (const payload of [{ name: '../Faye', text: 'x', version: '' }, { name: 'Faye', text: 'x', version: 'not the version' }, { name: 'Faye', text: 5, version: '' }]) {
          const answer = await ask('agent_instructions_write', { agentId: 'a1', ...payload })
          expect(Object.keys(answer), JSON.stringify(payload)).toEqual(['error'])
        }
        expect(readSharedInstructions).not.toHaveBeenCalled()
      })
    })

    it('are shown to nobody but the account\'s own computers: a collaborator is refused before anything is read', async () => {
      const { ask, cwd } = await project()
      await writeFile(join(cwd, 'AGENTS.md'), 'SECRET agent rules')
      vi.mocked(readSharedInstructions).mockClear()
      for (const asker of [{ local: false, owner: true }, { local: false, owner: false, guest: 'kim@acme.io' }]) {
        expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' }, asker)).toEqual({ error: 'OWNER_REQUIRED' })
      }
      expect(readSharedInstructions).not.toHaveBeenCalled()
    })
  })

  it('saves it when the writer saw the file as it is, and refuses a save over a change it did not see', async () => {
    const { ask, file } = await project()
    const first = await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'one', version: '' }, OWN_COMPUTER)
    expect(first).toEqual({ version: sha256('one') })
    expect(await readFile(file, 'utf8')).toBe('one')
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'two', version: '' }, OWN_COMPUTER)).toEqual({ error: 'CHANGED' })
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'two', version: first.version }, OWN_COMPUTER)).toEqual({ version: sha256('two') })
    expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ text: 'two', version: sha256('two') })
  })

  it('finds the agent as agent_read_file does', async () => {
    const { ask, resolve } = await project()
    await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })
    expect(resolve).toHaveBeenLastCalledWith('a1')
  })

  it.each([
    ['a window or tool here that may not control this computer', { local: true, owner: false }],
    ['a trusted collaborator', { local: false, owner: true }],
    ['a collaborator the host account does not vouch for', { local: false, owner: true, accountOwner: false }],
    ['a guest of a shared computer', { local: false, owner: false, guest: 'kim@acme.io' }],
    ['a device or an observer', { local: false, owner: false, accountOwner: false }],
  ])('refuses %s before it looks at the request, and reads and writes nothing', async (_who, asker) => {
    const { ask, resolve, cwd } = await project()
    await mkdir(join(cwd, 'agents'))
    await writeFile(join(cwd, 'agents', 'Faye.md'), 'private')
    for (const [type, payload] of [
      ['agent_instructions_read', { agentId: 'a1', name: 'Faye' }],
      ['agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'planted', version: sha256('private') }],
      ['agent_instructions_read', {}], ['agent_instructions_write', { agentId: 'nobody', name: '../x' }],
    ] as const) {
      expect(await ask(type, payload, asker), type).toEqual({ error: 'OWNER_REQUIRED' })
    }
    expect(resolve).not.toHaveBeenCalled()
    expect(await readFile(join(cwd, 'agents', 'Faye.md'), 'utf8')).toBe('private')
  })

  it.each(TYPES)('%s: asks for an agent and a name', async (type) => {
    const { ask } = await project()
    for (const payload of [{}, { name: 'Faye' }, { agentId: 'a1' }, { agentId: 'a1', name: '' }, { agentId: '', name: 'Faye' }, { agentId: 7, name: 'Faye' }, { agentId: 'a1', name: 7 }]) {
      expect(await ask(type, { text: 'x', version: '', ...payload }), JSON.stringify(payload)).toEqual({ error: 'MISSING_AGENT_OR_NAME' })
    }
  })

  it.each(TYPES)('%s: no such agent, or an agent with no folder, is AGENT_NOT_FOUND', async (type) => {
    const { ask } = await project()
    for (const agentId of ['nobody', 'a2']) {
      expect(await ask(type, { agentId, name: 'Faye', text: 'x', version: '' }), agentId).toEqual({ error: 'AGENT_NOT_FOUND' })
    }
  })

  it('names what is wrong with a name, a text, a size and a path, in the codes the apps read', async () => {
    const { ask, cwd } = await project()
    expect(await ask('agent_instructions_read', { agentId: 'a1', name: '../Faye' })).toEqual({ error: 'BAD_NAME' })
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: '   ', text: 'x', version: '' })).toEqual({ error: 'BAD_NAME' })
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 5, version: '' })).toEqual({ error: 'BAD_TEXT' })
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'a'.repeat(65_537), version: '' })).toEqual({ error: 'TOO_LARGE' })
    await mkdir(join(cwd, 'agents'))
    await writeFile(join(cwd, 'agents', 'Faye.md'), Buffer.alloc(65_537, 97))
    expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'TOO_LARGE' })
    await rm(join(cwd, 'agents'), { recursive: true })
    await mkdir(join(cwd, 'elsewhere'))
    if (process.platform === 'win32') return
    await symlink(join(cwd, 'elsewhere'), join(cwd, 'agents'))
    expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'UNSAFE_PATH' })
    expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'x', version: '' })).toEqual({ error: 'UNSAFE_PATH' })
  })

  // A file that is not text is not a failure of the disk: it is named, so the app can say what is wrong, and logged by that
  // name, so nobody has to guess at a bare error.
  it('says NOT_UTF8 for a file that is not text, whether it is read or saved over, and logs that name and nothing else', async () => {
    const { ask, cwd, file } = await project()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mkdir(join(cwd, 'agents'))
      const bytes = Buffer.from([0x66, 0xff, 0xfe, 0x66])
      await writeFile(file, bytes)
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'NOT_UTF8' })
      expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'my private words', version: createHash('sha256').update(bytes).digest('hex') })).toEqual({ error: 'NOT_UTF8' })
      expect(await readFile(file)).toEqual(bytes)
      expect(log.mock.calls.map((call) => call.join(' '))).toEqual([
        '[projects] agent_instructions_read failed · NOT_UTF8',
        '[projects] agent_instructions_write failed · NOT_UTF8',
      ])
    } finally { log.mockRestore() }
  })

  it('says WRITE_FAILED when the disk will not save, and logs its code, never where or what', async () => {
    const { ask, cwd } = await project()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ask('agent_instructions_write', { agentId: 'gone', name: 'Faye', text: 'my private words', version: '' })).toEqual({ error: 'WRITE_FAILED' })
      await expect(stat(join(cwd, 'moved-away'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(log.mock.calls.map((call) => call.join(' '))).toEqual(['[projects] agent_instructions_write failed · ENOENT'])
    } finally { log.mockRestore() }
  })

  // The same folder the disk cannot look at is where the project's files would be: none can be read, which the answer says beside
  // the error, and the log says by file and code.
  it.skipIf(process.platform === 'win32')('says READ_FAILED when the disk cannot look, and logs its code, never where', async () => {
    const { ask, cwd } = await project()
    await symlink('loop', join(cwd, 'loop'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await ask('agent_instructions_read', { agentId: 'loop', name: 'Faye' })).toEqual({
        error: 'READ_FAILED',
        skipped: ['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'].map((path) => ({
          name: path.split('/').pop(), path, loadedBy: path.includes('AGENTS') ? ['codex'] : ['claude'], why: 'unreadable',
        })),
      })
      expect(log.mock.calls.map((call) => call.join(' '))).toEqual([
        ...['AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.claude/CLAUDE.md'].map((path) => `[projects] agent_instructions_read left out ${path} · ELOOP`),
        '[projects] agent_instructions_read failed · ELOOP',
      ])
    } finally { log.mockRestore() }
  })

  it('logs a failure with no code as unknown, and never what the error said', async () => {
    const { ask } = await project()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      vi.mocked(readInstructions).mockRejectedValueOnce(new Error('/Users/me/secret-project/agents/Faye.md went wrong'))
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'READ_FAILED' })
      vi.mocked(writeInstructions).mockRejectedValueOnce(new Error('disk'))
      expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'x', version: '' })).toEqual({ error: 'WRITE_FAILED' })
      // A rejection with nothing in it is still a failure with a name, not a second failure in the handler that reports it.
      vi.mocked(readInstructions).mockRejectedValueOnce(undefined)
      expect(await ask('agent_instructions_read', { agentId: 'a1', name: 'Faye' })).toEqual({ error: 'READ_FAILED' })
      vi.mocked(writeInstructions).mockRejectedValueOnce(null)
      expect(await ask('agent_instructions_write', { agentId: 'a1', name: 'Faye', text: 'x', version: '' })).toEqual({ error: 'WRITE_FAILED' })
      expect(log.mock.calls.map((call) => call.join(' '))).toEqual([
        '[projects] agent_instructions_read failed · unknown',
        '[projects] agent_instructions_write failed · unknown',
        '[projects] agent_instructions_read failed · unknown',
        '[projects] agent_instructions_write failed · unknown',
      ])
    } finally { log.mockRestore() }
  })
})
