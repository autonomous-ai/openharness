import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repoState } from './agentHandoff.js'
import { agentProject } from './agentProject.js'
import { nameBranchAfterSession } from './branchNaming.js'
import { insideGitCheckout } from './gitProject.js'
import { readGitPullRequest } from './gitPullRequest.js'
import { projectPreview } from './projectPreview.js'
import type { RegisteredSession } from './registry.js'
import { inspectWorkspace, inspectWorktree } from './worktreeDeletion.js'

// On a Mac without the Command Line Tools, `/usr/bin/git` is Apple's stub: running it opens the
// "install the command line developer tools" dialog. A fresh Mac's first harness runs in a folder
// with no `.git`, and the daemon read it with git as the harness started (fresh macOS VM,
// 2026-10-08). A `git` on PATH that records being run stands in for the stub.
describe('a folder with no .git runs no git', () => {
  let root: string
  let calls: string
  let path: string | undefined
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'harness-git-stub-')))
    calls = join(root, 'git-calls')
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin', 'git'), `#!/bin/sh\necho "$*" >> '${calls}'\nexit 1\n`)
    await chmod(join(root, 'bin', 'git'), 0o755)
    await mkdir(join(root, 'project'))
    path = process.env.PATH
    process.env.PATH = `${join(root, 'bin')}:${path}`
  })
  afterEach(async () => {
    process.env.PATH = path
    await rm(root, { recursive: true, force: true })
  })
  const ran = () => readFile(calls, 'utf8').catch(() => '')

  it('when an agent starts there', async () => {
    expect((await agentProject(join(root, 'project')))?.root).toBeNull()
    expect(await ran()).toBe('')
  })

  it('when its pane is read for a pull request', async () => {
    expect(await readGitPullRequest(join(root, 'project'))).toEqual({ status: 'unavailable' })
    expect(await ran()).toBe('')
  })

  it('when its agent gets a name and its branch would be renamed', async () => {
    expect(await nameBranchAfterSession(join(root, 'project'), 'Make a small web page')).toBeNull()
    expect(await ran()).toBe('')
  })

  it('when Change agent hands its conversation on', async () => {
    expect(await repoState(join(root, 'project'))).toBe('none')
    expect(await ran()).toBe('')
  })

  it('when Harness Monitor previews deleting it', async () => {
    const session = { cwd: join(root, 'project') } as RegisteredSession
    expect(await inspectWorkspace(session, [session])).toMatchObject({ kind: 'folder' })
    await expect(inspectWorktree(session, [session])).rejects.toThrow(/No separate worktree/)
    expect(await ran()).toBe('')
  })

  it('when the project picker previews it', async () => {
    const preview = await projectPreview(join(root, 'project'), [root])
    expect(preview).toMatchObject({ path: join(root, 'project') })
    expect(preview).not.toHaveProperty('branch', expect.anything())
    expect(await ran()).toBe('')
  })

  // The control: the same readers do reach git (this stub) inside a checkout, so the cases above pass
  // because git was not needed, not because it could not be found.
  it('but runs it inside a checkout', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await agentProject(join(root, 'repo'))
    expect(await ran()).toMatch(/rev-parse/)
  })

  it('and reads a link into a checkout as inside it, as git does', async () => {
    await mkdir(join(root, 'mono', '.git'), { recursive: true })
    await mkdir(join(root, 'mono', 'packages', 'web'), { recursive: true })
    await symlink(join(root, 'mono', 'packages', 'web'), join(root, 'web'))
    expect(await insideGitCheckout(join(root, 'web'))).toBe(true)
    expect(await insideGitCheckout(join(root, 'project'))).toBe(false)
  })
})
