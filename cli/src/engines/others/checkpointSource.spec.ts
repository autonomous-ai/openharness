import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeFileKey } from '../kit/nativePaths.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { exportDatabase } from './checkpoint.js'
import { exportReceipt, type ExportSource, type ExportStage } from '../worker/storageProtocol.js'
import { OPENCLAW_COLUMNS } from '../openclaw/contract.js'

vi.mock('../../lib/sqliteRead.js', () => ({ sqliteReadAll: vi.fn() }))
let root: string, source: ExportSource, stage: ExportStage
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'checkpoint-source-')))
  const path = join(root, 'selected.db'), output = join(root, 'history.tmp')
  writeFileSync(path, 'selected store', { mode: 0o600 }); writeFileSync(output, '', { mode: 0o600 })
  source = { path, key: nativeFileKey(lstatSync(path, { bigint: true })), database: join(root, 'declared-alias.db') }
  stage = { path: output, key: nativeFileKey(lstatSync(output, { bigint: true })) }
  vi.mocked(sqliteReadAll).mockReset().mockImplementation(async (_database, sql) => ({ ok: true, via: 'builtin', rows:
    sql.includes('pragma_table_xinfo') ? [{ name: 'id', pk: 1 }]
      : sql.startsWith('WITH RECURSIVE') ? [{ ...Object.fromEntries(OPENCLAW_COLUMNS.transcript_events.map(name => [name, null])),
        event_zstd_hex: '', id: 'wanted', page_n: 1, page_more: 0, page_big: 0 }]
        : [{ id: 'wanted' }] }))
})
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })

it.each(['empty', 'unreadable', 'changed', 'cancelled', 'other engine'] as const)('reports unwritten history only from a complete stable OpenClaw read: %s', async how => {
  let current = true
  vi.mocked(sqliteReadAll).mockImplementationOnce(async () => {
    if (how === 'changed') writeFileSync(source.path, 'new native conversation')
    if (how === 'cancelled') current = false
    return how === 'unreadable' ? { ok: false, reason: 'unavailable' } as never : { ok: true, via: 'builtin', rows: [] }
  })
  const result = exportDatabase(how === 'other engine' ? 'hermes' : 'openclaw', { sessionId: 'agent:main:unwritten' }, stage, source, () => current)
  if (how === 'empty') {
    const receipt = await result
    expect(receipt).toMatchObject({ empty: true, bytes: 0 })
    expect(exportReceipt(receipt)).toBe(true)
    expect(exportReceipt({ ...receipt, empty: false })).toBe(false)
    expect(exportReceipt({ ...receipt, bytes: 1 })).toBe(false)
    expect(exportReceipt({ ...receipt, sha256: 'a'.repeat(64) })).toBe(false)
  } else await expect(result).rejects.toThrow()
  expect(readFileSync(stage.path, 'utf8')).toBe('')
})

it.each(['hermes', 'openclaw'] as const)('uses only the core-selected %s source despite another discovered profile/config', async engine => {
  const other = join(root, 'other'); mkdirSync(other)
  writeFileSync(join(other, 'openclaw.json'), JSON.stringify({ agents: { entries: { main: { agentDir: '/unrelated' } } } }))
  const receipt = await exportDatabase(engine, { sessionId: engine === 'openclaw' ? 'agent:main:wanted' : 'wanted',
    hermesHome: other, openclawStateDir: other, pid: 99 }, stage, source)
  expect(receipt.bytes).toBeGreaterThan(0)
  expect(vi.mocked(sqliteReadAll).mock.calls.every(([path]) => path === source.path)).toBe(true)
  expect(JSON.parse(readFileSync(stage.path, 'utf8')).database).toBe(source.database)
})

it.each(['replaced', 'alias'] as const)('refuses a %s input before any query or stage write', async how => {
  renameSync(source.path, source.path + '.old')
  if (how === 'alias') symlinkSync(source.path + '.old', source.path)
  else writeFileSync(source.path, 'another store')
  await expect(exportDatabase('hermes', { sessionId: 'wanted' }, stage, source)).rejects.toThrow('source refused')
  expect(sqliteReadAll).not.toHaveBeenCalled()
  expect(readFileSync(stage.path).length).toBe(0)
})
