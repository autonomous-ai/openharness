import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateHookCredential } from '../lib/hookAuth.js'
import { settingsCommand, SETTINGS_SIGNED_OUT, SETTINGS_USAGE } from './settings.js'

/** This computer's daemon as `harness settings` meets it: its answers to `/api/agent-settings`, and what was asked. */
function daemon(answer: (method: string, body: unknown) => { status: number; body: unknown } | Error, env: NodeJS.ProcessEnv = {}) {
  const asked: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    asked.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body })
    const reply = answer(String(init.method), body)
    if (reply instanceof Error) throw reply
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status })
  }) as unknown as typeof globalThis.fetch
  const out: string[] = [], err: string[] = []
  const run = (...argv: string[]) => settingsCommand(argv, { port: 4321, fetch, env, out: (l) => out.push(l), err: (l) => err.push(l) })
  return { run, asked, out, err }
}

const OFF = { agentsStartAgents: false, pullRequestLine: false, agentMessages: false, agentMessagesHideSummary: false, agentsTellAgents: false }

describe('harness settings', () => {
  it('lists the account\'s settings as this computer keeps them, every one off until turned on', async () => {
    const d = daemon(() => ({ status: 200, body: { ...OFF, signedIn: true } }))
    expect(await d.run()).toBe(0)
    expect(d.out).toEqual([[
      'agents-start-agents         off  agents may start, wait for and close harnesses of their own',
      'agents-tell-agents          off  an agent may give more work to a harness it started',
      'pull-request-line           off  a harness another agent starts says so in the pull requests it opens',
      'agent-messages              off  agents in the same tab may message each other',
      'agent-messages-hide-summary off  the one-line summary of what a harness does is kept from a shared tab\'s other accounts',
      'programs-reply              off  a program acting for you may give more work to an idle harness of yours',
    ].join('\n')])
    expect(d.asked).toEqual([{ url: 'http://127.0.0.1:4321/api/agent-settings', method: 'GET', headers: { 'x-adapter-local': '1' }, body: undefined }])
    expect(SETTINGS_USAGE).toContain('experiments of your account, the same on each of its\ncomputers, and each off until you turn it on')
  })

  it('says a computer signed out has none to turn on', async () => {
    const d = daemon(() => ({ status: 200, body: { ...OFF, agentMessages: true, signedIn: false } }))
    expect(await d.run()).toBe(0)
    expect(d.out[0]).toMatch(/^agent-messages +on /m)
    expect(d.out[1]).toBe(SETTINGS_SIGNED_OUT)
  })

  it('turns one on or off for the account, through the daemon', async () => {
    const d = daemon((method, body) => ({ status: 200, body: { ...OFF, ...(body as object), signedIn: true } }))
    expect(await d.run('agent-messages', 'on')).toBe(0)
    expect(d.out.pop()).toBe('agent-messages is on for your account.')
    expect(d.asked.pop()).toEqual({ url: 'http://127.0.0.1:4321/api/agent-settings', method: 'PATCH',
      headers: { 'x-adapter-local': '1', 'content-type': 'application/json' }, body: { agentMessages: true } })
    expect(await d.run('agents-start-agents', 'off')).toBe(0)
    expect(d.out.pop()).toBe('agents-start-agents is off for your account.')
    expect(d.asked.pop()!.body).toEqual({ agentsStartAgents: false })
    expect(await d.run('pull-request-line', 'on')).toBe(0)
    expect(d.out.pop()).toBe('pull-request-line is on for your account.')
  })

  it('says why it could not: signed out, the account out of reach, an odd answer, or no daemon', async () => {
    const signedOut = daemon(() => ({ status: 409, body: { error: { code: 'SIGNED_OUT', message: 'Sign in to Harness to change this.' } } }))
    expect(await signedOut.run('agent-messages', 'on')).toBe(1)
    expect(signedOut.err).toEqual(['Sign in to Harness to change this.'])
    const odd = daemon(() => ({ status: 503, body: 'not json' }))
    expect(await odd.run('agent-messages', 'off')).toBe(1)
    expect(await odd.run()).toBe(1)
    expect(odd.err).toEqual(['Harness could not change the settings (503).', 'Harness could not read the settings (503).'])
    const down = daemon(() => Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
    expect(await down.run()).toBe(1)
    expect(down.err).toHaveLength(1)
    expect(down.out).toEqual([])
  })

  it('has an agent ask the person before it turns one on, with its own tool for asking them', async () => {
    for (const agent of [{ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }, { CODEX_THREAD_ID: 't' }, { AI_AGENT: 'cursor' }]) {
      const d = daemon((method, body) => ({ status: 200, body: { ...OFF, ...(body as object), signedIn: true } }), agent)
      expect(await d.run('agents-start-agents', 'on')).toBe(5)
      expect(d.err).toEqual(['agents-start-agents is off. Ask the person, with your tool for asking them (Claude Code: AskUserQuestion; '
        + 'Codex: request_user_input), or in your reply, and wait for their answer: "May I start other agents (Claude Code, Codex) in '
        + 'harnesses of their own, for work that can run beside mine?" Only if they say yes, run `harness settings agents-start-agents '
        + 'on --person-said-yes` (through MCP: harness_settings with person_said_yes), then try again. Never answer it for them. '
        + 'If they say no: leave it as it is, and do the work another way.'])
      // Nothing was asked of the daemon.
      expect(d.asked).toEqual([])
      expect(await d.run('agent-messages', 'off')).toBe(0)
      expect(await d.run()).toBe(0)
    }
  })

  it('turns one on for an agent once the person said yes, and says who did in what it sends', async () => {
    const agent = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }
    const d = daemon((method, body) => ({ status: 200, body: { ...OFF, ...(body as object), signedIn: true } }), agent)
    expect(await d.run('agents-tell-agents', 'on', '--person-said-yes')).toBe(0)
    expect(d.out.at(-1)).toBe('agents-tell-agents is on for your account. The person said yes; tell them they can turn it off any time by asking you.')
    expect(d.asked.at(-1)!.body).toEqual({ agentsTellAgents: true, byAgent: 'Claude Code' })
    // The person's own: no word of an agent.
    const person = daemon((method, body) => ({ status: 200, body: { ...OFF, ...(body as object), signedIn: true } }))
    expect(await person.run('agents-tell-agents', 'on', '--person-said-yes')).toBe(0)
    expect(person.asked.at(-1)!.body).toEqual({ agentsTellAgents: true })
    expect(person.out.at(-1)).toBe('agents-tell-agents is on for your account.')
  })

  it('refuses an agent the direction that widens sharing: for the inverted summary switch that is off, not on', async () => {
    const agent = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's' }
    const d = daemon((method, body) => ({ status: 200, body: { ...OFF, ...(body as object), signedIn: true } }), agent)
    expect(await d.run('agent-messages-hide-summary', 'off')).toBe(5)
    expect(d.err.join('\n')).toMatch(/^agent-messages-hide-summary is on\. Ask the person, .* "May Harness share a one-line summary of what your harnesses do with the people in your shared tabs\?" Only if they say yes, run `harness settings agent-messages-hide-summary off --person-said-yes`/)
    expect(d.asked).toEqual([])
    // Hiding the summary narrows what is shared: an agent may.
    expect(await d.run('agent-messages-hide-summary', 'on')).toBe(0)
  })

  it('refuses what it does not know with the usage, and prints it for --help', async () => {
    const d = daemon(() => ({ status: 200, body: OFF }))
    expect(await d.run('nope', 'on')).toBe(2)
    expect(await d.run('agents-start-agents', 'maybe')).toBe(2)
    expect(await d.run('agents-start-agents', 'on', 'extra')).toBe(2)
    expect(d.err).toEqual([SETTINGS_USAGE, SETTINGS_USAGE, SETTINGS_USAGE])
    expect(await d.run('--help')).toBe(0)
    expect(d.out).toEqual([SETTINGS_USAGE])
    expect(d.asked).toEqual([])
  })

  it('shows the daemon this OS user\'s local credential, which its loopback port wants', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'settings-cred-'))
    try {
      const credential = loadOrCreateHookCredential(dataDir)
      const asked: Record<string, string>[] = []
      const fetch = (async (_url: string, init: RequestInit) => {
        asked.push(init.headers as Record<string, string>)
        return new Response(JSON.stringify({ ...OFF, signedIn: true }))
      }) as unknown as typeof globalThis.fetch
      expect(await settingsCommand([], { port: 4321, dataDir, fetch, env: {}, out: () => {}, err: () => {} })).toBe(0)
      expect(asked).toEqual([{ 'x-adapter-local': '1', 'X-Harness-Local': credential }])
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
})
