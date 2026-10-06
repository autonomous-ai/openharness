import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { env } from '../../../config/env.js'
import { claudeProjectsRoots, resetEngineHomes } from '../../engineHomes.js'
import { externalProviders } from './index.js'
import { scanMemo } from './support.js'

let root: string | undefined
afterEach(() => {
  rmSync(join(env.ADAPTER_DATA_DIR, 'engine-homes.json'), { force: true })
  resetEngineHomes()
  if (root) rmSync(root, { recursive: true, force: true })
})

it('search discovers homes adopted by the core after its separate process has started', async () => {
  root = mkdtempSync(join(tmpdir(), 'external-homes-'))
  resetEngineHomes()
  // Search starts before the core reads the login shell; its first root lookup may find no saved file.
  claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR)
  const providers = externalProviders()
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
  expect(await providers.find(p => p.engine === 'claude')!.scan(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sessionId: claudeId }),
  ]))
  expect(await providers.find(p => p.engine === 'codex')!.scan(ctx)).toEqual(expect.arrayContaining([
    expect.objectContaining({ sessionId: codexId, title: 'Moved Codex thread' }),
  ]))
})
