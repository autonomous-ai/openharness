import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { locateProject } from './project.js'
import { CodingMemoryStore } from './store.js'

const exec = promisify(execFile)
let directory: string
let store: CodingMemoryStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'memory-project-'))
  const opened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'owner' })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
})
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })

it('resolves nested workspaces, worktrees, and symlinks to one opaque persistent project ID', async () => {
  const repo = join(directory, 'repo')
  const worktree = join(directory, 'feature')
  await mkdir(repo)
  const git = (args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Memory Test', '-c', 'user.email=memory@example.invalid', '-C', repo, ...args])
  await git(['init', '-q'])
  await git(['commit', '--allow-empty', '-qm', 'initial'])
  await git(['worktree', 'add', '-qb', 'feature', worktree])
  await mkdir(join(worktree, 'src'))
  const alias = join(directory, 'alias')
  await symlink(repo, alias)
  const [main, branch, linked] = await Promise.all([locateProject(repo), locateProject(join(worktree, 'src')), locateProject(alias)])
  const id = store.projectForLocator(main.locator)
  expect(id).not.toContain(repo)
  expect(store.projectForLocator(branch.locator)).toBe(id)
  expect(store.projectForLocator(linked.locator)).toBe(id)
  expect(store.libraryProjects('owner').items).toEqual([{ id, name: 'repo', location: main.locator.path.replace(/\/\.git$/, '') }])
  expect(branch.branchRef).toBe('refs/heads/feature')
  expect(branch.revision).toBe(main.revision)
  store.close()
  const reopened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'owner' })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  expect(store.projectForLocator(main.locator)).toBe(id)
})

it('keeps unrelated folders separate and links only an explicit unused alias', async () => {
  const paths = ['one', 'two', 'clone'].map(name => join(directory, name))
  await Promise.all(paths.map(path => mkdir(path)))
  const [one, two, clone] = await Promise.all(paths.map(locateProject))
  const id = store.projectForLocator(one.locator)
  const other = store.projectForLocator(two.locator)
  expect(other).not.toBe(id)
  store.linkProjectLocator(id, clone.locator)
  expect(store.projectForLocator(clone.locator)).toBe(id)
  expect(store.libraryProjects('owner').items.find(project => project.id === id)?.name).toBe('one')
  expect(() => store.linkProjectLocator(id, two.locator)).toThrow('project_identity_conflict')
  expect(store.projectForLocator(two.locator)).toBe(other)
  await expect(locateProject('relative/path')).rejects.toThrow('invalid_workspace')
  await expect(locateProject(join(directory, 'missing'))).rejects.toThrow('workspace_unavailable')
})
