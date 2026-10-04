import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_INSTRUCTION_FILES } from '../dsh/adapters.js'
import { agentProject } from '../lib/agentProject.js'
import { encryptDownFrame, encryptRpcResult } from '../lib/e2ee/applicationFrames.js'
import { readGitProject } from '../lib/gitProject.js'
import { sweepWorktrees } from '../lib/worktreeSweep.js'
import { GitScmProject } from './gitScmProject.js'
import {
  describeScmProject, detectScmProject, forgetScmProject, prepareInstructionWrites, prepareScmWrite, renameScmProject, scmByKind, scmLaunchEnv, scmProjects, sweepScmProjects,
} from './scmProjects.js'
import { parseScmLaunchRecord, type ScmDetectResult, type ScmProject } from './types.js'

const exec = promisify(execFile)
describe('the SCM seam, with git as its only implementation', { timeout: 30_000 }, () => {
  let root: string, repo: string, plain: string
  const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout.trim()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-scm-seam-'))
    repo = join(root, 'app')
    plain = join(root, 'plain folder')
    await mkdir(repo)
    await mkdir(plain)
    await git(repo, 'init', '--quiet', '-b', 'main')
    await writeFile(join(repo, 'file'), 'one')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '--quiet', '-m', 'initial')
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('knows git, and nothing else yet', () => {
    expect(scmProjects.map(scm => scm.kind)).toEqual(['git'])
    expect(scmByKind('git')?.kind).toBe('git')
    expect(scmByKind('none')).toBeNull()
  })

  it('describes a folder exactly as agentProject does, plus its kind — none is a real answer, an implausible cwd is not', async () => {
    expect(await describeScmProject(repo)).toEqual({ kind: 'git', ...await agentProject(repo) })
    expect(await describeScmProject(plain)).toEqual({ kind: 'none', ...await agentProject(plain) })
    expect(await describeScmProject(plain)).toEqual({ kind: 'none', name: basename(plain), cwd: plain, root: null, remote: null, branch: null })
    expect(await describeScmProject(null)).toBeNull()
    expect(await describeScmProject(undefined)).toBeNull()
    expect(await describeScmProject('relative')).toBeNull()
    expect(await describeScmProject('/x\u0000y')).toBeNull()
  })

  it('forgets through the seam what the git implementation cached', async () => {
    expect(await describeScmProject(repo)).toMatchObject({ branch: 'main' })
    await git(repo, 'switch', '--quiet', '-c', 'other')
    forgetScmProject(repo)
    expect(await describeScmProject(repo)).toMatchObject({ kind: 'git', branch: 'other' })
  })

  it('detects a repository as git_project_info would, and reports none or the probe failure otherwise', async () => {
    const fence = { knownRoots: [root] }
    expect(await detectScmProject(repo, fence)).toEqual({ kind: 'git', git: await readGitProject(repo, fence) })
    expect(await detectScmProject(plain, fence)).toEqual({ kind: 'none' })
    expect(await detectScmProject(repo)).toEqual({ kind: 'none', error: 'FORBIDDEN' })
    expect(await detectScmProject('relative')).toEqual({ kind: 'none', error: 'INVALID_PATH' })
  })

  it('asks every SCM at once and reads the answers in order: a slow probe holds nobody back, a throwing one fails only itself', async () => {
    const order: string[] = []
    const none = (error?: string): ScmDetectResult => ({ kind: 'none', ...(error ? { error } : {}) })
    const slow = { kind: 'git', detect: async () => { await new Promise(resolve => setTimeout(resolve, 50)); order.push('slow'); return none('GIT_UNAVAILABLE') } }
    const fast = { kind: 'git', detect: async () => { order.push('fast'); return none() } }
    expect(await detectScmProject(plain, {}, [slow, fast] as unknown as ScmProject[])).toEqual(none('GIT_UNAVAILABLE'))
    expect(order).toEqual(['fast', 'slow'])
    const throws = { kind: 'git', detect: async () => { throw new Error('boom') } }
    expect(await detectScmProject(repo, { knownRoots: [root] }, [throws as unknown as ScmProject, new GitScmProject()])).toMatchObject({ kind: 'git' })
    expect(await detectScmProject(repo, {}, [throws as unknown as ScmProject])).toEqual(none('UNAVAILABLE'))
  })

  it('travels encrypted end to end, as git_project_info does: the answer names private branches', () => {
    expect(encryptDownFrame('scm_project_info')).toBe(true)
    expect(encryptRpcResult('scm_project_info_result')).toBe(true)
  })

  it('renames through the seam and answers null where git would', async () => {
    expect(await renameScmProject(plain, 'A title')).toBeNull()
    expect(await renameScmProject(repo, 'A title')).toBeNull()
  })

  it('sweeps what sweepWorktrees sweeps, reading a one-shot iterable of in-use folders only once', async () => {
    const harnesses = join(root, 'harnesses')
    const worktrees = join(harnesses, 'worktrees', 'app')
    await mkdir(worktrees, { recursive: true })
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'harness/idle', join(worktrees, 'idle'), 'main')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'harness/busy', join(worktrees, 'busy'), 'main')
    const later = Date.now() + 8 * 24 * 3600_000
    function* inUse() { yield join(worktrees, 'busy'); yield null }
    expect(await sweepScmProjects({ root: harnesses, inUse: inUse(), now: later })).toEqual([join(worktrees, 'idle')])
    expect(await sweepWorktrees({ root: harnesses, inUse: [join(worktrees, 'busy')], now: later })).toEqual([])
    expect(await sweepScmProjects({ root: join(root, 'nowhere'), inUse: [] })).toEqual([])
  })

  it('has no launch environment for git, and nothing for a missing record', () => {
    expect(scmLaunchEnv({ kind: 'git' })).toBeUndefined()
    expect(scmLaunchEnv(null)).toBeUndefined()
    expect(scmLaunchEnv(undefined)).toBeUndefined()
  })

  it('prepares a write as a no-op for git, and asks an SCM that has the hook, in order', async () => {
    await expect(prepareScmWrite(repo, ['AGENTS.md'])).resolves.toBeUndefined()
    await expect(prepareScmWrite(plain, ['AGENTS.md'])).resolves.toBeUndefined()
    const asked: Array<[string, readonly string[]]> = []
    const writer = { kind: 'git', prepareWrite: async (cwd: string, paths: readonly string[]) => { asked.push([cwd, paths]) } }
    await prepareScmWrite(repo, ['AGENTS.md', 'CLAUDE.md'], [new GitScmProject(), writer as unknown as ScmProject])
    expect(asked).toEqual([[repo, ['AGENTS.md', 'CLAUDE.md']]])
  })

  it('asks for the instruction files before a write, skips a missing cwd, and only logs a failure', async () => {
    const asked: Array<[string, readonly string[]]> = []
    const writer = { kind: 'git', prepareWrite: async (cwd: string, paths: readonly string[]) => { asked.push([cwd, paths]) } }
    await prepareInstructionWrites(repo, [writer as unknown as ScmProject])
    await prepareInstructionWrites(null, [writer as unknown as ScmProject])
    expect(asked).toEqual([[repo, PROJECT_INSTRUCTION_FILES]])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const failing = { kind: 'git', prepareWrite: async () => { throw new Error('locked') } }
      await expect(prepareInstructionWrites(repo, [failing as unknown as ScmProject])).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith('[scm] could not prepare instruction files for writing · locked')
    } finally { warn.mockRestore() }
  })

  it('rehydrates a launch record from the registry file and refuses anything else', () => {
    expect(parseScmLaunchRecord({ kind: 'git' })).toEqual({ kind: 'git' })
    expect(parseScmLaunchRecord({ kind: 'git', extra: 1 })).toEqual({ kind: 'git' })
    expect(parseScmLaunchRecord({ kind: 'none' })).toBeNull()
    expect(parseScmLaunchRecord({ kind: 'svn' })).toBeNull()
    expect(parseScmLaunchRecord({})).toBeNull()
    expect(parseScmLaunchRecord(null)).toBeNull()
    expect(parseScmLaunchRecord('git')).toBeNull()
    expect(parseScmLaunchRecord(undefined)).toBeNull()
  })
})
