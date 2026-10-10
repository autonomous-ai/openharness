import * as fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { PurgeDeps } from './purgeAgentService.js'

vi.mock('node:fs', async original => ({ ...await original<object>() }))
let root: string, cwd: string, path: string, catalog: string, row: RegisteredSession
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const codex = (id = ID) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n'
const write = (file: string, text: string) => { fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }) }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'native-history-deletion-'))); cwd = join(root, 'project')
  for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_HOME',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(key, join(root, key)); fs.mkdirSync(join(root, key), { recursive: true, mode: 0o700 })
  }
  vi.stubEnv('TZ', 'UTC'); fs.mkdirSync(cwd)
  catalog = join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'); write(catalog, '{}')
  path = join(root, 'CODEX_HOME', 'sessions', `${ID}.jsonl`); write(path, codex())
  row = { agentId: 'selected', sessionId: ID, engine: 'codex', cwd, transcriptPath: path, registeredAt: 1000,
    boundAt: 1000, codexHome: null, hermesHome: null, processIdentity: null, runtimes: [] } as unknown as RegisteredSession
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }) })

async function setup(over: Partial<PurgeDeps> = {}, rows = [row]) {
  const { PurgeAgentService } = await import('./purgeAgentService.js')
  const live = new Map(rows.map(entry => [entry.agentId, entry])), saved = new Map<string, RegisteredSession>()
  const deleted = vi.fn(), stop = vi.fn(async (id: string) => { saved.set(id, live.get(id)!); live.delete(id) })
  const service = new PurgeAgentService({ live: (id: string) => live.get(id), sessions: () => [...live.values(), ...saved.values()],
    stopped: { get: (id: string) => saved.get(id) ?? null, beginResume: () => 'fixture-reservation',
      finishResume: () => {}, remove: (id: string) => saved.delete(id) },
    checkpoints: { deletionFiles: () => [] }, stop, restarting: () => false, deleted, ...over,
  } as unknown as PurgeDeps)
  const request = { agentId: row.agentId, sessionId: row.sessionId, createdAt: row.registeredAt }
  return { service, live, saved, stop, deleted, request }
}

it('cannot lend the reviewed inode to a pathname redirected only during realpath', async () => {
  const { inspectNativeHistory, eraseNativeHistory } = await import('./purgeAgentService.js')
  const history = await inspectNativeHistory(row), other = join(root, 'unreviewed', basename(path))
  write(other, codex())
  const realpath = fs.realpathSync
  vi.spyOn(fs, 'realpathSync').mockImplementation(((input: fs.PathLike, ...options: unknown[]) => {
    if (String(input) !== path) return Reflect.apply(realpath, fs, [input, ...options])
    fs.renameSync(dirname(path), dirname(path) + '.original'); fs.symlinkSync(dirname(other), dirname(path))
    try { return Reflect.apply(realpath, fs, [input, ...options]) }
    finally { fs.unlinkSync(dirname(path)); fs.renameSync(dirname(path) + '.original', dirname(path)) }
  }) as typeof fs.realpathSync)
  await expect(eraseNativeHistory(history)).resolves.toBeGreaterThan(0)
  expect(fs.existsSync(other)).toBe(true)
  expect(fs.readFileSync(other, 'utf8')).toBe(codex()); expect(fs.existsSync(path)).toBe(false)
})

it('retains the same confirmation through a one-shot final native-target read failure', async () => {
  const { eraseNativeHistory } = await import('./purgeAgentService.js')
  let armed = false, injected = false
  const lstat = fs.lstatSync
  vi.spyOn(fs, 'lstatSync').mockImplementation(((input: fs.PathLike, ...options: unknown[]) => {
    if (armed && String(input) === path) { armed = false; injected = true; throw Object.assign(Error('fixture read failure'), { code: 'EIO' }) }
    return Reflect.apply(lstat, fs, [input, ...options])
  }) as typeof fs.lstatSync)
  const ctx = await setup({ erase: async history => {
    const verify = history.verify!
    history.verify = key => { verify(key); if (!injected) armed = true }
    try { return await eraseNativeHistory(history) } finally { history.verify = verify }
  } })
  const plan = await ctx.service.request({ ...ctx.request, mode: 'inspect' })
  const remove = () => ctx.service.request({ ...ctx.request, mode: 'delete', reviewId: String(plan.reviewId) })
  expect(await remove()).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, stopped: true })
  expect(injected).toBe(true); expect(fs.existsSync(path)).toBe(true); expect(ctx.deleted).not.toHaveBeenCalled()
  expect(await remove()).toMatchObject({ deleted: true, sessionDeleted: true })
  expect(ctx.stop).toHaveBeenCalledOnce()
})

it('keeps both files when the reviewed alias moves between final acquisition and logical verification', async () => {
  const { inspectNativeHistory, eraseNativeHistory } = await import('./purgeAgentService.js')
  const sessions = dirname(path), a = join(sessions, 'A'), c = join(sessions, 'C'), alias = join(sessions, 'selected')
  const original = join(a, basename(path)), replacement = codex(OTHER)
  write(original, codex()); fs.symlinkSync(a, alias)
  const history = await inspectNativeHistory({ ...row, transcriptPath: join(alias, basename(path)) })
  const verify = history.verify!
  history.verify = key => {
    if (key !== undefined) {
      fs.renameSync(a, c); write(original, replacement)
      fs.unlinkSync(alias); fs.symlinkSync(c, alias)
    }
    verify(key)
  }
  await expect(eraseNativeHistory(history)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(fs.readFileSync(original, 'utf8')).toBe(replacement)
  expect(fs.readFileSync(join(c, basename(path)), 'utf8')).toBe(codex())
})

it.each(['shared conversation', 'saved binding'])('keeps history when %s changes during the worktree await', async change => {
  const worktrees = await import('./worktreeDeletion.js')
  const tree = { path: join(root, 'tree'), main: cwd, branch: 'fixture', head: 'fixture', bytes: 1,
    dirty: false, changes: [], signature: 'fixture', dev: 1, ino: 2 }
  vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
  const { registry } = await import('./registry.js')
  const ctx = await setup({ sessions: () => [...ctx.live.values(), ...ctx.saved.values(), ...registry.list()] })
  const removeTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockImplementation(async () => {
    await Promise.resolve()
    if (change === 'saved binding') { ctx.saved.get(row.agentId)!.boundAt! += 1; return }
    const owner = registry.openPendingAgent({ engine: 'codex', cwd: root, runtimes: [{ backend: 'tmux', paneId: '%90077' }] })!
    Object.assign(owner, { sessionId: ID, transcriptPath: path })
    expect(registry.list().some(entry => entry.agentId === owner.agentId && entry.sessionId === ID)).toBe(true)
  })
  const plan = await ctx.service.request({ ...ctx.request, mode: 'inspect', includeWorktree: true })
  const result = await ctx.service.request({ ...ctx.request, mode: 'delete', reviewId: String(plan.reviewId),
    choices: { sessionData: true, worktreeData: true }, path: tree.path })
  expect(result, String(result.detail)).toMatchObject({ error: 'DELETE_REFUSED', worktreeDeleted: true, sessionDeleted: false })
  expect(result.detail).toContain('worktree was deleted'); expect(fs.existsSync(path)).toBe(true)
  expect(removeTree).toHaveBeenCalledOnce(); expect(ctx.deleted).not.toHaveBeenCalled()
})

it('keeps in-flight and held confirmations at capacity, refusing excess previews', async () => {
  const otherPath = join(dirname(path), `${OTHER}.jsonl`); write(otherPath, codex(OTHER))
  const other = { ...row, agentId: 'preview', sessionId: OTHER, transcriptPath: otherPath }
  const ctx = await setup({}, [row, other])
  let finish!: () => void
  const blocked = new Promise<void>(resolve => { finish = resolve })
  ctx.stop.mockImplementation(async id => { await blocked; ctx.saved.set(id, ctx.live.get(id)!); ctx.live.delete(id); write(catalog, '{') })
  const first = await ctx.service.request({ ...ctx.request, mode: 'inspect' })
  const remove = () => ctx.service.request({ ...ctx.request, mode: 'delete', reviewId: String(first.reviewId) })
  const pending = remove()
  await vi.waitFor(() => expect(ctx.stop).toHaveBeenCalledOnce())
  const preview = () => ctx.service.request({ agentId: other.agentId, sessionId: OTHER, createdAt: other.registeredAt, mode: 'inspect' })
  for (let i = 0; i < 63; i++) expect(await preview()).toHaveProperty('reviewId')
  expect(await preview()).toMatchObject({ error: 'DELETE_REFUSED', detail: expect.stringContaining('too many unexpired') })
  finish()
  expect(await pending).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true })
  write(catalog, '{}')
  expect(await preview()).toMatchObject({ error: 'DELETE_REFUSED' })
  expect(await remove()).toMatchObject({ deleted: true, sessionDeleted: true })
  expect(fs.existsSync(otherPath)).toBe(true)
})

const git = (directory: string, ...args: string[]) => execFileSync('git', ['-C', directory,
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
{ encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })

function piWorktree(kind: string) {
  const tree = join(root, 'worktree')
  git(cwd, 'init', '--quiet', '-b', 'main'); write(join(cwd, 'source'), 'keep main')
  git(cwd, 'add', '.'); git(cwd, 'commit', '--quiet', '-m', 'fixture'); git(cwd, 'worktree', 'add', '--quiet', '-b', 'feature', tree)
  const workspace = kind === 'root' ? tree : join(tree, 'nested')
  fs.mkdirSync(workspace, { recursive: true })
  row.cwd = workspace
  if (kind === 'alias') { row.cwd = join(root, 'workspace-alias'); fs.symlinkSync(workspace, row.cwd) }
  row.engine = 'pi'; path = join(root, 'PI_HOME', 'agent', 'sessions', 'fixture', `${ID}.jsonl`); row.transcriptPath = path
  write(path, JSON.stringify({ type: 'session', version: 3, id: ID, cwd: workspace }) + '\n')
  return tree
}

it.each(['root', 'nested', 'alias'])('deletes real Pi history with its reviewed %s worktree workspace', async kind => {
  const tree = piWorktree(kind)
  const ctx = await setup(), plan = await ctx.service.request({ ...ctx.request, mode: 'inspect', includeWorktree: true })
  expect(plan).toMatchObject({ choices: { sessionData: { available: true }, worktreeData: { available: true, path: tree } } })
  expect(await ctx.service.request({ ...ctx.request, mode: 'delete', reviewId: String(plan.reviewId),
    choices: { sessionData: true, worktreeData: true }, path: tree })).toMatchObject({ deleted: true, sessionDeleted: true, worktreeDeleted: true })
  expect(fs.existsSync(tree)).toBe(false); expect(fs.existsSync(path)).toBe(false)
  expect(fs.readFileSync(join(cwd, 'source'), 'utf8')).toBe('keep main')
})

it.each(['failed removal', 'unavailable header'])('keeps Pi history through %s and reports completed work truthfully', async failure => {
  const tree = piWorktree('alias'), originalHeader = fs.readFileSync(path, 'utf8')
  const worktrees = await import('./worktreeDeletion.js'), removeTree = worktrees.removeReviewedWorktree
  const removal = vi.spyOn(worktrees, 'removeReviewedWorktree').mockImplementation(async (...args) => {
    if (failure === 'failed removal') throw Error('fixture worktree removal failed')
    await removeTree(...args)
    write(path, '{')
  })
  const ctx = await setup(), plan = await ctx.service.request({ ...ctx.request, mode: 'inspect', includeWorktree: true })
  const request = { ...ctx.request, mode: 'delete' as const, reviewId: String(plan.reviewId),
    choices: { sessionData: true, worktreeData: true }, path: tree }
  const result = await ctx.service.request(request)
  expect(result).toMatchObject({ error: failure === 'failed removal' ? 'DELETE_REFUSED' : 'IDENTITY_UNAVAILABLE',
    stopped: true, worktreeDeleted: failure !== 'failed removal', sessionDeleted: false })
  expect(fs.existsSync(path)).toBe(true); expect(ctx.deleted).not.toHaveBeenCalled()
  expect(fs.existsSync(tree)).toBe(failure === 'failed removal')
  if (failure === 'unavailable header') {
    write(path, originalHeader)
    expect(await ctx.service.request(request)).toMatchObject({ deleted: true, worktreeDeleted: true, sessionDeleted: true })
    expect(fs.existsSync(path)).toBe(false)
  }
  expect(removal).toHaveBeenCalledOnce(); expect(ctx.stop).toHaveBeenCalledOnce()
})

it('does not earn Pi absent-workspace authority before removal has completed', async () => {
  const { nativeHistoryEvidence } = await import('./nativeHistoryEvidence.js')
  const tree = piWorktree('nested'), info = fs.statSync(tree)
  const proof = nativeHistoryEvidence('pi', ID, path, undefined, row.cwd)
  proof.prepareWorkspaceRemoval!({ path: tree, dev: info.dev, ino: info.ino })
  fs.rmSync(tree, { recursive: true })
  expect(() => proof.verify()).toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }))
  expect(fs.existsSync(path)).toBe(true)
})

it.each(['recreated root', 'changed ancestor', 'changed alias', 'changed header'])('rejects Pi removal authority with a %s', async change => {
  const { nativeHistoryEvidence } = await import('./nativeHistoryEvidence.js')
  const tree = join(root, 'workspace-parent', 'tree'), workspace = join(tree, 'nested'), alias = join(root, 'workspace-alias')
  fs.mkdirSync(workspace, { recursive: true }); fs.symlinkSync(workspace, alias)
  const piPath = join(root, 'PI_HOME', 'agent', 'sessions', 'fixture', `${ID}.jsonl`)
  const header = (folder: string) => JSON.stringify({ type: 'session', version: 3, id: ID, cwd: folder }) + '\n'
  write(piPath, header(workspace))
  const proof = nativeHistoryEvidence('pi', ID, piPath, undefined, alias), info = fs.statSync(tree)
  const removed = proof.prepareWorkspaceRemoval!({ path: tree, dev: info.dev, ino: info.ino })
  fs.rmSync(tree, { recursive: true }); removed()
  if (change === 'recreated root') fs.mkdirSync(tree)
  if (change === 'changed ancestor') { fs.renameSync(dirname(tree), dirname(tree) + '.original'); fs.mkdirSync(dirname(tree)) }
  if (change === 'changed alias') { fs.unlinkSync(alias); fs.symlinkSync(join(root, 'another-missing-workspace'), alias) }
  if (change === 'changed header') write(piPath, header(alias))
  expect(() => proof.verify()).toThrow(expect.objectContaining({ code: 'IDENTITY_UNAVAILABLE' }))
  expect(fs.existsSync(piPath)).toBe(true)
})

it.each(['exact leaf', 'missing ancestor', 'dangling alias'])('requires complete Pi absent-workspace evidence: %s', async kind => {
  const { inspectNativeHistory } = await import('./purgeAgentService.js')
  const workspace = kind === 'missing ancestor' ? join(root, 'absent-parent', 'workspace') : join(root, 'absent-workspace')
  if (kind === 'dangling alias') fs.symlinkSync(join(root, 'missing-target'), workspace)
  const piPath = join(root, 'PI_HOME', 'agent', 'sessions', 'fixture', `${ID}.jsonl`)
  write(piPath, JSON.stringify({ type: 'session', version: 3, id: ID, cwd: workspace }) + '\n')
  const result = inspectNativeHistory({ ...row, engine: 'pi', cwd: workspace, transcriptPath: piPath })
  if (kind === 'exact leaf') expect(await result).toMatchObject({ file: { path: piPath } })
  else await expect(result).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
})
