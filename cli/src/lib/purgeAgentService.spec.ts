import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registry, type RegisteredSession } from './registry.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { PurgeAgentService, inspectNativeHistory, eraseNativeHistory, sessionDataBytes, type PurgeRequest } from './purgeAgentService.js'
import { builtinSqlite } from './sqliteBuiltin.js'
import type { StopAgentOptions } from './stopAgentService.js'
import * as worktrees from './worktreeDeletion.js'

let root: string, session: RegisteredSession, stopped: StoppedAgentStore, checkpoints: SessionCheckpointStore
let service: PurgeAgentService, target: Omit<PurgeRequest, 'mode'>, now: number
let stop = vi.fn<(id: string, options: StopAgentOptions) => Promise<void>>()
let deleted = vi.fn<(session: RegisteredSession) => void>()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-purge-'))
  const codexHome = join(root, 'profile'), cwd = join(root, 'project')
  mkdirSync(join(codexHome, 'sessions'), { recursive: true }); mkdirSync(cwd)
  session = registry.openPendingAgent({ engine: 'codex', cwd, codexHome, runtimes: [{ backend: 'tmux', paneId: '%77' }] })!
  Object.assign(session, { sessionId: 'selected-session', launch: { state: 'ready' }, transcriptPath: join(codexHome, 'sessions', 'selected-session.jsonl') })
  writeFileSync(session.transcriptPath!, JSON.stringify({ type: 'session_meta', payload: {
    id: session.sessionId, cwd, source: 'cli',
  } }) + '\n')
  writeFileSync(join(codexHome, 'sessions', 'other.jsonl'), 'another conversation')
  writeFileSync(join(cwd, 'project.txt'), 'project files stay')
  stopped = new StoppedAgentStore(join(root, 'stopped'))
  checkpoints = new SessionCheckpointStore(join(root, 'checkpoints'))
  stop = vi.fn(async (id, options) => {
    expect(options.current?.()).toBe(true)
    stopped.save(registry.byAgent(id)!)
    registry.removeAgent(id)
  })
  deleted = vi.fn(); now = 1000
  service = new PurgeAgentService({ live: id => registry.byAgent(id), sessions: () => [...registry.list(), ...stopped.list()],
    stopped, checkpoints, stop, restarting: () => false, deleted, now: () => now })
  target = { agentId: session.agentId, sessionId: session.sessionId, createdAt: session.registeredAt }
})
afterEach(() => { for (const row of registry.list()) registry.removeAgent(row.agentId); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const review = () => service.request({ ...target, mode: 'inspect' })
const remove = (reviewId: unknown) => service.request({ ...target, mode: 'delete', reviewId: String(reviewId) })

it('workspace inspection is read-only and binds the selected session identity', async () => {
  expect(await service.worktreeRequest({ ...target, mode: 'describe' })).toMatchObject({ workspace: { kind: 'folder', path: realpathSync(session.cwd!), canDelete: false } })
  expect(await service.worktreeRequest({ ...target, sessionId: 'different', mode: 'describe' })).toHaveProperty('error')
  expect(stop).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled()
  expect(existsSync(session.transcriptPath!)).toBe(true)
})

describe('selected session and worktree cleanup', () => {
  const choices = (sessionData: boolean, worktreeData: boolean) => ({ sessionData, worktreeData })
  const treeReview = () => ({ path: join(root, 'temporary'), main: session.cwd!, branch: 'feature', head: 'commit',
    bytes: 1e9, dirty: false, changes: [], signature: 'tree-review', dev: 1, ino: 2 })
  it('deletes both real selected stores while keeping the main checkout and committed branch', async () => {
    const main = session.cwd!, tree = join(root, 'real-worktree')
    const git = (...args: string[]) => execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' })
    git('init', '--quiet', '-b', 'main'); git('add', '.'); git('commit', '--quiet', '-m', 'main project')
    git('worktree', 'add', '--quiet', '-b', 'feature', tree)
    session.cwd = tree
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    expect(plan).toMatchObject({ choices: { sessionData: { available: true }, worktreeData: { available: true, path: realpathSync(tree) } } })
    expect(await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), choices: choices(true, true), path: realpathSync(tree) })).toMatchObject({ deleted: true, worktreeDeleted: true, sessionDeleted: true })
    expect(existsSync(tree)).toBe(false); expect(existsSync(session.transcriptPath!)).toBe(false)
    expect(existsSync(join(main, 'project.txt'))).toBe(true)
    expect(git('show', 'feature:project.txt')).toBe('project files stay')
  })
  it.each([[true, false], [false, true], [true, true]])('only deletes the selected data: session %s, worktree %s', async (sessionData, worktreeData) => {
    const tree = treeReview()
    vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
    const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockImplementation(async () => {
      expect(service.busy(session.agentId)).toBe(true)
      expect(service.blocksFolder(tree.path)).toBe(true)
      expect(stopped.beginResume(session.agentId)).toBeNull()
    })
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    expect(plan).toMatchObject({ choices: { sessionData: { available: true, paths: [realpathSync(session.transcriptPath!)] }, worktreeData: { available: true, path: tree.path } } })
    expect(stop).not.toHaveBeenCalled(); expect(eraseTree).not.toHaveBeenCalled()
    const result = await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), choices: choices(sessionData, worktreeData), path: tree.path })
    expect(result).toMatchObject({ deleted: true, sessionDeleted: sessionData, worktreeDeleted: worktreeData, historyKept: !sessionData })
    expect(stop).toHaveBeenCalledOnce()
    expect(eraseTree).toHaveBeenCalledTimes(worktreeData ? 1 : 0)
    expect(existsSync(session.transcriptPath!)).toBe(!sessionData)
    expect(existsSync(join(session.cwd!, 'project.txt'))).toBe(true)
    expect(stopped.get(session.agentId) !== null).toBe(!sessionData)
  })
  it('refuses unreviewed, protected, empty or dirty selections before stopping', async () => {
    for (const scenario of ['legacy', 'protected', 'empty', 'dirty', 'path']) {
      vi.restoreAllMocks()
      const tree = { ...treeReview(), dirty: scenario === 'dirty', changes: ['?? draft'] }
      vi.spyOn(worktrees, 'inspectWorktree').mockImplementation(async () => {
        if (scenario === 'protected') throw new Error('Main project folder is protected.')
        return tree
      })
      const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree')
      const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: scenario !== 'legacy' })
      const result = await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), choices: choices(false, scenario !== 'empty'), path: scenario === 'path' ? '/wrong' : tree.path })
      expect(result).toHaveProperty('error')
      expect(stop).not.toHaveBeenCalled(); expect(eraseTree).not.toHaveBeenCalled()
      expect(existsSync(session.transcriptPath!)).toBe(true)
    }
  })
  it('can clean a worktree while unavailable conversation data is kept', async () => {
    const tree = treeReview()
    vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
    vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
    const originalPath = session.transcriptPath!
    session.transcriptPath = join(root, 'unverified-history')
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    expect(plan).toMatchObject({ choices: { sessionData: { available: false }, worktreeData: { available: true } } })
    expect(await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), choices: choices(false, true), path: tree.path })).toMatchObject({ deleted: true, historyKept: true })
    expect(existsSync(originalPath)).toBe(true)
  })
  it('holds remaining history after worktree deletion and retries only that remaining stage', async () => {
    const tree = treeReview()
    vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
    const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockImplementation(async () => {
      renameSync(session.transcriptPath!, session.transcriptPath! + '.old')
      writeFileSync(session.transcriptPath!, 'replacement must stay')
    })
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    const request = { ...target, mode: 'delete' as const, reviewId: String(plan.reviewId), choices: choices(true, true), path: tree.path }
    const result = await service.request(request)
    expect(result).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, worktreeDeleted: true })
    expect(result.detail).toContain('worktree was deleted')
    expect(existsSync(session.transcriptPath!)).toBe(true)
    expect(await service.request(request)).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, worktreeDeleted: true })
    rmSync(session.transcriptPath!); renameSync(session.transcriptPath! + '.old', session.transcriptPath!)
    expect(await service.request(request)).toMatchObject({ deleted: true, sessionDeleted: true, worktreeDeleted: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(eraseTree).toHaveBeenCalledOnce()
  })
})

it('previews without stopping, then deletes only reviewed history and checkpoints', async () => {
  await checkpoints.save(session, { screen: 'saved terminal' })
  const files = checkpoints.deletionFiles(session)
  const plan = await review()
  expect(plan.sessionBytes).toBe(await sessionDataBytes(session, checkpoints))
  expect(plan.sessionBytes).toBeGreaterThan(0)
  expect(stop).not.toHaveBeenCalled()
  expect(await remove(plan.reviewId)).toMatchObject({ deleted: true, workspaceKept: true })
  expect(existsSync(session.transcriptPath!)).toBe(false)
  expect(files.every(path => !existsSync(path))).toBe(true)
  expect(existsSync(join(session.codexHome!, 'sessions', 'other.jsonl'))).toBe(true)
  expect(existsSync(join(session.cwd!, 'project.txt'))).toBe(true)
  expect(stopped.get(session.agentId)).toBeNull()
  expect(deleted).toHaveBeenCalledOnce()
  expect(await remove(plan.reviewId)).toHaveProperty('error')
  expect(stop).toHaveBeenCalledOnce()
})
it('rejects an absent, expired, rotated or replaced review before stopping', async () => {
  expect(await remove('never-reviewed')).toHaveProperty('error')
  const expired = await review(); now += 120_001
  expect(await remove(expired.reviewId)).toHaveProperty('error')
  const rotated = await review(); session.sessionId = 'replacement'
  expect(await remove(rotated.reviewId)).toHaveProperty('error')
  session.sessionId = target.sessionId!
  const replaced = await review(); session.cwd = root
  expect(await remove(replaced.reviewId)).toHaveProperty('error')
  expect(stop).not.toHaveBeenCalled()
  expect(existsSync(session.transcriptPath!)).toBe(true)
})
it('keeps history if stopping fails, another harness uses it, or the file was replaced', async () => {
  const plan = await review()
  stop.mockRejectedValueOnce(new Error('process still alive'))
  expect(await remove(plan.reviewId)).toHaveProperty('error')
  expect(existsSync(session.transcriptPath!)).toBe(true)
  const other = { ...session, agentId: 'other-agent' }
  stopped.save(other)
  expect(await review()).toMatchObject({ error: 'DELETE_REFUSED', detail: expect.stringContaining('Another harness') })
  stopped.remove(other.agentId)
  const changed = await review()
  renameSync(session.transcriptPath!, session.transcriptPath! + '.old')
  writeFileSync(session.transcriptPath!, 'different file')
  expect(await remove(changed.reviewId)).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, stopped: false })
  expect(existsSync(session.transcriptPath!)).toBe(true)
  expect(deleted).not.toHaveBeenCalled()
})
it('refuses symlinks, hard links, foreign conversation names and monitor deletion', async () => {
  const original = session.transcriptPath!
  renameSync(original, original + '.old'); symlinkSync(original + '.old', original)
  expect(await review()).toHaveProperty('error')
  rmSync(original); linkSync(original + '.old', original)
  expect(await review()).toHaveProperty('error')
  rmSync(original); renameSync(original + '.old', original)
  session.transcriptPath = join(session.codexHome!, 'sessions', 'other.jsonl')
  expect(await review()).toHaveProperty('error')
  session.transcriptPath = original; session.dsh = 'autonomous/harness-monitor'
  expect(await review()).toHaveProperty('error')
  expect(stop).not.toHaveBeenCalled()
})
it('can explicitly review remaining checkpoints after an interrupted partial deletion', async () => {
  await checkpoints.save(session, { screen: 'keep until confirmed' })
  stopped.save(session); registry.removeAgent(session.agentId)
  rmSync(session.transcriptPath!)
  const plan = await review()
  expect(plan.reviewId).toBeTypeOf('string')
  expect(await remove(plan.reviewId)).toMatchObject({ deleted: true })
  expect(stop).not.toHaveBeenCalled()
  expect(checkpoints.deletionFiles(session)).toEqual([])
})
it('binds worktree deletion to the reviewed path and dirty consent, blocking concurrent lifecycle work', async () => {
  const path = join(root, 'temporary')
  const inspect = vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue({ path, main: session.cwd!, branch: 'feature', head: 'commit', bytes: 1e9, dirty: true, changes: ['?? draft'], signature: 'review', dev: 1, ino: 2 })
  const erase = vi.spyOn(worktrees, 'removeReviewedWorktree').mockImplementation(async () => {
    expect(service.busy(session.agentId)).toBe(true)
    expect(service.blocksFolder(join(path, 'src'))).toBe(true)
    expect(stopped.beginResume(session.agentId)).toBeNull()
  })
  const plan = await service.worktreeRequest({ ...target, mode: 'inspect' })
  expect(stop).not.toHaveBeenCalled()
  expect(await service.worktreeRequest({ ...target, mode: 'delete', reviewId: String(plan.reviewId), path: session.cwd!, discardChanges: true })).toHaveProperty('error')
  const next = await service.worktreeRequest({ ...target, mode: 'inspect' })
  expect(await service.worktreeRequest({ ...target, mode: 'delete', reviewId: String(next.reviewId), path })).toHaveProperty('error')
  expect(stop).not.toHaveBeenCalled()
  const final = await service.worktreeRequest({ ...target, mode: 'inspect' })
  expect(await service.worktreeRequest({ ...target, mode: 'delete', reviewId: String(final.reviewId), path, discardChanges: true })).toMatchObject({ deleted: true, historyKept: true, branchKept: true })
  expect(erase).toHaveBeenCalledOnce()
  expect(existsSync(session.transcriptPath!)).toBe(true)
  expect(stopped.get(session.agentId)).not.toBeNull()
  expect(service.busy(session.agentId)).toBe(false)
  expect(service.blocksFolder(path)).toBe(false)
  expect(deleted).not.toHaveBeenCalled()
  inspect.mockRestore(); erase.mockRestore()
})

describe('shared native databases', () => {
  const dbFixture = () => {
    const home = join(root, 'hermes'); mkdirSync(home)
    const Database = builtinSqlite()!
    const db = new Database(join(home, 'state.db'), { readOnly: false })
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, parent_session_id TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT REFERENCES sessions(id), content TEXT); INSERT INTO sessions VALUES ('selected-session', NULL), ('keep', NULL); INSERT INTO messages VALUES (1, 'selected-session', 'remove'), (2, 'keep', 'retained');")
    Object.assign(session, { engine: 'hermes', hermesHome: home, transcriptPath: null })
    return db
  }
  it('deletes only one conversation atomically, retaining the shared database and other sessions', async () => {
    const db = dbFixture()
    try {
      const history = await inspectNativeHistory(session)
      expect(history.bytes).toBeGreaterThan(0)
      await eraseNativeHistory(history)
      expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'keep' }])
      expect(db.prepare('SELECT content FROM messages').all()).toEqual([{ content: 'retained' }])
      expect(existsSync(join(session.hermesHome!, 'state.db'))).toBe(true)
    } finally { db.close() }
  })
  it('refuses dependent conversations, new dependencies and changed schemas without partial deletion', async () => {
    const db = dbFixture()
    try {
      const history = await inspectNativeHistory(session)
      db.exec("INSERT INTO sessions VALUES ('child', 'selected-session')")
      await expect(eraseNativeHistory(history)).rejects.toThrow()
      await expect(inspectNativeHistory(session)).rejects.toThrow('depend')
      expect(db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
      db.exec("DELETE FROM sessions WHERE id='child'")
      const next = await inspectNativeHistory(session)
      db.exec('CREATE TABLE added(id TEXT REFERENCES sessions(id) ON DELETE CASCADE)')
      await expect(eraseNativeHistory(next)).rejects.toThrow()
      await expect(inspectNativeHistory(session)).rejects.toThrow('Other engine data')
      expect(db.prepare('SELECT id FROM sessions').all()).toHaveLength(2)
    } finally { db.close() }
  })
})
