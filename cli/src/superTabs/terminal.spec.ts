import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CoreApi, SuperTabScreen } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CODEX_MODEL_MIGRATION, CODEX_SIGN_IN, CODEX_TRUST_PROMPT, CODEX_UPDATE_PROMPT } from '../lib/__fixtures__/takeoverScreens.js'
import { capScreen, limitOf, modelFailing, TerminalHost, typedKeys } from './terminal.js'

const row = (agentId = 'a1', harnessId = 'h1', over: Record<string, unknown> = {}) => ({ tabId: 'tab', agent: { id: agentId, harnessId, machineId: 'm1' }, ...over })
type Sent = { path: string; body: Record<string, any> }

function setup(options: { live?: string[]; screen?: (harnessId: string) => SuperTabScreen; requests?: unknown[] } = {}) {
  let clock = 1_000_000
  const sent: Sent[] = []
  let pending = options.requests ?? []
  const backend: CoreApi['account']['backend'] = vi.fn(async (method, path, body) => {
    if (path === '/api/super-tabs/hosts/m1/terminal') { const rows = pending; pending = []; return { status: 200, body: { success: true, data: rows } } }
    sent.push({ path, body: body as Record<string, any> })
    return { status: 200, body: { success: true, data: { result: {} } } }
  })
  let screen = options.screen ?? (() => ({ ok: true as const, text: '> ', hold: null }))
  const core = fakeCore({
    account: { backend },
    agents: { byAgent: vi.fn((id: string) => (options.live ?? ['h1']).includes(id) ? { agentId: id } as never : undefined) },
    superTabs: { attention: vi.fn(), cards: vi.fn(), cardRecap: vi.fn(), shareObservers: vi.fn(),
      screen: vi.fn(async (harnessId: string) => screen(harnessId)), input: vi.fn(async () => ({ ok: true as const })), dismissUpdate: vi.fn(async () => ({ ok: true as const })) },
  })
  const host = new TerminalHost(core, 'm1', { now: () => clock, log: vi.fn() })
  return { core, backend, sent, host,
    wait: (ms: number) => { clock += ms },
    request: (...rows: unknown[]) => { pending = rows },
    showing: (next: (harnessId: string) => SuperTabScreen) => { screen = next },
    polls: () => vi.mocked(backend).mock.calls.filter(([, path]) => path === '/api/super-tabs/hosts/m1/terminal').length,
    alerts: () => sent.filter(s => s.body.command.type === 'agent.alert').map(s => s.body.command) }
}
/** A screen as the engine draws it (fixtures/screens). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')
const screenRequest = (over: Record<string, unknown> = {}) => ({ tabId: 'tab', agentId: 'a1', harnessId: 'h1', request: { id: 'r1', kind: 'screen' }, ...over })

describe('a host serving its Lead\'s terminal requests', () => {
  it('reads the screen of its own agent and answers as that agent', async () => {
    const t = setup({ requests: [screenRequest({ request: { id: 'r1', kind: 'screen', scrollback: 50 } })],
      screen: () => ({ ok: true, text: 'Allow edit? 1. Yes 2. No', hold: 'permission_open' }) })
    await t.host.tick([row()])
    expect(t.core.superTabs!.screen).toHaveBeenCalledWith('h1', 50)
    expect(t.sent).toEqual([{ path: '/api/super-tabs/tab/commands', body: { operationId: 'terminal-r1', asAgentId: 'a1',
      command: { type: 'agent.screenResult', requestId: 'r1', ok: true, text: 'Allow edit? 1. Yes 2. No' } } }])
  })

  it('refuses a request whose harness is not the one running here, and never reads or types for it', async () => {
    const t = setup({ requests: [screenRequest({ harnessId: 'h-old' }),
      { tabId: 'tab', agentId: 'a1', harnessId: 'h-old', request: { id: 'r2', kind: 'input', text: 'y' } }] })
    await t.host.tick([row()])
    // The one read is the alert watch's own.
    expect(t.core.superTabs!.screen).toHaveBeenCalledOnce()
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
    expect(t.sent.map(s => s.body.command).sort((x, y) => x.requestId.localeCompare(y.requestId))).toEqual([
      { type: 'agent.screenResult', requestId: 'r1', ok: false, error: 'This agent\'s terminal on this machine changed. Ask again.' },
      { type: 'agent.inputResult', requestId: 'r2', ok: false, error: 'This agent\'s terminal on this machine changed. Ask again.' }])
  })

  it('never answers as another machine\'s agent, and tells at once that a stopping one or one not running here is not running', async () => {
    const t = setup({ live: ['h1', 'h3'], requests: [screenRequest({ agentId: 'a9', harnessId: 'h9' }), screenRequest({ agentId: 'a2', harnessId: 'h2' }),
      screenRequest({ agentId: 'a3', harnessId: 'h3', request: { id: 'r3', kind: 'screen' } }), screenRequest({ agentId: 'a4', harnessId: 'h4', request: { id: 'r4', kind: 'input', keys: ['Enter'] } })] })
    await t.host.tick([row(), { tabId: 'tab', agent: { id: 'a2', harnessId: 'h2', machineId: 'm2' } }, row('a3', 'h3', { stopRequested: true }), row('a4', 'h4')])
    expect(vi.mocked(t.core.superTabs!.screen).mock.calls).toEqual([['h1', 0]])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
    expect(t.sent.map(s => [s.body.asAgentId, s.body.command]).sort()).toEqual([
      ['a3', { type: 'agent.screenResult', requestId: 'r3', ok: false, error: 'This agent is not running on this machine.' }],
      ['a4', { type: 'agent.inputResult', requestId: 'r4', ok: false, error: 'This agent is not running on this machine.' }]])
  })

  it('asks for requests while only a stopping agent is here, so its requests are answered', async () => {
    const t = setup({ requests: [screenRequest({ agentId: 'a3', harnessId: 'h3' })] })
    await t.host.tick([row('a3', 'h3', { stopRequested: true })])
    expect(t.sent.map(s => s.body.command.error)).toEqual(['This agent is not running on this machine.'])
  })

  it('refuses typed text with a newline or another control character: those are keys, sent by name', async () => {
    const t = setup({ requests: ['a\nrm -rf x', 'a\u001b[A', 'ok\u007f'].map((text, i) => ({ tabId: 'tab', agentId: 'a1', harnessId: 'h1', request: { id: `r${i}`, kind: 'input', text } })) })
    await t.host.tick([row()])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
    expect(t.sent.map(s => s.body.command.error)).toEqual(Array(3).fill('Send Enter and other keys as named keys, not in the text.'))
  })

  it('caps the screen at 64 KB, keeping its end and never splitting a character', async () => {
    expect(capScreen('short')).toBe('short')
    const long = `${'x'.repeat(70_000)}é${'y'.repeat(65_535)}`
    const capped = capScreen(long)
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(65_536)
    expect(capped).toBe('y'.repeat(65_535))
    const t = setup({ requests: [screenRequest()], screen: () => ({ ok: true, text: 'z'.repeat(100_000), hold: null }) })
    await t.host.tick([row()])
    expect(Buffer.byteLength(t.sent[0].body.command.text)).toBe(65_536)
  })

  it('types the text and the named keys, mapped to the terminal\'s own key names', async () => {
    expect(typedKeys(['Enter', 'Esc', 'Tab', 'Up', 'Down', 'Left', 'Right', 'Ctrl-C', '0', '9'])).toEqual(['Enter', 'Escape', 'Tab', 'Up', 'Down', 'Left', 'Right', 'C-c', '0', '9'])
    expect(typedKeys(['esc', 'ctrl-c', 'ENTER'])).toEqual(['Escape', 'C-c', 'Enter'])
    expect(typedKeys(['Enter', 'C-d'])).toBe('Unknown key: C-d.')
    expect(typedKeys(['F1'])).toBe('Unknown key: F1.')
    const t = setup({ requests: [{ tabId: 'tab', agentId: 'a1', harnessId: 'h1', request: { id: 'r1', kind: 'input', text: '2', keys: ['Enter'] } },
      { tabId: 'tab', agentId: 'a1', harnessId: 'h1', request: { id: 'r2', kind: 'input', keys: ['Home'] } }] })
    await t.host.tick([row()])
    expect(t.core.superTabs!.input).toHaveBeenCalledOnce()
    expect(t.core.superTabs!.input).toHaveBeenCalledWith('h1', '2', ['Enter'])
    expect(t.sent.map(s => s.body.command).sort((x, y) => x.requestId.localeCompare(y.requestId))).toEqual([{ type: 'agent.inputResult', requestId: 'r1', ok: true },
      { type: 'agent.inputResult', requestId: 'r2', ok: false, error: 'Unknown key: Home.' }])
  })

  it('passes on why the core could not read the screen', async () => {
    const t = setup({ requests: [screenRequest()], screen: () => ({ ok: false, error: 'Could not read the terminal: pane gone' }) })
    await t.host.tick([row()])
    expect(t.sent[0].body.command).toEqual({ type: 'agent.screenResult', requestId: 'r1', ok: false, error: 'Could not read the terminal: pane gone' })
    // The backend takes a reason of at most 500 characters.
    t.showing(() => ({ ok: false, error: `Could not read the terminal: ${'x'.repeat(600)}` }))
    t.request(screenRequest({ request: { id: 'r2', kind: 'screen' } }))
    t.wait(3_000); await t.host.tick([row()])
    expect(t.sent[1].body.command.error).toHaveLength(500)
  })

  it('asks for requests every 3 seconds, and not at all without a Swarm agent here', async () => {
    const t = setup()
    await t.host.tick([])
    await t.host.tick([{ tabId: 'tab', agent: { id: 'a2', harnessId: 'h2', machineId: 'm2' } }])
    expect(t.polls()).toBe(0)
    await t.host.tick([row()])
    expect(t.polls()).toBe(1)
    t.wait(2_000)
    await t.host.tick([row()])
    expect(t.polls()).toBe(1)
    t.wait(1_000)
    await t.host.tick([row()])
    expect(t.polls()).toBe(2)
  })
})

describe('the stuck and usage-limit alerts', () => {
  const prompt = (): SuperTabScreen => ({ ok: true, text: 'Do you want to proceed?\n❯ 1. Yes\n  2. No', hold: 'permission_open' })
  const idle = (): SuperTabScreen => ({ ok: true, text: '> ', hold: null })

  it('alerts once when a prompt has waited 3 minutes, and ends the episode when it is answered', async () => {
    const t = setup({ screen: prompt })
    await t.host.tick([row()])
    t.wait(150_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([])
    t.wait(30_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'prompt', active: true }])
    for (let i = 0; i < 5; i++) { t.wait(15_000); await t.host.tick([row()]) }
    expect(t.alerts()).toHaveLength(1)
    t.showing(idle); t.wait(15_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'prompt', active: true }, { type: 'agent.alert', agentId: 'a1', alert: 'prompt', active: false }])
    // A new prompt is a new episode, with its own 3 minutes.
    t.showing(prompt); t.wait(15_000); await t.host.tick([row()])
    t.wait(150_000); await t.host.tick([row()])
    expect(t.alerts()).toHaveLength(2)
    t.wait(30_000); await t.host.tick([row()])
    expect(t.alerts()).toHaveLength(3)
    expect(new Set(t.sent.map(s => s.body.operationId)).size).toBe(3)
  })

  it('never alerts for a prompt answered within 3 minutes, nor ends an episode it never began', async () => {
    const t = setup({ screen: prompt })
    await t.host.tick([row()])
    t.showing(idle); t.wait(120_000); await t.host.tick([row()])
    t.showing(prompt); t.wait(120_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([])
  })

  it('reads the screen only every 15 seconds', async () => {
    const t = setup({ screen: idle })
    await t.host.tick([row()])
    t.wait(5_000); await t.host.tick([row()])
    expect(t.core.superTabs!.screen).toHaveBeenCalledOnce()
    t.wait(10_000); await t.host.tick([row()])
    expect(t.core.superTabs!.screen).toHaveBeenCalledTimes(2)
  })

  it('alerts once for a usage-limit screen with its reset time, and ends it when the screen moves on', async () => {
    const t = setup({ screen: () => ({ ok: true, text: 'Working on it\n\n■ You\'ve hit your usage limit. Upgrade to Pro or try again in 1 hour 30 minutes.\n> ', hold: null }) })
    await t.host.tick([row()])
    t.wait(15_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'limit', active: true, resetAt: new Date(1_000_000 + 90 * 60_000).toISOString() }])
    t.showing(idle); t.wait(15_000); await t.host.tick([row()])
    expect(t.alerts()[1]).toEqual({ type: 'agent.alert', agentId: 'a1', alert: 'limit', active: false })
  })

  it('alerts once its model has failed for 10 minutes, and ends it when answers come again', async () => {
    const failing = (): SuperTabScreen => ({ ok: true, text: '✻ Waiting for API response · will retry in 2m 38s · check your network\n❯ ', hold: null })
    const t = setup({ screen: failing })
    await t.host.tick([row()])
    t.wait(540_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([])
    t.wait(60_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'model', active: true }])
    // Answers coming again end it only once no retry has shown for ten minutes.
    t.showing(idle); t.wait(15_000); await t.host.tick([row()])
    expect(t.alerts()).toHaveLength(1)
    t.wait(585_000); await t.host.tick([row()])
    expect(t.alerts()[1]).toEqual({ type: 'agent.alert', agentId: 'a1', alert: 'model', active: false })
  })

  it('raises nothing for a burst of failures that recovers before ten minutes, so its task is never lost for it', async () => {
    // Last night's reviewer failures came and went (429 bursts): nine minutes of retries, then answers for ten.
    const failing = (): SuperTabScreen => ({ ok: true, text: '✻ Waiting for API response · will retry in 2m 38s · check your network\n❯ ', hold: null })
    const t = setup({ screen: failing })
    await t.host.tick([row()])
    t.wait(539_000); await t.host.tick([row()])
    t.showing(idle)
    for (let second = 0; second < 600; second += 15) { t.wait(15_000); await t.host.tick([row()]) }
    // A second burst starts its own ten minutes.
    t.showing(failing); t.wait(15_000); await t.host.tick([row()])
    t.wait(539_000); await t.host.tick([row()])
    expect(t.alerts()).toEqual([])
  })

  it('counts retries with fresh attempts between them as one failing stretch', async () => {
    // Claude Code shows its countdown, then a plain spinner for the minutes each new attempt takes.
    const failing = (): SuperTabScreen => ({ ok: true, text: '✻ Waiting for API response · will retry in 1m 18s · check your network\n❯ ', hold: null })
    const attempt = (): SuperTabScreen => ({ ok: true, text: '✻ Thinking… (4m 12s · esc to interrupt)\n❯ ', hold: null })
    const t = setup({ screen: failing })
    await t.host.tick([row()])
    for (let minute = 0; minute < 10; minute += 2) {
      t.showing(attempt); t.wait(60_000); await t.host.tick([row()])
      t.showing(failing); t.wait(60_000); await t.host.tick([row()])
    }
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'model', active: true }])
  })

  it.each(['claude-session-limit', 'claude-weekly-limit', 'claude-opus-limit', 'claude-fable-limit', 'codex-usage-limit', 'codex-model-limit'])(
    'alerts for the %s screen', async name => {
      const t = setup({ screen: () => ({ ok: true, text: fixture(name), hold: null }) })
      await t.host.tick([row()])
      expect(t.alerts()).toEqual([expect.objectContaining({ type: 'agent.alert', agentId: 'a1', alert: 'limit', active: true })])
    })

  it('tries an alert the backend did not take again on the next read', async () => {
    const t = setup({ screen: () => ({ ok: true, text: 'Claude usage limit reached. Your limit will reset at 3pm.', hold: null }) })
    const real = vi.mocked(t.backend).getMockImplementation()!
    let failed = false
    vi.mocked(t.backend).mockImplementation(async (method, path, body) => {
      if (!failed && path.endsWith('/commands')) { failed = true; return { status: 503, body: { success: false } } }
      return real(method, path, body)
    })
    await t.host.tick([row()])
    t.wait(15_000); await t.host.tick([row()])
    expect(t.alerts()).toHaveLength(1)
  })
})

describe('dismissing Codex\'s update screen for a Swarm agent', () => {
  const update = (): SuperTabScreen => ({ ok: true, text: CODEX_UPDATE_PROMPT, hold: 'update_prompt_open' })
  const idle = (): SuperTabScreen => ({ ok: true, text: '> ', hold: null })
  const dismissed = (t: ReturnType<typeof setup>) => vi.mocked(t.core.superTabs!.dismissUpdate).mock.calls

  it('asks the core to dismiss it (Esc, checked again under the pane\'s lock), types nothing itself, and raises no alert', async () => {
    const t = setup({ screen: update })
    await t.host.tick([row()])
    expect(dismissed(t)).toEqual([['h1']])
    expect(t.core.superTabs!.input).not.toHaveBeenCalled()
    t.showing(idle)
    for (let i = 0; i < 14; i++) { t.wait(15_000); await t.host.tick([row()]) }
    expect(dismissed(t)).toHaveLength(1)
    expect(t.alerts()).toEqual([])
  })

  it('answers only the agent whose screen shows it, and only a Swarm agent of this machine', async () => {
    const t = setup({ screen: harnessId => harnessId === 'h2' ? update() : idle(), live: ['h1', 'h2', 'h3'] })
    await t.host.tick([row('a1', 'h1'), row('a2', 'h2'), { tabId: 'tab', agent: { id: 'a3', harnessId: 'h3', machineId: 'other' } }])
    expect(dismissed(t)).toEqual([['h2']])
  })

  it.each([['trust', CODEX_TRUST_PROMPT, 'trust_open'], ['model', CODEX_MODEL_MIGRATION, 'model_prompt_open'],
    ['sign-in', CODEX_SIGN_IN, 'sign_in_open'], ['permission', 'Allow? 1. Yes', 'permission_open']] as const)('asks for nothing on the %s screen', async (_name, text, hold) => {
    const t = setup({ screen: () => ({ ok: true, text, hold }) })
    await t.host.tick([row()])
    expect(dismissed(t)).toEqual([])
  })

  it('asks for nothing when the update screen is misread (a Skip row as 0), and alerts as before after 3 minutes', async () => {
    const t = setup({ screen: () => ({ ok: true, text: CODEX_UPDATE_PROMPT.replace('  2. Skip\n', '  0. Skip\n'), hold: 'update_prompt_open' }) })
    await t.host.tick([row()])
    t.wait(180_000); await t.host.tick([row()])
    expect(dismissed(t)).toEqual([])
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'prompt', active: true }])
  })

  it('tries three times at most when the screen stays, then leaves it to the 3-minute alert', async () => {
    const t = setup({ screen: update })
    for (let i = 0; i < 12; i++) { await t.host.tick([row()]); t.wait(15_000) }
    await t.host.tick([row()])
    expect(dismissed(t)).toHaveLength(3)
    expect(t.alerts()).toEqual([{ type: 'agent.alert', agentId: 'a1', alert: 'prompt', active: true }])
  })

  it('starts the tries again for a new update screen once the old one is gone', async () => {
    const t = setup({ screen: update })
    await t.host.tick([row()])
    t.showing(idle); t.wait(15_000); await t.host.tick([row()])
    t.showing(update); t.wait(15_000); await t.host.tick([row()])
    expect(dismissed(t)).toHaveLength(2)
  })

  it('goes on watching when the core refuses, because the screen had changed or the terminal did not take the key', async () => {
    const t = setup({ screen: update })
    vi.mocked(t.core.superTabs!.dismissUpdate).mockResolvedValueOnce({ ok: false, error: 'The screen changed before the key was sent; nothing was typed.' })
    vi.mocked(t.core.superTabs!.dismissUpdate).mockRejectedValueOnce(new Error('core gone'))
    await t.host.tick([row()])
    t.wait(15_000); await t.host.tick([row()])
    t.wait(15_000); await t.host.tick([row()])
    expect(dismissed(t)).toHaveLength(3)
  })
})

describe('progress for the machine report', () => {
  const showing = (text: string) => (): SuperTabScreen => ({ ok: true, text, hold: null })

  it('records when each running agent\'s screen last changed, from the reads the watch already makes', async () => {
    const t = setup({ screen: showing('✻ Reading files…\n❯ ') })
    await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_000_000 })
    t.wait(15_000); await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_000_000 })
    t.showing(showing('✻ Editing host.ts…\n❯ ')); t.wait(15_000); await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_030_000 })
    expect(t.core.superTabs!.screen).toHaveBeenCalledTimes(3)
  })

  it('names only running agents, and forgets one once it stops or leaves', async () => {
    const t = setup({ live: ['h1', 'h2'] })
    await t.host.tick([row(), row('a2', 'h2', { stopRequested: true }), row('a3', 'h3')])
    expect(t.host.progressOf(['h1', 'h2', 'h3'])).toEqual({ h1: 1_000_000 })
    t.wait(15_000); await t.host.tick([row('a2', 'h2')])
    expect(t.host.progressOf(['h1', 'h2'])).toEqual({ h2: 1_015_000 })
    await t.host.tick([])
    expect(t.host.progressOf(['h1', 'h2'])).toEqual({})
  })

  it.each(['claude', 'codex'])('does not count %s redrawing only its spinner, elapsed time, token counter or tip, and counts new work', async engine => {
    const t = setup({ screen: showing(fixture(`${engine}-working-a`)) })
    await t.host.tick([row()])
    t.showing(showing(fixture(`${engine}-working-b`))); t.wait(15_000); await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_000_000 })
    t.showing(showing(fixture(`${engine}-working-b`).replace('\n\n', '\n\nEdited cli/src/superTabs/terminal.ts\n\n'))); t.wait(15_000); await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_030_000 })
  })

  it('does not count a screen that only shows its model retrying, nor one that could not be read', async () => {
    const t = setup({ screen: showing('✻ Waiting for API response · will retry in 2m 38s · check your network\n❯ ') })
    await t.host.tick([row()])
    t.showing(showing('✻ Waiting for API response · will retry in 2m 23s · check your network\n❯ ')); t.wait(15_000); await t.host.tick([row()])
    t.showing(() => ({ ok: false, error: 'pane gone' })); t.wait(15_000); await t.host.tick([row()])
    expect(t.host.progressOf(['h1'])).toEqual({ h1: 1_000_000 })
  })
})

describe('reading a usage limit off a screen', () => {
  const now = new Date(2026, 9, 23, 14, 10).getTime()
  it.each([
    ['5-hour limit reached ∙ resets 3pm', new Date(2026, 9, 23, 15, 0)],
    ['Claude usage limit reached. Your limit will reset at 3pm (Asia/Saigon).', new Date(2026, 9, 23, 15, 0)],
    ['You\'ve hit your limit · resets 1:30pm (Asia/Saigon)', new Date(2026, 9, 24, 13, 30)],
    ['Weekly limit reached ∙ resets Oct 25, 9am', new Date(2026, 9, 25, 9, 0)],
    ['5-hour limit reached ∙ resets 15:00', new Date(2026, 9, 23, 15, 0)],
    ['5-hour limit reached ∙ resets 0:30', new Date(2026, 9, 24, 0, 30)],
    ['5-hour limit reached ∙ resets 12pm', new Date(2026, 9, 24, 12, 0)],
    ['5-hour limit reached ∙ resets 12am', new Date(2026, 9, 24, 0, 0)],
    ['■ You\'ve hit your usage limit. Try again at 4:05 PM.', new Date(2026, 9, 23, 16, 5)],
    ['■ You\'ve hit your usage limit. Upgrade to Pro, or try again in 2 days 3 hours 1 minute.', new Date(now + ((2 * 24 + 3) * 60 + 1) * 60_000)],
  ])('reads %s', (line, reset) => {
    expect(limitOf(`some work\n${line}\n> `, now)).toEqual({ resetAt: reset.toISOString() })
  })
  // Whole screens as Claude Code 2.1.310 and Codex 0.154 draw them, their limit lines in the engines' own words
  // (fixtures/screens): Claude Code names the limit hit, and Codex wraps its long line and dates a reset after today.
  it.each([
    ['claude-session-limit', { resetAt: new Date(2026, 9, 23, 15, 0).toISOString() }],
    ['claude-weekly-limit', { resetAt: new Date(2026, 9, 30, 9, 0).toISOString() }],
    ['claude-opus-limit', { resetAt: new Date(2026, 9, 30, 9, 0).toISOString() }],
    ['claude-fable-limit', {}],
    ['codex-usage-limit', { resetAt: new Date(2026, 9, 27, 15, 5).toISOString() }],
    ['codex-model-limit', { resetAt: new Date(2026, 9, 23, 16, 5).toISOString() }],
  ])('reads the %s screen', (name, limit) => {
    expect(limitOf(fixture(name), now)).toEqual(limit)
  })
  it('knows a limit without a reset time, and ignores the words in an agent\'s own prose or far above the prompt', () => {
    expect(limitOf('⎿  API Error: Usage limit reached\n> ', now)).toEqual({})
    expect(limitOf('I will add a check for when the usage limit reached message shows.\n> ', now)).toBeNull()
    expect(limitOf(`5-hour limit reached ∙ resets 3pm\n${'line\n'.repeat(30)}> `, now)).toBeNull()
    expect(limitOf('> ', now)).toBeNull()
    // A full context is not a usage limit; a workspace out of credits is one.
    expect(limitOf('  ⎿  Context limit reached · /compact or /clear to continue\n> ', now)).toBeNull()
    expect(limitOf('■ You\'ve reached your workspace credit limit\n› ', now)).toEqual({})
  })
})

describe('reading a model that keeps failing off a screen', () => {
  it('knows the engines\' retry lines near the prompt, and nothing far up or in the agent\'s own words', () => {
    for (const line of ['✻ Waiting for API response · will retry in 2m 38s · check your network', '  ⎿  API Error: 503 upstream unavailable',
      'API Error: Request timed out.', 'API Error: Connection error.', '⚠ stream disconnected - retrying turn (3/5 in 1.2s)…', 'Reconnecting... 2/5']) {
      expect(modelFailing(`work\n${line}\n> `)).toBe(true)
    }
    expect(modelFailing('I will handle the case where the API response is slow.\n> ')).toBe(false)
    expect(modelFailing(`Waiting for API response\n${'line\n'.repeat(30)}> `)).toBe(false)
  })
})
