/**
 * OpenClaw discovery against stores built from the recorded fixtures (`engines/openclaw/__fixtures__/`, OpenClaw
 * 2026.11.2). The fixtures need a Node whose SQLite has fts5 (22.23 or 24; 23.11 lacks it).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { builtinSqlite, closeSqliteHandles } from '../../sqliteBuiltin.js'
import { openclawProvider } from './openclaw.js'
import { scanMemo } from './support.js'

const FIXTURES = join(import.meta.dirname, '../../../engines/openclaw/__fixtures__')
const dirs: string[] = []
afterEach(() => {
  closeSqliteHandles()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A state folder whose `main` agent holds the scenarios' keys. */
function stateDir(scenarios: string[], edit = ''): string {
  const state = mkdtempSync(join(tmpdir(), 'ext-openclaw-'))
  dirs.push(state)
  const agent = join(state, 'agents', 'main', 'agent')
  mkdirSync(agent, { recursive: true })
  const db = new (builtinSqlite()!)(join(agent, 'openclaw-agent.sqlite'), { readOnly: false })
  db.exec(readFileSync(join(FIXTURES, 'schema.sql'), 'utf8'))
  for (const scenario of scenarios) db.exec(readFileSync(join(FIXTURES, `${scenario}.sql`), 'utf8'))
  if (edit) db.exec(edit)
  db.close()
  return state
}

describe('openclawProvider', () => {
  it('lists the keys a person made, in the workspace their header names, and never a sub-agent\'s or a cron run\'s', async () => {
    const state = stateDir(['plain', 'tool'], "UPDATE session_nodes SET created_via = 'spawn' WHERE session_key = 'agent:main:tool'")
    const provider = openclawProvider({ stateDir: state })
    const found = await provider.scan(scanMemo({ excluded: [] }).context())
    expect(found.map((session) => session.sessionId)).toEqual(['agent:main:plain'])
    expect(found[0]).toMatchObject({ engine: 'openclaw', origin: 'terminal', transcriptPath: null, cwd: expect.stringMatching(/\/workspace$/) })
    expect(provider.lastScan()).toMatchObject({ found: 1, spawn: 1 })
    const history = await found[0].readHistory!()
    expect(history.filter((event) => event.type === 'user_message').map((event) => event.payload.content)).toEqual(['Reply with exactly: hello there'])
  })

  it('lists nothing from a state folder with no agents', async () => {
    const state = mkdtempSync(join(tmpdir(), 'ext-openclaw-'))
    dirs.push(state)
    expect(await openclawProvider({ stateDir: state }).scan(scanMemo({ excluded: [] }).context())).toEqual([])
  })
})
