import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from './registry.js'
import type { PurgeDeps } from './purgeAgentService.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in native history authority tests') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})

let root: string, cwd: string, home: string, path: string, catalog: string, row: RegisteredSession
let inspect: typeof import('./purgeAgentService.js').inspectNativeHistory
let erase: typeof import('./purgeAgentService.js').eraseNativeHistory
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const header = (id = ID) => JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n'

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-history-authority-')))
  cwd = join(root, 'project'); home = join(root, 'moved-codex')
  path = join(home, 'sessions', `rollout-${ID}.jsonl`)
  catalog = join(root, 'data', 'engine-homes.json')
  for (const directory of [cwd, dirname(path), dirname(catalog)]) mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), ADAPTER_DATA_DIR: dirname(catalog),
    ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'default-codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), TZ: 'UTC' })) {
    vi.stubEnv(key, value)
    if (key !== 'TZ') mkdirSync(value, { recursive: true, mode: 0o700 })
  }
  writeFileSync(catalog, JSON.stringify({ claude: [], codex: [home] }))
  writeFileSync(path, header(), { mode: 0o600 })
  row = { agentId: 'fixture-agent', engine: 'codex', sessionId: ID, transcriptPath: path,
    cwd, registeredAt: 1000, codexHome: null, hermesHome: null, processIdentity: null, runtimes: [] } as unknown as RegisteredSession
  vi.resetModules()
  ;({ inspectNativeHistory: inspect, eraseNativeHistory: erase } = await import('./purgeAgentService.js'))
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); rmSync(root, { recursive: true, force: true }) })

it.each(['wrong conversation', 'incomplete header', 'delegated conversation'])('keeps native history with %s before review', async kind => {
  const content = kind === 'wrong conversation' ? header(OTHER) : kind === 'incomplete header' ? '{"type":"session_meta","payload":'
    : JSON.stringify({ type: 'session_meta', payload: { id: ID, cwd, source: { subagent: { thread_spawn: { parent_thread_id: OTHER } } } } }) + '\n'
  writeFileSync(path, content)
  await expect(inspect(row)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readFileSync(path, 'utf8')).toBe(content)
})

it('rechecks a changed header on the same inode before deletion', async () => {
  const history = await inspect(row)
  writeFileSync(path, header(OTHER))
  await expect(erase(history)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(readFileSync(path, 'utf8')).toBe(header(OTHER))
})

it.each(['removed home', 'incomplete catalog'])('keeps reviewed history when its catalog has %s', async kind => {
  const history = await inspect(row)
  writeFileSync(catalog, kind === 'removed home' ? JSON.stringify({ claude: [], codex: [] }) : '{')
  await expect(erase(history)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(path)).toBe(true)
})

it('never substitutes a recreated native file for the reviewed inode', async () => {
  const history = await inspect(row)
  renameSync(path, path + '.original'); writeFileSync(path, header())
  await expect(erase(history)).rejects.toThrow()
  expect(existsSync(path)).toBe(true); expect(existsSync(path + '.original')).toBe(true)
})

it('rechecks missing-file cleanup against fresh home evidence', async () => {
  rmSync(path)
  const history = await inspect(row)
  writeFileSync(catalog, '{')
  await expect(erase(history)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(cwd)).toBe(true)
})

it('does not transfer missing-file cleanup to a replaced parent directory', async () => {
  rmSync(path)
  const history = await inspect(row)
  renameSync(dirname(path), dirname(path) + '.original'); mkdirSync(dirname(path))
  await expect(erase(history)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(existsSync(dirname(path) + '.original')).toBe(true)
})

it('accepts appended turns of the exact reviewed conversation', async () => {
  const history = await inspect(row)
  writeFileSync(path, header() + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'A later turn' } }) + '\n')
  expect(await erase(history)).toBeGreaterThan(0)
  expect(existsSync(path)).toBe(false); expect(existsSync(cwd)).toBe(true)
})

it.each(['before Stop', 'during Stop', 'during Stop before worktree deletion'])('keeps the review on unavailable evidence %s, then permits the same reviewed retry', async moment => {
  const { PurgeAgentService } = await import('./purgeAgentService.js')
  const worktreeData = moment.endsWith('worktree deletion')
  const worktrees = await import('./worktreeDeletion.js')
  const tree = { path: join(root, 'temporary'), main: cwd, branch: 'fixture', head: 'fixture-head',
    bytes: 1, dirty: false, changes: [], signature: 'fixture-review', dev: 1, ino: 2 }
  vi.spyOn(worktrees, 'inspectWorktree').mockResolvedValue(tree)
  const removeTree = vi.spyOn(worktrees, 'removeReviewedWorktree').mockResolvedValue()
  let live: RegisteredSession | undefined = row, saved: RegisteredSession | null = null
  const stop = vi.fn(async () => { saved = row; live = undefined; if (moment.startsWith('during Stop')) writeFileSync(catalog, '{') })
  const removed = vi.fn(), deleted = vi.fn()
  const service = new PurgeAgentService({ live: () => live, sessions: () => [row],
    stopped: { get: () => saved, beginResume: () => 'fixture-reservation', finishResume: () => {}, remove: removed },
    checkpoints: { deletionFiles: () => [] }, stop, restarting: () => false, deleted,
  } as unknown as PurgeDeps)
  const request = { agentId: row.agentId, sessionId: ID, createdAt: row.registeredAt }
  const plan = await service.request({ ...request, mode: 'inspect', includeWorktree: worktreeData })
  expect(plan.reviewId).toEqual(expect.any(String))
  if (moment === 'before Stop') writeFileSync(catalog, '{')
  const remove = () => service.request({ ...request, mode: 'delete', reviewId: String(plan.reviewId),
    choices: { sessionData: true, worktreeData }, ...(worktreeData ? { path: tree.path } : {}) })
  expect(await remove()).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', retryable: true, stopped: moment.startsWith('during Stop') })
  expect(stop).toHaveBeenCalledTimes(moment.startsWith('during Stop') ? 1 : 0)
  expect(removeTree).not.toHaveBeenCalled()
  expect(removed).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled()
  expect(existsSync(path)).toBe(true)
  writeFileSync(catalog, JSON.stringify({ claude: [], codex: [home] }))
  expect(await remove()).toMatchObject({ deleted: true, sessionDeleted: true })
  expect(stop).toHaveBeenCalledOnce(); expect(deleted).toHaveBeenCalledOnce(); expect(removed).toHaveBeenCalledOnce()
  expect(removeTree).toHaveBeenCalledTimes(worktreeData ? 1 : 0)
})
