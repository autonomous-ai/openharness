import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { env } from '../../../config/env.js'
import { claudeProjectsRoots, resetEngineHomes } from '../../engineHomes.js'
import { externalPaths, externalProviders } from './index.js'
import { scanMemo } from './support.js'

let root: string | undefined

/**
 * The providers with this test's own default homes. With the process's (env.CLAUDE_PROJECTS_DIR,
 * env.CODEX_HOME) they scanned the developer's real ~/.claude and ~/.codex: on one Mac 27 GB of Codex
 * sessions, which took the Codex case past its 5 s on a loaded machine, and which a test must never read.
 */
function providers(at: string) {
  const claudeProjectsDir = join(at, 'default-claude', 'projects')
  return { claudeProjectsDir, all: externalProviders({ ...externalPaths(), claudeProjectsDir, codexHome: join(at, 'default-codex') }) }
}

afterEach(() => {
  rmSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), { force: true })
  resetEngineHomes()
  if (root) rmSync(root, { recursive: true, force: true })
})

it.each(['claude', 'codex'] as const)('search discovers %s homes adopted by the core after its separate process has started', async engine => {
  root = mkdtempSync(join(tmpdir(), 'external-homes-'))
  resetEngineHomes()
  const own = providers(root)
  // Search starts before the core reads the login shell; its first root lookup may find no saved file.
  claudeProjectsRoots(own.claudeProjectsDir)
  const claudeHome = join(root, 'claude'), codexHome = join(root, 'codex')
  const claudeId = '11111111-1111-4111-8111-111111111111', codexId = '22222222-2222-4222-8222-222222222222'
  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(value) + '\n')
  }
  write(join(claudeHome, 'projects', 'project', `${claudeId}.jsonl`), {
    type: 'user', entrypoint: 'cli', sessionId: claudeId, cwd: root, message: { role: 'user', content: 'find the moved Claude conversation' },
  })
  write(join(codexHome, 'sessions', '2026', '10', '06', `rollout-${codexId}.jsonl`), {
    type: 'session_meta', payload: { id: codexId, cwd: root, source: 'cli' },
  })
  write(join(codexHome, 'session_index.jsonl'), { id: codexId, thread_name: 'Moved Codex thread' })
  write(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), { claude: [claudeHome], codex: [codexHome] })
  const ctx = scanMemo().context()
  expect(await own.all.find(p => p.engine === engine)!.scan(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining(engine === 'claude' ? { sessionId: claudeId } : { sessionId: codexId, title: 'Moved Codex thread' }),
  ]))
})

it('search recognizes a moved Claude conversation that is still busy in another terminal', async () => {
  root = mkdtempSync(join(tmpdir(), 'external-homes-'))
  const home = join(root, 'claude')
  const record = join(home, 'sessions', '123.json')
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(record, JSON.stringify({ pid: 123, sessionId: 'external-conversation', status: 'busy', startedAt: 1000 }))
  writeFileSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), JSON.stringify({ claude: [home] }))
  const provider = providers(root).all.find(p => p.engine === 'claude')!
  const claims = await provider.owners!({
    alive: pid => pid === 123,
    list: async () => [{ pid: 123, ppid: 1, executable: 'claude', args: 'claude', started: 1000 }],
    openFiles: async () => new Map(), openFilesOf: async () => new Map(),
  })
  expect(claims).toContainEqual({ sessionId: 'external-conversation', pid: 123, record })
  expect(await provider.busy!(claims[0])).toBe(true)
})
