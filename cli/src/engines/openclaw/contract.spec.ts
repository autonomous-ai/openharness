import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPENCLAW_COLUMNS, OPENCLAW_FIRST_TASK, OPENCLAW_KEY, OPENCLAW_LAUNCH, OPENCLAW_LOCAL, OPENCLAW_STATES, OPENCLAW_STORE_KEPT,
  isOpenclawLocalStopped, openclawAgentDb, openclawBoxHolds, openclawDefaultStateDir, openclawFolderInUse, openclawLocalStopped,
  readOpenclawScreen,
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
  'screen-answer-history-words.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-banner.txt': { key: null, url: null },
  'screen-box-scrolled.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-connecting.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-disconnected.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-fail-model.txt': { key: 'agent:main:fail', url: 'ws://127.0.0.1:18789' },
  'screen-fail.txt': { key: 'agent:main:fail', url: 'ws://127.0.0.1:18789' },
  'screen-gateway-starting.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-history-failed.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-history-refused.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
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
  'screen-running-quiet.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-sending.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-starting-up-disconnected.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-starting-up.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-startup-failed.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
  'screen-tool.txt': { key: 'agent:main:tool', url: 'ws://127.0.0.1:18789' },
  'screen-two-panes-main-a.txt': { key: 'agent:main:main', url: 'ws://127.0.0.1:18789' },
  'screen-two-panes-main-b.txt': { key: 'agent:main:main', url: null },
  'screen-waiting.txt': { key: 'agent:main:plain', url: 'ws://127.0.0.1:18789' },
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
    expect(readOpenclawScreen(running.replace('running •', 'connecting •'))).toMatchObject({ state: 'starting', running: false })
    for (const idle of ['screen-plain.txt', 'screen-no-gateway.txt', 'screen-no-token.txt']) expect(readOpenclawScreen(fixture(idle)).running, idle).toBe(false)
  })

  // Launch to ready, a run, and a history load that failed, as the TUI draws them (`__fixtures__/MISSING.md`).
  it.each([
    ['banner', { key: null, state: null, status: null, box: null, running: false, gatewayLost: false }],
    ['connecting', { state: 'starting', status: 'connecting | idle', box: '', running: false, gatewayLost: false }],
    ['starting-up', { state: 'starting', status: '⠙ starting up • 0s | subscribing to session events', box: '', running: false, gatewayLost: false, gatewayStarting: false }],
    // A cold Gateway on a slow machine: the TUI starts up for over a minute, the Gateway answering it is starting.
    ['gateway-starting', { state: 'starting', status: '⠙ starting up • 20s | gateway starting', box: '', running: false, gatewayLost: false, gatewayStarting: true }],
    ['starting-up-disconnected', { state: 'starting', status: '⠴ starting up • 25s | disconnected', box: '', running: false, gatewayLost: false, gatewayStarting: false }],
    ['sending', { state: 'busy', status: '⠋ sending • 0s | connected', box: '', running: false, gatewayLost: false }],
    ['waiting', { state: 'busy', status: '⠼ flibbertigibbeting… • 0s | connected', box: '', running: false, gatewayLost: false }],
    ['running-quiet', { state: 'busy', status: '⠦ running • 45s | connected', box: '', running: true, gatewayLost: false }],
    ['history-failed', { state: 'no-history', status: 'gateway connected | idle', box: '', running: false, gatewayLost: false }],
    ['history-refused', { state: 'no-history', status: 'connected | idle', box: 'Say hello from scenario proxy-histdrop 1795078028664', running: false, gatewayLost: false }],
    ['disconnected', { state: null, status: 'disconnected | idle', box: '', running: false, gatewayLost: true }],
    ['startup-failed', { state: null, status: 'startup failed | idle', box: '', running: false, gatewayLost: false }],
    ['answer-history-words', { state: 'ready', status: 'connected | idle', box: '', running: false, gatewayLost: false }],
    ['plain', { state: 'ready', status: 'connected | idle', box: '', running: false, gatewayLost: false }],
  ])('screen-%s reads as the TUI drew it', (name, reading) => {
    expect(readOpenclawScreen(fixture(`screen-${name}.txt`))).toMatchObject(reading)
  })

  it('a spinner line with a timer is a run, in minutes too, and starting up stays starting', () => {
    const plain = fixture('screen-plain.txt')
    const status = (line: string) => readOpenclawScreen(plain.replace(' connected | idle', ` ${line}`)).state
    expect(status('⠋ finishing context • 1m 5s | connected')).toBe('busy')
    expect(status('⠋ kerfuffling… • 12s | gateway connected')).toBe('busy')
    expect(status('⠋ starting up • 3s | connected')).toBe('starting')
    expect(status('⠋ connecting…')).toBe('starting')
  })

  it('a connected TUI with no spinner is ready, whatever its activity word says', () => {
    const plain = fixture('screen-plain.txt')
    const status = (line: string) => readOpenclawScreen(plain.replace(' connected | idle', ` ${line}`)).state
    // A message refused while the TUI started leaves `disconnected` as its activity once it connects (tui `onConnected`).
    for (const line of ['connected | idle', 'gateway connected | idle', 'gateway reconnected | aborted', 'connected | disconnected',
      'gateway connected | disconnected', 'connected | tools expanded', 'connected | tools collapsed', 'connected | abort failed',
      'event gap: expected 12, got 15 | idle', 'local ready', 'local ready | tools collapsed']) {
      expect(status(line), line).toBe('ready')
    }
    for (const line of ['disconnected | idle', 'disconnected | disconnected', 'startup failed | idle', 'session event subscription failed | idle',
      'connectedness | idle']) {
      expect(status(line), line).toBeNull()
    }
  })

  it('only a history line OpenClaw drew in the chat makes a ready pane one whose history did not load', () => {
    const plain = fixture('screen-plain.txt')
    const above = (line: string) => readOpenclawScreen(plain.replace(' connected | idle', `${line}\n connected | idle`)).state
    expect(above(' history failed: gateway request timeout for chat.history')).toBe('no-history')
    expect(above(' session history not ready — wait or retry /session')).toBe('no-history')
    expect(above('session history not ready — wait or retry /session')).toBe('ready')
    expect(above('  history failed: quoted')).toBe('ready')
    // A run under the line is a run: the history loaded since.
    expect(readOpenclawScreen(plain.replace(' connected | idle', ' history failed: x\n ⠦ running • 3s | connected')).state).toBe('busy')
  })

  it('the box holds a message only when it shows all of it, wrapped or not', () => {
    const message = 'Say hello from scenario proxy-histdrop 1795078028664 and then list the files here'
    const wrapped = fixture('screen-history-refused.txt')
      .replace('Say hello from scenario proxy-histdrop 1795078028664', 'Say hello from scenario proxy-histdrop\n1795078028664 and then list the files here  ')
    const box = readOpenclawScreen(wrapped).box
    expect(box).toBe('Say hello from scenario proxy-histdrop 1795078028664 and then list the files here')
    expect(openclawBoxHolds(box, message)).toBe(true)
    expect(openclawBoxHolds(box, 'Say  hello\nfrom scenario proxy-histdrop 1795078028664 and then\tlist the files here ')).toBe(true)
    expect(openclawBoxHolds('hi', 'hi')).toBe(true)
    // Text the person typed after the message, or in place of it, is theirs: an Enter would send it.
    expect(openclawBoxHolds(box, 'Say hello from scenario proxy-histdrop')).toBe(false)
    expect(openclawBoxHolds("yesterday's build failed, can you", 'yes')).toBe(false)
    expect(openclawBoxHolds(box, 'Something else entirely')).toBe(false)
    expect(openclawBoxHolds('Say hello from', message)).toBe(false)
    expect(openclawBoxHolds('', message)).toBe(false)
    expect(openclawBoxHolds(null, message)).toBe(false)
    expect(openclawBoxHolds('anything', '  ')).toBe(false)
  })

  it('a paste over 10 lines or 1000 characters holds the message its marker counts', () => {
    // pi-tui's editor draws such a paste as one marker, its lines or its characters as it counts them (`handlePaste`).
    const long = 'word '.repeat(250)
    const pasted = fixture('screen-plain.txt').replace(/(─{8,}\n)\n(─{8,})/, '$1[paste #1 1250 chars]\n$2')
    const box = readOpenclawScreen(pasted).box
    expect(box).toBe('[paste #1 1250 chars]')
    expect(openclawBoxHolds(box, long)).toBe(true)
    expect(openclawBoxHolds(box, `${long}more`)).toBe(false)
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
    expect(openclawBoxHolds('[paste #1 +12 lines]', lines)).toBe(true)
    expect(openclawBoxHolds('[paste #2 +12 lines]', lines.replace(/\n/g, '\r\n'))).toBe(true)
    expect(openclawBoxHolds('[paste #1 +13 lines]', lines)).toBe(false)
    // A line break is one character and a tab four, as the editor counts them.
    expect(openclawBoxHolds('[paste #1 1205 chars]', `${'x'.repeat(600)}\r\n\t${'y'.repeat(600)}`)).toBe(true)
    expect(openclawBoxHolds('[paste #1 1250 chars] and this', long)).toBe(false)
  })

  it('a box taller than the TUI shows it is read through its scroll borders, and holds the message whose part it shows', () => {
    // At tmux's default 80x24 the box shows 7 lines (pi-tui's editor: 30% of the rows, at least 5): a message OpenClaw
    // refused and put back with its cursor at the end shows its last lines under `↑ 1 more`.
    const message = 'Read the build log in ci/last-run.txt and find the first test that failed. Explain in two sentences why it '
      + 'failed, quoting the assertion message exactly as the log prints it. Then open the test file, find the code under '
      + 'test, and propose the smallest change to the code (not the test) that would make the assertion pass. Do not edit '
      + 'any file yet: list the change as a unified diff, say which other tests call the same function, and say whether any '
      + 'of them would change their result. Finish with one line that starts with VERDICT: and names the file you would change.'
    const scrolled = fixture('screen-box-scrolled.txt')
    const screen = readOpenclawScreen(scrolled)
    expect(screen).toMatchObject({ key: 'agent:main:plain', state: 'ready', boxHidden: { above: 1, below: 0 } })
    expect(screen.box).toMatch(/^Explain in two sentences .* names the file you would change\.$/)
    expect(openclawBoxHolds(screen.box, message, screen.boxHidden)).toBe(true)
    expect(openclawBoxHolds(screen.box, `${message} Keep it short.`, screen.boxHidden)).toBe(false)
    // The cursor moved up: the box shows the message's start, `↓ N more` under it, or a part of it with both.
    const down = scrolled.replace(/^─+ ↑ 1 more ─+$/m, '─'.repeat(80)).replace(/^─{80}$(?![\s\S]*^─)/m, `${'─'.repeat(35)} ↓ 2 more ${'─'.repeat(35)}`)
    expect(readOpenclawScreen(down)).toMatchObject({ state: 'ready', boxHidden: { above: 0, below: 2 } })
    expect(openclawBoxHolds('Read the build log in ci/last-run.txt and find the first', message, { above: 0, below: 2 })).toBe(true)
    expect(openclawBoxHolds('Explain in two sentences why it failed', message, { above: 1, below: 2 })).toBe(true)
    expect(openclawBoxHolds('Explain in two sentences why it failed', message, { above: 0, below: 2 })).toBe(false)
  })

  it('says a first task OpenClaw did not take', () => {
    expect(OPENCLAW_FIRST_TASK).toEqual({ error: 'FIRST_TASK_NOT_TAKEN', detail: 'OpenClaw did not take the first task. Close it and start it again.' })
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
    expect(readOpenclawScreen(local('starting local runtime'))).toMatchObject({ state: 'starting', running: false })
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
