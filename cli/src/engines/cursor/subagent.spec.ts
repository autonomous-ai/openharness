import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCursorReplayTaskLinks } from './subagent.js'
import { builtinSqlite } from '../../lib/sqliteBuiltin.js'

const parent = 'aaaaaaaa-1111-4222-8333-444444444444'
const child = 'bbbbbbbb-1111-4222-8333-444444444444'
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cursor-subagent-'))
  // A child transcript counts only under Cursor's data root.
  vi.stubEnv('CURSOR_DATA_DIR', root)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function chat(id: string): void {
  const dir = join(root, 'chats', 'workspace', id)
  mkdirSync(dir, { recursive: true })
  const meta = Buffer.from(JSON.stringify({ agentId: id,
    subagentInfo: { parentAgentId: parent, toolCallId: 'task-1' },
  })).toString('hex')
  const db = new (builtinSqlite()!)(join(dir, 'store.db'), { readOnly: false })
  try {
    db.exec(`CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('0','${meta}');`)
  } finally { db.close() }
}

describe('Cursor subagent Task output', () => {
  it.skipIf(!builtinSqlite())('is the child\'s final answer, not the narration before its tool calls', async () => {
    chat(parent)
    chat(child)
    const dir = join(root, 'projects', 'project', 'agent-transcripts', child)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${child}.jsonl`), [
      { role: 'user', message: { content: [{ type: 'text', text: 'Find the bug' }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: 'Let me search the logs.' },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'error' } },
      ] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Found it: a null check.' }] } },
      { type: 'turn_ended', status: 'success' },
    ].map((line) => JSON.stringify(line)).join('\n'))

    const links = await loadCursorReplayTaskLinks(root, parent)
    expect(links).toMatchObject([{ agentId: child, toolUseId: 'task-1', output: 'Found it: a null check.' }])
  })
})
