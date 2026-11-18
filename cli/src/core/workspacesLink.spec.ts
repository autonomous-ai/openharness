import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitProjectFolder } from '../lib/projectFolder.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { WorktreeReview } from '../lib/worktreeDeletion.js'
import { fakeCore } from '../testing/fakeCore.js'
import { WORKSPACES_OFF } from './api.js'
import { createWorkspacesLink, PREPARE_FOLDER_MS, WORKTREE_REMOVE_MS, WORKTREE_REVIEW_MS, PREPARE_INSTRUCTIONS_MS, prepareWorkspaceInstructions } from './workspacesLink.js'

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/h/worktrees/repo/${agentId}`, title: 'Fix the login page', ...over }) as RegisteredSession

const worktree: GitProjectFolder = { source: 'worktree', gitSource: '/h/code/repo', branchRef: 'refs/heads/main' }
const target = { cwd: '/h/harnesses/worktrees/repo/brave-otter', transcriptPath: null }
const review: WorktreeReview = { path: '/h/harnesses/worktrees/repo/brave-otter', main: '/h/code/repo', branch: 'brave-otter', head: 'abc123',
  bytes: 4096, dirty: true, changes: [' M src/app.ts'], signature: 'sig-1', dev: 16777220, ino: 4242 }

function setup(connected = true) {
  const live = [agent('a1'), agent('a2')]
  const stopped = agent('old', { active: false })
  const core = fakeCore({
    agents: {
      live: vi.fn(() => live),
      all: vi.fn(async () => [...live, stopped]),
      byAgent: vi.fn((agentId: string) => live.find((session) => session.agentId === agentId)),
    },
  })
  const notify = vi.fn(() => connected)
  const call = vi.fn(async (_type: string, _payload: Record<string, unknown>, _waitMs: number): Promise<Record<string, unknown>> => ({}))
  const link = createWorkspacesLink(core, notify, call)
  return { core, notify, call, link, port: link.port, live, stopped }
}

/** A link whose process said it makes folders, answering [answer] to the next ask. */
function asking(answer: Record<string, unknown>) {
  const s = setup()
  s.link.answer('folders', {})
  s.call.mockResolvedValue(answer)
  return s
}

describe('workspaces in their own process, as the core tells them', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tells the process to name branches with the live agents on each pass, and holds nothing it misses', () => {
    const { notify, port, live } = setup(false)
    port.nameBranches()
    // Not held: the next title pass says it again, with the agents as they are then.
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'nameBranches', agents: live } }]])
  })

  // #4166: the daemon swept clean, week-idle worktrees twice a day, the ones their person chose to keep too. The core
  // neither asks the process to sweep nor lists every folder in use for one.
  it('never tells the process to sweep, and lists no folders for one', () => {
    const { link, port, core } = setup()
    expect(Object.keys(port)).toEqual(['stop', 'nameBranches', 'ready', 'prepareInstructions', 'prepareFolder', 'describeWorkspace', 'reviewWorktree', 'removeWorktree'])
    port.stop()
    expect(link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(core.agents.all).not.toHaveBeenCalled()
  })

  it('sends a renamed agent\'s frame again, read fresh', () => {
    const { link, core, live } = setup()
    expect(link.answer('branchNamed', { agentId: 'a2', requestId: 'q1', query: 'branchNamed' })).toEqual({ synced: true })
    expect(core.agents.sync).toHaveBeenCalledWith(live[1])
  })

  it('has no frame to send for an agent that is gone, or one it cannot name; one with no folder is only sent again', () => {
    const { link, core, live } = setup()
    expect(link.answer('branchNamed', { agentId: 'gone' })).toEqual({ synced: false })
    expect(link.answer('branchNamed', { agentId: 7 })).toEqual({ synced: false })
    expect(core.agents.sync).not.toHaveBeenCalled()
    live[0].cwd = undefined as never
    expect(link.answer('branchNamed', { agentId: 'a1' })).toEqual({ synced: true })
    expect(core.agents.sync).toHaveBeenCalledWith(live[0])
  })

  it('refuses a question it does not know', () => {
    expect(setup().link.answer('context', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})

describe('the git workspaces do for the core', () => {
  afterEach(() => vi.restoreAllMocks())

  // A process from before this build never answers these: asked, it would hold a create for the whole backstop.
  it('asks a process nothing of git until it says it makes folders, and not again once it goes until it says so again', async () => {
    const { link, port, call } = setup()
    expect(port.ready()).toBe(false)
    expect(await port.prepareFolder(worktree, { cloneFallback: true })).toEqual(await WORKSPACES_OFF.prepareFolder(worktree, { cloneFallback: true }))
    expect(await port.describeWorkspace(target, [])).toBeNull()
    expect(await port.reviewWorktree(target, [])).toEqual(await WORKSPACES_OFF.reviewWorktree(target, []))
    expect(await port.removeWorktree(review, target, [], false)).toEqual(await WORKSPACES_OFF.removeWorktree(review, target, [], false))
    expect(call).not.toHaveBeenCalled()
    expect(link.answer('folders', { requestId: 'q1' })).toEqual({ ok: true })
    expect(port.ready()).toBe(true)
    link.disconnected()
    expect(port.ready()).toBe(false)
    await port.prepareFolder(worktree, { cloneFallback: true })
    expect(call).not.toHaveBeenCalled()
  })

  it('asks for a create\'s folder under the backstop and takes the folder, what its relaunch needs and the alias it got in by', async () => {
    const cwd = '/h/harnesses/worktrees/repo/brave-otter'
    const { port, call } = asking({ cwd, scmLaunchRecord: { kind: 'git' }, clonedVia: { alias: 'gh-work' } })
    expect(await port.prepareFolder(worktree, { cloneFallback: true })).toEqual({ ok: true, cwd, scmLaunchRecord: { kind: 'git' }, clonedVia: { alias: 'gh-work' } })
    expect(call).toHaveBeenCalledWith('prepareFolder', { project: worktree, cloneFallback: true }, PREPARE_FOLDER_MS)
    // What the core cannot read of it is left out, never passed on.
    call.mockResolvedValue({ cwd, scmLaunchRecord: { kind: 'svn' }, clonedVia: { alias: 'gh work; rm -rf ~' } })
    expect(await port.prepareFolder(worktree, { cloneFallback: false })).toEqual({ ok: true, cwd })
    call.mockResolvedValue({ cwd, clonedVia: { alias: 7 } })
    expect(await port.prepareFolder(worktree, { cloneFallback: false })).toEqual({ ok: true, cwd })
  })

  it('takes a create\'s refusal in its own code and words, and says a folder may yet appear when its ask went unanswered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refusal = { error: 'CLONE_FAILED', detail: 'Could not access this repository.', access: 'denied' }
    expect(await asking(refusal).port.prepareFolder(worktree, { cloneFallback: true })).toEqual({ ok: false, ...refusal })
    expect(await asking({ error: 'PROJECT_EXISTS', access: 'granted' }).port.prepareFolder(worktree, { cloneFallback: true }))
      .toEqual({ ok: false, error: 'PROJECT_EXISTS', detail: 'Could not prepare the project folder.' })
    expect(await asking({ error: 'CLONE_FAILED', detail: 'x'.repeat(2001) }).port.prepareFolder(worktree, { cloneFallback: true }))
      .toEqual({ ok: false, error: 'CLONE_FAILED', detail: 'Could not prepare the project folder.' })
    // Asked, and no answer in time: the process may have made some of it before it went.
    const unanswered = { ok: false, error: 'SERVICE_UNAVAILABLE',
      detail: 'Could not make the project folder: Harness\'s workspaces service did not answer. A folder it began may still appear in your projects.' }
    expect(await asking({ error: 'SERVICE_UNAVAILABLE', service: 'workspaces', retryable: true }).port.prepareFolder(worktree, { cloneFallback: true })).toEqual(unanswered)
    expect(warn).not.toHaveBeenCalled()
    // An answer the core cannot read is taken as one that did not come, and said.
    for (const answer of [{}, { cwd: 'harnesses/repo' }, { cwd: '/h/a\nb' }, { cwd: `/${'a'.repeat(4096)}` }, { error: 'not a code' }, { error: 7 }]) {
      expect(await asking(answer).port.prepareFolder(worktree, { cloneFallback: true })).toEqual(unanswered)
    }
    expect(warn).toHaveBeenCalledTimes(6)
    expect(warn).toHaveBeenCalledWith('[workspaces] prepareFolder: an answer the core cannot read, taken as not answered')
  })

  it('reads where a harness works, for Inspect, only in the shape Inspect shows', async () => {
    const workspace = { kind: 'worktree', path: target.cwd, worktreePath: target.cwd, mainPath: '/h/code/repo', canDelete: true, reason: 'Selecting Worktree data removes it.' }
    const { port, call } = asking({ workspace })
    expect(await port.describeWorkspace(target, ['/h/code/other'])).toEqual(workspace)
    expect(call).toHaveBeenCalledWith('describeWorkspace', { target, others: ['/h/code/other'] }, WORKTREE_REVIEW_MS)
    const none = { kind: 'unavailable', path: null, canDelete: false, reason: 'No working folder' }
    expect(await asking({ workspace: none }).port.describeWorkspace(target, [])).toEqual(none)
    expect(await asking({ error: 'SERVICE_UNAVAILABLE' }).port.describeWorkspace(target, [])).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [null, 'worktree', { ...workspace, kind: 'cloud' }, { ...workspace, path: 'repo' }, { ...workspace, canDelete: 'yes' },
      { ...workspace, reason: '' }, { ...workspace, worktreePath: 'repo' }, { ...workspace, mainPath: 'repo' }]) {
      expect(await asking({ workspace: bad }).port.describeWorkspace(target, [])).toBeNull()
    }
    expect(warn).toHaveBeenCalledTimes(8)
  })

  it('keeps a worktree\'s review only in the shape its removal is held to, and its refusal in its words', async () => {
    const { port, call } = asking({ ok: true, review })
    const answered = await port.reviewWorktree(target, ['/h/code/other'])
    expect(answered).toEqual({ ok: true, review })
    expect(call).toHaveBeenCalledWith('reviewWorktree', { target, others: ['/h/code/other'] }, WORKTREE_REVIEW_MS)
    const plain = { ...review, branch: null, bytes: null, dirty: false, changes: [] }
    expect(await asking({ ok: true, review: plain }).port.reviewWorktree(target, [])).toEqual({ ok: true, review: plain })
    // Windows' file ids pass 2^53: held roughly, but alike each time the same file is read.
    const ntfs = { ...review, dev: 2_966_473_045, ino: 2.8e16 }
    expect(await asking({ ok: true, review: ntfs }).port.reviewWorktree(target, [])).toEqual({ ok: true, review: ntfs })
    const reason = 'Another harness uses this worktree or an overlapping folder. Its files must be kept.'
    expect(await asking({ ok: false, reason }).port.reviewWorktree(target, [])).toEqual({ ok: false, reason })
    const unanswered = await WORKSPACES_OFF.reviewWorktree(target, [])
    expect(unanswered).toEqual({ ok: false, reason: expect.stringContaining('did not answer') })
    expect(await asking({ error: 'SERVICE_UNAVAILABLE' }).port.reviewWorktree(target, [])).toEqual(unanswered)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [{ ok: false }, { ok: true }, { ok: true, review: 'r' }, { ok: true, review: { ...review, path: 'w' } },
      { ok: true, review: { ...review, main: 'm' } }, { ok: true, review: { ...review, branch: '' } }, { ok: true, review: { ...review, head: '' } },
      { ok: true, review: { ...review, bytes: 1.5 } }, { ok: true, review: { ...review, dirty: 'no' } }, { ok: true, review: { ...review, changes: 'a' } },
      { ok: true, review: { ...review, changes: Array(13).fill('a') } }, { ok: true, review: { ...review, changes: [7] } },
      { ok: true, review: { ...review, signature: '' } }, { ok: true, review: { ...review, dev: '1' } }, { ok: true, review: { ...review, ino: -0.5 } },
      { ok: true, review: { ...review, ino: Infinity } }]) {
      expect(await asking(bad).port.reviewWorktree(target, [])).toEqual(unanswered)
    }
    expect(warn).toHaveBeenCalledTimes(16)
  })

  it('removes a reviewed worktree as the process says, kept when it was never asked, and unknown when it did not answer', async () => {
    const { port, call } = asking({ ok: true })
    expect(await port.removeWorktree(review, target, ['/h/code/other'], true)).toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith('removeWorktree', { review, target, others: ['/h/code/other'], discardChanges: true }, WORKTREE_REMOVE_MS)
    const reason = 'Confirm discarding the listed uncommitted files before deleting this worktree.'
    expect(await asking({ ok: false, reason }).port.removeWorktree(review, target, [], false)).toEqual({ ok: false, reason })
    // Never asked (above, before it said it makes folders): kept. Asked and not answered: it may have gone.
    const unknown = { ok: false, reason: 'Harness could not tell whether the worktree was deleted: its workspaces service did not answer. Review this harness again.' }
    expect(await asking({ error: 'SERVICE_UNAVAILABLE' }).port.removeWorktree(review, target, [], false)).toEqual(unknown)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const bad of [{ ok: false }, { ok: 'yes' }]) {
      expect(await asking(bad).port.removeWorktree(review, target, [], false)).toEqual(unknown)
    }
    expect(warn).toHaveBeenCalledWith('[workspaces] removeWorktree: an answer the core cannot read, taken as not answered')
  })
})


describe('optional workspace instructions', () => {
  afterEach(() => vi.restoreAllMocks())
  it('asks only a process that advertises instructions and forgets the capability on disconnect', async () => {
    const { port, link, call } = setup()
    expect(await port.prepareInstructions('/work', 'claude')).toBe(false)
    link.answer('folders', {})
    expect(await port.prepareInstructions('/work', 'claude')).toBe(false)
    expect(call).not.toHaveBeenCalled()
    link.answer('folders', { instructions: true })
    for (const [workspace, engine] of [['relative', 'claude'], ['/work', ''], ['/work', 'x'.repeat(65)]]) expect(await port.prepareInstructions(workspace, engine)).toBe(false)
    expect(call).not.toHaveBeenCalled()
    call.mockResolvedValue({ prepared: true })
    expect(await port.prepareInstructions('/work', 'claude')).toBe(true)
    expect(call).toHaveBeenCalledExactlyOnceWith('prepareInstructions', { workspace: '/work', engine: 'claude' }, PREPARE_INSTRUCTIONS_MS)
    for (const answer of [{}, { prepared: 'yes' }, { error: 'SERVICE_UNAVAILABLE' }, { prepared: false }]) {
      call.mockResolvedValue(answer)
      expect(await port.prepareInstructions('/work', 'claude')).toBe(false)
    }
    link.disconnected()
    call.mockClear()
    expect(await port.prepareInstructions('/work', 'claude')).toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it('keeps ordinary launches usable while missing, malformed or failing and logs no personal data', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepareInstructions = vi.fn(async () => true)
    const port = { ...WORKSPACES_OFF, prepareInstructions }
    for (const cwd of [null, undefined, '']) await prepareWorkspaceInstructions(port, cwd, 'claude')
    expect(prepareInstructions).not.toHaveBeenCalled()
    await prepareWorkspaceInstructions(port, '/private/work', 'claude')
    expect(log).not.toHaveBeenCalled()
    prepareInstructions.mockResolvedValueOnce(false).mockRejectedValueOnce(Error('secret file path'))
    await prepareWorkspaceInstructions(port, '/private/work', 'claude')
    await prepareWorkspaceInstructions(port, '/private/work', 'claude')
    await prepareWorkspaceInstructions(null, '/private/work', 'claude')
    expect(log).toHaveBeenCalledTimes(3)
    for (const [line] of log.mock.calls) {
      expect(line).toContain('TOOL_INSTRUCTIONS_UNAVAILABLE')
      expect(line).not.toContain('/private/work')
      expect(line).not.toContain('secret')
    }
  })
})
