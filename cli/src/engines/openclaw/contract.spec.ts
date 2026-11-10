import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENCLAW_COLUMNS, OPENCLAW_HEADER, OPENCLAW_HEADER_URL, OPENCLAW_KEY, OPENCLAW_LAUNCH, openclawAgentDb } from './contract.js'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const screens = readdirSync(FIXTURES).filter((name) => /^screen-.*\.txt$/.test(name)).sort()

/**
 * The key and the Gateway URL each recorded screen shows (OpenClaw 2026.11.2). Every screen is listed, so a new
 * recording fails here until someone has said what it shows.
 * - The no-gateway panes never heard from the Gateway, so the session line under the title is not drawn.
 * - The no-token and remote-without-credentials runs exit before the TUI opens.
 * - The second of two 80-column panes on main has scrolled its title line off.
 */
const SHOWN: Record<string, { key: string | null; url: string | null }> = {
  'screen-abort-running.txt': { key: 'agent:main:abort', url: 'ws://127.0.0.1:18789' },
  'screen-abort.txt': { key: 'agent:main:abort', url: 'ws://127.0.0.1:18789' },
  'screen-approval.txt': { key: 'agent:main:approval', url: 'ws://127.0.0.1:18789' },
  'screen-fail-model.txt': { key: 'agent:main:fail', url: 'ws://127.0.0.1:18789' },
  'screen-fail.txt': { key: 'agent:main:fail', url: 'ws://127.0.0.1:18789' },
  'screen-main-heartbeat.txt': { key: 'agent:main:main', url: 'ws://127.0.0.1:18789' },
  'screen-model-switch.txt': { key: 'agent:main:model-switch', url: 'ws://127.0.0.1:18789' },
  'screen-multi-tool.txt': { key: 'agent:main:multi-tool', url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway-attached.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway-bare.txt': { key: null, url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway-reconnected.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway.txt': { key: null, url: 'ws://127.0.0.1:18789' },
  'screen-no-token.txt': { key: null, url: null },
  'screen-plain-darwin.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain-start-darwin.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain-start.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-remote-no-credentials.txt': { key: null, url: null },
  'screen-remote.txt': { key: 'agent:main:remote', url: 'ws://172.17.0.3:18789' },
  'screen-reset-new.txt': { key: 'agent:main:tui-652cc362-2631-416e-bf1c-6ac369311a20', url: 'ws://127.0.0.1:18789' },
  'screen-reset.txt': { key: 'agent:main:reset', url: 'ws://127.0.0.1:18789' },
  'screen-rewind.txt': { key: 'agent:main:rewind', url: 'ws://127.0.0.1:18789' },
  'screen-tool.txt': { key: 'agent:main:tool', url: 'ws://127.0.0.1:18789' },
  'screen-two-panes-main-a.txt': { key: 'agent:main:main', url: 'ws://127.0.0.1:18789' },
  'screen-two-panes-main-b.txt': { key: 'agent:main:main', url: null },
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Each table's columns as the recorded `schema.sql` creates them. */
function recordedColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>()
  for (const [, table, body] of fixture('schema.sql').matchAll(/^CREATE TABLE (\w+) \(\n([\s\S]*?)\n\)(?: STRICT)?;$/gm)) {
    tables.set(table, new Set(body.split('\n').map((line) => /^ {2}(\w+) [A-Z]/.exec(line)?.[1]).filter((column) => column !== undefined)))
  }
  return tables
}

describe('the OpenClaw contract', () => {
  it('OPENCLAW_HEADER reads the key from every recorded screen', () => {
    expect(screens).toEqual(Object.keys(SHOWN).sort())
    for (const screen of screens) {
      expect(OPENCLAW_HEADER.exec(fixture(screen))?.[1] ?? null, screen).toBe(SHOWN[screen].key)
    }
  })

  it('OPENCLAW_HEADER_URL tells a loopback Gateway from the remote fixture', () => {
    for (const screen of screens) {
      const url = OPENCLAW_HEADER_URL.exec(fixture(screen))?.[1] ?? null
      expect(url, screen).toBe(SHOWN[screen].url)
      if (url) expect(LOOPBACK.has(new URL(url).hostname), screen).toBe(screen !== 'screen-remote.txt')
    }
  })

  it('OPENCLAW_KEY matches every key in the fixtures', () => {
    const keys = new Set<string>()
    for (const name of readdirSync(FIXTURES).filter((file) => /\.(sql|txt)$/.test(file))) {
      for (const [key] of fixture(name).matchAll(/agent:[^\s'",|)]+/g)) keys.add(key)
    }
    expect(keys.size).toBeGreaterThan(10)
    for (const key of keys) expect(OPENCLAW_KEY.exec(key)?.slice(1), key).toEqual(['main', key.slice('agent:main:'.length)])
    for (const key of ['agent:main', 'agent::x', 'agent:main:', 'agent:a b:x', `agent:main:${'x'.repeat(129)}`]) {
      expect(OPENCLAW_KEY.test(key), key).toBe(false)
    }
    // What Harness launches is a key the TUI then shows.
    expect(OPENCLAW_KEY.test(`agent:main:${OPENCLAW_LAUNCH.newSession('0123456789abcdef').at(-1)}`)).toBe(true)
  })

  it('OPENCLAW_COLUMNS names only tables and columns the recorded schema has', () => {
    const recorded = recordedColumns()
    expect(Object.keys(OPENCLAW_COLUMNS).sort()).toEqual(['session_nodes', 'session_transcript_active_events', 'session_windows',
      'transcript_events', 'transcript_rewrite_watermarks'])
    for (const [table, columns] of Object.entries(OPENCLAW_COLUMNS)) {
      expect(columns.filter((column) => !recorded.get(table)?.has(column)), table).toEqual([])
    }
    expect(OPENCLAW_COLUMNS.transcript_events).toContain('navigation_json')
  })

  it('finds an agent\'s database in the state folder, or where the config moved the agent', () => {
    expect(openclawAgentDb('/h/.openclaw', 'main')).toBe(join('/h/.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    expect(openclawAgentDb('/h/.openclaw', 'main', null)).toBe(join('/h/.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
    expect(openclawAgentDb('/h/.openclaw', 'main', '/srv/agents/main')).toBe(join('/srv/agents/main', 'openclaw-agent.sqlite'))
  })

  it('launches a new session under Harness\'s name and resumes a key as the TUI\'s target', () => {
    expect([...OPENCLAW_LAUNCH.base, ...OPENCLAW_LAUNCH.newSession('abc')]).toEqual(['tui', '--session', 'harness-abc'])
    expect([...OPENCLAW_LAUNCH.base, ...OPENCLAW_LAUNCH.resume('agent:main:plain')]).toEqual(['tui', 'agent:main:plain'])
  })
})
