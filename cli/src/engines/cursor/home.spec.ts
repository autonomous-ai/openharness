import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cursorConfigDir, cursorDataDir } from './home.js'
import { CursorTranscriptDiscovery } from './discovery.js'
import { loadCursorReplayTaskLinks } from './subagent.js'
import { cleanupCursorOneShotSession } from '../../lib/oneshot.js'
import { builtinSqlite } from '../../lib/sqliteBuiltin.js'

const parent = 'aaaaaaaa-1111-4222-8333-444444444444'
const child = 'bbbbbbbb-1111-4222-8333-444444444444'
let root = ''
let config = ''
let data = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cursor-split-'))
  config = join(root, 'config')
  data = join(root, 'data')
  vi.stubEnv('CURSOR_CONFIG_DIR', config)
  vi.stubEnv('CURSOR_DATA_DIR', data)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function transcript(id: string): string {
  const dir = join(data, 'projects', 'project', 'agent-transcripts', id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, [
    { role: 'user', message: { content: [{ type: 'text', text: 'Find the bug' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Found it' }] } },
    { type: 'turn_ended', status: 'success' },
  ].map((line) => JSON.stringify(line)).join('\n'))
  return file
}

describe('Cursor with separate config and data directories', () => {
  it('honors explicit config first, then XDG, independently of the transcript root', () => {
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: ' /explicit ', XDG_CONFIG_HOME: '/xdg' })).toBe('/explicit')
    expect(cursorConfigDir({ CURSOR_CONFIG_DIR: ' ', XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/cursor')
    expect(cursorDataDir()).toBe(data)
  })

  it('discovers and validates a transcript under the data root', async () => {
    const file = transcript(child)
    const found = vi.fn()
    const discovery = new CursorTranscriptDiscovery(cursorDataDir(), found)
    await discovery.start()
    try {
      await discovery.add(child)
      expect(found).toHaveBeenCalledWith(child, file)
    } finally { await discovery.stop() }
  })

  it.skipIf(!builtinSqlite())('joins subagent metadata in config to the completed transcript in data', async () => {
    for (const id of [parent, child]) {
      const dir = join(config, 'chats', 'workspace', id)
      mkdirSync(dir, { recursive: true })
      const meta = Buffer.from(JSON.stringify({ agentId: id,
        subagentInfo: { parentAgentId: parent, toolCallId: 'task-1' },
      })).toString('hex')
      const db = new (builtinSqlite()!)(join(dir, 'store.db'), { readOnly: false })
      try {
        db.exec(`CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('0','${meta}');`)
      } finally { db.close() }
    }
    transcript(child)
    const links = await loadCursorReplayTaskLinks(cursorConfigDir(), parent, cursorDataDir())
    expect(links).toMatchObject([{ agentId: child, toolUseId: 'task-1', prompt: 'Find the bug', output: 'Found it' }])
  })

  it('cleans the recap in both roots and preserves another conversation', async () => {
    const recap = transcript(child)
    const other = transcript(parent)
    const chat = join(config, 'chats', 'workspace', child)
    const otherChat = join(config, 'chats', 'workspace', parent)
    mkdirSync(chat, { recursive: true })
    mkdirSync(otherChat, { recursive: true })
    await cleanupCursorOneShotSession(child)
    expect(existsSync(recap)).toBe(false)
    expect(existsSync(chat)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(otherChat)).toBe(true)
  })
})
