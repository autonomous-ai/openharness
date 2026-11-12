import { describe, expect, it, vi } from 'vitest'
import { claudeConnectors, codexPluginPages, codexPlugins, connectVia, disconnectVia, elsewhere, engineBinary, type Run, type Via } from './elsewhere.js'
import { ICONS } from './generated/icons.js'

/** `claude mcp list` as Claude Code 2.1 prints it. */
const CLAUDE_LIST = [
  'Checking MCP server health…',
  '',
  'linear: harness mcp-shim linear - ✔ Connected',
  'claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✔ Connected',
  'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication',
  'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✗ Failed to connect',
].join('\n')

const CODEX_LIST = JSON.stringify({
  installed: [
    { pluginId: 'gmail@openai-curated-remote', installed: true, source: { source: 'remote', id: 'plugin_connector_1p_gmail' } },
    { pluginId: 'pdf@openai-primary-runtime', installed: true },
    { pluginId: 'google-drive@openai-curated-remote', installed: false },
    { pluginId: 'sharepoint@openai-curated-remote', installed: true },
  ],
  available: [],
})

describe('Gmail, Calendar and Drive through Claude Code or Codex', () => {
  it('reads claude.ai\'s connectors from `claude mcp list`, and only those', () => {
    expect(claudeConnectors(CLAUDE_LIST)).toEqual({ Gmail: 'connected', 'Google Drive': 'reconnect', 'Claude Docs': 'reconnect' })
    expect(claudeConnectors('claude.ai Gmail: https://x - not connected')).toEqual({ Gmail: 'reconnect' })
  })

  it('reads the installed Codex plugins, and nothing from what is not JSON', () => {
    expect([...codexPlugins(CODEX_LIST)]).toEqual(['gmail@openai-curated-remote', 'pdf@openai-primary-runtime', 'sharepoint@openai-curated-remote'])
    expect(codexPlugins('not json').size).toBe(0)
    expect(codexPlugins('null').size).toBe(0)
    expect(codexPlugins('{"installed": {}}').size).toBe(0)
    expect([...codexPlugins('{"installed": [null, {"pluginId": 3}, {"pluginId": "a@b"}]}')]).toEqual(['a@b'])
  })

  it('offers only the engines this computer has, each with its state and scope', async () => {
    const asked: string[][] = []
    const run: Run = async (command, args) => {
      asked.push([command, ...args])
      return command === '/bin/claude' ? CLAUDE_LIST : CODEX_LIST
    }
    const both = await elsewhere({ binary: (name) => `/bin/${name}`, run })
    expect(both.engines).toEqual({ claude: true, codex: true })
    expect(both.connections).toEqual({
      gmail: { claude: 'connected', codex: 'installed' },
      google_calendar: { claude: 'not_connected', codex: 'not_connected' },
      google_drive: { claude: 'reconnect', codex: 'not_connected' },
      // One of its three plugins is in: Codex reaches it.
      microsoft_365: { claude: 'not_connected', codex: 'installed' },
    })
    expect(both.scopes.gmail).toEqual({ claude: 'Read, search, draft, send.', codex: 'Read, search, manage.', harness: 'Send only.' })
    // No Harness sign-in for it, and no Harness card: the apps draw it from here.
    expect(both.scopes.microsoft_365.harness).toBeUndefined()
    expect(both.services).toEqual([{ connector: 'microsoft_365', name: 'Microsoft 365', description: expect.stringContaining('Outlook') }])
    expect(asked).toEqual([['/bin/claude', 'mcp', 'list'], ['/bin/codex', 'plugin', 'list', '--json', '--marketplace', 'openai-curated-remote']])
    // ChatGPT connects each of Microsoft 365's plugins on its own: each with its state, for the apps to offer alone.
    const chatGpt = 'https://chatgpt.com/#settings/Connectors'
    expect(both.parts).toEqual({
      microsoft_365: [
        { plugin: 'outlook-email@openai-curated-remote', name: 'Outlook mail', icon: 'outlook_mail', state: 'not_connected', page: chatGpt },
        { plugin: 'outlook-calendar@openai-curated-remote', name: 'Outlook calendar', icon: 'outlook_calendar', state: 'not_connected', page: chatGpt },
        { plugin: 'sharepoint@openai-curated-remote', name: 'SharePoint', icon: 'sharepoint', state: 'installed', page: chatGpt },
      ],
    })
    // Each part's icon is one the apps carry (assets/web/icons, copied to the desktop and the phone).
    for (const part of both.parts.microsoft_365) expect(ICONS[part.icon]).toMatch(/^data:image\/png;base64,/)
    // Each service's own page in each engine's account, for adding an account there once it is in: the Codex
    // plugin's own where Codex names it, each one's list where not.
    expect(both.pages.gmail).toEqual({
      claude: 'https://claude.ai/new/#customize/connectors/id/gmail-gmailmcp',
      codex: 'https://chatgpt.com/settings/plugins-settings/plugin_connector_1p_gmail',
    })
    expect(both.pages.google_calendar.claude).toBe('https://claude.ai/new/#customize/connectors/id/google-calendar-calendarmcp')
    expect(both.pages.google_drive).toEqual({ claude: 'https://claude.ai/new/#customize/connectors/id/google-drive-drivemcp', codex: chatGpt })

    const none = await elsewhere({ binary: () => null, run })
    expect(none.engines).toEqual({ claude: false, codex: false })
    expect(none.connections.gmail).toEqual({})
    expect(none.parts).toEqual({})
    expect(none.pages.gmail).toEqual({})

    // An engine that cannot answer (signed out, timed out) reads as nothing connected through it.
    const failing = await elsewhere({ binary: (name) => `/bin/${name}`, run: () => Promise.reject(new Error('timed out')) })
    expect(failing.connections.gmail).toEqual({ claude: 'not_connected', codex: 'not_connected' })
  })

  it('lets a slow first read finish past the answer, once, so the next answer has it', async () => {
    // Codex just signed in reads ChatGPT's plugin catalog in about a minute, once (the MSI, 2026-11-12):
    // killed at the answer's 45 s it never saved it, and every later read started over and was killed again.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const asked: { args: string[], timeoutMs: number }[] = []
    let finish: (listing: string) => void = () => {}
    const slow: Run = (command, args, timeoutMs) => {
      asked.push({ args, timeoutMs })
      if (command === '/bin/claude') return Promise.resolve(CLAUDE_LIST)
      return new Promise((resolve) => { finish = resolve })
    }
    const deps = { binary: (name: Via) => `/bin/${name}`, run: slow, answerMs: 5 }
    const [first, second] = await Promise.all([elsewhere(deps), elsewhere(deps)])
    expect(first.connections.gmail).toEqual({ claude: 'connected', codex: 'not_connected' })
    expect(second.connections.gmail).toEqual(first.connections.gmail)
    const codexReads = () => asked.filter((call) => call.args[0] === 'plugin')
    // Two pages asking at once share one read, and it is given minutes, not the answer's seconds.
    expect(codexReads()).toHaveLength(1)
    expect(codexReads()[0].timeoutMs).toBeGreaterThanOrEqual(5 * 60_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[connections] codex has not answered'))

    finish(CODEX_LIST)
    const fast: Run = async (command) => command === '/bin/claude' ? CLAUDE_LIST : CODEX_LIST
    const next = await elsewhere({ ...deps, run: fast })
    expect(next.connections.gmail).toEqual({ claude: 'connected', codex: 'installed' })
    warn.mockRestore()
  })

  it('installs the Codex plugin, then answers the page to sign in on', async () => {
    const asked: string[][] = []
    // What it installs and removes; the list it reads for a plugin's page has its own test below.
    const run: Run = async (command, args) => { if (args[1] !== 'list') asked.push([command, ...args]); return '' }
    const deps = { binary: (name: string) => `/bin/${name}`, run }
    expect(await connectVia('gmail', 'codex', deps)).toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
    expect(asked).toEqual([['/bin/codex', 'plugin', 'add', 'gmail@openai-curated-remote']])
    expect(await connectVia('google_drive', 'claude', deps)).toEqual({ url: 'https://claude.ai/new/#customize/connectors/id/google-drive-drivemcp' })
    // Straight to its own connector, as Gmail, not the directory to look for it in.
    expect(await connectVia('microsoft_365', 'claude', deps)).toEqual({ url: 'https://claude.ai/new/#customize/connectors/id/microsoft-365' })
    expect(asked).toHaveLength(1)
    expect(await disconnectVia('google_calendar', 'codex', deps)).toEqual({})
    expect(asked.at(-1)).toEqual(['/bin/codex', 'plugin', 'remove', 'google-calendar@openai-curated-remote'])
    expect(await disconnectVia('gmail', 'claude', deps)).toEqual({ url: 'https://claude.ai/new/#customize/connectors/id/gmail-gmailmcp' })
    expect(asked).toHaveLength(2)
    // Microsoft 365 is three plugins to Codex: asked with none named (an app from before parts), all of them in and out.
    await connectVia('microsoft_365', 'codex', deps)
    await disconnectVia('microsoft_365', 'codex', deps)
    expect(asked.slice(2).map((call) => call.slice(2).join(' '))).toEqual([
      'add outlook-email@openai-curated-remote', 'add outlook-calendar@openai-curated-remote', 'add sharepoint@openai-curated-remote',
      'remove outlook-email@openai-curated-remote', 'remove outlook-calendar@openai-curated-remote', 'remove sharepoint@openai-curated-remote',
    ])
  })

  it('installs one of a service\'s plugins when it is named, and opens that plugin\'s own page on ChatGPT', async () => {
    // As Codex 0.167 lists them (the MSI, 2026-11-12): each plugin's `source.id` is its page on ChatGPT.
    const listing = JSON.stringify({
      installed: [
        { pluginId: 'gmail@openai-curated-remote', source: { source: 'remote', id: 'plugin_connector_1p_95d39881713c8191931482a62d6edff9' } },
        { pluginId: 'outlook-calendar@openai-curated-remote', source: { source: 'remote', id: 'plugin_connector_1p_fd0f4f41caa88191a9456514bbffa06d' } },
        { pluginId: 'sharepoint@openai-curated-remote', source: { source: 'remote', id: 'not/a plain id' } },
      ],
    })
    const asked: string[] = []
    const run: Run = async (_command, args) => { asked.push(args.join(' ')); return listing }
    const deps = { binary: (name: string) => `/bin/${name}`, run }
    expect(await connectVia('gmail', 'codex', deps))
      .toEqual({ url: 'https://chatgpt.com/settings/plugins-settings/plugin_connector_1p_95d39881713c8191931482a62d6edff9' })
    expect(await connectVia('microsoft_365', 'codex', deps, 'outlook-calendar@openai-curated-remote'))
      .toEqual({ url: 'https://chatgpt.com/settings/plugins-settings/plugin_connector_1p_fd0f4f41caa88191a9456514bbffa06d' })
    // An id that is not plainly one never becomes an address; ChatGPT's list opens instead.
    expect(await connectVia('microsoft_365', 'codex', deps, 'sharepoint@openai-curated-remote'))
      .toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
    // Removing one is removing it here, and nothing to open: no page asked for.
    asked.length = 0
    expect(await disconnectVia('microsoft_365', 'codex', deps, 'sharepoint@openai-curated-remote')).toEqual({})
    expect(asked).toEqual(['plugin remove sharepoint@openai-curated-remote'])
    asked.length = 0
    await connectVia('gmail', 'codex', deps)
    await connectVia('microsoft_365', 'codex', deps, 'outlook-calendar@openai-curated-remote')
    expect(asked.filter((call) => !call.startsWith('plugin list'))).toEqual([
      'plugin add gmail@openai-curated-remote', 'plugin add outlook-calendar@openai-curated-remote',
    ])
    // A plugin of another service, or none Codex has, is refused before anything is installed.
    asked.length = 0
    await expect(connectVia('microsoft_365', 'codex', deps, 'gmail@openai-curated-remote')).rejects.toThrow('Choose one of this service')
    await expect(connectVia('microsoft_365', 'codex', deps, 7)).rejects.toThrow('Choose one of this service')
    expect(asked).toEqual([])
    // Codex that cannot list: the plugin is in, and ChatGPT's list opens.
    let installs = 0
    const noList: Run = async (_command, args) => { if (args[1] === 'list') throw new Error('timed out'); installs++; return '' }
    expect(await connectVia('gmail', 'codex', { ...deps, run: noList })).toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
    expect(installs).toBe(1)
  })

  it('reads each plugin\'s page from what Codex lists, and nothing from what is not that', () => {
    expect(codexPluginPages('not json').size).toBe(0)
    expect(codexPluginPages('null').size).toBe(0)
    expect([...codexPluginPages(JSON.stringify({
      installed: [{ pluginId: 'a@m', source: { id: 'x_1' } }, { pluginId: 'b@m' }, null],
      available: [{ pluginId: 'c@m', source: { id: 'y_2' } }],
    }))]).toEqual([['a@m', 'https://chatgpt.com/settings/plugins-settings/x_1'], ['c@m', 'https://chatgpt.com/settings/plugins-settings/y_2']])
  })

  it('says why it cannot, in words a person can act on', async () => {
    const none = { binary: () => null, run: async () => '' }
    await expect(connectVia('gmail', 'codex', none)).rejects.toThrow('Codex is not installed')
    await expect(connectVia('gmail', 'claude', none)).rejects.toThrow('Claude Code is not installed')
    await expect(connectVia('linear', 'claude', none)).rejects.toThrow('Only Gmail, Google Calendar, Google Drive and Microsoft 365')
    await expect(connectVia(7, 'claude', none)).rejects.toThrow('Only Gmail')
    await expect(connectVia('gmail', 'opencode', none)).rejects.toThrow('Choose Claude or Codex')
    const broken = { binary: (name: string) => `/bin/${name}`, run: () => Promise.reject(new Error('exit 1')) }
    await expect(connectVia('gmail', 'codex', broken)).rejects.toThrow('could not install its plugin')
    await expect(disconnectVia('gmail', 'codex', broken)).rejects.toThrow('could not remove its plugin')
    // Codex gone since: nothing to remove here, only the account's page.
    // Codex gone since: nothing to remove, and nothing to open.
    expect(await disconnectVia('gmail', 'codex', none)).toEqual({})
  })

  it('finds an engine on the PATH it is given', () => {
    expect(engineBinary('claude', { PATH: '/nowhere' })).toBeNull()
  })
})
