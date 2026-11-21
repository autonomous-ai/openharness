import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registry, type RegisteredSession } from './registry.js'
import { StoppedAgentStore } from './stoppedAgents.js'
import { AgentCreationReceiptError } from './agentCreationReceipt.js'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { SessionCheckpointStore } from './sessionCheckpoint.js'
import { PurgeAgentService, inspectNativeHistory, eraseNativeHistory, type PurgeDeps, type PurgeRequest } from './purgeAgentService.js'
import { builtinSqlite } from './sqliteBuiltin.js'
import type { StopAgentOptions } from './stopAgentService.js'
import * as worktrees from './worktreeDeletion.js'
import { WORKSPACES_OFF } from '../core/api.js'
import { sessionDataBytes } from '../engines/others/historySize.js'
import { env } from '../config/env.js'

let root: string, session: RegisteredSession, stopped: StoppedAgentStore, checkpoints: SessionCheckpointStore
let service: PurgeAgentService, target: Omit<PurgeRequest, 'mode'>, now: number
let stop = vi.fn<(id: string, options: StopAgentOptions) => Promise<void>>()
let deleted = vi.fn<(session: RegisteredSession) => void>()
let eraseRecords = vi.fn<(session: RegisteredSession) => Promise<void>>()
let eraseFirst = vi.fn<(session: RegisteredSession) => Promise<void>>()
/** Workspaces as the purge finds them at each call: up, on this module's functions, unless a test takes them down. */
let workspaces: PurgeDeps['worktrees']
beforeEach(async () => {
  await registry.load()
  root = mkdtempSync(join(tmpdir(), 'harness-purge-'))
  const codexHome = join(root, 'profile'), cwd = join(root, 'project')
  mkdirSync(join(codexHome, 'sessions'), { recursive: true }); mkdirSync(cwd)
  session = (await registry.openPendingAgent({ engine: 'codex', cwd, codexHome, runtimes: [{ backend: 'tmux', paneId: '%77' }] }))!
  const transcriptPath = join(codexHome, 'sessions', 'selected-session.jsonl')
  writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: {
    id: 'selected-session', cwd, source: 'cli',
  } }) + '\n')
  const bound = await registry.register({ engine: 'codex', sessionId: 'selected-session', tmuxPane: '%77', cwd, codexHome, transcriptPath })
  expect(bound?.entry.agentId).toBe(session.agentId)
  session = registry.byAgent(session.agentId)!
  registry.setLaunch(session.agentId, { state: 'ready' })
  writeFileSync(join(codexHome, 'sessions', 'other.jsonl'), 'another conversation')
  writeFileSync(join(cwd, 'project.txt'), 'project files stay')
  stopped = new StoppedAgentStore(join(root, 'stopped'))
  checkpoints = new SessionCheckpointStore(join(root, 'checkpoints'))
  stop = vi.fn(async (id, options) => {
    expect(options.current?.()).toBe(true)
    await stopped.save(registry.byAgent(id)!)
    ;(await removeRegistryAgent(registry, id))
  })
  deleted = vi.fn(); eraseRecords = vi.fn(async () => {}); eraseFirst = vi.fn(async () => {}); now = 1000
  workspaces = () => worktrees.worktreeAnswers(worktrees)
  service = new PurgeAgentService({ live: id => registry.byAgent(id), liveSessions: () => registry.list(),
    worktrees: () => workspaces(), stopped, checkpoints, stop, restarting: () => false, deleted, eraseRecords, eraseFirst, now: () => now })
  target = { agentId: session.agentId, sessionId: session.sessionId, createdAt: session.registeredAt }
})
afterEach(async () => { for (const row of registry.list()) (await removeRegistryAgent(registry, row.agentId)); await stopped?.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })
const review = () => service.request({ ...target, mode: 'inspect' })
const remove = (reviewId: unknown) => service.request({ ...target, mode: 'delete', reviewId: String(reviewId) })

describe('database deletion without safe subprocess authority', () => {
  const engines = ['opencode', 'kilo', 'hermes', 'devin'] as const
  const original = { OPENCODE_DATA_DIR: env.OPENCODE_DATA_DIR, KILO_DATA_DIR: env.KILO_DATA_DIR, DEVIN_HOME: env.DEVIN_HOME }
  afterEach(() => Object.assign(env, original))
  function database(engine: typeof engines[number]): string {
    Object.assign(env, { OPENCODE_DATA_DIR: root, KILO_DATA_DIR: root, DEVIN_HOME: root })
    Object.assign(session, { engine, hermesHome: root, transcriptPath: null })
    const path = join(root, { opencode: 'opencode.db', kilo: 'kilo.db', hermes: 'state.db', devin: 'sessions.db' }[engine])
    const db = new (builtinSqlite()!)(path, { readOnly: false })
    try {
      if (engine === 'opencode' || engine === 'kilo') db.exec("CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT); CREATE TABLE part(message_id TEXT, content TEXT); INSERT INTO session VALUES ('selected-session'), ('other'); INSERT INTO message VALUES ('m', 'selected-session'); INSERT INTO part VALUES ('m', 'kept');")
      else db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY); CREATE TABLE ${engine === 'hermes' ? 'messages' : 'message_nodes'}(session_id TEXT, content TEXT); INSERT INTO sessions VALUES ('selected-session'), ('other'); INSERT INTO ${engine === 'hermes' ? 'messages' : 'message_nodes'} VALUES ('selected-session', 'kept');`)
    } finally { db.close() }
    return path
  }
  const tree = () => ({ path: join(root, 'temporary'), main: session.cwd!, branch: 'feature', head: 'commit',
    bytes: 100, dirty: false, changes: [], signature: 'tree-review', dev: 1, ino: 2 })
  it.each(engines)('preserves the read-only monitor total for %s', async engine => {
    const path = database(engine), before = readFileSync(path)
    expect(await sessionDataBytes(session, checkpoints)).toBe(engine === 'opencode' || engine === 'kilo' ? 38 : 36)
    expect(readFileSync(path)).toEqual(before)
  })
  it('preserves the OpenCode v2 monitor layout selection', async () => {
    const path = database('opencode'), db = new (builtinSqlite()!)(path, { readOnly: false })
    try { db.exec("CREATE TABLE session_v2(id TEXT PRIMARY KEY); CREATE TABLE session_message(session_id TEXT, content TEXT); INSERT INTO session_v2 VALUES ('selected-session'); INSERT INTO session_message VALUES ('selected-session', 'v');") }
    finally { db.close() }
    const before = readFileSync(path)
    expect(await sessionDataBytes(session, checkpoints)).toBe(33)
    expect(readFileSync(path)).toEqual(before)
  })
  it.each(engines)('refuses %s inspection and mixed deletion before every effect and retains the shared store', async engine => {
    const path = database(engine), before = readFileSync(path), workspace = tree()
    vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(workspace)
    const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
    const refused = { error: 'DELETE_REFUSED', reason: 'STORAGE_PURGE_AUTHORITY_UNAVAILABLE', stopped: false, sessionDeleted: false, worktreeDeleted: false }
    expect(await review()).toMatchObject(refused)
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    expect(plan).toMatchObject({ choices: { sessionData: { available: false, reason: expect.stringContaining('Delete this conversation in its engine.') }, worktreeData: { available: true } } })
    expect(await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), path: workspace.path,
      choices: { sessionData: true, worktreeData: true } })).toMatchObject(refused)
    // A stale review or substituted dependency cannot bypass the core's pre-effect refusal.
    expect(await remove('review-from-another-core')).toMatchObject(refused)
    expect(stop).not.toHaveBeenCalled(); expect(eraseFirst).not.toHaveBeenCalled(); expect(eraseRecords).not.toHaveBeenCalled()
    expect(eraseTree).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled()
    expect((await stopped.get(session.agentId))).toBeNull()
    expect(registry.byAgent(session.agentId)).toBe(session)
    expect(readFileSync(path)).toEqual(before)
  })
  it.each(engines)('keeps separately selected worktree deletion available for %s', async engine => {
    const path = database(engine), before = readFileSync(path), workspace = tree()
    vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(workspace)
    const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
    const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
    expect(await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), path: workspace.path,
      choices: { sessionData: false, worktreeData: true } })).toMatchObject({ deleted: true, worktreeDeleted: true, sessionDeleted: false, historyKept: true })
    expect(stop).toHaveBeenCalledOnce(); expect(eraseTree).toHaveBeenCalledOnce()
    expect(eraseFirst).not.toHaveBeenCalled(); expect(eraseRecords).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled()
    expect(readFileSync(path)).toEqual(before)
  })
})

it('says where a harness works is unknown while workspaces do not answer, and asks git nothing itself', async () => {
  workspaces = () => WORKSPACES_OFF
  expect(await service.worktreeRequest({ ...target, mode: 'describe' })).toEqual({ workspace: { kind: 'unavailable', path: session.cwd,
    canDelete: false, reason: 'The working folder could not be verified. Reopen Inspect to try again.' } })
  expect(await service.worktreeRequest({ ...target, mode: 'inspect' }))
    .toEqual({ error: 'WORKTREE_DELETE_REFUSED', stopped: false, detail: expect.stringContaining('The worktree could not be checked.') })
  // Delete's own review offers the session data alone, and says why not the worktree.
  expect(await service.request({ ...target, mode: 'inspect', includeWorktree: true })).toMatchObject({ choices: {
    sessionData: { available: true }, worktreeData: { available: false, reason: expect.stringContaining('did not answer') } } })
  expect(stop).not.toHaveBeenCalled()
})

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
    expect((await stopped.get(session.agentId)) !== null).toBe(!sessionData)
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
  // A worktree's removal is git's, in the workspaces service: asked again before the stop, the harness's first step that
  // cannot be undone, so a delete it cannot finish leaves the harness running and every file where it was.
  it.each(['workspaces down', 'the worktree changed'])('refuses a delete before the stop when %s since the review', async (since) => {
    const tree = treeReview()
    const inspect = vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
    const eraseTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
    for (const sessionData of [true, false]) {
      const plan = await service.request({ ...target, mode: 'inspect', includeWorktree: true })
      const alone = await service.worktreeRequest({ ...target, mode: 'inspect' })
      if (since === 'workspaces down') workspaces = () => WORKSPACES_OFF
      else inspect.mockResolvedValue({ ...tree, signature: 'changed-since' })
      const both = await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId), choices: choices(sessionData, true), path: tree.path })
      const worktree = await service.worktreeRequest({ ...target, mode: 'delete', reviewId: String(alone.reviewId), path: tree.path })
      const why = since === 'workspaces down' ? 'did not answer' : 'changed. Review it again'
      expect(both).toMatchObject({ error: 'DELETE_REFUSED', stopped: false, worktreeDeleted: false, sessionDeleted: false, detail: expect.stringContaining(why) })
      expect(worktree).toEqual({ error: 'WORKTREE_DELETE_REFUSED', stopped: false, detail: expect.stringContaining(why) })
      expect(stop).not.toHaveBeenCalled(); expect(eraseTree).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled()
      expect(registry.byAgent(session.agentId)).toBeDefined()
      expect(existsSync(session.transcriptPath!)).toBe(true)
      workspaces = () => worktrees.worktreeAnswers(worktrees); inspect.mockResolvedValue(tree)
    }
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
  expect((await stopped.get(session.agentId))).toBeNull()
  expect(deleted).toHaveBeenCalledOnce()
  expect(await remove(plan.reviewId)).toHaveProperty('error')
  expect(stop).toHaveBeenCalledOnce()
})
describe('every record of a harness', () => {
  const KEPT = { what: 'engine-store', reason: "OpenClaw's store is kept: delete its session with OpenClaw." }
  const deleteOnce = async () => service.request({ ...target, mode: 'delete', reviewId: String((await review()).reviewId),
    choices: { sessionData: true, worktreeData: false } })

  it('an OpenClaw harness is deleted: what Harness keeps goes, its store is kept and said', async () => {
    Object.assign(session, { engine: 'openclaw', sessionId: 'agent:main:harness-1', transcriptPath: null, codexHome: null })
    target.sessionId = session.sessionId
    expect(await inspectNativeHistory(session)).toEqual({ bytes: 0, kept: KEPT })
    expect(await deleteOnce()).toMatchObject({ deleted: true, sessionDeleted: true, historyKept: false, kept: [KEPT] })
    expect(eraseRecords).toHaveBeenCalledWith(expect.objectContaining({ agentId: session.agentId }))
    expect(deleted).toHaveBeenCalledOnce()
    expect(eraseRecords.mock.invocationCallOrder[0]).toBeLessThan(deleted.mock.invocationCallOrder[0]!)
    expect((await stopped.get(session.agentId))).toBeNull()
  })

  it('a harness whose engine\'s history Harness erases keeps nothing', async () => {
    const result = await deleteOnce()
    expect(result).toMatchObject({ deleted: true, sessionDeleted: true, historyKept: false })
    expect(result).not.toHaveProperty('kept')
    expect(existsSync(session.transcriptPath!)).toBe(false)
  })

  it('erases the checkpoints saved under every session key the harness had', async () => {
    session.earlierSessionIds = ['earlier-session']
    const saved = (s: RegisteredSession) => join(root, `${s.sessionId}.checkpoint`)
    const files = vi.spyOn(checkpoints, 'deletionFiles').mockImplementation(s => [saved(s)])
    for (const key of ['selected-session', 'earlier-session']) writeFileSync(join(root, `${key}.checkpoint`), `screen of ${key}`)
    const plan = await review()
    expect(plan.sessionPaths).toEqual(expect.arrayContaining(['selected-session', 'earlier-session'].map(key => realpathSync(join(root, `${key}.checkpoint`)))))
    expect(await service.request({ ...target, mode: 'delete', reviewId: String(plan.reviewId) })).toMatchObject({ deleted: true, sessionDeleted: true })
    expect(files.mock.calls.map(([s]) => s.sessionId)).toEqual(['selected-session', 'earlier-session', 'selected-session', 'earlier-session'])
    expect(files.mock.calls.every(([s]) => s.agentId === session.agentId && s.engine === 'codex')).toBe(true)
    expect(existsSync(join(root, 'selected-session.checkpoint'))).toBe(false)
    expect(existsSync(join(root, 'earlier-session.checkpoint'))).toBe(false)
  })

  // What another process keeps of the harness (its told lines, the agent cleanup's) is erased before anything here:
  // that process may be down, and a refusal after the conversation had gone left a harness that would not delete.
  it('erases what another process keeps first, and refused there deletes nothing; asked again, it finishes', async () => {
    eraseFirst.mockRejectedValueOnce(new Error('Harness could not erase what this harness was told, so nothing was deleted.'))
    const refused = await deleteOnce()
    expect(refused).toMatchObject({ error: 'DELETE_REFUSED', sessionDeleted: false, worktreeDeleted: false, stopped: true })
    expect(String(refused.detail)).toBe('Harness could not erase what this harness was told, so nothing was deleted. The harness is stopped; refresh before trying again.')
    // The conversation is still there, and so is everything else of it.
    expect(existsSync(session.transcriptPath!)).toBe(true)
    expect(eraseRecords).not.toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalled()
    expect((await stopped.get(session.agentId))).not.toBeNull()
    expect(await deleteOnce()).toMatchObject({ deleted: true, sessionDeleted: true })
    expect(eraseFirst).toHaveBeenCalledTimes(2)
    expect(eraseFirst).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: session.agentId }))
    expect(existsSync(session.transcriptPath!)).toBe(false)
    expect(eraseFirst.mock.invocationCallOrder[1]).toBeLessThan(eraseRecords.mock.invocationCallOrder[0]!)
    expect(deleted).toHaveBeenCalledOnce()
  })

  it('is refused, and says why, when its other records cannot be erased; asked again, it finishes', async () => {
    eraseRecords.mockRejectedValueOnce(new Error('The agent ledger is busy. Try again.'))
    const refused = await deleteOnce()
    expect(refused).toMatchObject({ error: 'DELETE_REFUSED', sessionDeleted: false })
    expect(String(refused.detail)).toContain('The agent ledger is busy. Try again.')
    expect(deleted).not.toHaveBeenCalled()
    expect((await stopped.get(session.agentId))).not.toBeNull()
    expect(await deleteOnce()).toMatchObject({ deleted: true, sessionDeleted: true })
    expect(eraseRecords).toHaveBeenCalledTimes(2)
    expect(deleted).toHaveBeenCalledOnce()
    expect((await stopped.get(session.agentId))).toBeNull()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('says in plain words a launch request it could not erase, never the receipt\'s code', async () => {
    eraseRecords.mockRejectedValueOnce(new AgentCreationReceiptError('CREATION_STORAGE_FAILED'))
    const refused = await deleteOnce()
    expect(refused).toMatchObject({ error: 'DELETE_REFUSED', sessionDeleted: false })
    expect(String(refused.detail)).toMatch(/^Harness could not erase this harness's saved launch request\. Try deleting it again\./)
    expect(String(refused.detail)).not.toContain('CREATION_STORAGE_FAILED')
    // A folder this account may not use: what its owner does about it, too.
    eraseRecords.mockRejectedValueOnce(new AgentCreationReceiptError('CREATION_STORAGE_FAILED', 'The creation folder ~/x is not usable by this account (permissions).'))
    expect(String((await deleteOnce()).detail)).toContain("saved launch request. The creation folder ~/x is not usable by this account (permissions). Try deleting it again.")
  })
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
  await stopped.save(other)
  expect(await review()).toMatchObject({ error: 'DELETE_REFUSED', detail: expect.stringContaining('Another harness') })
  await stopped.remove(other.agentId)
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
// A lamp's run teardown deletes its harness while an OpenClaw --local run still reads "starting local runtime": the
// launch is stopped, as a close stops it, and erased; refused only while it cannot be stopped yet, and said so.
describe('a harness still starting', () => {
  beforeEach(() => {
    Object.assign(session, { launch: { state: 'starting' }, sessionId: '', transcriptPath: null, processIdentity: null })
    target.sessionId = null
  })

  it('is stopped and erased, its engine found between the review and the delete', async () => {
    const plan = await review()
    expect(plan.reviewId).toEqual(expect.any(String))
    session.processIdentity = { pid: 4242, startMarker: 'Thu Nov 12 10:00:00 2026', executable: 'codex' }
    expect(await remove(plan.reviewId)).toMatchObject({ deleted: true, sessionDeleted: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(eraseRecords).toHaveBeenCalledOnce()
    expect(deleted).toHaveBeenCalledOnce()
    expect((await stopped.get(session.agentId))).toBeNull()
  })

  it('that cannot be stopped yet is refused in plain words, nothing deleted', async () => {
    const plan = await review()
    stop.mockRejectedValueOnce(new IdentityReadUnavailable('the native control descriptor type is unavailable'))
    const refused = await remove(plan.reviewId)
    expect(refused).toMatchObject({ error: 'DELETE_REFUSED', stopped: false, sessionDeleted: false })
    expect(refused.detail).toBe('This harness is still starting. Try again in a moment.')
    expect(eraseRecords).not.toHaveBeenCalled()
    expect(deleted).not.toHaveBeenCalled()
    expect(registry.byAgent(session.agentId)).toBeDefined()
  })
})

it('can explicitly review remaining checkpoints after an interrupted partial deletion', async () => {
  await checkpoints.save(session, { screen: 'keep until confirmed' })
  await stopped.save(session); (await removeRegistryAgent(registry, session.agentId))
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
  expect((await stopped.get(session.agentId))).not.toBeNull()
  expect(service.busy(session.agentId)).toBe(false)
  expect(service.blocksFolder(path)).toBe(false)
  expect(deleted).not.toHaveBeenCalled()
  inspect.mockRestore(); erase.mockRestore()
})

it.each(['root-resolution', 'final-child-answer'] as const)('keeps a worktree when stopped occupancy changes at %s', async phase => {
  const path = join(root, 'temporary')
  const tree = { path, main: session.cwd!, branch: 'feature', head: 'commit', bytes: 1, dirty: false, changes: [], signature: 'review', dev: 1, ino: 2 }
  const other = { ...session, agentId: 'other-stopped', sessionId: 'other-conversation', cwd: join(root, 'elsewhere') }
  await stopped.save(other)
  const file = join(root, 'stopped', `${other.agentId}.json`)
  const occupy = () => {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...value, session: { ...value.session, cwd: join(path, 'child') } }))
  }
  let armed = false
  vi.spyOn(worktrees, 'inspectWorktree').mockImplementation(async () => {
    if (armed && phase === 'root-resolution') occupy()
    return tree
  })
  const query = stopped.query.bind(stopped)
  vi.spyOn(stopped, 'query').mockImplementation(async request => {
    const answer = await query(request)
    if (armed && phase === 'final-child-answer' && !registry.byAgent(session.agentId)) occupy()
    return answer
  })
  const erase = vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
  const plan = await service.worktreeRequest({ ...target, mode: 'inspect' })
  expect(plan.reviewId).toBeTypeOf('string')
  armed = true
  expect(await service.worktreeRequest({ ...target, mode: 'delete', reviewId: String(plan.reviewId), path }))
    .toMatchObject({ error: 'WORKTREE_DELETE_REFUSED' })
  expect(erase).not.toHaveBeenCalled()
  expect(existsSync(session.transcriptPath!)).toBe(true)
  expect(deleted).not.toHaveBeenCalled()
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
  it('keeps read-only monitor totals and both conversations while deletion is unavailable', async () => {
    const db = dbFixture()
    try {
      expect(await sessionDataBytes(session, checkpoints)).toBe(39)
      await expect(inspectNativeHistory(session)).rejects.toThrow('Delete this conversation in its engine.')
      expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'keep' }, { id: 'selected-session' }])
      expect(db.prepare('SELECT content FROM messages').all()).toEqual([{ content: 'remove' }, { content: 'retained' }])
      expect(existsSync(join(session.hermesHome!, 'state.db'))).toBe(true)
    } finally { db.close() }
  })
  it('keeps monitor sizes unknown for dependent conversations, new references and trigger schemas', async () => {
    const db = dbFixture()
    try {
      db.exec("INSERT INTO sessions VALUES ('child', 'selected-session')")
      expect(await sessionDataBytes(session, checkpoints)).toBeNull()
      db.exec("DELETE FROM sessions WHERE id='child'; CREATE TABLE added(id TEXT REFERENCES sessions(id) ON DELETE CASCADE)")
      expect(await sessionDataBytes(session, checkpoints)).toBeNull()
      db.exec("DROP TABLE added; CREATE TRIGGER prevent AFTER DELETE ON sessions BEGIN SELECT 1; END")
      expect(await sessionDataBytes(session, checkpoints)).toBeNull()
      expect(db.prepare('SELECT id FROM sessions').all()).toHaveLength(2)
      expect(db.prepare('SELECT id FROM messages').all()).toHaveLength(2)
    } finally { db.close() }
  })

  // OpenCode 2.2.6's tables that name a conversation (MSI, 2026-11-19), trimmed to their keys: every delete of one was
  // refused as "Other engine data" while only session_message was known.
  const opencode2Fixture = () => {
    const data = join(root, 'opencode'); mkdirSync(data)
    const was = env.OPENCODE_DATA_DIR
    ;(env as { OPENCODE_DATA_DIR: string }).OPENCODE_DATA_DIR = data
    const Database = builtinSqlite()!
    const db = new Database(join(data, 'opencode.db'), { readOnly: false })
    const cascade = "REFERENCES session_v2(id) ON DELETE CASCADE"
    db.exec(`CREATE TABLE project(id TEXT PRIMARY KEY);
      CREATE TABLE session(id TEXT PRIMARY KEY);
      CREATE TABLE session_v2(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, parent_id TEXT, fork_session_id TEXT);
      CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL ${cascade}, data TEXT);
      CREATE TABLE session_part(message_id TEXT NOT NULL REFERENCES session_message(id) ON DELETE CASCADE, session_id TEXT NOT NULL ${cascade}, ordinal INTEGER, data TEXT, PRIMARY KEY(message_id, ordinal));
      CREATE TABLE blob(hash TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE blob_ref(session_id TEXT NOT NULL ${cascade}, message_id TEXT NOT NULL, hash TEXT NOT NULL REFERENCES blob(hash) ON DELETE CASCADE, PRIMARY KEY(session_id, message_id, hash));
      CREATE TABLE instruction_entry(session_id TEXT NOT NULL ${cascade}, key TEXT, PRIMARY KEY(session_id, key));
      CREATE TABLE instruction_state(session_id TEXT PRIMARY KEY ${cascade});
      CREATE TABLE session_inbox(id TEXT PRIMARY KEY, session_id TEXT NOT NULL ${cascade});
      CREATE TABLE schedule(id TEXT PRIMARY KEY, session_id TEXT ${cascade});
      INSERT INTO project VALUES ('p'); INSERT INTO blob VALUES ('h', x'00');`)
    for (const id of ['selected-session', 'keep']) db.exec(`INSERT INTO session_v2 VALUES ('${id}', 'p', NULL, NULL);
      INSERT INTO session_message VALUES ('${id}-m', '${id}', 'said');
      INSERT INTO session_part VALUES ('${id}-m', '${id}', 0, 'part');
      INSERT INTO blob_ref VALUES ('${id}', '${id}-m', 'h');
      INSERT INTO instruction_entry VALUES ('${id}', 'k'); INSERT INTO instruction_state VALUES ('${id}');
      INSERT INTO session_inbox VALUES ('${id}-i', '${id}'); INSERT INTO schedule VALUES ('${id}-s', '${id}');`)
    Object.assign(session, { engine: 'opencode', transcriptPath: null })
    return { db, restore: () => { db.close(); (env as { OPENCODE_DATA_DIR: string }).OPENCODE_DATA_DIR = was } }
  }
  const opencode2Tables = ['session_v2', 'session_message', 'session_part', 'blob_ref', 'instruction_entry', 'instruction_state', 'session_inbox', 'schedule']

  it('reads an OpenCode 2 conversation size without deleting its rows or the shared blobs', async () => {
    const { db, restore } = opencode2Fixture()
    try {
      expect(await sessionDataBytes(session, checkpoints)).toBe(230)
      await expect(inspectNativeHistory(session)).rejects.toMatchObject({ code: 'STORAGE_PURGE_AUTHORITY_UNAVAILABLE' })
      for (const table of opencode2Tables) {
        const column = table === 'session_v2' ? 'id' : 'session_id'
        expect(db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all(), table).toEqual([{ id: 'keep' }, { id: 'selected-session' }])
      }
      expect(db.prepare('SELECT hash FROM blob').all()).toEqual([{ hash: 'h' }])
    } finally { restore() }
  })

  it('keeps an OpenCode 2 conversation size unknown for forks and tables it does not know', async () => {
    const { db, restore } = opencode2Fixture()
    try {
      db.exec("INSERT INTO session_v2 VALUES ('fork', 'p', NULL, 'selected-session')")
      expect(await sessionDataBytes(session, checkpoints)).toBeNull()
      db.exec("DELETE FROM session_v2 WHERE id = 'fork'")
      expect(await sessionDataBytes(session, checkpoints)).toBe(230)
      db.exec('CREATE TABLE added(session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE)')
      expect(await sessionDataBytes(session, checkpoints)).toBeNull()
      for (const table of opencode2Tables) expect(db.prepare(`SELECT 1 FROM ${table}`).all(), table).toHaveLength(2)
    } finally { restore() }
  })
})
