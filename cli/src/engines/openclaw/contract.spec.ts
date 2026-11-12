import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPENCLAW_COLUMNS, OPENCLAW_KEY, OPENCLAW_LAUNCH, OPENCLAW_LOCAL, OPENCLAW_STATES, OPENCLAW_STORE_KEPT, isOpenclawLocalStopped,
  openclawAgentDb, openclawDefaultStateDir, openclawFolderInUse, openclawLocalStopped, readOpenclawScreen,
} from './contract.js'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const screens = readdirSync(FIXTURES).filter((name) => /^screen-.*\.txt$/.test(name)).sort()

/**
 * The key and the Gateway URL each recorded screen shows (OpenClaw 2026.11.2). Every screen is listed, so a new
 * recording fails here until someone has said what it shows.
 * - The key is the footer's, which every running TUI draws last, the no-gateway ones too.
 * - The no-token and remote-without-credentials runs exit before the TUI opens.
 * - The second of two 80-column panes on main has scrolled its title off and wraps its footer.
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
  'screen-no-gateway-bare.txt': { key: 'agent:main:rewind', url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway-reconnected.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-no-gateway.txt': { key: 'agent:main:no-gateway', url: 'ws://127.0.0.1:18789' },
  'screen-no-token.txt': { key: null, url: null },
  'screen-plain-darwin.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain-start-darwin.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain-start.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-plain-win32.txt': { key: 'agent:main:win-check', url: 'ws://127.0.0.1:18789' },
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
  it('reads the key off the footer of every recorded screen, and the Gateway URL off its title', () => {
    expect(screens).toEqual(Object.keys(SHOWN).sort())
    for (const screen of screens) {
      const shown = readOpenclawScreen(fixture(screen))
      expect({ key: shown.key, url: shown.url }, screen).toEqual(SHOWN[screen])
      if (shown.url) expect(LOOPBACK.has(new URL(shown.url).hostname), screen).toBe(screen !== 'screen-remote.txt')
    }
  })

  it('a long session whose title scrolled off is still read from its footer, wrapped at 80 columns', () => {
    const long = fixture('screen-main-heartbeat.txt').split('\n').slice(3).join('\n')
    expect(long).not.toContain('openclaw tui -')
    expect(readOpenclawScreen(long)).toMatchObject({ key: 'agent:main:main', url: null, state: 'ready' })
  })

  it('reads a title and a footer the TUI word-wrapped, on a Harness key at 80 and 100 columns, local and remote', () => {
    // A launch key is `harness-<agent uuid>`: the title is then 103 characters. The TUI pads its text one column and
    // wraps it at spaces (`Text(…, 1, 0)` in OpenClaw's tui).
    const key = 'harness-aaaaaaaa-1111-4222-8333-000000000001'
    const wrap = (text: string, columns: number): string[] => {
      const lines: string[] = []
      let line = ''
      for (const word of text.split(' ')) {
        if (line && line.length + 1 + word.length > columns - 2) { lines.push(` ${line}`); line = word }
        else line = line ? `${line} ${word}` : word
      }
      return [...lines, ` ${line}`]
    }
    for (const columns of [80, 100]) {
      for (const url of ['ws://127.0.0.1:18789', 'ws://172.17.0.3:18789']) {
        const draw = (titled: string): string => [
          ...wrap(`openclaw tui - ${url} - agent main - session ${titled}`, columns),
          '',
          ` session agent:main:${key}`,
          ' connected | idle',
          ...wrap(`agent main | session ${key} | deepseek/deepseek-v4.1-flash | deliver:off | tokens ?`, columns),
          '─'.repeat(columns), '', '─'.repeat(columns),
        ].join('\n')
        const capture = draw(key)
        expect(capture.split('\n')[1], `${columns}`).not.toBe('')
        const remote = url !== 'ws://127.0.0.1:18789'
        expect(readOpenclawScreen(capture), `${columns} ${url}`).toMatchObject({
          key: `agent:main:${key}`, url, state: remote ? 'remote' : 'ready',
        })
        // The title still has to name the footer's session.
        expect(readOpenclawScreen(draw(`${key}-other`)).key, `${columns} ${url}`).toBeNull()
      }
    }
  })

  it('a line the model wrote is never taken for the session', () => {
    // The session line under the title is one more chat line: an answer can print the same words.
    const said = fixture('screen-plain.txt').replace(' connected | idle', ' session agent:main:other\n agent main | session other | m | deliver:off |\n connected | idle')
    expect(readOpenclawScreen(said).key).toBe('agent:main:plain')
    // A title-like line in the chat that names another session stops the read instead of moving it.
    const titled = fixture('screen-plain.txt').replace(' connected | idle', ' openclaw tui - ws://127.0.0.1:18789 - agent main - session other\n connected | idle')
    expect(readOpenclawScreen(titled).key).toBeNull()
  })

  it('a TUI restarted in the same pane is read only once it has drawn its own footer', () => {
    const exited = `${fixture('screen-plain.txt').trimEnd()}\n$ openclaw tui --session other\n`
    expect(readOpenclawScreen(exited).key).toBeNull()
    const titled = `${exited} openclaw tui - ws://127.0.0.1:18789 - agent main - session other\n\n session agent:main:other\n`
    expect(readOpenclawScreen(titled).key).toBeNull()
    const drawn = `${titled} connected | idle\n agent main | session other | deepseek/deepseek-v4.1-flash | deliver:off | tokens ?\n${'─'.repeat(40)}\n\n${'─'.repeat(40)}\n`
    expect(readOpenclawScreen(drawn)).toMatchObject({ key: 'agent:main:other', state: 'ready' })
  })

  it('names the agent and the session even when the TUI labels them', () => {
    const labelled = fixture('screen-plain.txt')
      .replace('agent main - session plain', 'agent main (Molty) - session plain')
      .replace('agent main | session plain |', 'agent main (Molty) | session plain (Fix the parser) |')
    expect(readOpenclawScreen(labelled).key).toBe('agent:main:plain')
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
    expect(OPENCLAW_COLUMNS.transcript_events).toContain('event_utf8_bytes')
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

  it('reads a run in progress off the status line: running and streaming, never connecting', () => {
    const running = fixture('screen-abort-running.txt')
    expect(readOpenclawScreen(running)).toMatchObject({ state: 'busy', running: true })
    expect(readOpenclawScreen(running.replace('running •', 'streaming •'))).toMatchObject({ state: 'busy', running: true })
    expect(readOpenclawScreen(running.replace('running •', 'connecting •'))).toMatchObject({ state: 'busy', running: false })
    for (const idle of ['screen-plain.txt', 'screen-no-gateway.txt', 'screen-no-token.txt']) expect(readOpenclawScreen(fixture(idle)).running, idle).toBe(false)
  })

  it('the default state folder is the one OpenClaw resolves', () => {
    const at = (vars: Record<string, string>) => openclawDefaultStateDir(vars, '/home/u')
    expect(at({})).toBe('/home/u/.openclaw')
    expect(at({ OPENCLAW_HOME: '/h' })).toBe('/h/.openclaw')
    expect(at({ OPENCLAW_STATE_DIR: '~/x' })).toBe('/home/u/x')
    expect(at({ OPENCLAW_STATE_DIR: '~/x', OPENCLAW_HOME: '/h' })).toBe('/h/x')
    expect(at({ OPENCLAW_STATE_DIR: '  /s  ' })).toBe('/s')
    expect(at({ OPENCLAW_STATE_DIR: '~' })).toBe('/home/u')
    expect(at({ OPENCLAW_HOME: '~/claw' })).toBe('/home/u/claw/.openclaw')
    expect(at({ OPENCLAW_STATE_DIR: '   ', OPENCLAW_HOME: ' ' })).toBe('/home/u/.openclaw')
  })

  it('the launch contract types the first prompt, names the daemon variables, and the store state reads as written', () => {
    expect(OPENCLAW_LAUNCH.firstPrompt).toBe('typed')
    expect(OPENCLAW_LAUNCH.environment).toEqual(['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME'])
    expect(OPENCLAW_STATES.noSessions).toBe("Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's OPENCLAW_STATE_DIR, then restart this agent.")
  })

  const local = (status: string) => fixture('screen-plain.txt')
    .replace('openclaw tui - ws://127.0.0.1:18789 - ', 'openclaw tui - local embedded - ').replace(' connected | idle', ` ${status}`)

  it('reads a local run off its status line', () => {
    expect(readOpenclawScreen(local('local ready | idle'))).toMatchObject({ key: 'agent:main:plain', url: null, state: 'ready', running: false, stopped: null })
    expect(readOpenclawScreen(local('local ready')).state).toBe('ready')
    expect(readOpenclawScreen(local('starting local runtime'))).toMatchObject({ state: 'busy', running: false })
    expect(readOpenclawScreen(local('⠏ running • 6s | local ready'))).toMatchObject({ state: 'busy', running: true })
    expect(readOpenclawScreen(local('local runtime stopped: boom | idle'))).toMatchObject({ state: 'local-stopped', stopped: 'boom' })
    expect(readOpenclawScreen(local('local runtime stopped | idle'))).toMatchObject({ state: 'local-stopped', stopped: '' })
    expect(readOpenclawScreen(local('local stopped | idle'))).toMatchObject({ state: 'local-stopped', stopped: null })
    expect(readOpenclawScreen(local('local runtime stopped: model relay refused the\n request | idle')))
      .toMatchObject({ state: 'local-stopped', stopped: 'model relay refused the request' })
    expect(readOpenclawScreen(fixture('screen-plain.txt')).stopped).toBeNull()
  })

  it('a stopped line the model wrote above a live status line is not a stop', () => {
    const said = fixture('screen-plain.txt').replace(' connected | idle', ' local runtime stopped: said\n connected | idle')
    expect(readOpenclawScreen(said)).toMatchObject({ state: 'ready', stopped: null })
  })

  it('says a stopped local run, with its reason when it has one', () => {
    expect(openclawLocalStopped('boom')).toBe("OpenClaw's local run stopped: boom")
    expect(openclawLocalStopped('')).toBe("OpenClaw's local run stopped.")
    expect(openclawLocalStopped(null)).toBe("OpenClaw's local run stopped.")
    expect(isOpenclawLocalStopped("OpenClaw's local run stopped: boom")).toBe(true)
    expect(isOpenclawLocalStopped(OPENCLAW_STATES.noGateway)).toBe(false)
    expect(Object.values(OPENCLAW_STATES).some(isOpenclawLocalStopped)).toBe(false)
  })

  it('knows the words OpenClaw leaves when its folder is taken', () => {
    expect(openclawFolderInUse('A Gateway is running for this state directory (pid 7, port 18789). Run without --local to use it')).toBe(true)
    expect(openclawFolderInUse('Error: failed to acquire gateway state ownership')).toBe(true)
    expect(openclawFolderInUse(fixture('screen-no-token.txt'))).toBe(false)
  })

  it('the local launch words and copy read as written', () => {
    expect(OPENCLAW_LAUNCH.local).toEqual(['--local'])
    expect(OPENCLAW_LAUNCH.resumeLocal('agent:main:harness-1')).toEqual(['--session', 'agent:main:harness-1'])
    expect(OPENCLAW_LAUNCH.localClear).toEqual(['OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR', 'OPENCLAW_OAUTH_DIR', 'OPENCLAW_WORKSPACE_DIR'])
    expect(OPENCLAW_LOCAL).toMatchObject({ notOpenclaw: '--local is for OpenClaw only.',
      folderInUse: 'Another OpenClaw is using this folder. Give each run its own --local folder.',
      folderGone: "This run's OpenClaw folder is gone.", noFork: 'This run cannot be forked.',
      unprepared: 'This Harness could not prepare the --local folder. Nothing was started.' })
    expect(OPENCLAW_LOCAL.notFolder('/nowhere')).toBe('/nowhere is not a folder.')
    expect(OPENCLAW_STORE_KEPT).toBe("OpenClaw's store is kept: delete its session with OpenClaw.")
  })
})
