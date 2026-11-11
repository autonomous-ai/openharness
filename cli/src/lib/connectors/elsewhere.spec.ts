import { describe, expect, it } from 'vitest'
import { claudeConnectors, codexPlugins, connectVia, disconnectVia, elsewhere, engineBinary, type Run } from './elsewhere.js'

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
    { pluginId: 'gmail@openai-curated-remote', installed: true },
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
    expect(both.scopes.gmail).toEqual({ claude: 'Read, search, draft. No sending.', codex: 'Read, search, manage.', harness: 'Send only.' })
    // No Harness sign-in for it, and no Harness card: the apps draw it from here.
    expect(both.scopes.microsoft_365.harness).toBeUndefined()
    expect(both.services).toEqual([{ connector: 'microsoft_365', name: 'Microsoft 365', description: expect.stringContaining('Outlook') }])
    expect(asked).toEqual([['/bin/claude', 'mcp', 'list'], ['/bin/codex', 'plugin', 'list', '--json']])

    const none = await elsewhere({ binary: () => null, run })
    expect(none.engines).toEqual({ claude: false, codex: false })
    expect(none.connections.gmail).toEqual({})

    // An engine that cannot answer (signed out, timed out) reads as nothing connected through it.
    const failing = await elsewhere({ binary: (name) => `/bin/${name}`, run: () => Promise.reject(new Error('timed out')) })
    expect(failing.connections.gmail).toEqual({ claude: 'not_connected', codex: 'not_connected' })
  })

  it('installs the Codex plugin, then answers the page to sign in on', async () => {
    const asked: string[][] = []
    const run: Run = async (command, args) => { asked.push([command, ...args]); return '' }
    const deps = { binary: (name: string) => `/bin/${name}`, run }
    expect(await connectVia('gmail', 'codex', deps)).toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
    expect(asked).toEqual([['/bin/codex', 'plugin', 'add', 'gmail@openai-curated-remote']])
    expect(await connectVia('google_drive', 'claude', deps)).toEqual({ url: 'https://claude.ai/new#customize/connectors' })
    expect(asked).toHaveLength(1)
    expect(await disconnectVia('google_calendar', 'codex', deps)).toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
    expect(asked.at(-1)).toEqual(['/bin/codex', 'plugin', 'remove', 'google-calendar@openai-curated-remote'])
    expect(await disconnectVia('gmail', 'claude', deps)).toEqual({ url: 'https://claude.ai/new#customize/connectors/id/gmail-gmailmcp' })
    expect(asked).toHaveLength(2)
    // Microsoft 365 is three plugins to Codex: all of them in, all of them out.
    await connectVia('microsoft_365', 'codex', deps)
    await disconnectVia('microsoft_365', 'codex', deps)
    expect(asked.slice(2).map((call) => call.slice(2).join(' '))).toEqual([
      'add outlook-email@openai-curated-remote', 'add outlook-calendar@openai-curated-remote', 'add sharepoint@openai-curated-remote',
      'remove outlook-email@openai-curated-remote', 'remove outlook-calendar@openai-curated-remote', 'remove sharepoint@openai-curated-remote',
    ])
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
    expect(await disconnectVia('gmail', 'codex', none)).toEqual({ url: 'https://chatgpt.com/#settings/Connectors' })
  })

  it('finds an engine on the PATH it is given', () => {
    expect(engineBinary('claude', { PATH: '/nowhere' })).toBeNull()
  })
})
